import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appleEnv } from '../apple.ts';
import { BaseDeviceBackend, type PressOutcome } from '../backend.ts';
import type {
  AlertAction,
  BackendAlertResult,
  Key,
  OpenAppResult,
  PressTarget,
  ScrollDirection,
  ScrollOptions,
  Snapshot,
  SnapshotNode,
} from '../device.ts';
import { ALL_CAPABILITIES } from '../device.ts';
import {
  ActionFailedError,
  DeviceNotFoundError,
  PhoneUseError,
  SessionNotFoundError,
  TimeoutError,
  UnsupportedCapabilityError,
} from '../errors.ts';
import {
  type EnsureRunnerOptions,
  ensureRunner,
  type RunnerEndpoint,
  runningApps,
  stopRunner,
} from './ios-runner.ts';

// ---------------------------------------------------------------------------
// The native iOS simulator backend: phone-use's own XCTest runner, reached
// over loopback HTTP. It replaces the third-party device layer the SDK used to
// depend on; nothing here imports another automation tool.
//
// Division of labour:
//   runner (on the simulator) — accessibility snapshots, refs, gestures, text,
//     alerts, app activation: everything that needs XCTest privileges.
//   host (here) — simctl for what is faster or only possible from the Mac:
//     screenshots, installed apps, launchd's running-app list (the input to
//     frontmost-app detection), opening URLs with the system default handler.
// ---------------------------------------------------------------------------

const pExecFile = promisify(execFile);
const SPRINGBOARD = 'com.apple.springboard';

/** Options for {@link createXctestBackend}. */
export type XctestBackendOptions = EnsureRunnerOptions & {
  /**
   * Simulator udid to drive, or `'booted'` for "the one booted simulator".
   * `'booted'` refuses to guess: with zero or several booted simulators it
   * fails and lists them, instead of driving whichever happens to come first.
   */
  udid: string;
  /** Per-RPC timeout in ms (default 45 s; long waits add their own timeout). */
  rpcTimeoutMs?: number | undefined;
};

type WireNode = {
  ref: string;
  type: string;
  label?: string;
  value?: string;
  identifier?: string;
  placeholder?: string;
  enabled?: boolean;
  selected?: boolean;
  focused?: boolean;
  offscreen?: boolean;
  system?: boolean;
  blocked?: string;
  rect: { x: number; y: number; width: number; height: number };
};

type WireSnapshot = {
  app: { bundleId: string; name: string };
  viewport: { width: number; height: number };
  nodes: WireNode[];
  more?: { above: number; below: number };
  generation: number;
  ms: number;
};

type WireError = { code: string; message: string; hint?: string };

/** Map a runner error onto the SDK's typed error tree. */
function toError(method: string, error: WireError): PhoneUseError {
  const details = { backendCode: error.code, ...(error.hint ? { hint: error.hint } : {}) };
  switch (error.code) {
    case 'TIMEOUT':
      return new TimeoutError(error.message, { details });
    case 'STALE_REF':
      return new ActionFailedError(error.message, { details });
    case 'UNKNOWN_METHOD':
      return new UnsupportedCapabilityError({ backend: 'xctest', capability: method });
    case 'UNAUTHORIZED':
      return new SessionNotFoundError(
        'the runner rejected our token (it was restarted by another process?)',
        {
          details,
        },
      );
    case 'BAD_PARAMS':
    case 'OUT_OF_BOUNDS':
    case 'OCCLUDED':
    case 'COVERED':
      // Retrying the same call cannot help; the hint says what will.
      return new PhoneUseError(error.message, { code: 'ACTION_FAILED', retryable: false, details });
    default:
      return new ActionFailedError(error.message, { details });
  }
}

/** The single booted simulator, or a DeviceNotFoundError explaining why there is not one. */
export async function soleBootedSimulator(): Promise<string> {
  const { stdout } = await pExecFile('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], {
    env: appleEnv(),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const rows = Object.values(
    (JSON.parse(stdout) as { devices: Record<string, Array<{ udid: string; name: string; state: string }>> })
      .devices,
  )
    .flat()
    .filter((d) => d.state === 'Booted');
  if (rows.length === 1 && rows[0]) return rows[0].udid;
  if (rows.length === 0) {
    throw new DeviceNotFoundError('no iOS simulator is booted', {
      details: { hint: 'boot one, or let phone-use create one: PHONE_USE_DEVICE=launch' },
    });
  }
  throw new DeviceNotFoundError(
    `${rows.length} simulators are booted (${rows.map((r) => `${r.name} ${r.udid}`).join(', ')}); refusing to guess which one to drive`,
    { details: { hint: 'pick one with PHONE_USE_DEVICE=<udid> (or ios.connect(udid))' } },
  );
}

class XctestBackend extends BaseDeviceBackend {
  udid: string;
  private readonly options: XctestBackendOptions;
  private endpoint: RunnerEndpoint | undefined;
  private starting: Promise<RunnerEndpoint> | undefined;
  /** The app we last saw or put in front; passed to the runner as a hint. */
  private knownBundleId: string | undefined;
  private appNames: Map<string, string> | undefined;

  constructor(options: XctestBackendOptions) {
    super('xctest', ALL_CAPABILITIES);
    this.udid = options.udid;
    this.options = options;
  }

  private runner(): Promise<RunnerEndpoint> {
    if (this.endpoint) return Promise.resolve(this.endpoint);
    this.starting ??= (async () => {
      if (this.udid === 'booted') this.udid = await soleBootedSimulator();
      return ensureRunner(this.udid, this.options);
    })().then(
      (endpoint) => {
        this.endpoint = endpoint;
        this.starting = undefined;
        return endpoint;
      },
      (error) => {
        this.starting = undefined;
        throw error;
      },
    );
    return this.starting;
  }

  /** One RPC. A dead runner is restarted once, transparently. */
  private async rpc<T>(method: string, params: Record<string, unknown> = {}, retried = false): Promise<T> {
    const endpoint = await this.runner();
    const timeout = (this.options.rpcTimeoutMs ?? 45_000) + (Number(params.timeoutMs) || 0);
    let res: Response;
    try {
      res = await fetch(`${endpoint.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify({ method, params }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (cause) {
      if ((cause as Error).name === 'TimeoutError') {
        throw new TimeoutError(`the iOS runner did not answer ${method} within ${timeout}ms`, { cause });
      }
      if (retried) {
        throw new DeviceNotFoundError(`the iOS runner on ${this.udid} is unreachable`, {
          cause,
          details: { hint: `see ${endpoint.logPath}` },
        });
      }
      // The runner died (simulator rebooted, xcodebuild killed): start a new one.
      this.endpoint = undefined;
      stopRunner(this.udid, this.options);
      return this.rpc<T>(method, params, true);
    }
    if (res.status === 401 && !retried) {
      this.endpoint = undefined;
      return this.rpc<T>(method, params, true);
    }
    const body = (await res.json()) as { result?: T; error?: WireError };
    if (body.error) throw toError(method, body.error);
    return body.result as T;
  }

  private async simctl(args: string[], timeoutMs = 30_000): Promise<string> {
    if (this.udid === 'booted') this.udid = await soleBootedSimulator();
    const resolved = args.map((a) => (a === 'booted' ? this.udid : a));
    args = resolved;
    try {
      const { stdout } = await pExecFile('xcrun', ['simctl', ...args], {
        env: appleEnv(),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
      });
      return stdout;
    } catch (cause) {
      const err = cause as { stderr?: string; message: string };
      throw new ActionFailedError(`simctl ${args[0]} failed: ${(err.stderr ?? err.message).trim()}`, {
        cause,
      });
    }
  }

  // --- observe -------------------------------------------------------------

  override async snapshot(opts?: {
    interactiveOnly?: boolean | undefined;
    depth?: number | undefined;
  }): Promise<Snapshot> {
    const base = {
      interactiveOnly: opts?.interactiveOnly ?? true,
      ...(opts?.depth === undefined ? {} : { depth: opts.depth }),
      // SpringBoard always reports itself foreground, so it is never a useful hint.
      ...(this.knownBundleId && this.knownBundleId !== SPRINGBOARD ? { bundleId: this.knownBundleId } : {}),
    };
    let wire = await this.rpc<WireSnapshot>('snapshot', base);
    // The runner falls back to SpringBoard when the app it knows about left
    // the foreground. If we were not expecting the Home Screen, ask launchd
    // which apps are running and let the runner check those.
    if (wire.app.bundleId === SPRINGBOARD && this.knownBundleId !== SPRINGBOARD) {
      const candidates = await runningApps(this.udid).catch(() => [] as string[]);
      const apps = candidates.filter((id) => !id.endsWith('.xctrunner') && id !== SPRINGBOARD);
      if (apps.length) wire = await this.rpc<WireSnapshot>('snapshot', { ...base, candidates: apps });
    }
    this.knownBundleId = wire.app.bundleId;
    return {
      appName: wire.app.name || wire.app.bundleId,
      appBundleId: wire.app.bundleId,
      nodes: wire.nodes.map(toNode),
    };
  }

  override async screenshot(opts: {
    path: string;
    overlayRefs?: boolean | undefined;
  }): Promise<{ path: string }> {
    if (opts.overlayRefs) {
      const { base64 } = await this.rpc<{ base64: string }>('screenshot', { overlayRefs: true });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(opts.path, Buffer.from(base64, 'base64'));
      return { path: opts.path };
    }
    await this.simctl(['io', this.udid, 'screenshot', '--type=png', opts.path]);
    return { path: opts.path };
  }

  // --- act -----------------------------------------------------------------

  /** After a gesture the foreground app may have changed (a link, a share sheet). */
  private uncertain(): void {
    if (this.knownBundleId === SPRINGBOARD) this.knownBundleId = undefined;
  }

  private lastPress: PressOutcome | undefined;

  override async press(target: PressTarget): Promise<void> {
    this.lastPress = undefined;
    const r = await this.rpc<{ changed?: boolean }>(
      'tap',
      'ref' in target ? { ref: target.ref, diff: true } : { x: target.x, y: target.y, diff: true },
    );
    this.uncertain();
    // The runner compares the screen before the tap with the settled screen after it.
    this.lastPress = { changed: r?.changed };
  }

  pressOutcome(): PressOutcome | undefined {
    return this.lastPress;
  }

  override async longPress(ref: string, durationMs?: number): Promise<void> {
    await this.rpc('long_press', { ref, ...(durationMs === undefined ? {} : { durationMs }) });
  }

  override async fill(ref: string, text: string): Promise<void> {
    await this.rpc('fill', { ref, text });
  }

  override async typeText(text: string): Promise<void> {
    await this.rpc('type', { text });
  }

  override async pressKey(key: Key): Promise<void> {
    await this.rpc('key', { key });
  }

  override async scroll(direction: ScrollDirection, opts: ScrollOptions = {}): Promise<void> {
    await this.rpc('scroll', { direction, ...(opts.settle === false ? { settle: false } : {}) });
  }

  override async pan(x: number, y: number, dx: number, dy: number, durationMs?: number): Promise<void> {
    await this.rpc('drag', { x, y, dx, dy, ...(durationMs === undefined ? {} : { durationMs }) });
    this.uncertain();
  }

  override async waitForText(text: string, timeoutMs = 5000): Promise<void> {
    // After a URL open or a tap that may have switched apps, the runner does
    // not know which app is in front; give it launchd's running apps so its
    // wait follows the app that comes forward (Safari after openurl).
    const params: Record<string, unknown> = { text, timeoutMs };
    if (this.knownBundleId && this.knownBundleId !== SPRINGBOARD) params.bundleId = this.knownBundleId;
    else if (this.knownBundleId === undefined) {
      const running = await runningApps(this.udid).catch(() => [] as string[]);
      params.candidates = running.filter((id) => !id.endsWith('.xctrunner') && id !== SPRINGBOARD);
    }
    await this.rpc('wait_text', params);
  }

  override async systemAlert(action: AlertAction): Promise<BackendAlertResult> {
    const result = await this.rpc<{
      alert: { title?: string; message?: string; buttons?: string[] } | null;
      handled?: boolean;
      button?: string;
    }>('alert', { action });
    return { alert: result.alert, handled: result.handled, button: result.button };
  }

  override async home(): Promise<void> {
    await this.rpc('home');
    this.knownBundleId = SPRINGBOARD;
  }

  override async back(): Promise<void> {
    await this.rpc('back');
    this.uncertain();
  }

  override async openApp(opts: {
    app?: string | undefined;
    url?: string | undefined;
    relaunch?: boolean | undefined;
  }): Promise<OpenAppResult> {
    const bundleId = opts.app === undefined ? undefined : await this.resolveBundleId(opts.app);
    if (opts.url !== undefined) {
      if (bundleId) {
        await this.rpc('launch', { bundleId });
        await this.rpc('open_url', { url: opts.url, bundleId });
        this.knownBundleId = bundleId;
      } else {
        const front = async () =>
          (await this.snapshot({ interactiveOnly: true, depth: 1 }).catch(() => undefined))?.appBundleId;
        const before = await front();
        // XCTest's system open routes the URL to its owning app. `simctl openurl`
        // does not bring that app forward once the runner has activated another
        // app (measured: Settings stayed in front), so it is only the fallback.
        await this.rpc('open_url', { url: opts.url }).catch(() =>
          this.simctl(['openurl', this.udid, opts.url!]),
        );
        this.knownBundleId = undefined;
        // The owning app takes a moment to come forward; wait for it (up to 2 s)
        // so the next observation is of that app, not the one the URL left.
        let now: string | undefined;
        for (const end = Date.now() + 2000; Date.now() < end; ) {
          await new Promise((r) => setTimeout(r, 150));
          now = await front();
          if (now && now !== before) return { appBundleId: now, appName: await this.appName(now) };
        }
        // Nothing came forward: the link may have opened in the app already in
        // front, or not at all. Say so rather than report a plain success.
        return {
          unverified: `no app came forward (${now ?? before ?? 'unknown'} is still in front); it may have opened there, or not at all`,
        };
      }
      return { appBundleId: bundleId, appName: await this.appName(bundleId) };
    }
    if (!bundleId) throw new ActionFailedError('openApp needs an app or a url');
    const result = await this.rpc<{ bundleId: string; name?: string }>('launch', {
      bundleId,
      relaunch: opts.relaunch ?? false,
    });
    this.knownBundleId = bundleId;
    return { appBundleId: result.bundleId, appName: result.name || (await this.appName(bundleId)) };
  }

  override async listApps(): Promise<string[]> {
    const names = await this.installed(true);
    return [...names].map(([bundleId, name]) => `${name} (${bundleId})`);
  }

  override async closeSession(): Promise<void> {
    // The runner outlives this process on purpose (the next CLI call reuses
    // it). Stopping it is explicit: stopXctestRunner(udid).
  }

  // --- apps ------------------------------------------------------------------

  private async installed(force = false): Promise<Map<string, string>> {
    if (this.appNames && !force) return this.appNames;
    const plist = await this.simctl(['listapps', this.udid]);
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      const child = execFile(
        'plutil',
        ['-convert', 'json', '-o', '-', '-'],
        { maxBuffer: 64 * 1024 * 1024 },
        (err, out) => (err ? reject(err) : resolve({ stdout: out })),
      );
      child.stdin?.end(plist);
    });
    const parsed = JSON.parse(stdout) as Record<
      string,
      { CFBundleDisplayName?: string; CFBundleName?: string }
    >;
    const names = new Map<string, string>();
    for (const [bundleId, info] of Object.entries(parsed)) {
      names.set(bundleId, info.CFBundleDisplayName || info.CFBundleName || bundleId);
    }
    this.appNames = names;
    return names;
  }

  private async appName(bundleId: string): Promise<string | undefined> {
    return (await this.installed().catch(() => new Map<string, string>())).get(bundleId);
  }

  /** "Settings" → com.apple.Preferences; a bundle id passes through. */
  private async resolveBundleId(app: string): Promise<string> {
    if (/^[\w-]+(\.[\w-]+)+$/.test(app)) return app;
    const names = await this.installed();
    const wanted = app.trim().toLowerCase();
    for (const [bundleId, name] of names) if (name.toLowerCase() === wanted) return bundleId;
    for (const [bundleId, name] of names) if (name.toLowerCase().includes(wanted)) return bundleId;
    throw new ActionFailedError(`no installed app named "${app}"`, {
      details: { hint: 'listApps shows installed apps as "Name (bundle.id)"' },
    });
  }
}

function toNode(n: WireNode): SnapshotNode {
  return {
    ref: n.ref,
    type: n.type,
    role: n.type,
    label: n.label,
    value: n.value,
    identifier: n.identifier,
    ...(n.enabled === false ? { enabled: false } : { enabled: true }),
    ...(n.selected ? { selected: true } : {}),
    ...(n.focused ? { focused: true } : {}),
    ...(n.blocked ? { interactionBlocked: n.blocked } : {}),
    rect: n.rect,
  };
}

/**
 * Backend for an iOS simulator, driven by phone-use's own XCTest runner. The
 * runner is built on first use (cached per Xcode version) and kept running
 * between processes; pass the simulator `udid` explicitly.
 */
export function createXctestBackend(
  options: XctestBackendOptions,
): BaseDeviceBackend & { readonly udid: string } {
  if (!options?.udid) {
    throw new DeviceNotFoundError('the xctest backend needs a simulator udid', {
      details: { hint: 'use ios.launch() / ios.connect(), or pass { udid }' },
    });
  }
  return new XctestBackend(options);
}

/** Stop the phone-use runner on a simulator (it otherwise keeps running for reuse). */
export function stopXctestRunner(udid: string, opts?: EnsureRunnerOptions): boolean {
  return stopRunner(udid, opts);
}

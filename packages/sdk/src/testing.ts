import { BaseDeviceBackend } from './backend.ts';
import type {
  AlertAction,
  BackendAlertResult,
  Capability,
  OpenAppResult,
  PressTarget,
  Rect,
  ScrollDirection,
  Snapshot,
  SnapshotNode,
} from './device.ts';
import { ALL_CAPABILITIES } from './device.ts';

/** One scripted screen in a {@link FakeBackend} sequence (alias of Snapshot). */
export type FakeScreen = Snapshot;
/** A recorded backend call: method name plus the arguments it received. */
export type FakeCall = { method: string; args: unknown[] };

/**
 * The device-free test double — runs anywhere, no simulator needed.
 * Scripts a sequence of snapshot "screens"; records
 * every call; lets tests simulate screen transitions per action. Zero deps,
 * Node-only. Public via the `@phone-use/sdk/testing` subpath so harness tests
 * and third-party backend authors share it.
 */
export class FakeBackend extends BaseDeviceBackend {
  /** Every backend call made, in order. */
  readonly calls: FakeCall[] = [];
  private screens: FakeScreen[];
  private current = 0;
  private readonly onAction: ((call: FakeCall, current: number) => number | undefined) | undefined;
  private readonly failWith: ((call: FakeCall) => unknown) | undefined;

  constructor(opts: {
    screens: FakeScreen[];
    name?: string;
    capabilities?: Iterable<Capability>;
    /** Return a new screen index to simulate a transition caused by the call. */
    onAction?: (call: FakeCall, current: number) => number | undefined;
    /** Throw for matching calls — return the error to throw, undefined to pass. */
    failWith?: (call: FakeCall) => unknown;
  }) {
    super(opts.name ?? 'fake', opts.capabilities ?? ALL_CAPABILITIES);
    if (!opts.screens.length) throw new Error('FakeBackend needs at least one screen');
    this.screens = opts.screens;
    this.onAction = opts.onAction;
    this.failWith = opts.failWith;
  }

  /** Jump to screen `i` (throws when out of range). */
  setScreen(i: number): void {
    if (i < 0 || i >= this.screens.length) throw new Error(`no screen ${i}`);
    this.current = i;
  }

  /** Index of the screen currently being served. */
  get screenIndex(): number {
    return this.current;
  }

  private record(method: string, ...args: unknown[]): FakeCall {
    const call: FakeCall = { method, args };
    this.calls.push(call);
    const err = this.failWith?.(call);
    if (err !== undefined) throw err;
    const next = this.onAction?.(call, this.current);
    if (next !== undefined) this.setScreen(next);
    return call;
  }

  override snapshot(opts?: {
    interactiveOnly?: boolean | undefined;
    depth?: number | undefined;
  }): Promise<Snapshot> {
    this.record('snapshot', opts);
    return Promise.resolve(this.screens[this.current]!);
  }

  override screenshot(opts: { path: string; overlayRefs?: boolean | undefined }): Promise<{ path: string }> {
    this.record('screenshot', opts);
    return Promise.resolve({ path: opts.path }); // records; writes nothing
  }

  override press(target: PressTarget): Promise<void> {
    this.record('press', target);
    return Promise.resolve();
  }

  override longPress(ref: string, durationMs?: number): Promise<void> {
    this.record('longPress', ref, durationMs);
    return Promise.resolve();
  }

  override fill(ref: string, text: string): Promise<void> {
    this.record('fill', ref, text);
    return Promise.resolve();
  }

  override typeText(text: string): Promise<void> {
    this.record('typeText', text);
    return Promise.resolve();
  }

  override pressKey(key: 'return'): Promise<void> {
    this.record('pressKey', key);
    return Promise.resolve();
  }

  override scroll(direction: ScrollDirection): Promise<void> {
    this.record('scroll', direction);
    return Promise.resolve();
  }

  override pan(x: number, y: number, dx: number, dy: number, durationMs?: number): Promise<void> {
    this.record('pan', x, y, dx, dy, durationMs);
    return Promise.resolve();
  }

  override waitForText(text: string, timeoutMs?: number): Promise<void> {
    this.record('waitForText', text, timeoutMs);
    return Promise.resolve();
  }

  override systemAlert(action: AlertAction): Promise<BackendAlertResult> {
    this.record('systemAlert', action);
    return Promise.resolve({ alert: null });
  }

  override home(): Promise<void> {
    this.record('home');
    return Promise.resolve();
  }

  override back(): Promise<void> {
    this.record('back');
    return Promise.resolve();
  }

  override openApp(opts: {
    app?: string | undefined;
    url?: string | undefined;
    relaunch?: boolean | undefined;
  }): Promise<OpenAppResult> {
    this.record('openApp', opts);
    const s = this.screens[this.current]!;
    return Promise.resolve({ appName: s.appName, appBundleId: s.appBundleId });
  }

  override listApps(): Promise<string[]> {
    this.record('listApps');
    return Promise.resolve([]);
  }

  override closeSession(): Promise<void> {
    this.record('closeSession');
    return Promise.resolve();
  }
}

const DEFAULT_RECT: Rect = { x: 0, y: 100, width: 390, height: 44 };

/** Fixture sugar: an element with sane defaults (Button role, on-screen rect). */
export function el(partial: Partial<SnapshotNode> & { ref: string }): SnapshotNode {
  return { type: 'Button', label: '', rect: { ...DEFAULT_RECT }, ...partial };
}

/** Fixture sugar: a screen with an Application root so viewport detection works. */
export function screen(
  nodes: SnapshotNode[],
  app: { appName?: string | undefined; appBundleId?: string | undefined } = {},
): FakeScreen {
  const root: SnapshotNode = { type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } };
  return { nodes: [root, ...nodes], appName: app.appName, appBundleId: app.appBundleId };
}

export type { ExecOptions, ExecResult, ExecRunner } from './exec.ts';

/** One step in a {@link scriptedExecRunner} script — what the next exec call gets. */
export type ScriptedExecStep = {
  /** Optional argv guard — the step throws if the call doesn't match. */
  expectArgs?: ((file: string, args: string[]) => boolean) | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
  /** Nonzero → the call rejects with an execFile-shaped error. */
  code?: number | undefined;
  /** Simulate a runner timeout kill. */
  killed?: boolean | undefined;
};

/** The runner {@link scriptedExecRunner} returns: an ExecRunner plus call inspection. */
export type ScriptedExecRunner = import('./exec.ts').ExecRunner & {
  /** Every exec call made, in order. */
  calls: { file: string; args: string[] }[];
  /** Steps not yet consumed (assert 0 at test end for full-sequence checks). */
  remaining(): number;
};

/**
 * The DI'd process runner for lifecycle tests (the injectable counterpart to
 * defaultExecRunner). Takes an ordered script of steps; each call consumes the
 * next step, optionally asserting the argv shape, and resolves/rejects in the
 * execFile-error shape defaultExecRunner produces.
 */
export function scriptedExecRunner(steps: ScriptedExecStep[]): ScriptedExecRunner {
  const queue = [...steps];
  const calls: { file: string; args: string[] }[] = [];
  const runner = (async (file: string, args: string[]) => {
    calls.push({ file, args: [...args] });
    const step = queue.shift();
    if (!step) throw new Error(`scriptedExecRunner: unexpected call ${file} ${args.join(' ')}`);
    if (step.expectArgs && !step.expectArgs(file, args)) {
      throw new Error(`scriptedExecRunner: argv mismatch for ${file} ${args.join(' ')}`);
    }
    if (step.code !== undefined && step.code !== 0) {
      const err = new Error(`Command failed: ${file} ${args.join(' ')}\n${step.stderr ?? ''}`) as Error & {
        code: number;
        stdout: string;
        stderr: string;
        killed: boolean;
      };
      err.code = step.code;
      err.stdout = step.stdout ?? '';
      err.stderr = step.stderr ?? '';
      err.killed = step.killed ?? false;
      throw err;
    }
    if (step.killed) {
      const err = new Error(`Command killed: ${file}`) as Error & { killed: boolean; signal: string };
      err.killed = true;
      err.signal = 'SIGTERM';
      throw err;
    }
    return { stdout: step.stdout ?? '', stderr: step.stderr ?? '' };
  }) as ScriptedExecRunner;
  runner.calls = calls;
  runner.remaining = () => queue.length;
  return runner;
}

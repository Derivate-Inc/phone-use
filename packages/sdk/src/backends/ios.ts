import { appleEnv } from '../apple.ts';
import { BaseDeviceBackend, type DeviceBackend } from '../backend.ts';
import { ActionFailedError, DeviceNotFoundError, TimeoutError, toPhoneUseError } from '../errors.ts';
import { defaultExecRunner, type ExecRunner, isExecError } from '../exec.ts';
import { createDeviceHandle, type Device } from '../lifecycle.ts';
import { stopRunner } from './ios-runner.ts';
import { createXctestBackend } from './xctest.ts';

// ---------------------------------------------------------------------------
// The iOS engine (engine-as-object): ios.launch() creates
// and boots a DEDICATED simulator via simctl — no more "whatever is booted" —
// and returns a Device whose backend is pinned to that udid. ios.connect()
// reattaches; its no-arg form is the sole survivor of the old booted-sim
// auto-detect. Scripts never branch on locality: connect(endpoint) for cloud
// devices is reserved API — local-only for now.
//
// Created sims are named `phone-use-<hex>` deliberately: if a process is
// kill -9'd, the in-process reaper can't run, and the name prefix is how
// orphans are found (`xcrun simctl list devices -j` | filter the prefix).
// ---------------------------------------------------------------------------

type CommonIosOptions = {
  /**
   * Custom simulator device set directory (maps to `simctl --set`). Lifecycle
   * only: xcodebuild cannot run the XCTest runner on a custom set, so a device
   * created there can be booted and closed but not driven.
   */
  simulatorDeviceSet?: string | undefined;
  /** Stop another tool's XCTest runner found on the simulator instead of failing. */
  takeover?: boolean | undefined;
  /** @internal test seam — supplies the backend instead of the XCTest runner. */
  backendFactory?: ((udid: string) => DeviceBackend) | undefined;
  /** Idle lease window in ms (false disables). Default 180_000 (3 min). */
  idleTimeoutMs?: number | false | undefined;
  /** Observer for reaper-initiated closes. */
  onIdleClose?: ((device: Device) => void) | undefined;
  /** Initial %name% secret values (see Device.secrets). */
  secrets?: Record<string, string> | undefined;
  /** @internal harness seam — supplies the verb core (see createDeviceHandle). */
  coreFactory?:
    | ((backend: import('../backend.ts').DeviceBackend) => import('../observe.ts').DeviceCore)
    | undefined;
  /**
   * Start the XCTest runner right away (one listApps) so a broken toolchain
   * fails at launch instead of on first use. Default false: the runner starts
   * lazily on the first verb.
   */
  failFast?: boolean | undefined;
  /** @internal test seam — DI'd process runner. */
  exec?: ExecRunner | undefined;
};

/** Options for `ios.launch()` — device type, runtime, name, boot ceiling. */
export type IosLaunchOptions = CommonIosOptions & {
  /** simctl device type, e.g. "iPhone 16" (the default). */
  deviceType?: string | undefined;
  /** simctl runtime id; omitted → newest compatible. */
  runtime?: string | undefined;
  /** Simulator name; default `phone-use-<hex>` (the orphan-discovery prefix). */
  name?: string | undefined;
  /** Boot wait ceiling for `simctl bootstatus` (default 120_000 ms). */
  bootTimeoutMs?: number | undefined;
};

/** Options for `ios.connect()`. */
export type IosConnectOptions = CommonIosOptions & {
  /** Boot wait ceiling when connect has to boot a shut-down sim (default 120_000 ms). */
  bootTimeoutMs?: number | undefined;
};

const UDID_RE = /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;

type SimctlDeviceRow = { udid: string; state: string; name?: string; isAvailable?: boolean };
type SimctlList = { devices: Record<string, SimctlDeviceRow[]> };

function simctlArgs(setPath: string | undefined, args: string[]): string[] {
  return setPath === undefined ? ['simctl', ...args] : ['simctl', '--set', setPath, ...args];
}

// Exit 149 = "operation not allowed in current state" (already booted /
// already shut down). Code first, stderr regex as fallback — Apple rewords
// messages; the numeric code is the stable signal.
function isAlreadyInState(err: unknown): boolean {
  if (!isExecError(err)) return false;
  if (err.code === 149) return true;
  return /current state.*(Booted|Shutdown)/i.test(err.stderr ?? '');
}

async function runSimctl(
  exec: ExecRunner,
  setPath: string | undefined,
  args: string[],
  opts: { timeoutMs?: number | undefined; tolerateState?: boolean | undefined } = {},
): Promise<string> {
  try {
    const r = await exec('xcrun', simctlArgs(setPath, args), {
      env: appleEnv(),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
    return r.stdout;
  } catch (err) {
    if (opts.tolerateState && isAlreadyInState(err)) return '';
    if (isExecError(err)) {
      if (err.killed || err.signal) {
        throw new TimeoutError(
          `simctl ${args[0]} timed out${opts.timeoutMs ? ` after ${opts.timeoutMs}ms` : ''}`,
          {
            cause: err,
          },
        );
      }
      throw new ActionFailedError(
        `simctl ${args[0]} failed (exit ${String(err.code ?? '?')}): ${(err.stderr ?? err.message).trim()}`,
        { details: { backendCode: String(err.code ?? 'EXEC') }, cause: err },
      );
    }
    throw toPhoneUseError(err);
  }
}

function parseCreatedUdid(stdout: string): string {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  if (!UDID_RE.test(last)) {
    throw new ActionFailedError(
      `could not parse udid from simctl create output: ${JSON.stringify(stdout.slice(0, 200))}`,
    );
  }
  return last;
}

function parseList(stdout: string): SimctlDeviceRow[] {
  let parsed: SimctlList;
  try {
    parsed = JSON.parse(stdout) as SimctlList;
  } catch (err) {
    throw new ActionFailedError('could not parse simctl list output as JSON', { cause: err });
  }
  return Object.values(parsed.devices ?? {}).flat();
}

/** A device on a custom simulator set: lifecycle works, every verb is unsupported. */
class UndrivableSimulator extends BaseDeviceBackend {
  constructor() {
    super('xctest', []);
  }
}

function makeBackend(udid: string, opts: CommonIosOptions): DeviceBackend {
  if (opts.backendFactory) return opts.backendFactory(udid);
  // xcodebuild only sees the default device set, so the runner cannot be
  // launched on a simulator in a custom set.
  if (opts.simulatorDeviceSet !== undefined) return new UndrivableSimulator();
  return createXctestBackend({ udid, ...(opts.takeover === undefined ? {} : { takeover: opts.takeover }) });
}

async function bootAndWait(
  exec: ExecRunner,
  setPath: string | undefined,
  udid: string,
  bootTimeoutMs: number,
): Promise<void> {
  await runSimctl(exec, setPath, ['boot', udid], { tolerateState: true });
  // -b boots if needed, closing the boot/bootstatus race; blocks until booted.
  await runSimctl(exec, setPath, ['bootstatus', udid, '-b'], { timeoutMs: bootTimeoutMs });
}

async function finishHandle(
  udid: string,
  name: string | undefined,
  createdByUs: boolean,
  opts: CommonIosOptions,
  exec: ExecRunner,
): Promise<Device> {
  const backend = makeBackend(udid, opts);
  if (opts.failFast) await backend.listApps();
  return createDeviceHandle({
    id: udid,
    platform: 'ios',
    name,
    backend,
    createdByUs,
    idleTimeoutMs: opts.idleTimeoutMs,
    onIdleClose: opts.onIdleClose,
    secrets: opts.secrets,
    coreFactory: opts.coreFactory,
    doClose: async () => {
      stopRunner(udid);
      await runSimctl(exec, opts.simulatorDeviceSet, ['shutdown', udid], { tolerateState: true });
      if (createdByUs) await runSimctl(exec, opts.simulatorDeviceSet, ['delete', udid]);
    },
  });
}

/**
 * Create and boot a DEDICATED simulator via simctl — no more "whatever is
 * booted" — and return a {@link Device} pinned to its udid. Created sims are
 * named `phone-use-<hex>` deliberately: if the process is kill -9'd the
 * in-process reaper can't run, and the name prefix is how orphans are found.
 * `close()` shuts the sim down AND deletes it (we created it); a failed boot
 * best-effort-deletes before rethrowing.
 */
async function launch(options: IosLaunchOptions = {}): Promise<Device> {
  const exec = options.exec ?? defaultExecRunner;
  const deviceType = options.deviceType ?? 'iPhone 16';
  const name = options.name ?? `phone-use-${Math.random().toString(16).slice(2, 10)}`;
  const bootTimeoutMs = options.bootTimeoutMs ?? 120_000;

  const createArgs = [
    'create',
    name,
    deviceType,
    ...(options.runtime === undefined ? [] : [options.runtime]),
  ];
  const udid = parseCreatedUdid(await runSimctl(exec, options.simulatorDeviceSet, createArgs));

  try {
    await bootAndWait(exec, options.simulatorDeviceSet, udid, bootTimeoutMs);
  } catch (err) {
    // We created it and it never booted — best-effort delete so the failure
    // doesn't leak a sim, then rethrow the original error.
    await runSimctl(exec, options.simulatorDeviceSet, ['delete', udid]).catch(() => undefined);
    throw err;
  }

  return finishHandle(udid, name, true, options, exec);
}

/**
 * Reattach to an existing simulator by udid (booting it if shut down). The
 * no-arg form is the sole survivor of the old booted-sim auto-detect: it
 * attaches to the first booted, available sim. `close()` on a connected
 * device shuts it down but never deletes it.
 */
async function connect(udid?: string, options: IosConnectOptions = {}): Promise<Device> {
  const exec = options.exec ?? defaultExecRunner;
  const bootTimeoutMs = options.bootTimeoutMs ?? 120_000;

  if (udid === undefined) {
    // The surviving auto-detect: attach to the first booted, available sim.
    const rows = parseList(
      await runSimctl(exec, options.simulatorDeviceSet, ['list', 'devices', 'booted', '-j']),
    );
    const booted = rows.find((d) => d.state === 'Booted' && d.isAvailable !== false);
    if (!booted) throw new DeviceNotFoundError('no booted simulator — use ios.launch() or boot one');
    return finishHandle(booted.udid, booted.name, false, options, exec);
  }

  const rows = parseList(await runSimctl(exec, options.simulatorDeviceSet, ['list', 'devices', '-j']));
  const row = rows.find((d) => d.udid.toLowerCase() === udid.toLowerCase());
  if (!row) throw new DeviceNotFoundError(`no simulator with udid ${udid}`);
  if (row.state !== 'Booted') await bootAndWait(exec, options.simulatorDeviceSet, row.udid, bootTimeoutMs);
  return finishHandle(row.udid, row.name, false, options, exec);
}

/**
 * The iOS engine object (Playwright-style): `ios.launch()` for a dedicated
 * simulator, `ios.connect()` to reattach. Both return the same Device type.
 */
export const ios = {
  /** Create + boot a dedicated simulator and return a Device pinned to it. */
  launch,
  /** Reattach to an existing simulator (no-arg: first booted sim). */
  connect,
} as const;

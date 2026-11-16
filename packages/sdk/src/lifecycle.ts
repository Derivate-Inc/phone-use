import {
  type Action,
  type ActionResult,
  type ActOptions,
  buildObserveResult,
  type ElementQuery,
  executeAction,
  type ObserveResult,
} from './actions.ts';
import type { DeviceBackend } from './backend.ts';
import type { Capability, ScrollDirection } from './device.ts';
import { SessionNotFoundError } from './errors.ts';
import { DeviceCore } from './observe.ts';
import { SecretStore } from './secrets.ts';

/** The platform a {@link Device} runs on. */
export type DevicePlatform = 'ios' | 'android';
/** Lifecycle state of a {@link Device} handle. */
export type DeviceStatus = 'running' | 'closed';

/**
 * The Device lifecycle handle: id, pinned backend, close/dispose, idle lease +
 * reaper — plus the action verb surface layered onto the same type.
 * `ios.launch()`/`ios.connect()` and `android.launch()`/`android.connect()`
 * all return it, built over `createDeviceHandle`.
 */
export interface Device {
  /** udid (iOS) / serial (Android). */
  readonly id: string;
  /** Which platform this device runs. */
  readonly platform: DevicePlatform;
  /** Simulator/device name when known. */
  readonly name?: string | undefined;
  /** Name of the backend driving this device. */
  readonly backendName: string;
  /** The backend's declared capability set. */
  readonly capabilities: ReadonlySet<Capability>;
  /**
   * The pinned backend — `new DeviceContext(device.backend)` works today.
   * Backend calls through this handle count as activity for the idle lease.
   */
  readonly backend: DeviceBackend;
  /** true when launch() created the device — close() then also deletes it. */
  readonly createdByUs: boolean;
  /** Current lifecycle state. */
  readonly status: DeviceStatus;
  /** Sugar for `status === 'closed'`. */
  readonly isClosed: boolean;
  /** Re-arm the idle lease (ms overrides the configured window for this arm only). */
  extendLease(ms?: number): void;
  /** Canonical, idempotent shutdown. `await using` is sugar over this. */
  close(): Promise<void>;
  /** `await using` support — delegates to {@link Device.close}. */
  [Symbol.asyncDispose](): Promise<void>;

  // --- the action surface: flat hot path ------------------------------------
  /** Look at the screen: elements + rendered text + portable Action[]. */
  observe(opts?: { signal?: AbortSignal | undefined }): Promise<ObserveResult>;
  /** Tap by label/id query. Auto-waits; never throws for normal outcomes. */
  tap(target: string | ElementQuery, opts?: ActOptions): Promise<ActionResult>;
  /** Type text (optionally into a field resolved by query); %name% secrets substituted. */
  type(
    text: string,
    opts?: ActOptions & { field?: string | ElementQuery | undefined; submit?: boolean | undefined },
  ): Promise<ActionResult>;
  /** Execute a portable Action deterministically — no re-inference. */
  act(action: Action, opts?: ActOptions): Promise<ActionResult>;

  // --- grouped breadth -------------------------------------------------------
  /** App management: open by name/deep link, list installed, current app. */
  readonly apps: {
    /** Open an app by name/bundle id, or a deep link when `url` is set. */
    open(
      app: string,
      opts?: { relaunch?: boolean | undefined; url?: string | undefined; signal?: AbortSignal | undefined },
    ): Promise<ActionResult>;
    /** List installed app bundle ids. */
    list(opts?: { signal?: AbortSignal | undefined }): Promise<string[]>;
    /** The frontmost app name from the last observation (no new snapshot). */
    current(): string | undefined;
  };
  /** Screen-level verbs: scroll, screenshot, waitForText, alert, back, home. */
  readonly screen: {
    /** Scroll the active scroll view one step. */
    scroll(direction: ScrollDirection, opts?: { signal?: AbortSignal | undefined }): Promise<ActionResult>;
    /** Save a screenshot to `path`. */
    screenshot(opts: {
      path: string;
      signal?: AbortSignal | undefined;
    }): Promise<{ success: boolean; message: string; path?: string | undefined }>;
    /** Block until `text` appears on screen or the timeout elapses. */
    waitForText(
      text: string,
      opts?: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined },
    ): Promise<ActionResult>;
    /** Read ('get'), accept, or dismiss a blocking system alert. */
    alert(
      action: 'get' | 'accept' | 'dismiss',
      opts?: { signal?: AbortSignal | undefined },
    ): Promise<ActionResult>;
    /** Navigate back. */
    back(opts?: { signal?: AbortSignal | undefined }): Promise<ActionResult>;
    /** Go to the home screen. */
    home(opts?: { signal?: AbortSignal | undefined }): Promise<ActionResult>;
  };
  /** %name% secret store — values substituted at execution, redacted everywhere else. */
  readonly secrets: SecretStore;
}

// The idle lease: an unref'd timer, so a LEAKED handle can never hold the
// process open — and on expiry the reaper closes the device, so a leaked
// handle can't poison the host with an orphaned booted sim either (the
// bench-hang failure mode). Limits, honestly: this protects in-process leaks
// only; a kill -9'd process orphans the sim until external cleanup — created
// sims carry the `phone-use-` name prefix precisely so
// `xcrun simctl list devices -j` can find and delete them.
export class IdleLease {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly windowMs: number | false;
  private readonly onExpire: () => void;

  constructor(windowMs: number | false, onExpire: () => void) {
    this.windowMs = windowMs;
    this.onExpire = onExpire;
    this.touch();
  }

  /** Re-arm with the configured window (no-op when disabled). */
  touch(): void {
    this.arm(this.windowMs);
  }

  /** Re-arm with a one-shot override window. */
  extend(ms?: number): void {
    this.arm(ms ?? this.windowMs);
  }

  private arm(ms: number | false): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (ms === false) return;
    const t = setTimeout(this.onExpire, ms);
    // Fake-timer objects may lack unref — guard, don't crash.
    t.unref?.();
    this.timer = t;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Inputs to {@link createDeviceHandle} — what an engine supplies per device. */
export type CreateDeviceHandleOptions = {
  /** udid (iOS) / serial (Android). */
  id: string;
  /** Which platform the device runs. */
  platform: DevicePlatform;
  /** Simulator/device name when known. */
  name?: string | undefined;
  /** The backend pinned to this device. */
  backend: DeviceBackend;
  /** true when the engine created the device (close() then also deletes it). */
  createdByUs: boolean;
  /** Idle window in ms; false disables the lease. Default 180_000 (3m). */
  idleTimeoutMs?: number | false | undefined;
  /** Observer for reaper-initiated closes (the SDK never logs). */
  onIdleClose?: ((device: Device) => void) | undefined;
  /** Initial %name% secret values. */
  secrets?: Record<string, string> | undefined;
  /** @internal harness seam — supplies the verb core (DeviceContext extends DeviceCore). */
  coreFactory?: ((backend: DeviceBackend) => DeviceCore) | undefined;
  /** Platform teardown: shutdown (+ delete when createdByUs). */
  doClose: () => Promise<void>;
};

/**
 * Assemble a Device handle over a backend: lease/reaper, verb surface,
 * close/dispose semantics. Engine authors (ios and android here,
 * phone-backend-* third parties) build on this; tests fabricate devices with
 * it over a FakeBackend.
 */
export function createDeviceHandle(opts: CreateDeviceHandleOptions): Device {
  let status: DeviceStatus = 'running';
  let closePromise: Promise<void> | null = null;

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      status = 'closed';
      lease.dispose();
      // Best-effort session close; a session may never have opened (backends
      // start lazily), so swallow the not-found case.
      await opts.backend.closeSession().catch(() => undefined);
      await opts.doClose();
    })();
    return closePromise;
  };

  const lease = new IdleLease(opts.idleTimeoutMs ?? 180_000, () => {
    void close()
      .catch(() => undefined)
      .then(() => opts.onIdleClose?.(device));
  });

  // Backend calls through the handle count as lease activity — without this,
  // a long bench run driving DeviceContext(device.backend) would be reaped
  // mid-run, recreating the exact hazard the lease exists to prevent.
  const touchingBackend = new Proxy(opts.backend, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (status === 'running') lease.touch();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });

  // The verb surface drives its own DeviceCore over the lease-touching proxy,
  // so every verb call counts as activity. One brain: all logic lives in
  // DeviceCore + executeAction; the Device only wires them together.
  const core = opts.coreFactory?.(touchingBackend) ?? new DeviceCore(touchingBackend);
  const secrets = new SecretStore(opts.secrets);

  const assertOpen = (): void => {
    if (status === 'closed') throw new SessionNotFoundError(`device ${opts.id} is closed`);
  };

  const toQuery = (target: string | ElementQuery): ElementQuery =>
    typeof target === 'string' ? { label: target } : target;

  const device: Device = {
    id: opts.id,
    platform: opts.platform,
    name: opts.name,
    backendName: opts.backend.backendName,
    capabilities: opts.backend.capabilities,
    backend: touchingBackend,
    createdByUs: opts.createdByUs,
    get status() {
      return status;
    },
    get isClosed() {
      return status === 'closed';
    },
    extendLease(ms?: number) {
      if (status === 'running') lease.extend(ms);
    },
    close,
    [Symbol.asyncDispose]: close,

    observe() {
      assertOpen();
      return buildObserveResult(core, secrets);
    },
    tap(target, actOpts = {}) {
      assertOpen();
      return executeAction(
        core,
        { formatVersion: 0, verb: 'tap', target: toQuery(target) },
        actOpts,
        secrets,
      );
    },
    type(text, actOpts = {}) {
      assertOpen();
      const { field, submit, ...rest } = actOpts;
      const action: Action =
        field === undefined
          ? { formatVersion: 0, verb: 'type', params: { text, submit } }
          : { formatVersion: 0, verb: 'fill', target: toQuery(field), params: { text, submit } };
      return executeAction(core, action, rest, secrets);
    },
    act(action, actOpts = {}) {
      assertOpen();
      return executeAction(core, action, actOpts, secrets);
    },

    apps: {
      open(app, o = {}) {
        assertOpen();
        const action: Action =
          o.url === undefined
            ? { formatVersion: 0, verb: 'openApp', params: { app, relaunch: o.relaunch } }
            : { formatVersion: 0, verb: 'openUrl', params: { app, url: o.url } };
        return executeAction(core, action, { signal: o.signal }, secrets);
      },
      list(o = {}) {
        assertOpen();
        void o;
        return core.listApps();
      },
      current() {
        return core.currentApp();
      },
    },
    screen: {
      scroll(direction, o = {}) {
        assertOpen();
        return executeAction(
          core,
          { formatVersion: 0, verb: 'scroll', params: { direction } },
          { signal: o.signal },
          secrets,
        );
      },
      async screenshot(o) {
        assertOpen();
        const path = await core.screenshot(o.path);
        return { success: true, message: `screenshot saved`, path };
      },
      waitForText(text, o = {}) {
        assertOpen();
        return executeAction(
          core,
          { formatVersion: 0, verb: 'waitForText', params: { text } },
          { signal: o.signal, timeoutMs: o.timeoutMs },
          secrets,
        );
      },
      alert(action, o = {}) {
        assertOpen();
        if (action === 'get') {
          return core.handleAlert('get').then((r) => ({
            success: r.present,
            message: r.present ? `alert: ${r.description ?? ''}` : 'no system alert is showing',
          }));
        }
        return executeAction(
          core,
          { formatVersion: 0, verb: 'alert', params: { alertAction: action } },
          { signal: o.signal },
          secrets,
        );
      },
      back(o = {}) {
        assertOpen();
        return executeAction(core, { formatVersion: 0, verb: 'back' }, { signal: o.signal }, secrets);
      },
      home(o = {}) {
        assertOpen();
        return executeAction(core, { formatVersion: 0, verb: 'home' }, { signal: o.signal }, secrets);
      },
    },
    secrets,
  };
  return device;
}

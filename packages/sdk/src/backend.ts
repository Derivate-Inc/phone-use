import type { DeviceConfig } from './config.ts';
import type {
  AlertAction,
  BackendAlertResult,
  Capability,
  Key,
  OpenAppResult,
  PressTarget,
  ScrollDirection,
  ScrollOptions,
  Snapshot,
} from './device.ts';
import { PhoneUseError, UnsupportedCapabilityError } from './errors.ts';

/**
 * The backend contract: a STRUCTURAL interface —
 * any object with these methods is a backend — plus an optional
 * {@link BaseDeviceBackend} class with the plumbing done. Methods reject only
 * with PhoneUseError subclasses; backends normalize their transport's errors
 * at the boundary.
 */
/** What a tap did, when the backend can tell (the iOS runner compares the screen before and after). */
export type PressOutcome = { changed?: boolean | undefined };

/** The transport behind a {@link Device}: one implementation per kind of device (simulator, Android, cloud, mirror). */
export interface DeviceBackend {
  /** Stable backend identifier, e.g. `"xctest"`. */
  readonly backendName: string;
  /** The capabilities this backend actually implements. */
  readonly capabilities: ReadonlySet<Capability>;

  /** Capture the accessibility tree of the frontmost app. */
  snapshot(opts?: { interactiveOnly?: boolean | undefined; depth?: number | undefined }): Promise<Snapshot>;
  /** Save a screenshot to `path` (optionally with `@ref` overlays drawn). */
  screenshot(opts: { path: string; overlayRefs?: boolean | undefined }): Promise<{ path: string }>;
  /** Tap an element ref or raw coordinates. */
  press(target: PressTarget): Promise<void>;
  /** What the last press did, when the backend can tell (optional). */
  pressOutcome?(): PressOutcome | undefined;
  /** Long-press an element ref. */
  longPress(ref: string, durationMs?: number): Promise<void>;
  /** Focus an element and replace its text. */
  fill(ref: string, text: string): Promise<void>;
  /** Type into whatever currently has keyboard focus. */
  typeText(text: string): Promise<void>;
  /** Press one keyboard key. A backend rejects a key it cannot press. */
  pressKey(key: Key): Promise<void>;
  /** Scroll the active scroll view one step. Backends that always return at once ignore `opts`. */
  scroll(direction: ScrollDirection, opts?: ScrollOptions): Promise<void>;
  /** Coordinate drag: touch down at (x,y), move by (dx,dy). Operates picker wheels, sliders, carousels. */
  pan(x: number, y: number, dx: number, dy: number, durationMs?: number): Promise<void>;
  /** Block until `text` appears on screen or the timeout elapses. */
  waitForText(text: string, timeoutMs?: number): Promise<void>;
  /** Read/accept/dismiss the app's own alert via the transport's alert command. */
  systemAlert(action: AlertAction): Promise<BackendAlertResult>;
  /** Go to the home screen. */
  home(): Promise<void>;
  /** Navigate back (hardware back / nav-bar back). */
  back(): Promise<void>;
  /** Open an app by name/bundle id, or a URL (deep link). */
  openApp(opts: {
    app?: string | undefined;
    url?: string | undefined;
    relaunch?: boolean | undefined;
  }): Promise<OpenAppResult>;
  /** List installed app bundle ids. */
  listApps(): Promise<string[]>;
  /** Close the transport session (idempotent; safe when none is open). */
  closeSession(): Promise<void>;
}

/**
 * Optional plumbing base: every method rejects with a typed
 * UnsupportedCapabilityError until overridden. Subclasses declare their
 * capability set and override exactly what they support.
 */
export abstract class BaseDeviceBackend implements DeviceBackend {
  readonly backendName: string;
  readonly capabilities: ReadonlySet<Capability>;

  protected constructor(backendName: string, capabilities: Iterable<Capability>) {
    this.backendName = backendName;
    this.capabilities = new Set(capabilities);
  }

  protected unsupported(capability: Capability): UnsupportedCapabilityError {
    return new UnsupportedCapabilityError({ backend: this.backendName, capability });
  }

  /** Throws UnsupportedCapabilityError unless this backend declares `capability`. */
  requireCapability(capability: Capability): void {
    if (!this.capabilities.has(capability)) throw this.unsupported(capability);
  }

  snapshot(_opts?: { interactiveOnly?: boolean | undefined; depth?: number | undefined }): Promise<Snapshot> {
    return Promise.reject(this.unsupported('snapshot'));
  }
  screenshot(_opts: { path: string; overlayRefs?: boolean | undefined }): Promise<{ path: string }> {
    return Promise.reject(this.unsupported('screenshot'));
  }
  press(_target: PressTarget): Promise<void> {
    return Promise.reject(this.unsupported('press'));
  }
  longPress(_ref: string, _durationMs?: number): Promise<void> {
    return Promise.reject(this.unsupported('longPress'));
  }
  fill(_ref: string, _text: string): Promise<void> {
    return Promise.reject(this.unsupported('fill'));
  }
  typeText(_text: string): Promise<void> {
    return Promise.reject(this.unsupported('type'));
  }
  pressKey(_key: Key): Promise<void> {
    return Promise.reject(this.unsupported('key'));
  }
  scroll(_direction: ScrollDirection, _opts?: ScrollOptions): Promise<void> {
    return Promise.reject(this.unsupported('scroll'));
  }
  pan(_x: number, _y: number, _dx: number, _dy: number, _durationMs?: number): Promise<void> {
    return Promise.reject(this.unsupported('pan'));
  }
  waitForText(_text: string, _timeoutMs?: number): Promise<void> {
    return Promise.reject(this.unsupported('waitForText'));
  }
  systemAlert(_action: AlertAction): Promise<BackendAlertResult> {
    return Promise.reject(this.unsupported('alert'));
  }
  home(): Promise<void> {
    return Promise.reject(this.unsupported('home'));
  }
  back(): Promise<void> {
    return Promise.reject(this.unsupported('back'));
  }
  openApp(_opts: {
    app?: string | undefined;
    url?: string | undefined;
    relaunch?: boolean | undefined;
  }): Promise<OpenAppResult> {
    return Promise.reject(this.unsupported('openApp'));
  }
  listApps(): Promise<string[]> {
    return Promise.reject(this.unsupported('listApps'));
  }
  closeSession(): Promise<void> {
    return Promise.reject(this.unsupported('closeSession'));
  }
}

// ---------------------------------------------------------------------------
// Runtime backend registry (registerBackend + the phone-backend-* naming
// convention). A deliberate module-level Map: this IS the registry — mirrored
// on permissions.ts's documented pattern.
// ---------------------------------------------------------------------------

/** Builds a backend from an optional {@link DeviceConfig}. */
export type BackendFactory = (config?: DeviceConfig) => DeviceBackend | Promise<DeviceBackend>;

const factories = new Map<string, BackendFactory>();

/**
 * Register a backend factory under a unique name (the `phone-backend-*`
 * convention for third parties). Throws if the name is already taken.
 */
export function registerBackend(name: string, factory: BackendFactory): void {
  if (factories.has(name)) {
    throw new PhoneUseError(`backend "${name}" is already registered`, {
      code: 'ACTION_FAILED',
      retryable: false,
    });
  }
  factories.set(name, factory);
}

/** Look up a registered factory by name; throws `BACKEND_NOT_FOUND` if absent. */
export function getBackendFactory(name: string): BackendFactory {
  const factory = factories.get(name);
  if (!factory) {
    throw new PhoneUseError(
      `no backend named "${name}" — registered: ${[...factories.keys()].join(', ') || '(none)'}`,
      {
        code: 'BACKEND_NOT_FOUND',
        retryable: false,
      },
    );
  }
  return factory;
}

/** Names of every registered backend, in registration order. */
export function listBackends(): string[] {
  return [...factories.keys()];
}

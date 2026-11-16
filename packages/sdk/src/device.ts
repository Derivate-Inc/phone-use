// ---------------------------------------------------------------------------
// Shared device types — the SDK's own vocabulary. No backend type appears in
// the public API. Every optional is `| undefined` so
// narrower backend types assign structurally under exactOptionalPropertyTypes.
// ---------------------------------------------------------------------------

/** Element geometry in screen points (same space as screenshot pixels at @1x). */
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * One accessibility-tree node as reported by a backend snapshot, in the SDK's
 * own vocabulary (no backend type in the public API).
 */
export type SnapshotNode = {
  ref?: string | undefined;
  type?: string | undefined;
  role?: string | undefined;
  label?: string | undefined;
  value?: string | undefined;
  identifier?: string | undefined;
  enabled?: boolean | undefined;
  selected?: boolean | undefined;
  focused?: boolean | undefined;
  interactionBlocked?: string | undefined;
  rect?: Rect | undefined;
};

/** One backend snapshot: the node list plus the frontmost app when known. */
export type Snapshot = {
  nodes: SnapshotNode[];
  appName?: string | undefined;
  appBundleId?: string | undefined;
};

/** Scroll gesture direction. */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/** The keyboard keys a backend can press. Text goes through `type`; these are the keys text cannot express. */
export type Key = 'return' | 'tab' | 'backspace' | 'space' | 'escape';
export const KEYS: readonly Key[] = ['return', 'tab', 'backspace', 'space', 'escape'];

/** Options for one scroll step. */
export type ScrollOptions = {
  /**
   * Wait for the screen to stop changing before returning (default true). A
   * scroll-to-find search passes false: the swipe holds still before lifting,
   * so the list is already at rest when the scroll returns.
   */
  settle?: boolean | undefined;
};

/** A press target: an element ref from a snapshot, or raw screen coordinates. */
export type PressTarget = { ref: string } | { x: number; y: number };

/** What to do with a system alert: read it, accept it, or dismiss it. */
export type AlertAction = 'get' | 'accept' | 'dismiss';

/** Raw result of a backend's system-alert command. */
export type BackendAlertResult = {
  alert?:
    | { title?: string | undefined; message?: string | undefined; buttons?: string[] | undefined }
    | null
    | undefined;
  handled?: boolean | undefined;
  button?: string | undefined;
};

/** What a backend reports after opening an app or URL. */
export type OpenAppResult = {
  appName?: string | undefined;
  appBundleId?: string | undefined;
  /** Set when the outcome could not be confirmed (a URL opened, but no app came forward). */
  unverified?: string | undefined;
};

/** A backend feature a caller can query via `backend.capabilities`. */
export type Capability =
  | 'snapshot'
  | 'screenshot'
  | 'press'
  | 'longPress'
  | 'fill'
  | 'type'
  | 'key'
  | 'scroll'
  | 'pan'
  | 'waitForText'
  | 'alert'
  | 'home'
  | 'back'
  | 'openApp'
  | 'openUrl'
  | 'listApps'
  | 'closeSession';

/** Every capability — what a full backend (the iOS XCTest runner) declares. */
export const ALL_CAPABILITIES: readonly Capability[] = [
  'snapshot',
  'screenshot',
  'press',
  'longPress',
  'fill',
  'type',
  'key',
  'scroll',
  'pan',
  'waitForText',
  'alert',
  'home',
  'back',
  'openApp',
  'openUrl',
  'listApps',
  'closeSession',
];

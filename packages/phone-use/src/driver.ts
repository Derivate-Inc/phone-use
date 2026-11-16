// Thin compatibility facade over DeviceContext. All mutable
// state and device logic live in ./device-context.ts; this module keeps every
// pre-seam export with a byte-identical signature, delegating to a lazily
// constructed default context wired to the local iOS XCTest backend. Laziness
// matters: importing this module must not construct a backend (key-free smoke
// tests import the tool surface without a daemon).
import type { Key } from '@phone-use/sdk';
import { createCloudSandboxBackend, createDeviceRunnerBackend, createXctestBackend } from '@phone-use/sdk';
import { createAndroidBackend } from './android/backend.ts';
import type {
  ActionEvidence,
  AlertOutcome,
  CursorFrame,
  LiveState,
  Observation,
  Resolution,
  ResolveOpts,
  UiElement,
} from './device-context.ts';
import { DeviceContext } from './device-context.ts';
import { currentExecution } from './execution-context.ts';
import { createMirrorBackend } from './mirror/backend.ts';
import { isConfigDefault } from './settings.ts';

const slot: { ctx: DeviceContext | null } = { ctx: null };

/**
 * Pick the backend kind for an environment. Precedence: an explicitly
 * exported PHONE_USE_DEVICE (mirror/android) wins, then a cloud sandbox
 * (PHONE_USE_SANDBOX_URL — printed by `phone-use env <id>`, which names ONE
 * specific phone and so outranks a device TYPE that only defaulted in from
 * config.json), then a config-defaulted device type, then an on-device
 * runner (PHONE_USE_RUNNER_URL), then the local simulator via our XCTest
 * runner — pinned by a udid in PHONE_USE_DEVICE, otherwise the one booted
 * simulator (it refuses to guess when several are booted).
 */
export function selectBackendKind(
  env: Record<string, string | undefined>,
  deviceIsConfigDefault: boolean,
): 'mirror' | 'android' | 'sandbox' | 'runner' | 'local' {
  const device =
    env.PHONE_USE_DEVICE === 'mirror' || env.PHONE_USE_DEVICE === 'android'
      ? env.PHONE_USE_DEVICE
      : undefined;
  if (device && !(deviceIsConfigDefault && env.PHONE_USE_SANDBOX_URL)) return device;
  if (env.PHONE_USE_SANDBOX_URL) return 'sandbox';
  if (device) return device;
  if (env.PHONE_USE_RUNNER_URL) return 'runner';
  return 'local';
}

const UDID_RE = /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;

/** A udid named in PHONE_USE_DEVICE, else "the one booted simulator". */
function localSimulatorUdid(spec: string | undefined): string {
  return spec && UDID_RE.test(spec) ? spec : 'booted';
}

/** The process-default DeviceContext, created on first use. */
export function defaultDeviceContext(): DeviceContext {
  const scoped = currentExecution();
  if (scoped) return scoped.device;
  const kind = selectBackendKind(process.env, isConfigDefault('PHONE_USE_DEVICE'));
  slot.ctx ??= new DeviceContext(
    kind === 'mirror'
      ? createMirrorBackend()
      : kind === 'android'
        ? createAndroidBackend()
        : kind === 'sandbox'
          ? createCloudSandboxBackend()
          : kind === 'runner'
            ? createDeviceRunnerBackend({
                endpoint: process.env.PHONE_USE_RUNNER_URL as string,
                ...(process.env.PHONE_USE_RUNNER_TOKEN ? { token: process.env.PHONE_USE_RUNNER_TOKEN } : {}),
              })
            : createXctestBackend({ udid: localSimulatorUdid(process.env.PHONE_USE_DEVICE) }),
  );
  return slot.ctx;
}

/** @internal test hook / item-5 rebind seam */
export function setDefaultDeviceContext(ctx: DeviceContext | null): void {
  slot.ctx = ctx;
}

export type {
  ActionEvidence,
  AlertOutcome,
  CursorFrame,
  LiveState,
  Observation,
  Resolution,
  ResolveOpts,
  UiElement,
} from './device-context.ts';
// Pure helpers — stateless, re-exported directly.
export { describeError, labelMatches } from './device-context.ts';

/** Canonical post-action report for LLM tool results. */
export function renderActionResult(
  prefix: string,
  evidence?: ActionEvidence,
  refresh = false,
): Promise<string> {
  return defaultDeviceContext().renderActionResult(prefix, evidence, refresh);
}

/** Render the current cached screen for the LLM (full tree or compact delta). */
export function renderObservation(full = false): string {
  return defaultDeviceContext().renderObservation(full);
}

export function currentElements(): Observation {
  return defaultDeviceContext().currentElements();
}

/** The frontmost app name from the last snapshot. */
export function currentApp(): string | undefined {
  return defaultDeviceContext().currentApp();
}

/** Every node in the current cache, unfiltered (containers included). */
export function allElements(): ReturnType<DeviceContext['allElements']> {
  return defaultDeviceContext().allElements();
}

/** Structured interactive elements from the current cache. */
export function interactiveElements(): UiElement[] {
  return defaultDeviceContext().interactiveElements();
}

/** Editable text inputs from the current cache. */
export function inputFields(includeMultiline = false): UiElement[] {
  return defaultDeviceContext().inputFields(includeMultiline);
}

/** Element resolution ladder: id → exact label → substring → fuzzy, scrolling. */
export function resolveElement(query: string, opts: ResolveOpts = {}): Promise<Resolution> {
  return defaultDeviceContext().resolveElement(query, opts);
}

/** Single best element or null (read paths). */
export function findElement(labelSubstring: string): Promise<UiElement | null> {
  return defaultDeviceContext().findElement(labelSubstring);
}

/** Read a labeled value ("Label, value" rows or Switch values). */
export function readField(labelSubstring: string): Promise<string | null> {
  return defaultDeviceContext().readField(labelSubstring);
}

/** Structural fingerprint of the current screen (stable across dynamic text). */
export function screenSignature(): string {
  return defaultDeviceContext().screenSignature();
}

export function screenTitle(): string {
  return defaultDeviceContext().screenTitle();
}

export function observe(): Promise<Observation> {
  return defaultDeviceContext().observe();
}

export function openApp(app: string, relaunch = false): Promise<string> {
  return defaultDeviceContext().openApp(app, relaunch);
}

/** Deep-link navigation; re-scopes the session when the URL opens another app. */
export function openUrl(url: string, app?: string): Promise<string> {
  return defaultDeviceContext().openUrl(url, app);
}

export function listApps(): Promise<string[]> {
  return defaultDeviceContext().listApps();
}

export function press(ref: string): Promise<ActionEvidence> {
  return defaultDeviceContext().press(ref);
}

/** Open an app and walk its nav stack back to the root. */
export function goToRoot(app: string): Promise<void> {
  return defaultDeviceContext().goToRoot(app);
}

export function viewportHeight(): number {
  return defaultDeviceContext().viewportHeight();
}

/** Vertical span of interactive content in the current cache. */
export function contentBounds(): { minY: number; maxY: number } {
  return defaultDeviceContext().contentBounds();
}

/** Scroll the active scroll view to the top (status-bar tap, gesture fallback). */
export function scrollToTop(): Promise<void> {
  return defaultDeviceContext().scrollToTop();
}

/** Tap an element by label, scrolling it into view first if needed. */
export function tapLabel(label: string): Promise<boolean> {
  return defaultDeviceContext().tapLabel(label);
}

/** What the most recent tap did to the screen (changed / did not / unverified). */
export function lastPressEvidence(): ActionEvidence {
  return defaultDeviceContext().lastPressEvidence();
}

/** Vision-path fallback: tap raw coordinates (@1x points). */
export function pressAt(x: number, y: number): Promise<ActionEvidence> {
  return defaultDeviceContext().pressAt(x, y);
}

/** Set-of-Marks screenshot with @ref labels drawn on the elements. */
export function screenshotWithRefs(path: string): Promise<string> {
  return defaultDeviceContext().screenshotWithRefs(path);
}

/** Crop + magnify a screen region; pressInZoom maps coords back to the screen. */
export function zoomRegion(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  outPath: string,
): Promise<{ path: string; note: string }> {
  return defaultDeviceContext().zoomRegion(x1, y1, x2, y2, outPath);
}

export function pressInZoom(zx: number, zy: number): Promise<ActionEvidence> {
  return defaultDeviceContext().pressInZoom(zx, zy);
}

export function longPress(ref: string, durationMs = 800): Promise<void> {
  return defaultDeviceContext().longPress(ref, durationMs);
}

export function fill(ref: string, text: string): Promise<ActionEvidence> {
  return defaultDeviceContext().fill(ref, text);
}

export function typeText(text: string): Promise<void> {
  return defaultDeviceContext().typeText(text);
}

/** Press the keyboard's return/go key. */
export function pressKey(key: Key): Promise<void> {
  return defaultDeviceContext().pressKey(key);
}

export function pressReturn(): Promise<void> {
  return defaultDeviceContext().pressReturn();
}

export function scroll(direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {
  return defaultDeviceContext().scroll(direction);
}

/** Coordinate drag — picker wheels, sliders, carousels (same space as observe rects). */
export function pan(x: number, y: number, dx: number, dy: number, durationMs?: number): Promise<void> {
  return defaultDeviceContext().pan(x, y, dx, dy, durationMs);
}

export function waitForText(text: string, timeoutMs = 5000): Promise<string> {
  return defaultDeviceContext().waitForText(text, timeoutMs);
}

/** Detect/accept/dismiss a blocking system dialog. */
export function handleAlert(action: 'get' | 'accept' | 'dismiss'): Promise<AlertOutcome> {
  return defaultDeviceContext().handleAlert(action);
}

/** Clear the launch permission gauntlet; returns the buttons tapped. */
export function clearBlockingAlerts(action: 'accept' | 'dismiss' = 'accept', max = 6): Promise<string[]> {
  return defaultDeviceContext().clearBlockingAlerts(action, max);
}

export function goHome(): Promise<void> {
  return defaultDeviceContext().goHome();
}

export function goBack(): Promise<void> {
  return defaultDeviceContext().goBack();
}

export function screenshot(path: string): Promise<string> {
  return defaultDeviceContext().screenshot(path);
}

export function closeSession(): Promise<void> {
  return defaultDeviceContext().closeSession();
}

export function getCursor(): { x: number; y: number } {
  return defaultDeviceContext().getCursor();
}

/** Fast raw JPEG frame via `simctl io screenshot` (live stream path). */
export function captureFastJpeg(): Promise<Buffer | null> {
  return defaultDeviceContext().captureFastJpeg();
}

/** Subscribe to live overlay state; returns an unsubscribe function. */
export function onState(fn: (s: LiveState) => void): () => void {
  return defaultDeviceContext().onState(fn);
}

export function getLiveState(): LiveState {
  return defaultDeviceContext().getLiveState();
}

export function moveCursorToRef(ref: string, outPath: string): Promise<CursorFrame> {
  return defaultDeviceContext().moveCursorToRef(ref, outPath);
}

export function moveCursorToPoint(x: number, y: number, outPath: string): Promise<CursorFrame> {
  return defaultDeviceContext().moveCursorToPoint(x, y, outPath);
}

export function clickCursor(outPath: string): Promise<CursorFrame & { evidence: ActionEvidence }> {
  return defaultDeviceContext().clickCursor(outPath);
}

export function renderCurrentFrame(outPath: string): Promise<string> {
  return defaultDeviceContext().renderCurrentFrame(outPath);
}

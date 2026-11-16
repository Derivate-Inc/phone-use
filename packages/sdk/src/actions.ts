import type { Rect, ScrollDirection } from './device.ts';
import {
  AbortedError,
  ActionFailedError,
  PhoneUseError,
  type PhoneUseErrorCode,
  TimeoutError,
} from './errors.ts';
import {
  CACHE_FRESH_MS,
  type DeviceCore,
  matchInElements,
  type Resolution,
  type ResolveOpts,
  TAPPABLE,
  type UiElement,
} from './observe.ts';
import { SecretStore } from './secrets.ts';

// ---------------------------------------------------------------------------
// The observe→act seam: observe() returns
// portable Action descriptors carrying RE-RESOLVABLE element queries; act()
// re-resolves against the live tree and executes with no re-inference. A
// compiled skill is a stored Action[]. The resolution ladder (DeviceCore) is
// the one query engine — this module contains dispatch, auto-wait, abort, and
// secrets wiring, never matching logic.
//
// Never-throw contract: executeAction returns {success:false,...} for every
// device-legible outcome (not found, ambiguous, wait deadline, gesture
// failure). It throws PhoneUseError subclasses only for infrastructure:
// aborts, closed sessions on non-observe verbs, unsupported capabilities,
// unknown errors.
// ---------------------------------------------------------------------------

/**
 * A RE-RESOLVABLE element query — how a portable {@link Action} names its
 * target. Resolved against the live tree by the resolution ladder at act()
 * time; no stale handles.
 */
export type ElementQuery = {
  /** Label to match (exact → substring → fuzzy, the ladder's rungs). */
  label?: string | undefined;
  /** Accessibility identifier — rung 0 of the ladder, wins when present. */
  id?: string | undefined;
  /** Disambiguator: restrict matches to this role (e.g. "Button"). */
  role?: string | undefined;
  /** Disambiguator: label of another element; pick the geometrically closest match. */
  near?: string | undefined;
};

/** Verbs a portable {@link Action} can carry. */
export type ActionVerb =
  | 'tap'
  | 'longPress'
  | 'fill'
  | 'type'
  | 'pressKey'
  | 'scroll'
  | 'openApp'
  | 'openUrl'
  | 'back'
  | 'home'
  | 'alert'
  | 'waitForText';

/**
 * The observe→act seam: a portable action
 * descriptor carrying a re-resolvable {@link ElementQuery}. `observe()` returns
 * these; `act()` re-resolves against the live tree and executes with no
 * re-inference. A compiled skill is a stored `Action[]`.
 */
export type Action = {
  /** Versioned, documented UNSTABLE pre-1.0. */
  formatVersion: 0;
  /** What to do. */
  verb: ActionVerb;
  /** Target query for element-directed verbs (tap/longPress/fill). */
  target?: ElementQuery | undefined;
  /** Verb parameters (text, direction, app, url, ...). */
  params?:
    | {
        /** fill/type text — may contain %name% secret references. */
        text?: string | undefined;
        direction?: ScrollDirection | undefined;
        app?: string | undefined;
        url?: string | undefined;
        durationMs?: number | undefined;
        key?: 'return' | undefined;
        alertAction?: 'accept' | 'dismiss' | undefined;
        submit?: boolean | undefined;
        relaunch?: boolean | undefined;
      }
    | undefined;
  /**
   * Provenance from observe/record time. ADVISORY ONLY — act() always
   * re-resolves; this exists for traces, drift diagnosis, and human review.
   */
  observed?:
    | {
        via?: string | undefined;
        label?: string | undefined;
        role?: string | undefined;
        rect?: Rect | undefined;
        app?: string | undefined;
        screenTitle?: string | undefined;
      }
    | undefined;
};

/** The stored-Action[] artifact (public TYPE, unstable FORMAT pre-1.0). */
export type CompiledSkill = {
  formatVersion: 0;
  name: string;
  description?: string | undefined;
  params?: string[] | undefined;
  precondition?: string | undefined;
  actions: Action[];
};

/** An interactive element as surfaced by `observe()` (alias of {@link UiElement}). */
export type ObservedElement = UiElement;

/** What `observe()` returns: elements, rendered text, and portable actions. */
export type ObserveResult = {
  /** Always true for a completed observation. */
  success: boolean;
  /** Human-readable summary of the observation. */
  message: string;
  /** Frontmost app name, when known. */
  app?: string | undefined;
  /** Frontmost app bundle id, when known. */
  bundleId?: string | undefined;
  /** Navigation-bar title of the current screen, when present. */
  screenTitle?: string | undefined;
  /** Structured channel (secret-redacted values). */
  elements: ObservedElement[];
  /** Compressed text channel (secret-redacted). */
  rendered: string;
  /** Portable descriptors: a tap per tappable, a fill per input field. */
  actions: Action[];
};

/**
 * Structured outcome of every action verb. Never-throw contract: device-legible
 * failures (not found, ambiguous, wait deadline, gesture failure) come back as
 * `{success: false, ...}`; only infrastructure errors (abort, closed session,
 * unsupported capability) throw PhoneUseError subclasses.
 */
export type ActionResult = {
  /** Did the action execute as intended. */
  success: boolean;
  /** Human-readable outcome (secret-redacted). */
  message: string;
  /** tapAndDiff verdict where applicable: did the screen actually change. */
  changed?: boolean | undefined;
  /** How the target resolved (match provenance, ref, label, role, rect). */
  resolved?: { via: string; ref: string; label: string; role: string; rect?: Rect | undefined } | undefined;
  /** The ambiguity contract, surfaced structurally. */
  candidates?: ObservedElement[] | undefined;
  /** Auto-wait cost when the slow path ran (elapsed ms, poll count). */
  waited?: { ms: number; polls: number } | undefined;
  /** Set on structured failures with an error flavor (e.g. TIMEOUT). */
  code?: PhoneUseErrorCode | undefined;
};

/** Per-call options accepted by every action verb. */
export type ActOptions = {
  /** Abort the call; the in-flight gesture may still land (state indeterminate). */
  signal?: AbortSignal | undefined;
  /** Auto-wait deadline (default 5000 ms). */
  timeoutMs?: number | undefined;
  /** Per-call secret overrides, layered on the device store. */
  vars?: Record<string, string> | undefined;
};

// --- abort plumbing ---------------------------------------------------------

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortedError();
}

/** Race a backend promise against the caller's abort. The abandoned in-flight
 *  call may still land on the device — documented abort semantics (state
 *  indeterminate); no retry follows an abort. */
async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new AbortedError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return raceWithAbort(new Promise<void>((r) => setTimeout(r, ms)), signal);
}

// --- observe-side synthesis ---------------------------------------------------

function queryFor(el: UiElement): ElementQuery {
  return el.id ? { id: el.id } : { label: el.label };
}

function provenance(core: DeviceCore, el: UiElement, via?: string) {
  return {
    ...(via === undefined ? {} : { via }),
    label: el.label,
    role: el.role,
    ...(el.rect === undefined ? {} : { rect: el.rect }),
    ...(core.currentApp() === undefined ? {} : { app: core.currentApp() }),
    ...(core.screenTitle() ? { screenTitle: core.screenTitle() } : {}),
  };
}

/** Synthesize portable actions from the CURRENT cache (observe-time). */
export function toActions(core: DeviceCore): Action[] {
  const actions: Action[] = [];
  for (const el of core.interactiveElements()) {
    const kind = el.role;
    if (TAPPABLE.has(kind)) {
      actions.push({
        formatVersion: 0,
        verb: 'tap',
        target: queryFor(el),
        observed: provenance(core, el, el.id ? 'id' : 'exact label'),
      });
    }
  }
  for (const el of core.inputFields(true)) {
    actions.push({
      formatVersion: 0,
      verb: 'fill',
      target: queryFor(el),
      params: { text: '' },
      observed: provenance(core, el, el.id ? 'id' : 'exact label'),
    });
  }
  return actions;
}

const NO_SECRETS = new SecretStore();

/**
 * Take one fresh snapshot and assemble the full {@link ObserveResult}:
 * deduped element channel, secret-redacted rendered text, and a portable
 * Action per tappable / input field.
 */
export async function buildObserveResult(
  core: DeviceCore,
  secrets: SecretStore = NO_SECRETS,
): Promise<ObserveResult> {
  const obs = await core.observe();
  const redact = (s: string) => secrets.redact(s);
  // Tappables + input fields: one structured element channel (deduped by ref).
  const seen = new Set<string>();
  const elements: ObservedElement[] = [];
  for (const el of [...core.interactiveElements(), ...core.inputFields(true)]) {
    if (seen.has(el.ref)) continue;
    seen.add(el.ref);
    elements.push({
      ...el,
      label: redact(el.label),
      ...(el.value === undefined || el.value === null ? {} : { value: redact(el.value) }),
    });
  }
  return {
    success: true,
    message: elements.length
      ? `observed ${elements.length} interactive elements`
      : obs.elements.slice(0, 120),
    ...(obs.app === undefined ? {} : { app: obs.app }),
    ...(obs.bundleId === undefined ? {} : { bundleId: obs.bundleId }),
    ...(core.screenTitle() ? { screenTitle: core.screenTitle() } : {}),
    elements,
    rendered: redact(core.renderObservation(true)),
    actions: toActions(core),
  };
}

// --- act-side dispatch ---------------------------------------------------------

function toResolveOpts(q: ElementQuery): ResolveOpts {
  return {
    ...(q.role === undefined ? {} : { role: q.role }),
    ...(q.near === undefined ? {} : { near: q.near }),
  };
}

function queryText(q: ElementQuery): string {
  const t = q.id ?? q.label;
  if (t === undefined || t === '') {
    throw new ActionFailedError('action target needs an id or label');
  }
  return t;
}

function isActionable(el: UiElement): boolean {
  return el.enabled !== false && !el.blocked;
}

const POLL_STEPS_MS = [150, 300, 600, 800];

type WaitOutcome =
  | { ok: true; el: UiElement; via: string; waited: { ms: number; polls: number } | undefined }
  | { ok: false; result: ActionResult };

/**
 * Resolve + auto-wait (visible+hittable+enabled+settled on every
 * action, no caller sleep — and it must not double latency).
 * Fast path: a fresh cache resolving to an actionable target executes with
 * ZERO extra snapshots. Slow path: poll in place (never scroll — scrolling is
 * the ladder's job, and polling must not dismiss transient menus) until the
 * target is actionable AND the tree signature is stable between polls.
 */
async function resolveWithWait(
  core: DeviceCore,
  q: ElementQuery,
  opts: ActOptions,
  pool: 'tappable' | 'fields',
): Promise<WaitOutcome> {
  const signal = opts.signal;
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  const text = queryText(q);
  const rOpts = toResolveOpts(q);
  // Tap targets resolve against interactive (tappable) elements; fill targets
  // against input fields — two pools, one matcher (the ladder's rungs).
  const inCache = (): Resolution =>
    pool === 'fields'
      ? matchInElements(core.inputFields(true), text, rOpts)
      : core.resolveInCache(text, rOpts);

  // Fast path: fresh cache + actionable target → go now, zero snapshots.
  if (core.cacheAgeMs() < CACHE_FRESH_MS) {
    const r = inCache();
    if (r.el && isActionable(r.el)) return { ok: true, el: r.el, via: r.via ?? 'cache', waited: undefined };
    if (r.candidates?.length) return { ok: false, result: ambiguityResult(text, r) };
  }

  // Not in the (possibly stale) cache at all. For tappables, run one full
  // ladder pass (scroll search) — not-on-screen is a search problem;
  // not-yet-enabled is a wait problem. Fields skip the scroll ladder (fields
  // live on the current form) and go straight to the poll.
  throwIfAborted(signal);
  let r: Resolution;
  if (pool === 'tappable') {
    r = await raceWithAbort(core.resolveElement(text, rOpts), signal);
  } else {
    await raceWithAbort(core.observe(), signal);
    r = inCache();
  }
  if (!r.el && r.candidates?.length) return { ok: false, result: ambiguityResult(text, r) };
  if (r.el && isActionable(r.el)) return { ok: true, el: r.el, via: r.via ?? 'ladder', waited: undefined };

  // Wait loop: poll in place until actionable + settled, or deadline.
  const started = Date.now();
  let polls = 0;
  let lastSig = core.stateSignature();
  let step = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_STEPS_MS[Math.min(step, POLL_STEPS_MS.length - 1)]!, signal);
    step++;
    polls++;
    throwIfAborted(signal);
    await raceWithAbort(core.observe(), signal);
    const sig = core.stateSignature();
    const settled = sig === lastSig;
    lastSig = sig;
    const rr = inCache();
    if (rr.el && isActionable(rr.el) && settled) {
      return { ok: true, el: rr.el, via: rr.via ?? 'wait', waited: { ms: Date.now() - started, polls } };
    }
    if (!rr.el && rr.candidates?.length) return { ok: false, result: ambiguityResult(text, rr) };
    r = rr;
  }
  return {
    ok: false,
    result: {
      success: false,
      code: 'TIMEOUT',
      message: r.el
        ? `timed out after ${opts.timeoutMs ?? 5000}ms waiting for "${text}" to become enabled/settled`
        : `timed out after ${opts.timeoutMs ?? 5000}ms — no element matching "${text}" on this screen`,
      waited: { ms: Date.now() - started, polls },
    },
  };
}

function ambiguityResult(text: string, r: Resolution): ActionResult {
  const list = (r.candidates ?? [])
    .map(
      (c) => `${c.role} "${c.label}"${c.rect ? ` at (${Math.round(c.rect.x)},${Math.round(c.rect.y)})` : ''}`,
    )
    .join('; ');
  return {
    success: false,
    message: `"${text}" is ambiguous — ${r.candidates?.length ?? 0} matches: ${list}. Disambiguate with role or near.`,
    candidates: r.candidates ?? [],
  };
}

function resolvedOf(el: UiElement, via: string) {
  return {
    via,
    ref: el.ref,
    label: el.label,
    role: el.role,
    ...(el.rect === undefined ? {} : { rect: el.rect }),
  };
}

/**
 * THE dispatcher: resolve → auto-wait → execute → diff. One brain — used by
 * device.tap/type/act, and (items 5-6) by the harness and the skill runner.
 */
export async function executeAction(
  core: DeviceCore,
  action: Action,
  opts: ActOptions = {},
  secrets: SecretStore = NO_SECRETS,
): Promise<ActionResult> {
  const signal = opts.signal;
  throwIfAborted(signal);
  const store = secrets.withOverrides(opts.vars);
  const redact = (s: string) => store.redact(s);

  try {
    switch (action.verb) {
      case 'tap':
      case 'longPress':
      case 'fill': {
        if (!action.target) return { success: false, message: `${action.verb} needs a target query` };
        const wait = await resolveWithWait(
          core,
          action.target,
          opts,
          action.verb === 'fill' ? 'fields' : 'tappable',
        );
        if (!wait.ok) return wait.result;
        const { el, via, waited } = wait;
        if (action.verb === 'longPress') {
          await raceWithAbort(core.longPress(el.ref, action.params?.durationMs), signal);
          return {
            success: true,
            message: redact(`long-pressed "${el.label}"`),
            resolved: resolvedOf(el, via),
            waited,
          };
        }
        if (action.verb === 'fill') {
          const text = store.substitute(action.params?.text ?? '');
          const ev = await raceWithAbort(core.fill(el.ref, text), signal);
          if (action.params?.submit) await raceWithAbort(core.pressReturn(), signal);
          return {
            success: true,
            message: redact(`filled "${el.label}"${action.params?.submit ? ', pressed Return' : ''}`),
            ...(ev.changed === undefined ? {} : { changed: ev.changed }),
            resolved: resolvedOf(el, via),
            waited,
          };
        }
        const ev = await raceWithAbort(core.press(el.ref), signal);
        return {
          success: true,
          message: redact(`tapped "${el.label}"${ev.changed === false ? ' (no change)' : ''}`),
          ...(ev.changed === undefined ? {} : { changed: ev.changed }),
          resolved: resolvedOf(el, via),
          waited,
        };
      }
      case 'type': {
        const text = store.substitute(action.params?.text ?? '');
        await raceWithAbort(core.typeText(text), signal);
        if (action.params?.submit) await raceWithAbort(core.pressReturn(), signal);
        return { success: true, message: redact(`typed ${JSON.stringify(action.params?.text ?? '')}`) };
      }
      case 'pressKey': {
        await raceWithAbort(core.pressReturn(), signal);
        return { success: true, message: 'pressed Return' };
      }
      case 'scroll': {
        const direction = action.params?.direction ?? 'down';
        await raceWithAbort(core.scroll(direction), signal);
        await raceWithAbort(core.observe(), signal);
        return { success: true, message: `scrolled ${direction}` };
      }
      case 'openApp': {
        if (!action.params?.app) return { success: false, message: 'openApp needs params.app' };
        const note = await raceWithAbort(
          core.openApp(action.params.app, action.params.relaunch ?? false),
          signal,
        );
        return { success: true, message: note };
      }
      case 'openUrl': {
        if (!action.params?.url) return { success: false, message: 'openUrl needs params.url' };
        const note = await raceWithAbort(core.openUrl(action.params.url, action.params.app), signal);
        return { success: true, message: note };
      }
      case 'back': {
        await raceWithAbort(core.goBack(), signal);
        return { success: true, message: 'went back' };
      }
      case 'home': {
        await raceWithAbort(core.goHome(), signal);
        return { success: true, message: 'went home' };
      }
      case 'alert': {
        const outcome = await raceWithAbort(core.handleAlert(action.params?.alertAction ?? 'accept'), signal);
        if (!outcome.present) return { success: false, message: 'no system alert is showing' };
        return {
          success: outcome.handled !== false,
          message: `alert ${outcome.handled ? `handled via "${outcome.button}"` : 'NOT handled'}: ${outcome.description ?? ''}`,
        };
      }
      case 'waitForText': {
        if (!action.params?.text) return { success: false, message: 'waitForText needs params.text' };
        const note = await raceWithAbort(
          core.waitForText(action.params.text, opts.timeoutMs ?? 5000),
          signal,
        );
        const ok = !/did not appear|not found|timed out/i.test(note);
        return { success: ok, message: redact(note), ...(ok ? {} : { code: 'TIMEOUT' as const }) };
      }
      default:
        return { success: false, message: `unknown verb ${String((action as { verb?: unknown }).verb)}` };
    }
  } catch (error) {
    // Infrastructure failures propagate; device-legible gesture failures are
    // structured results.
    if (error instanceof AbortedError) throw error;
    if (error instanceof PhoneUseError) {
      if (error instanceof ActionFailedError || error instanceof TimeoutError) {
        return { success: false, message: redact(error.message), code: error.code };
      }
      throw error;
    }
    throw error;
  }
}

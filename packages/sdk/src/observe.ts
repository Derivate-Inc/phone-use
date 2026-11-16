import type { DeviceBackend } from './backend.ts';
import type { Key, Rect, SnapshotNode } from './device.ts';
import { SessionNotFoundError } from './errors.ts';

// ---------------------------------------------------------------------------
// DeviceCore: the one-brain observe/resolve/act core, moved
// verbatim from the harness's DeviceContext. Everything here is portable —
// no runtime-specific globals and no image libraries — so it runs under Node. The
// module level holds only types, pure functions, and read-only lookup tables;
// the harness's DeviceContext subclasses this and layers on cursor/live-view
// rendering.
// ---------------------------------------------------------------------------

/** One compressed observation: the frontmost app plus the rendered element list. */
export type Observation = {
  /** Frontmost app name, when known. */
  app?: string | undefined;
  /** Frontmost app bundle id, when known. */
  bundleId?: string | undefined;
  /** Whether the element list was truncated. */
  truncated: boolean;
  /** The compressed, human/LLM-readable element listing. */
  elements: string;
};

/**
 * Post-action evidence from the driver's verify pass: whether the
 * accessibility tree changed, without paying for a full follow-up snapshot.
 */
export type ActionEvidence = {
  /** Did the tree fingerprint change across the action. */
  changed?: boolean | undefined;
  /** Human-readable verdict detail. */
  detail?: string | undefined;
};

// Raw iOS accessibility trees are unusable for agents on content-heavy screens
// (a full HN page is 485 nodes / ~15k tokens, most of it "|" separators and
// off-screen rows). observe() reduces to what a human sees: on-screen,
// non-noise elements with compact geometry, plus counts for what's off-screen.
const NOISE_LABELS: ReadonlySet<string> = new Set(['|', '(', ')', ',', '·', '•']);

function isNoise(n: SnapshotNode): boolean {
  const kind = n.type ?? n.role ?? '';
  if (!n.label) return false;
  return (kind === 'StaticText' || kind === 'Other') && NOISE_LABELS.has(n.label.trim());
}

function intersectsViewport(rect: Rect | undefined, vw: number, vh: number): boolean {
  if (!rect) return true;
  return rect.x < vw && rect.y < vh && rect.x + rect.width > 0 && rect.y + rect.height > 0;
}

// Longest label/value the renderer emits verbatim. Longer text is cut WITH an
// explicit "[truncated]" marker — a silently shortened value reads as the
// field's full content and sends the model verifying against a phantom.
const RENDER_TEXT_MAX = 160;

function renderText(s: string): string {
  return s.length <= RENDER_TEXT_MAX
    ? JSON.stringify(s)
    : `${JSON.stringify(s.slice(0, RENDER_TEXT_MAX))} [truncated]`;
}

function formatNode(n: SnapshotNode, opts: { suppressFocused: boolean; vw?: number | undefined }): string {
  const role = n.role ?? n.type ?? 'element';
  const ref = n.ref && !n.ref.startsWith('@') ? `@${n.ref}` : (n.ref ?? '');
  const parts = [`${ref} [${role}]`];
  const label = n.label ?? n.identifier;
  if (label) parts.push(renderText(label));
  if (n.value && n.value !== n.label) parts.push(`value=${renderText(n.value)}`);
  if (n.rect)
    parts.push(
      `(${Math.round(n.rect.x)},${Math.round(n.rect.y)} ${Math.round(n.rect.width)}x${Math.round(n.rect.height)})`,
    );
  // Rendered nodes always intersect the viewport, but a carousel/pager item can
  // straddle the edge with its CENTER off-screen horizontally — where a
  // center-targeted tap misses. Say so instead of letting the line imply a
  // normally tappable element.
  if (n.rect && opts.vw !== undefined) {
    const cx = n.rect.x + n.rect.width / 2;
    if (cx < 0 || cx > opts.vw) parts.push('(center off-screen)');
  }
  if (n.enabled === false) parts.push('(disabled)');
  if (n.selected) parts.push('(selected)');
  if (n.focused && !opts.suppressFocused) parts.push('(focused)');
  if (n.interactionBlocked) parts.push(`(blocked: ${n.interactionBlocked})`);
  return parts.join(' ');
}

// The on-screen, non-noise elements plus off-viewport counts — the shared core
// of both the full render (compressNodes) and the delta render.
function keptViewportNodes(nodes: SnapshotNode[]): {
  kept: SnapshotNode[];
  above: number;
  below: number;
  aboveNames: string[];
  belowNames: string[];
  suppressFocused: boolean;
  vw: number;
} {
  const root = nodes.find((n) => (n.type === 'Application' || n.type === 'Window') && n.rect);
  const vw = root?.rect?.width ?? 500;
  const vh = root?.rect?.height ?? 1000;

  // The XCTest tree sometimes marks every node focused — meaningless; only
  // show (focused) when it identifies a minority of elements.
  const focusedCount = nodes.filter((n) => n.focused).length;
  const suppressFocused = focusedCount > nodes.length / 3;

  const kept: SnapshotNode[] = [];
  let above = 0;
  let below = 0;
  // Name the actionable controls hiding off-screen instead of only counting
  // them. Measured failure (AndroidWorld MarkorCreateNote): the create-note
  // FAB sat below the fold, the render said only "[9 elements below]", and the
  // agent burned its whole budget guessing labels (`tap "+"`) for a button it
  // was never told existed. Tappable roles only, capped, so a long list view
  // doesn't flood the render with row labels.
  const aboveNames: string[] = [];
  const belowNames: string[] = [];
  const controlName = (n: SnapshotNode): string | undefined => {
    const role = n.role ?? n.type ?? '';
    if (!TAPPABLE.has(role) || role === 'StaticText' || role === 'Cell') return undefined;
    const label = (n.label ?? n.identifier ?? '').trim();
    return label || undefined;
  };
  for (const n of nodes) {
    if (isNoise(n)) continue;
    if (!intersectsViewport(n.rect, vw, vh)) {
      const name = controlName(n);
      if (n.rect && n.rect.y >= vh) {
        below += 1;
        if (name && belowNames.length < 5 && !belowNames.includes(name)) belowNames.push(name);
      } else {
        above += 1;
        if (name && aboveNames.length < 5 && !aboveNames.includes(name)) aboveNames.push(name);
      }
      continue;
    }
    kept.push(n);
  }
  return { kept, above, below, aboveNames, belowNames, suppressFocused, vw };
}

function compressNodes(nodes: SnapshotNode[]): string {
  const { kept, above, below, aboveNames, belowNames, suppressFocused, vw } = keptViewportNodes(nodes);
  const lines = kept.map((n) => formatNode(n, { suppressFocused, vw }));
  const controls = (names: string[]) =>
    names.length ? ` — controls there: ${names.map((n) => `"${n}"`).join(', ')}` : '';
  if (above > 0)
    lines.unshift(`[${above} elements above the viewport — scroll up to reach them${controls(aboveNames)}]`);
  if (below > 0)
    lines.push(`[${below} elements below the viewport — scroll down to reach them${controls(belowNames)}]`);
  return lines.join('\n');
}

// --- Observation delta rendering (LLM-loop token saver) --------------------
// Re-serializing the whole compressed tree on every observe is the dominant
// token cost of a long agent loop (research brief 3: LLM round-trips are
// 75-94% of task latency). When the screen is structurally identical to the
// last render — same elements, same order, so @refs are unchanged — we emit
// only the value/state changes plus an "unchanged" note instead of the full
// tree. This is SAFE BY CONSTRUCTION: iOS @refs are assigned by traversal
// order, so ANY add/remove/reorder rotates them; we detect that via ordered-
// key equality and fall back to the full tree, which re-establishes valid
// refs. The delta path therefore only fires when refs are provably stable
// (the toggle / settings re-observe case); scrolls and screen changes render
// full. This is a rendering optimization only — the driver's structured
// element accessors (interactiveElements/findElement) are unaffected.

/** The delta renderer's baseline: last rendered app, element keys, and lines. */
export type RenderState = { app?: string | undefined; keys: string[]; lineByKey: Map<string, string> };

// Identity of an element that is stable across a value/state change (so a
// flipped toggle keeps its key) but distinguishes different elements. Value is
// deliberately excluded; the formatted line carries value/state for diffing.
function elementKey(n: SnapshotNode): string {
  const role = n.role ?? n.type ?? 'element';
  const label = (n.label ?? n.identifier ?? '').trim();
  const pos = n.rect ? `${Math.round(n.rect.x)},${Math.round(n.rect.y)}` : '';
  return `${role}|${label}|${pos}`;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A structured interactive element extracted from the snapshot cache. */
export type UiElement = {
  /** Snapshot-scoped element ref (normalized to the `@N` form). */
  ref: string;
  /** Visible label (or accessibility identifier when the label is empty). */
  label: string;
  /** Semantic role, e.g. "Button", "Cell", "Switch". */
  role: string;
  /** Current value ("1"/"0" for switches, field contents, ...). */
  value?: string | undefined;
  /** On-screen geometry when known. */
  rect?: Rect | undefined;
  /** Accessibility identifier when the app exposes one. */
  id?: string | undefined;
  /** false when the element is disabled. */
  enabled?: boolean | undefined;
  /** Reason interaction is blocked, when the tree reports one. */
  blocked?: string | undefined;
};

/**
 * How old the cached screen may be and still be acted on without a fresh read
 * (act()'s fast path and resolveElement's look-first both use it).
 */
export const CACHE_FRESH_MS = 2000;

export const TAPPABLE: ReadonlySet<string> = new Set([
  'Button',
  'Cell',
  'Link',
  'MenuItem',
  'Tab',
  'StaticText',
  'Switch',
]);

const EDITABLE: ReadonlySet<string> = new Set(['SearchField', 'TextField', 'SecureTextField']);
// Multiline bodies (Notes/Messages compose areas) are TextViews — reachable by
// setField but NOT by search (a search bar is never a TextView), so they're
// opt-in to avoid a compose body shadowing a real search field.
const EDITABLE_MULTILINE: ReadonlySet<string> = new Set([...EDITABLE, 'TextView', 'TextEditor']);

function labelTokens(s: string): string[] {
  // Numbers are kept whatever their length: "Row 5" and "Row 53", or "item 1"
  // and "item 12", are different things, not spelling variants.
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 2 || /^\d+$/.test(t));
}

// How well a query matches a label, tolerant of punctuation / spacing / word
// order: the fraction of the label's tokens the query covers. 1.0 means the query
// contains every significant word of the label (a pure punctuation/spacing
// variant); a partial overlap (e.g. "Screen Capture" vs "Full Screen Previews",
// sharing only "screen") scores low and is rejected.
function fuzzyScore(label: string, query: string): number {
  // Numbers on both sides must agree: "Invoice 5 total amount" shares three of
  // four words with "Invoice 53 total amount" but is a different invoice.
  const ln = numbersIn(label);
  const qn = numbersIn(query);
  if (ln && qn && ln !== qn) return 0;
  const qt = new Set(labelTokens(query));
  const lt = labelTokens(label);
  if (!qt.size || !lt.length) return 0;
  return lt.filter((t) => qt.has(t)).length / lt.length;
}

/**
 * Does a label match a query — by substring, or a strict punctuation/spacing-
 * tolerant fuzzy match? Shared by the task layer's cached-map lookups so
 * ask/toggle tolerate rewording the same way findElement does.
 */
export function labelMatches(label: string, query: string): boolean {
  return containsQuery(label, query) || fuzzyScore(label, query) >= 0.75;
}

/** The numbers in a string, sorted, as one key ('' when it has none). */
function numbersIn(s: string): string {
  return (s.match(/\d+/g) ?? [])
    .map(Number)
    .sort((a, b) => a - b)
    .join(',');
}

/** `label` contains `query` without splitting a number: "Row 5" is not inside "Row 53". */
function containsQuery(label: string, query: string): boolean {
  const l = label.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return true;
  const digit = /\d/;
  for (let i = l.indexOf(q); i !== -1; i = l.indexOf(q, i + 1)) {
    if (digit.test(q[0]!) && digit.test(l[i - 1] ?? '')) continue;
    if (digit.test(q[q.length - 1]!) && digit.test(l[i + q.length] ?? '')) continue;
    return true;
  }
  return false;
}

// --- Element resolution ladder (harness v2, decision doc research/10 §4) ----
// Progressive relaxation, apply_patch-style: each rung only fires if the rung
// above found nothing. `via` reports the match provenance so drift is visible
// in traces. Ambiguity is a CONTRACT, not a guess: multiple distinct matches on
// the winning rung (different role or id) return `candidates` instead of
// silently picking one — the caller disambiguates with role/near or fails
// loudly with the list (the Claude Code Edit-tool uniqueness pattern).

/**
 * Outcome of the resolution ladder. Exactly one of: a match (`el` set, `via`
 * reporting the winning rung), an ambiguity (`el` null + `candidates` listing
 * the distinct matches — the caller disambiguates with role/near), or a miss
 * (`el` null, no candidates).
 */
export type Resolution = {
  /** The winning element, or null on ambiguity/miss. */
  el: UiElement | null;
  /** Match provenance — which rung won (id, exact label, substring, fuzzy). */
  via?: string | undefined;
  /** On ambiguity: the distinct elements that tied. */
  candidates?: UiElement[] | undefined;
};

/** Disambiguators accepted by the resolution ladder. */
export type ResolveOpts = {
  /** Restrict matches to this role (case-insensitive). */
  role?: string | undefined;
  /** Label of another element; pick the candidate geometrically closest to it. */
  near?: string | undefined;
};

function center(e: UiElement): { x: number; y: number } | null {
  return e.rect ? { x: e.rect.x + e.rect.width / 2, y: e.rect.y + e.rect.height / 2 } : null;
}

const within = (a: Rect, b: Rect): boolean =>
  a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;

/**
 * A row and a same-named control nested inside it are one target, not two: a
 * Settings "About" row is a Cell "About" holding a Button "About". Drop any
 * match that sits inside another match with the same label, keeping the outer
 * one (the first, when two share a frame).
 */
function collapseNested(pool: UiElement[]): UiElement[] {
  return pool.filter(
    (e, i) =>
      !pool.some(
        (o, j) =>
          j !== i &&
          e.rect !== undefined &&
          o.rect !== undefined &&
          o.label.toLowerCase() === e.label.toLowerCase() &&
          within(e.rect, o.rect) &&
          (!within(o.rect, e.rect) || j < i),
      ),
  );
}

function disambiguate(matches: UiElement[], via: string, opts: ResolveOpts, els: UiElement[]): Resolution {
  let pool = matches;
  if (opts.role) {
    const byRole = pool.filter((e) => e.role.toLowerCase() === opts.role!.toLowerCase());
    if (byRole.length) pool = byRole;
  }
  // After the role filter, so an explicit role (say Button) still picks the
  // inner control rather than the row around it.
  pool = collapseNested(pool);
  if (pool.length > 1 && opts.near) {
    const anchor = els.find((e) => labelMatches(e.label, opts.near!));
    const ac = anchor ? center(anchor) : null;
    if (ac) {
      pool = [...pool].sort((a, b) => {
        const ca = center(a);
        const cb = center(b);
        const da = ca ? (ca.x - ac.x) ** 2 + (ca.y - ac.y) ** 2 : Infinity;
        const db = cb ? (cb.x - ac.x) ** 2 + (cb.y - ac.y) ** 2 : Infinity;
        return da - db;
      });
      return { el: pool[0]!, via: `${via}, nearest "${opts.near}"` }; // non-empty: sorted copy of pool
    }
  }
  if (pool.length === 1) return { el: pool[0]!, via };
  // Same role AND same label are pre-deduped upstream, and same-label nesting
  // is collapsed above; what's left here are genuinely different controls
  // matching the same query — refuse to guess.
  return { el: null, candidates: pool, via };
}

/**
 * One screen's worth of the resolution ladder: id exact → exact label →
 * substring → fuzzy above a strict bar. This is the per-iteration body of
 * resolveElement's scroll loop, extracted so callers holding a fresh cache
 * (item-4 auto-wait) can match without scrolling. Returns `{ el: null }` with
 * no candidates when no rung matched at all.
 */
export function matchInElements(els: UiElement[], query: string, opts: ResolveOpts): Resolution {
  const q = query.toLowerCase();

  // Rung 0: exact accessibility-identifier match — the stablest anchor an
  // app exposes (survives label rewording and localization).
  const byId = els.filter((e) => e.id && e.id.toLowerCase() === q);
  if (byId.length) return disambiguate(byId, 'id', opts, els);

  // Rung 1: exact label (case-insensitive).
  const exact = els.filter((e) => e.label.toLowerCase() === q);
  if (exact.length) return disambiguate(exact, 'exact label', opts, els);

  // Rung 2: label substring (never splitting a number).
  const sub = els.filter((e) => containsQuery(e.label, q));
  if (sub.length) return disambiguate(sub, 'label substring', opts, els);

  // Rung 3: best punctuation/spacing-tolerant fuzzy match above a strict bar.
  let best: UiElement | null = null;
  let bestScore = 0;
  for (const e of els) {
    const s = fuzzyScore(e.label, query);
    if (s > bestScore) {
      bestScore = s;
      best = e;
    }
  }
  if (best && bestScore >= 0.75) return { el: best, via: `fuzzy ${bestScore.toFixed(2)}` };

  return { el: null };
}

/** Outcome of a system-alert interaction (see `DeviceCore.handleAlert`). */
export type AlertOutcome = {
  /** Was an alert showing at all. */
  present: boolean;
  /** Was it cleared (accept/dismiss actions only). */
  handled?: boolean | undefined;
  /** The button that was tapped, when handled. */
  button?: string | undefined;
  /** Title/message/buttons summary of the alert. */
  description?: string | undefined;
};

// Permission / system dialogs surface in the snapshot as a type:"Alert" node
// whose sibling Buttons are the choices (the alert is modal, so no other
// buttons coexist). The daemon's system-alert command only sees an app's *own*
// UIAlertControllers — SpringBoard-presented permission prompts (location,
// notifications, contacts…) are invisible to it, which is why real apps stalled
// the crawler behind a dialog it couldn't clear. Detecting the node directly
// catches both. Button labels use a curly apostrophe ("Don't Allow"), so match
// on an apostrophe-normalized form.
const na = (s: string): string => s.toLowerCase().replace(/[’']/g, "'").trim();
// Preference order matters: for a location prompt, "Allow While Using App" is
// the standard grant and must win over "Allow Once".
const ALERT_ACCEPT: readonly string[] = [
  'allow while using app',
  'always allow',
  'allow',
  'ok',
  'yes',
  'continue',
  'allow once',
  'turn on',
  'enable',
  'agree',
  'accept',
  'got it',
  'join',
];
const ALERT_DISMISS: readonly string[] = [
  "don't allow",
  'not now',
  'cancel',
  'no thanks',
  'no',
  'deny',
  'dismiss',
  'later',
  'skip',
  "don't",
];

type AlertInfo = { title: string; message?: string | undefined; buttons: UiElement[] };

function pickAlertButton(buttons: UiElement[], action: 'accept' | 'dismiss'): UiElement | undefined {
  const prefs = action === 'accept' ? ALERT_ACCEPT : ALERT_DISMISS;
  for (const p of prefs) {
    const hit = buttons.find((b) => na(b.label) === p);
    if (hit) return hit;
  }
  for (const p of prefs) {
    const hit = buttons.find((b) => na(b.label).includes(p));
    if (hit) return hit;
  }
  // Last resort: accepting picks any non-negative button; dismissing, any button.
  if (action === 'accept') return buttons.find((b) => !ALERT_DISMISS.some((d) => na(b.label).includes(d)));
  return buttons[0];
}

function describeAlert(info: AlertInfo): string {
  const head = `${info.title}${info.message ? ` ${info.message}` : ''}`.trim();
  return head + (info.buttons.length ? ` [buttons: ${info.buttons.map((b) => b.label).join(', ')}]` : '');
}

function normRef(ref: string): string {
  return ref.startsWith('@') ? ref : `@${ref}`;
}

/** Render any thrown value as a one-line message (appends `details.hint` when present). */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    const hint = (error as { details?: { hint?: string } }).details?.hint;
    return hint ? `${error.message} (${hint})` : error.message;
  }
  return String(error);
}

/**
 * The device core: one instance = one device's observe/resolve/act state,
 * driving one {@link DeviceBackend}. Everything here is portable — no
 * runtime-specific globals and no image libraries — so it runs under Node.
 * The harness's DeviceContext subclasses this and adds the cursor +
 * live-viewer layer via the onCacheUpdated hook.
 */
export class DeviceCore {
  /** The backend this core drives. */
  readonly backend: DeviceBackend;

  // Shared snapshot cache so a cursor move (highlight an element) doesn't need
  // a fresh accessibility snapshot — observe() populates it; the cursor tools
  // reuse it for element geometry and box overlays.
  protected cachedNodes: SnapshotNode[] = [];
  protected cachedViewport = { width: 390, height: 844 };
  protected lastApp: { app?: string | undefined; bundleId?: string | undefined } = {};
  private lastRender: RenderState | null = null;
  // Freshness stamp of the snapshot cache (item-4 auto-wait reads this).
  protected cacheAt = 0;

  constructor(backend: DeviceBackend) {
    this.backend = backend;
  }

  // Hook for harness-side live-viewer publication: called after every snapshot
  // cache update. The base core has no viewer, so this is a no-op.
  protected onCacheUpdated(): void {}

  /**
   * Canonical post-action report for LLM tool results, shared by every tool
   * surface (agent tools + MCP): verdict from the action's own evidence, then a
   * delta-rendered view of the screen it left behind.
   */
  async renderActionResult(prefix: string, evidence?: ActionEvidence, refresh = false): Promise<string> {
    if (refresh) await this.observe(); // refresh the cache; renderObservation reads it
    const verdict = evidence?.detail ? ` (${evidence.detail})` : '';
    return `${prefix}${verdict}\n\nCurrent screen (app: ${this.currentApp() ?? 'unknown'}):\n${this.renderObservation()}`;
  }

  /**
   * Render the current cached screen for the LLM. full=true (or a structural
   * change since last render) yields the complete compressed tree; otherwise a
   * compact delta. Always updates the baseline.
   */
  renderObservation(full = false): string {
    const app = this.lastApp.app;
    const { kept, above, below, aboveNames, belowNames, suppressFocused, vw } = keptViewportNodes(
      this.cachedNodes,
    );
    const keys = kept.map(elementKey);
    const lineByKey = new Map<string, string>();
    for (const n of kept) lineByKey.set(elementKey(n), formatNode(n, { suppressFocused, vw }));

    const sameStructure =
      !full &&
      this.lastRender != null &&
      this.lastRender.app === app &&
      arraysEqual(this.lastRender.keys, keys) &&
      // Guard against duplicate-key collisions collapsing the maps differently.
      lineByKey.size === keys.length &&
      this.lastRender.lineByKey.size === this.lastRender.keys.length;

    if (sameStructure && this.lastRender) {
      const changed: string[] = [];
      for (const key of keys) {
        const now = lineByKey.get(key)!;
        const before = this.lastRender.lineByKey.get(key);
        if (before !== now) changed.push(`~ ${now}`);
      }
      this.lastRender = { app, keys, lineByKey };
      if (changed.length === 0) {
        return `Screen unchanged since last observation (${keys.length} elements).`;
      }
      return `Same screen; ${changed.length} of ${keys.length} element(s) changed:\n${changed.join('\n')}\n(other elements and their @refs unchanged)`;
    }

    // Full render + refresh the baseline.
    this.lastRender = { app, keys, lineByKey };
    const lines = kept.map((n) => formatNode(n, { suppressFocused, vw }));
    const controls = (names: string[]) =>
      names.length ? ` — controls there: ${names.map((n) => `"${n}"`).join(', ')}` : '';
    if (above > 0)
      lines.unshift(
        `[${above} elements above the viewport — scroll up to reach them${controls(aboveNames)}]`,
      );
    if (below > 0)
      lines.push(`[${below} elements below the viewport — scroll down to reach them${controls(belowNames)}]`);
    return lines.join('\n');
  }

  private cacheSnapshot(nodes: SnapshotNode[]): void {
    this.cachedNodes = nodes;
    const root = nodes.find((n) => (n.type === 'Application' || n.type === 'Window') && n.rect);
    if (root?.rect) this.cachedViewport = { width: root.rect.width, height: root.rect.height };
    this.cacheAt = Date.now();
    this.onCacheUpdated();
  }

  // One snapshot → cache. observe() and every action share this so we snapshot
  // once per state change instead of separately for verify + observe.
  private async refreshCache(): Promise<void> {
    const snap = await this.backend.snapshot({ interactiveOnly: true });
    this.cacheSnapshot(snap.nodes);
    this.lastApp = { app: snap.appName, bundleId: snap.appBundleId };
  }

  // A cheap fingerprint of the current screen to detect whether an action
  // changed anything, replacing the driver's expensive verify pass.
  private cacheSignature(): string {
    const head = this.cachedNodes
      .slice(0, 16)
      .map((n) => `${n.ref ?? ''}:${n.label ?? n.type ?? ''}`)
      .join('|');
    return `${this.cachedNodes.length}#${head}`;
  }

  /** Milliseconds since the cache was last refreshed (Infinity before first). */
  cacheAgeMs(): number {
    return this.cacheAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.cacheAt;
  }

  /** Public fingerprint of the cached tree — the settle/verify signal. */
  stateSignature(): string {
    return this.cacheSignature();
  }

  /** The cached screen as a compressed {@link Observation} (no new snapshot). */
  currentElements(): Observation {
    return {
      app: this.lastApp.app,
      bundleId: this.lastApp.bundleId,
      truncated: false,
      elements: compressNodes(this.cachedNodes),
    };
  }

  /**
   * The frontmost app name from the last snapshot — cheap label without paying
   * the full tree compression (used by the delta renderer's callers).
   */
  currentApp(): string | undefined {
    return this.lastApp.app;
  }

  /**
   * Structured interactive elements from the current cache — the crawler taps
   * these by label (refs are only valid within one snapshot).
   */
  interactiveElements(): UiElement[] {
    const out: UiElement[] = [];
    const seen = new Set<string>();
    for (const n of this.cachedNodes) {
      if (!n.ref || !n.rect) continue;
      // role-first, matching the human-readable element list (a Settings row is
      // type=Button role=Cell; we treat it as its semantic role, "Cell").
      const role = n.role ?? n.type ?? '';
      if (!TAPPABLE.has(role)) continue;
      const label = (n.label ?? n.identifier ?? '').trim();
      if (!label) continue;
      if (n.rect.width >= this.cachedViewport.width && n.rect.height >= this.cachedViewport.height) continue;
      const key = `${role}:${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ref: normRef(n.ref),
        label,
        role,
        value: n.value,
        rect: n.rect,
        id: n.identifier?.trim() || undefined,
        enabled: n.enabled,
        blocked: n.interactionBlocked,
      });
    }
    return out;
  }

  /**
   * Editable text inputs from the current cache. These roles are deliberately
   * excluded from interactiveElements() (they aren't "tap" targets), so the
   * input primitive needs its own accessor to find a search bar / text field to
   * focus. includeMultiline adds TextView bodies for form/compose filling.
   */
  inputFields(includeMultiline = false): UiElement[] {
    const editable = includeMultiline ? EDITABLE_MULTILINE : EDITABLE;
    const out: UiElement[] = [];
    for (const n of this.cachedNodes) {
      if (!n.ref || !n.rect) continue;
      const role = n.role ?? n.type ?? '';
      if (!editable.has(role)) continue;
      out.push({
        ref: normRef(n.ref),
        label: (n.label ?? n.identifier ?? '').trim(),
        role,
        value: n.value,
        rect: n.rect,
        enabled: n.enabled,
        blocked: n.interactionBlocked,
      });
    }
    return out;
  }

  /**
   * Run the resolution ladder against the current cache only — no scrolling,
   * no fresh snapshot. resolveElement drives this per scroll step.
   */
  resolveInCache(query: string, opts: ResolveOpts = {}): Resolution {
    return matchInElements(this.interactiveElements(), query, opts);
  }

  /**
   * The full ladder: the current screen first, then scroll to top and match +
   * scroll down until found or the list ends.
   */
  async resolveElement(query: string, opts: ResolveOpts = {}): Promise<Resolution> {
    // Look where the agent is looking before scrolling anywhere. An id or
    // exact-label match here is
    // the target (or, when several tie, the ambiguity the agent must resolve).
    // A weaker match could lose to an exact one elsewhere, so it still gets
    // the full search from the top.
    if (this.cacheAgeMs() >= CACHE_FRESH_MS) await this.observe();
    const here = this.resolveInCache(query, opts);
    if ((here.el || here.candidates) && (here.via === 'id' || here.via === 'exact label')) return here;

    await this.scrollToTop();
    for (let i = 0; i < 10; i++) {
      const r = this.resolveInCache(query, opts);
      if (r.el || r.candidates) return r;
      if (!(await this.searchStep('down', () => this.screenSignature(), true))) break;
    }
    return { el: null };
  }

  /**
   * Compatibility wrapper: single best element or null (read paths — ask/read a
   * value — where picking the first match is low-risk). Tap paths use
   * resolveElement directly and honor the ambiguity contract.
   */
  async findElement(labelSubstring: string): Promise<UiElement | null> {
    const r = await this.resolveElement(labelSubstring);
    return r.el ?? r.candidates?.[0] ?? null;
  }

  /**
   * Read a labeled value. iOS list rows fold the value into the label
   * ("iOS Version, 26.1") or expose it as a Switch value ("1"/"0"); handle both.
   */
  async readField(labelSubstring: string): Promise<string | null> {
    const el = await this.findElement(labelSubstring);
    if (!el) return null;
    if (el.value != null && el.value !== '') return el.value;
    // "Label, value" pattern → take the part after the label text. If the query
    // wasn't a substring (a fuzzy match), we can't split cleanly — return the
    // whole row, which still carries the value.
    const idx = el.label.toLowerCase().indexOf(labelSubstring.toLowerCase());
    if (idx < 0) return el.label;
    const after = el.label
      .slice(idx + labelSubstring.length)
      .replace(/^[\s,:]+/, '')
      .trim();
    return after || el.label;
  }

  /**
   * A structural fingerprint of the current screen that is stable across
   * dynamic content (times, battery, values) — it keys the crawler's graph
   * nodes so the same screen is recognized regardless of transient text.
   */
  screenSignature(): string {
    const title =
      this.cachedNodes.find((n) => (n.type === 'NavigationBar' || n.role === 'NavigationBar') && n.label)
        ?.label ?? '';
    const labels = this.cachedNodes
      .filter((n) => TAPPABLE.has(n.role ?? n.type ?? '') && (n.label ?? '').trim())
      .map((n) => `${n.role ?? n.type}:${(n.label ?? '').trim()}`)
      .sort();
    const uniq = [...new Set(labels)];
    return `${this.lastApp.bundleId ?? ''}|${title}|${uniq.join('~')}`;
  }

  /** Navigation-bar title of the cached screen ('' when absent). */
  screenTitle(): string {
    return (
      this.cachedNodes.find((n) => (n.type === 'NavigationBar' || n.role === 'NavigationBar') && n.label)
        ?.label ?? ''
    );
  }

  /** Take one fresh snapshot into the cache and return the compressed observation. */
  async observe(): Promise<Observation> {
    try {
      await this.refreshCache();
      return this.currentElements();
    } catch (error) {
      if (
        error instanceof SessionNotFoundError ||
        (error as { code?: string })?.code === 'SESSION_NOT_FOUND'
      ) {
        return {
          truncated: false,
          elements: 'No app session is active yet. Use open_app to launch an app first.',
        };
      }
      throw error;
    }
  }

  /**
   * Open an app by name/bundle id. relaunch forces a fresh launch (clean
   * initial screen) instead of just foregrounding — iOS keeps an app's
   * navigation state across foregrounding, so primitives that need a known
   * starting screen pass relaunch=true.
   */
  async openApp(app: string, relaunch = false): Promise<string> {
    const result = await this.backend.openApp({ app, relaunch });
    return `Opened ${result.appName ?? app} (${result.appBundleId ?? 'unknown bundle'})`;
  }

  /**
   * Level-2 of the action ladder: deep links beat tap sequences when a URL route
   * exists (maps://, app schemes, https:// universal links). XCTest sessions are
   * app-scoped, so a link that opens a different app must re-scope the session
   * to that app or observations keep tracking the old one.
   */
  async openUrl(url: string, app?: string): Promise<string> {
    // Without an app, the system routes the URL to the app that owns it. Sending
    // it to the current app instead (Settings asked to open an https link)
    // opened nothing while this reported success.
    const r = await this.backend.openApp(app ? { app, url } : { url });
    const where = app ? ` in ${app}` : r.appBundleId ? ` in ${r.appName ?? r.appBundleId}` : '';
    return `Opened ${url}${where}${r.unverified ? ` (unverified: ${r.unverified})` : ''}`;
  }

  /** List installed app bundle ids. */
  async listApps(): Promise<string[]> {
    return this.backend.listApps();
  }

  // A tap self-diffs against our own snapshot cache: fingerprint before, tap
  // with no driver-side verify (which would cost a second snapshot pair),
  // re-snapshot once, fingerprint after. One snapshot instead of the verify
  // pass's three, and the cache is left fresh so callers don't observe again.
  private async tapAndDiff(tap: () => Promise<unknown>): Promise<ActionEvidence> {
    // The backend's own before/after comparison answers when it has one (the
    // iOS runner makes it from captures it takes anyway). Otherwise the cached
    // screen is compared with the one after; a fresh process (one CLI verb) has
    // none, and the change is reported unverified. Never compare against an
    // empty cache: every tap would look like a change.
    const before = this.cacheAt === 0 ? undefined : this.cacheSignature();
    await tap();
    const outcome = this.backend.pressOutcome?.();
    await this.refreshCache();
    // The backend's comparison brackets the tap itself; the cached screen may be
    // older, and a change since it was read is not the tap's doing.
    const changed = outcome?.changed ?? (before !== undefined ? before !== this.cacheSignature() : undefined);
    if (changed === undefined) {
      this.lastPress = { detail: 'screen change unverified' };
      return this.lastPress;
    }
    this.lastPress = {
      changed,
      detail: changed ? 'screen changed' : 'screen did NOT change — the action may have had no effect',
    };
    return this.lastPress;
  }

  private lastPress: ActionEvidence = {};

  /** What the most recent tap did to the screen (callers that tap by label report it). */
  lastPressEvidence(): ActionEvidence {
    return this.lastPress;
  }

  /** Tap an element ref, self-diffing the cache to report whether the screen changed. */
  async press(ref: string): Promise<ActionEvidence> {
    try {
      return await this.tapAndDiff(() => this.backend.press({ ref }));
    } catch (error) {
      // The runner refuses center-targeted taps whose center is off-screen
      // ("off-screen and not safe to press") — but a carousel/pager item can
      // straddle the viewport edge with most of it visible and perfectly
      // tappable. Fall back to the midpoint of the VISIBLE region. Fully
      // off-screen elements still refuse (rethrow), preserving the scroll-into-
      // view recovery in tapLabel/tapControl.
      if (!/off-?screen/i.test(describeError(error))) throw error;
      const mid = this.visibleMidpoint(this.findNode(ref)?.rect);
      if (!mid) throw error;
      return this.tapAndDiff(() => this.backend.press({ x: mid.x, y: mid.y }));
    }
  }

  // Midpoint of the part of `rect` inside the viewport, or null when nothing
  // of it is visible.
  private visibleMidpoint(rect?: Rect): { x: number; y: number } | null {
    if (!rect) return null;
    const x1 = Math.max(rect.x, 0);
    const y1 = Math.max(rect.y, 0);
    const x2 = Math.min(rect.x + rect.width, this.cachedViewport.width);
    const y2 = Math.min(rect.y + rect.height, this.cachedViewport.height);
    if (x2 <= x1 || y2 <= y1) return null;
    return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
  }

  // Fully within a safe band clear of the top nav bar and bottom tab/home area.
  protected onScreen(rect?: Rect): boolean {
    if (!rect) return false;
    const cy = rect.y + rect.height / 2;
    return cy > 56 && cy < this.cachedViewport.height - 44 && rect.x < this.cachedViewport.width;
  }

  /**
   * Open an app and walk its nav stack back to the root (dismissing modals), so
   * map-based navigation always starts from a known origin.
   */
  async goToRoot(app: string): Promise<void> {
    const DISMISS = ['Close', 'Cancel', 'Done', 'Not Now', 'Dismiss'];
    await this.observe().catch(() => undefined);
    if (this.lastApp.bundleId !== app) {
      await this.openApp(app);
      await this.observe();
    }
    // Real apps launch behind stacked permission prompts (see clearBlockingAlerts);
    // clear them first so the nav-stack walk below sees the actual app.
    await this.clearBlockingAlerts('accept');
    for (let i = 0; i < 12; i++) {
      const els = this.interactiveElements();
      const back = els.find((e) => e.role === 'Button' && !!e.rect && e.rect.x < 70 && e.rect.y < 110);
      const dismiss = els.find((e) => e.role === 'Button' && DISMISS.includes(e.label));
      const target = back ?? dismiss;
      if (!target) break;
      await this.press(target.ref);
      await this.observe();
    }
    // The root may be left scrolled from prior navigation; reset it to the top
    // so crawls/navigation start from a known position.
    await this.scrollToTop();
  }

  /** Height of the cached viewport in points. */
  viewportHeight(): number {
    return this.cachedViewport.height;
  }

  /**
   * Vertical span of interactive content in the current cache. Used to decide
   * whether scrolling is even necessary — scroll gestures cost ~2s each, so
   * skipping them on screens that already fit is the single biggest crawl
   * speedup.
   */
  contentBounds(): { minY: number; maxY: number } {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of this.cachedNodes) {
      if (!n.rect) continue;
      if (!TAPPABLE.has(n.role ?? n.type ?? '')) continue;
      minY = Math.min(minY, n.rect.y);
      maxY = Math.max(maxY, n.rect.y + n.rect.height);
    }
    return { minY: minY === Infinity ? 0 : minY, maxY: maxY === -Infinity ? 0 : maxY };
  }

  /**
   * Tapping the status bar scrolls the active scroll view to the top — native
   * iOS behavior, one fast tap instead of multiple ~2s scroll gestures. Falls
   * back to gesture scrolling if the tap doesn't take.
   */
  async scrollToTop(): Promise<void> {
    try {
      await this.backend.press({ x: Math.round(this.cachedViewport.width / 2), y: 6 });
      await this.observe();
      return;
    } catch {
      /* fall back to gesture scroll below */
    }
    for (let i = 0; i < 6; i++) {
      const before = this.screenSignature();
      await this.scroll('up');
      await this.observe();
      if (this.screenSignature() === before) return;
    }
  }

  /**
   * Tap an element by its label, scrolling it into view first if it's
   * off-screen. The crawler and the map navigator use this so a target below
   * the fold (a long Settings list) is still reachable. Re-resolves the ref
   * after each scroll.
   */
  async tapLabel(label: string): Promise<boolean> {
    let sweepUp = true;
    let blocked: unknown;
    for (let i = 0; i < 12; i++) {
      const el = this.interactiveElements().find((e) => e.label === label);
      if (el && this.onScreen(el.rect)) {
        try {
          await this.press(el.ref);
          return true;
        } catch (error) {
          // Straddled the edge, or sitting under a sheet/toast/overlay. Both are
          // positional and both are what the nudge scroll below is for, so retry
          // rather than throw — real apps stack overlays over their own chrome,
          // and a covered element used to abort an entire crawl.
          if (!/off-?screen|covered/i.test(describeError(error))) throw error;
          blocked = error;
        }
      }
      // Known position → scroll toward it. Not in the realized tree at all →
      // sweep to the top first (rows may be scrolled past above), then scan down.
      const dir: 'up' | 'down' = el?.rect
        ? el.rect.y < 0
          ? 'up'
          : 'down'
        : sweepUp && i < 5
          ? 'up'
          : 'down';
      if (!(await this.searchStep(dir, () => this.cacheSignature(), dir === 'down'))) {
        // The scroll moved nothing: that end is reached. An upward sweep turns
        // down; otherwise further scrolling cannot help.
        if (dir === 'up' && !el?.rect) {
          sweepUp = false;
          continue;
        }
        break;
      }
    }
    // Found but never reachable (covered, say): say why, not "not found".
    if (blocked) throw blocked;
    return false;
  }

  /**
   * One step of a scroll-to-find search: swipe, then read the screen at once.
   * Returns whether the screen changed.
   *
   * The swipe holds still before lifting, so the list does not coast and is at
   * rest when the scroll returns (measured: nothing moves afterwards). Waiting
   * for the screen to go quiet cost 0.6–2.6 s per step.
   *
   * An unchanged screen is the end of the list, unless rows load in late (an
   * infinite feed). With `confirmEnd`, a second swipe that also changes nothing
   * is required before saying so.
   */
  private async searchStep(
    dir: 'up' | 'down',
    signature: () => string,
    confirmEnd: boolean,
  ): Promise<boolean> {
    const before = signature();
    for (let attempt = 0; attempt < (confirmEnd ? 2 : 1); attempt++) {
      await this.backend.scroll(dir, { settle: false });
      await this.observe();
      if (signature() !== before) return true;
    }
    return false;
  }

  /**
   * Vision-path fallback: tap raw coordinates when the accessibility tree is
   * missing or wrong (canvas, games, custom controls). Coordinates are in the
   * same space as observe()'s rects and the screenshot pixels (@1x points).
   */
  async pressAt(x: number, y: number): Promise<ActionEvidence> {
    return this.tapAndDiff(() => this.backend.press({ x, y }));
  }

  /**
   * Coordinate drag: touch down at (x,y), move by (dx,dy). The primitive for
   * controls a tap can't operate — picker wheels (drag vertically on the wheel
   * column), sliders, and custom carousels. Same coordinate space as rects.
   */
  async pan(x: number, y: number, dx: number, dy: number, durationMs?: number): Promise<void> {
    await this.backend.pan(x, y, dx, dy, durationMs);
  }

  /**
   * Set-of-Marks visual observation: screenshot with `@ref` labels drawn on the
   * elements, so a vision model can ground itself in pixels and still act by ref.
   */
  async screenshotWithRefs(path: string): Promise<string> {
    const result = await this.backend.screenshot({ path, overlayRefs: true });
    return result.path;
  }

  protected async currentViewport(): Promise<{ width: number; height: number }> {
    try {
      const snap = await this.backend.snapshot({ interactiveOnly: true, depth: 1 });
      const root = snap.nodes.find((n) => (n.type === 'Application' || n.type === 'Window') && n.rect);
      return { width: root?.rect?.width ?? 390, height: root?.rect?.height ?? 844 };
    } catch {
      return { width: 390, height: 844 };
    }
  }

  /** Long-press an element ref. */
  async longPress(ref: string, durationMs = 800): Promise<void> {
    await this.backend.longPress(ref, durationMs);
  }

  /** Focus a field and replace its text, self-diffing the cache for evidence. */
  async fill(ref: string, text: string): Promise<ActionEvidence> {
    return this.tapAndDiff(() => this.backend.fill(ref, text));
  }

  /** Type into whatever currently has keyboard focus. */
  async typeText(text: string): Promise<void> {
    await this.backend.typeText(text);
  }

  /**
   * Press the keyboard's return/go key. Submits a search bar that acts on
   * Return (Safari's address bar, web forms) rather than filtering results as
   * you type.
   */
  async pressKey(key: Key): Promise<void> {
    await this.backend.pressKey(key);
  }

  async pressReturn(): Promise<void> {
    await this.backend.pressKey('return');
  }

  /** Scroll the active scroll view one step. */
  async scroll(direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {
    await this.backend.scroll(direction);
  }

  /** Block until `text` appears on screen; returns a confirmation note. */
  async waitForText(text: string, timeoutMs = 5000): Promise<string> {
    await this.backend.waitForText(text, timeoutMs);
    return `"${text}" appeared on screen`;
  }

  // Read a modal alert (if any) from the current snapshot cache — cheap, no
  // extra snapshot, since observe() already caches the Alert node
  // (interactiveOnly keeps it).
  private alertFromCache(): AlertInfo | null {
    const alert = this.cachedNodes.find((n) => (n.type ?? n.role) === 'Alert');
    if (!alert) return null;
    const texts = this.cachedNodes
      .filter((n) => (n.type ?? n.role) === 'StaticText' && n.label)
      .map((n) => (n.label ?? '').trim());
    const buttons: UiElement[] = [];
    for (const n of this.cachedNodes) {
      if (!n.ref || !n.rect || (n.role ?? n.type) !== 'Button') continue;
      const label = (n.label ?? n.identifier ?? '').trim();
      if (label)
        buttons.push({
          ref: normRef(n.ref),
          label,
          role: 'Button',
          value: n.value,
          rect: n.rect,
          enabled: n.enabled,
          blocked: n.interactionBlocked,
        });
    }
    const title = (alert.label ?? texts[0] ?? 'Alert').trim();
    return { title, message: texts.find((t) => t !== title), buttons };
  }

  /**
   * System dialogs (permissions, sign-in prompts) block everything else; the
   * driver exposes them as a first-class action instead of hoping a tap lands.
   */
  async handleAlert(action: 'get' | 'accept' | 'dismiss'): Promise<AlertOutcome> {
    await this.observe().catch(() => undefined);
    const info = this.alertFromCache();
    if (info) {
      const description = describeAlert(info);
      if (action === 'get') return { present: true, description };
      const btn = pickAlertButton(info.buttons, action);
      if (!btn?.rect) return { present: true, handled: false, description };
      await this.pressAt(btn.rect.x + btn.rect.width / 2, btn.rect.y + btn.rect.height / 2);
      await this.observe().catch(() => undefined);
      const still = this.alertFromCache();
      // Handled if this alert is gone; a *different* alert surfacing (stacked
      // prompts) still counts — this one was cleared.
      return {
        present: true,
        handled: still == null || still.title !== info.title,
        button: btn.label,
        description,
      };
    }
    // Fallback: the backend's command for an app's own alert not surfaced as a node.
    try {
      const result = await this.backend.systemAlert(action);
      const alert = result.alert;
      return {
        present: alert != null,
        handled: result.handled,
        button: result.button,
        description: alert
          ? `${alert.title ?? ''} ${alert.message ?? ''}`.trim() +
            (alert.buttons?.length ? ` [buttons: ${alert.buttons.join(', ')}]` : '')
          : undefined,
      };
    } catch (error) {
      if (/alert not found/i.test(describeError(error))) return { present: false };
      throw error;
    }
  }

  /**
   * Clear the launch permission gauntlet — real apps stack location /
   * notification / tracking prompts on first open, each blocking the app.
   * Grants by default so the crawl sees the most surface. Returns the buttons
   * tapped. Bounded so a non-clearing dialog can't loop forever.
   */
  async clearBlockingAlerts(action: 'accept' | 'dismiss' = 'accept', max = 6): Promise<string[]> {
    const tapped: string[] = [];
    let lastTitle = '';
    for (let i = 0; i < max; i++) {
      const info = this.alertFromCache();
      if (!info) {
        await this.observe().catch(() => undefined);
        if (!this.alertFromCache()) break;
      }
      const r = await this.handleAlert(action);
      if (!r.present || !r.button || !r.handled) break;
      if (r.description === lastTitle) break; // no progress — same dialog persists
      lastTitle = r.description ?? '';
      tapped.push(r.button);
    }
    return tapped;
  }

  /** Go to the home screen. */
  async goHome(): Promise<void> {
    await this.backend.home();
  }

  /** Navigate back (nav-bar back / hardware back). */
  async goBack(): Promise<void> {
    await this.backend.back();
  }

  /** Save a screenshot to `path`; returns the written path. */
  async screenshot(path: string): Promise<string> {
    const result = await this.backend.screenshot({ path });
    return result.path;
  }

  /** Close the backend's transport session. */
  async closeSession(): Promise<void> {
    await this.backend.closeSession();
  }

  protected findNode(ref: string): SnapshotNode | undefined {
    const want = normRef(ref);
    return this.cachedNodes.find((n) => n.ref && normRef(n.ref) === want);
  }

  // Ensure the cache is fresh enough to resolve refs / draw boxes.
  protected async ensureCache(): Promise<void> {
    if (this.cachedNodes.length === 0) await this.observe();
  }
}

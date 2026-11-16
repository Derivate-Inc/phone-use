import { resolveApp } from './apps.ts';
import * as driver from './driver.ts';
import type { AppMap } from './explore.ts';
import { crawlToward, findPath, mergeMaps, navigate, type SmartGotoResult, smartGoto } from './explore.ts';

// Resolve an app name or bundle id to a bundle id (batch actions may name apps).
async function bundleFor(app: string): Promise<string> {
  return (await resolveApp(app))?.bundleId ?? app;
}

// Deterministic, map-guided tasks: use the App Cartographer's map to navigate to
// the right screen with zero model calls, then perform a concrete final action
// (read a value, toggle a setting). This is the productivity payoff of the
// atlas — the agent is fast because it already knows the app's layout.

export type MapIO = {
  loadMap: (app: string) => Promise<AppMap | null>;
  saveMap: (map: AppMap) => Promise<unknown>;
  listMaps?: () => Promise<string[]>;
};

export type ReadResult = {
  ok: boolean;
  value?: string | undefined;
  nav: SmartGotoResult['mapped'];
  reason?: string | undefined;
};
export type ToggleResult = {
  ok: boolean;
  before?: string | undefined;
  after?: string | undefined;
  changed?: boolean | undefined;
  nav: SmartGotoResult['mapped'] | 'map' | 'search';
  reason?: string | undefined;
};

// Navigate to `destination` via the map, then read the value of the field whose
// row label contains `field`.
export async function readField(
  app: string,
  destination: string,
  field: string,
  io: MapIO,
): Promise<ReadResult> {
  const nav = await smartGoto(app, destination, io);
  if (!nav.ok)
    return { ok: false, nav: nav.mapped, reason: `could not reach "${destination}" (${nav.reason})` };
  const value = await driver.readField(field);
  return value != null
    ? { ok: true, value, nav: nav.mapped }
    : { ok: false, nav: nav.mapped, reason: `"${field}" not found on ${destination}` };
}

export type AnswerResult = {
  ok: boolean;
  value?: string | undefined;
  screen?: string | undefined;
  via: 'map' | 'search';
  reason?: string | undefined;
};

// Ask for a value without knowing which screen it's on: search cached maps for a
// screen whose rows mention the field, else directed-crawl to the screen that
// *contains* it, then read. Turns the atlas into a queryable knowledge base.
export async function answerField(app: string, query: string, io: MapIO): Promise<AnswerResult> {
  const q = query.toLowerCase();
  const map = await io.loadMap(app);

  // Fast path: a mapped screen already lists this field.
  if (map) {
    const node = map.nodes.find((n) => n.labels.some((l) => driver.labelMatches(l, q)));
    if (node) {
      const path = findPath(map, node.title);
      if (path) {
        await navigate(app, path);
        const value = await driver.readField(query);
        if (value != null) return { ok: true, value, screen: node.title, via: 'map' };
      }
    }
  }

  // Directed search: crawl to the screen that contains the field, then read it.
  const explored = await crawlToward(app, query, { stopOnContain: true });
  const merged = map ? mergeMaps(map, explored.map) : explored.map;
  await io.saveMap(merged);
  if (!explored.found) return { ok: false, via: 'search', reason: `"${query}" not found in ${app}` };
  const value = await driver.readField(query);
  return value != null
    ? { ok: true, value, screen: explored.path[explored.path.length - 1] ?? 'root', via: 'search' }
    : { ok: false, via: 'search', reason: `reached the screen but couldn't read "${query}"` };
}

export type SearchResult = { ok: boolean; results?: string | undefined; reason?: string | undefined };

// The input primitive: open an app, focus its search field (activating it if it
// needs a tap first), type the query, and return the results screen. Most search
// bars filter live; pass submit=true for ones that act on Return (Safari's
// address bar, web forms). Rounds out the intent vocabulary.
export async function search(app: string, query: string, submit = false): Promise<SearchResult> {
  await driver.openApp(app);
  await Bun.sleep(500);
  await driver.observe();

  // Prefer a real editable field; fall back to a "Search" affordance (a bottom
  // card handle, a row) that reveals the field when tapped.
  const field = () => driver.inputFields()[0];
  const affordance = () =>
    driver.interactiveElements().find(
      (e) =>
        /^search$|search /i.test(e.label) ||
        /^(card controller|search)$/i.test(e.label) ||
        // Android search entry points often carry no text at all, only a
        // resource-id (com.android.settings:id/search_action_bar, …); the
        // label falls back to that id, so match "search" as an id segment.
        /(?:^|[:/_])search(?:[:/_]|$)/i.test(e.id ?? e.label),
    );

  let f = field();
  // iOS large-title search bars hide above the list; a rubber-band scroll up
  // reveals them.
  if (!f) {
    await driver.scroll('up');
    await driver.observe();
    f = field();
  }
  // Bottom-card apps (Maps) keep the field collapsed until the card is tapped.
  if (!f) {
    const a = affordance();
    if (a) {
      await driver.press(a.ref);
      await Bun.sleep(500);
      await driver.observe();
      f = field();
    }
  }
  // Still nothing? The app may be parked in a sub-screen (a place detail, a
  // pushed view) from a prior task. Relaunch for a clean initial screen and
  // retry the reveal once.
  if (!f) {
    await driver.openApp(app, true);
    // Heavy apps (Maps) take a beat to render their card/search chrome after a
    // cold relaunch; give it time, then poll a couple of times.
    for (let i = 0; i < 3 && !f; i++) {
      await Bun.sleep(900);
      await driver.observe();
      f = field();
    }
    if (!f) {
      await driver.scroll('up');
      await driver.observe();
      f = field();
    }
    if (!f) {
      const a = affordance();
      if (a) {
        await driver.press(a.ref);
        await Bun.sleep(500);
        await driver.observe();
        f = field();
      }
    }
  }
  if (!f) return { ok: false, reason: `no search field found in ${app}` };

  // Focus via a coordinate tap on the field's center — more reliable at raising
  // the keyboard than a ref-press — then type. If typeText lands before focus
  // settles (XCTest "action may not have been performed"), tap again and retry.
  const focusTap = () =>
    f!.rect
      ? driver.pressAt(Math.round(f!.rect.x + f!.rect.width / 2), Math.round(f!.rect.y + f!.rect.height / 2))
      : driver.press(f!.ref);
  await focusTap();
  await Bun.sleep(450);
  await driver.observe();
  try {
    await driver.typeText(query);
  } catch {
    await focusTap();
    await Bun.sleep(650);
    await driver.observe();
    await driver.typeText(query);
  }
  if (submit) {
    await driver.pressReturn(); // commit for Return-driven bars (Safari, forms)
    await Bun.sleep(2500); // allow navigation/load
  } else {
    await Bun.sleep(900);
  }
  await driver.observe();

  return { ok: true, results: driver.currentElements().elements };
}

export type OpenResult = {
  ok: boolean;
  opened?: string | undefined;
  match?: string | undefined;
  reason?: string | undefined;
};

// Search → act: type the query, then tap the best-matching result row. Closes
// the loop the `search` primitive opens — the dynamic-content counterpart to
// `goto` (which acts on the static, mapped nav). `match` picks a specific result
// by label substring; omit it to open the top result. E.g. Maps "coffee" → open
// the first shop; Contacts "Ada" → open Ada's card.
export async function searchAndOpen(app: string, query: string, match?: string): Promise<OpenResult> {
  const s = await search(app, query);
  if (!s.ok) return { ok: false, reason: s.reason };

  // Results are the tappable rows on the results screen; skip the search field's
  // own chrome and pick by position (topmost) or by the requested match.
  const rows = driver
    .interactiveElements()
    .filter((e) => (e.role === 'Cell' || e.role === 'Link') && e.rect && e.rect.height > 8)
    .sort((a, b) => a.rect!.y - b.rect!.y);
  if (!rows.length) return { ok: false, reason: `no results to open for "${query}" in ${app}` };

  const m = match?.toLowerCase();
  const pick = m ? rows.find((r) => r.label.toLowerCase().includes(m)) : rows[0];
  if (!pick) return { ok: false, reason: `no result matching "${match}" for "${query}" in ${app}` };

  await driver.press(pick.ref);
  await Bun.sleep(700);
  await driver.observe();
  return { ok: true, opened: driver.screenTitle() || pick.label, match: pick.label };
}

export type TapResult = {
  ok: boolean;
  label?: string | undefined;
  changed?: boolean | undefined;
  reason?: string | undefined;
  via?: string | undefined;
};

// The button-press action verb: activate a control (button/cell/link) by its
// exact-or-substring label. Buttons usually sit on the current screen after
// prior steps, so it taps in place; only if the control isn't visible does it
// scroll to find it. Rounds out the action vocabulary — toggle flips switches,
// tap presses buttons ("Done", "Send", "Add") — so skills can do create/compose
// errands, not just navigate and read.
//
// Ambiguity contract (harness v2): if the query matches multiple DISTINCT
// controls and neither role nor near disambiguates, the tap FAILS with the
// candidate list instead of silently pressing the first — the caller retries
// with a disambiguator. Silently tapping the wrong "Add" was the one real
// robustness bug in the v1 design.
export async function tapControl(
  label: string,
  app?: string,
  opts: driver.ResolveOpts = {},
): Promise<TapResult> {
  if (app) {
    await driver.openApp(app); // foreground only (keep nav state); a button lives in-flow
    await Bun.sleep(300);
  }
  await driver.observe();

  // A control that's physically on screen but sits in the bottom band (a context
  // menu / popover item, an action-sheet button) would be treated as off-screen
  // by press(ref) and *scrolled to* by tapLabel — which dismisses the transient
  // menu. Coordinate-tap it in place instead.
  const q = label.toLowerCase();
  const vh = driver.viewportHeight();
  const inBottomBand = driver
    .interactiveElements()
    .find(
      (e) =>
        e.rect &&
        (e.label === label || e.label.toLowerCase().includes(q)) &&
        e.rect.y + e.rect.height / 2 >= vh - 44 &&
        e.rect.y < vh,
    );
  if (inBottomBand?.rect) {
    const ev = await driver.pressAt(
      Math.round(inBottomBand.rect.x + inBottomBand.rect.width / 2),
      Math.round(inBottomBand.rect.y + inBottomBand.rect.height / 2),
    );
    await driver.observe();
    return { ok: true, label: inBottomBand.label, changed: ev.changed };
  }

  // Resolve through the anchoring ladder (id → exact → substring → fuzzy).
  // Ambiguity fails loudly with candidates rather than guessing.
  const res = await driver.resolveElement(label, opts);
  if (!res.el && res.candidates?.length) {
    const list = res.candidates
      .map(
        (c) =>
          `${c.role} "${c.label}"${c.rect ? ` at (${Math.round(c.rect.x)},${Math.round(c.rect.y)})` : ''}`,
      )
      .join('; ');
    return {
      ok: false,
      reason: `"${label}" is ambiguous — ${res.candidates.length} matches: ${list}. Disambiguate with role or near.`,
    };
  }

  // Exact label: tapLabel scrolls the control into view and retries if it
  // straddles the fold — so an off-screen match isn't pressed blindly.
  if (res.el && (await driver.tapLabel(res.el.label))) {
    // Report what the tap did (it may have changed nothing), not an assumed
    // change: unknown stays unknown.
    const changed = driver.lastPressEvidence().changed;
    await driver.observe();
    return { ok: true, label: res.el.label, changed, via: res.via };
  }

  const el = res.el;
  if (!el) return { ok: false, reason: `no control matching "${label}" on this screen` };
  try {
    const ev = await driver.press(el.ref);
    await driver.observe();
    return { ok: true, label: el.label, changed: ev.changed, via: res.via };
  } catch (err) {
    if (!/off-?screen/i.test(driver.describeError(err))) throw err;
    // Below the fold: scroll it up into the safe band and retry once.
    await driver.scroll('down');
    await driver.observe();
    const again = driver.interactiveElements().find((e) => e.label === el.label);
    if (!again) return { ok: false, reason: `found "${el.label}" but it stayed off-screen` };
    const ev = await driver.press(again.ref);
    await driver.observe();
    return { ok: true, label: again.label, changed: ev.changed, via: res.via };
  }
}

export type LongPressResult = { ok: boolean; label?: string | undefined; reason?: string | undefined };

// Press-and-hold a control by label to open its context menu — the interaction
// real apps use for delete / share / "open in…" and previews. Locates the
// control (scrolling to it if needed), then long-presses. Returns the resulting
// screen so a follow-up tap can pick a menu item.
export async function longPressControl(label: string, app?: string): Promise<LongPressResult> {
  if (app) {
    await driver.openApp(app);
    await Bun.sleep(300);
  }
  await driver.observe();
  const el = await driver.findElement(label);
  if (!el) return { ok: false, reason: `no control matching "${label}" on this screen` };
  await driver.longPress(el.ref);
  await Bun.sleep(500);
  await driver.observe();
  return { ok: true, label: el.label };
}

/** Runner refusals that mean the target cannot be typed into safely. */
const FILL_REFUSALS = new Set(['STALE_REF', 'OCCLUDED', 'COVERED', 'OUT_OF_BOUNDS']);

export type FillResult = {
  ok: boolean;
  field?: string | undefined;
  changed?: boolean | undefined;
  reason?: string | undefined;
  /** The field's actual content re-read after typing (ground truth, not hope). */
  readback?: string | undefined;
  /** The field is a secure (password) field: what was typed must not be echoed. */
  secure?: boolean | undefined;
};

// Set a text field to a value by its label/placeholder — the input verb for
// forms and compose bodies (vs search, which is for search bars). Reaches
// TextView bodies (Notes/message text), not just single-line fields. Pairs with
// tap to do compose/create errands: fill "First name" → fill "Last name" → tap
// Done. If the screen has exactly one field, `fieldLabel` may be omitted.
export async function setField(
  value: string,
  fieldLabel?: string,
  app?: string,
  opts?: { append?: boolean },
): Promise<FillResult> {
  if (app) {
    await driver.openApp(app); // foreground only — a form field lives in-flow
    await Bun.sleep(300);
  }
  await driver.observe();
  const fields = driver.inputFields(true); // include TextView bodies (Notes/compose)
  if (!fields.length) return { ok: false, reason: 'no editable text field on this screen' };

  const q = fieldLabel?.toLowerCase();
  const field = q
    ? fields.find((f) => f.label.toLowerCase().includes(q))
    : fields.length === 1
      ? fields[0]
      : undefined;
  if (!field) {
    const labels = fields.map((f) => f.label || '(unlabeled)').join(', ');
    return {
      ok: false,
      reason: fieldLabel
        ? `no text field matching "${fieldLabel}" (fields: ${labels})`
        : `several text fields — specify one of: ${labels}`,
    };
  }

  // Post-typing read-back (minitap's +15pp reliability stack, ported): after
  // the fill, re-observe and report the field's ACTUAL content so the model
  // verifies against ground truth instead of assuming the type landed.
  const readBack = (): string | undefined => {
    const fields2 = driver.inputFields(true);
    const again = fields2.find((f) => f.ref === field.ref) ?? fields2.find((f) => f.label === field.label);
    return again?.value;
  };

  if (opts?.append) {
    // Append = insert at the end WITHOUT clearing — fill() erases the whole
    // field, which destroys existing documents/notes when the agent only
    // wants to add a line (observed: Budget Tracker doc replaced by one row).
    // Caret-to-end recipe: tap just inside the field's bottom-right corner —
    // a tap past the last character puts the caret at the end of the text
    // (same edge-tap the XCTest runner's own moveCaretToEnd uses).
    if (field.rect) {
      await driver.pressAt(
        Math.round(field.rect.x + field.rect.width - 6),
        Math.round(field.rect.y + field.rect.height - 6),
      );
    } else {
      await driver.press(field.ref);
    }
    await Bun.sleep(500);
    await driver.typeText(value);
    await driver.observe();
    return { ok: true, field: field.label, secure: field.role === 'SecureTextField', readback: readBack() };
  }

  try {
    const ev = await driver.fill(field.ref, value); // focuses + sets text by ref
    await driver.observe();
    return {
      ok: true,
      field: field.label,
      secure: field.role === 'SecureTextField',
      changed: ev.changed,
      readback: readBack(),
    };
  } catch (err) {
    // A refusal is the answer: the field is gone or ambiguous, or something
    // covers it. Tapping its old point would type into whatever is there now.
    const code = (err as { details?: { backendCode?: string } }).details?.backendCode;
    if (code && FILL_REFUSALS.has(code)) return { ok: false, reason: driver.describeError(err) };
    // Focus-race fallback (mirrors search): coordinate-tap the field, then type.
    if (field.rect) {
      await driver.pressAt(
        Math.round(field.rect.x + field.rect.width / 2),
        Math.round(field.rect.y + field.rect.height / 2),
      );
    } else {
      await driver.press(field.ref);
    }
    await Bun.sleep(500);
    await driver.observe();
    await driver.typeText(value);
    await driver.observe();
    return { ok: true, field: field.label, secure: field.role === 'SecureTextField', readback: readBack() };
  }
}

export type VerifyResult = { ok: boolean; detail: string };

// Postcondition check: assert the current screen contains some text. Turns a
// skill from fire-and-hope into checked automation — after "tap Send", verify
// "Delivered"; after "tap Done", verify the list is back. Combined with the
// per-step retry it doubles as wait-for-condition: a verify that retries polls
// the screen until the text appears (or the retries run out).
export async function verifyScreen(contains: string): Promise<VerifyResult> {
  await driver.observe();
  const haystack = `${driver.screenTitle()}\n${driver.currentElements().elements}`.toLowerCase();
  const found = haystack.includes(contains.toLowerCase());
  return { ok: found, detail: found ? `screen contains "${contains}"` : `"${contains}" not on screen` };
}

// --- Validated action batching (UFO2-style, research brief 3 #3) -----------
// One agent turn emits several same-context actions instead of one-per-turn
// round-trip. Each action is re-resolved against the LIVE tree at execution
// time (targets are by LABEL, not @ref — @refs rotate as the screen changes),
// and the batch HALTS on the first action that no longer applies, reporting how
// far it got, so a stale plan can't blindly fire into a changed screen. The
// safety comes from executing one action at a time with a fresh resolve; the
// speed comes from spending one LLM round-trip instead of N.
export type BatchAction =
  | { do: 'tap'; label: string; app?: string }
  | { do: 'fill'; value: string; field?: string; append?: boolean; app?: string }
  | { do: 'toggle'; label: string; on?: boolean; app?: string }
  | { do: 'scroll'; direction: 'up' | 'down' | 'left' | 'right' }
  | { do: 'verify'; contains: string };

export type BatchStep = { do: string; ok: boolean; detail: string };
export type BatchResult = { ok: boolean; steps: BatchStep[]; stoppedAt?: number | undefined };

export async function runActionBatch(actions: BatchAction[], io?: MapIO): Promise<BatchResult> {
  const steps: BatchStep[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!; // loop-bounded: i < actions.length
    let step: BatchStep;
    try {
      switch (a.do) {
        case 'tap': {
          const r = await tapControl(a.label, a.app ? await bundleFor(a.app) : undefined);
          step = {
            do: 'tap',
            ok: r.ok,
            detail: r.ok ? `tapped "${r.label}"${r.changed ? '' : ' (no change)'}` : `"${a.label}" not found`,
          };
          break;
        }
        case 'fill': {
          const r = await setField(a.value, a.field, a.app ? await bundleFor(a.app) : undefined, {
            append: a.append === true,
          });
          step = {
            do: 'fill',
            ok: r.ok,
            detail: r.ok
              ? `${a.append === true ? 'appended to' : 'filled'} "${r.field}"`
              : `field "${a.field ?? '(focused)'}" not found`,
          };
          break;
        }
        case 'toggle': {
          if (!io) {
            step = { do: 'toggle', ok: false, detail: 'toggle needs map access' };
            break;
          }
          const r = await toggleField(
            a.app ? await bundleFor(a.app) : (driver.currentApp() ?? ''),
            a.label,
            io,
            a.on,
          );
          step = {
            do: 'toggle',
            ok: r.ok,
            detail: r.ok ? `${a.label}: ${r.before} → ${r.after}` : `"${a.label}" not found`,
          };
          break;
        }
        case 'scroll': {
          await driver.scroll(a.direction);
          await driver.observe();
          step = { do: 'scroll', ok: true, detail: `scrolled ${a.direction}` };
          break;
        }
        case 'verify': {
          const r = await verifyScreen(a.contains);
          step = { do: 'verify', ok: r.ok, detail: r.detail };
          break;
        }
      }
    } catch (error) {
      step = { do: a.do, ok: false, detail: `error: ${driver.describeError(error)}` };
    }
    steps.push(step!);
    // Halt on the first action that didn't apply — the screen has diverged from
    // the plan, so remaining actions would fire into the wrong context.
    if (!step!.ok) return { ok: false, steps, stoppedAt: i };
  }
  return { ok: true, steps };
}

export type PhoneAnswer = {
  ok: boolean;
  value?: string | undefined;
  app?: string | undefined;
  screen?: string | undefined;
  reason?: string | undefined;
};

// Phone-wide "ask anything": search every mapped app for a screen that lists the
// field, resolve which app has it, navigate there, and read — without being told
// the app. The atlas becomes a knowledge base of the whole phone, and it gets
// richer as more apps are explored.
export async function answerAcrossApps(query: string, io: MapIO): Promise<PhoneAnswer> {
  const q = query.toLowerCase();
  const bundles = io.listMaps ? await io.listMaps() : [];
  for (const app of bundles) {
    const map = await io.loadMap(app);
    if (!map) continue;
    const node = map.nodes.find((n) => n.labels.some((l) => driver.labelMatches(l, q)));
    if (!node) continue;
    const path = findPath(map, node.title);
    if (!path) continue;
    await navigate(app, path);
    const value = await driver.readField(query);
    if (value != null) return { ok: true, value, app, screen: node.title };
  }
  return {
    ok: false,
    reason: bundles.length
      ? `"${query}" isn't on any mapped screen yet — ask within an app to explore for it`
      : 'no apps mapped yet — map an app or ask within one first',
  };
}

// Flip a switch by name WITHOUT knowing its screen: search the map for a screen
// listing the switch, else directed-crawl to the screen that contains it, then
// toggle. Optional `desired` sets it to on/off instead of blind flipping. The
// action analog of answerField.
export async function toggleField(
  app: string,
  switchLabel: string,
  io: MapIO,
  desired?: boolean,
): Promise<ToggleResult> {
  const q = switchLabel.toLowerCase();
  const map = await io.loadMap(app);

  let reached = false;
  if (map) {
    const node = map.nodes.find((n) => n.labels.some((l) => driver.labelMatches(l, q)));
    if (node) {
      const path = findPath(map, node.title);
      if (path) {
        await navigate(app, path);
        reached = true;
      }
    }
  }
  if (!reached) {
    const explored = await crawlToward(app, switchLabel, { stopOnContain: true });
    const merged = map ? mergeMaps(map, explored.map) : explored.map;
    await io.saveMap(merged);
    if (!explored.found)
      return { ok: false, nav: 'search', reason: `switch "${switchLabel}" not found in ${app}` };
  }

  return flipHere(switchLabel, reached ? 'map' : 'search', desired);
}

// Toggle a switch on the current screen (shared by toggle/toggleField).
async function flipHere(
  switchLabel: string,
  nav: 'map' | 'search',
  desired?: boolean,
): Promise<ToggleResult> {
  const el = await driver.findElement(switchLabel);
  const sw =
    el && el.role !== 'Switch'
      ? (driver
          .interactiveElements()
          .find((e) => e.role === 'Switch' && e.label.toLowerCase().includes(switchLabel.toLowerCase())) ??
        el)
      : el;
  if (!sw) return { ok: false, nav, reason: `switch "${switchLabel}" not on this screen` };

  const before = sw.value ?? '';
  const wantOn = desired === true ? '1' : desired === false ? '0' : null;
  if (wantOn != null && before === wantOn) return { ok: true, before, after: before, changed: false, nav };
  if (sw.rect) {
    await driver.pressAt(
      Math.round(sw.rect.x + sw.rect.width - 24),
      Math.round(sw.rect.y + sw.rect.height / 2),
    );
  } else {
    await driver.press(sw.ref);
  }
  await driver.observe();
  const after = (await driver.findElement(switchLabel))?.value ?? '';
  return { ok: true, before, after, changed: before !== after, nav };
}

// Navigate to `destination`, find the switch whose label contains `switchLabel`,
// tap it, and confirm its value flipped.
export async function toggle(
  app: string,
  destination: string,
  switchLabel: string,
  io: MapIO,
): Promise<ToggleResult> {
  const nav = await smartGoto(app, destination, io);
  if (!nav.ok)
    return { ok: false, nav: nav.mapped, reason: `could not reach "${destination}" (${nav.reason})` };

  let el = await driver.findElement(switchLabel);
  // Prefer an actual Switch when several rows share the label text.
  if (el && el.role !== 'Switch') {
    const sw = driver
      .interactiveElements()
      .find((e) => e.role === 'Switch' && e.label.toLowerCase().includes(switchLabel.toLowerCase()));
    if (sw) el = sw;
  }
  if (!el)
    return { ok: false, nav: nav.mapped, reason: `switch "${switchLabel}" not found on ${destination}` };

  const before = el.value ?? '';
  // The toggle control sits at the right edge of the row; a center tap misses it.
  if (el.rect) {
    await driver.pressAt(
      Math.round(el.rect.x + el.rect.width - 24),
      Math.round(el.rect.y + el.rect.height / 2),
    );
  } else {
    await driver.press(el.ref);
  }
  await driver.observe();
  const after = (await driver.findElement(switchLabel))?.value ?? '';
  return { ok: true, before, after, changed: before !== after, nav: nav.mapped };
}

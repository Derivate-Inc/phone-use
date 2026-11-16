import { z } from 'zod';
import { forgetMap, listMaps, loadMap, saveMap, summarize } from './appmap.ts';
import { resolveApp } from './apps.ts';
import {
  type AtlasBundle,
  atlasOverview,
  exportAtlas,
  importAtlas,
  inspectAtlas,
  summarizeDiff,
  summarizeOverview,
} from './atlas.ts';
import { detectBlindTree } from './blind-tree.ts';
import * as driver from './driver.ts';
import { currentExecution } from './execution-context.ts';
import { crawl, smartGoto } from './explore.ts';
import { extractOtp } from './otp.ts';
import { record, recordingStatus, startRecording, stopRecording } from './recorder.ts';
import {
  forgetSkill,
  listSkills,
  loadSkill,
  parameterizeSkill,
  runSkill,
  type Skill,
  saveSkill,
} from './skills.ts';
import {
  answerAcrossApps,
  answerField,
  type BatchAction,
  longPressControl,
  runActionBatch,
  searchAndOpen,
  setField,
  tapControl,
  search as taskSearch,
  toggle as taskToggle,
  toggleField,
  verifyScreen,
} from './task.ts';
import { currentTraceSession } from './trace-session.ts';

// ---------------------------------------------------------------------------
// The single source of truth for the tool surface. Both the MCP server and the
// built-in agent loop RENDER this registry — one definition, two surfaces, so
// descriptions/behavior can never drift between them (the v1 disease).
//
// Slimmed per the harness-v2 decision doc (research/10): 45 tools → 16
// (~6.6k → ~2.3k schema tokens). Verb-level `risk` tags are the floor of the
// permission system; element-level vetting (a toggle labeled "Delete Account"
// escalates regardless of verb) layers on top in permissions.ts.
// ---------------------------------------------------------------------------

export type Risk = 'read' | 'navigate' | 'mutate' | 'destructive';

/** Suffix line a text result may carry to attach an image: `[vision] /path.png`. */
export const VISION_MARKER = '[vision] ';

export type ToolDef = {
  name: string;
  description: string;
  /** zod RAW SHAPE — MCP takes it directly; the agent renderer wraps z.object() */
  schema: z.ZodRawShape;
  risk: Risk;
  handler: (args: Record<string, unknown>) => Promise<string>;
  /** rich-channel tools (screenshots) return a file path the MCP renderer turns into image content */
  imagePath?: boolean;
};

async function toBundle(app: string): Promise<string> {
  return (await resolveApp(app))?.bundleId ?? app;
}

// ---------------------------------------------------------------------------
// What a permission check vets. A label the model typed is the obvious signal,
// but a model that observed `@e7 [Button] "Delete Account"` and taps BY REF
// (or by the rect's coordinates, or accepts the sheet that follows) must meet
// the same gate — so refs, coordinates, and alert buttons are resolved against
// the last observation. That cache is in memory, so this stays synchronous;
// an empty cache (fresh process) resolves to nothing, exactly as before.
// ---------------------------------------------------------------------------

function cachedElements(): ReturnType<typeof driver.allElements> {
  try {
    return driver.allElements();
  } catch {
    return [];
  }
}

function labelForRef(ref: unknown): string | undefined {
  if (typeof ref !== 'string' || !ref) return undefined;
  const want = ref.startsWith('@') ? ref : `@${ref}`;
  try {
    return driver.interactiveElements().find((e) => e.ref === want)?.label || undefined;
  } catch {
    return undefined;
  }
}

/** The smallest labelled element whose rect contains (x, y) — what a raw tap lands on. */
function labelAt(at: unknown): string | undefined {
  if (!at || typeof at !== 'object') return undefined;
  const { x, y } = at as { x?: unknown; y?: unknown };
  if (typeof x !== 'number' || typeof y !== 'number') return undefined;
  let best: string | undefined;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const e of cachedElements()) {
    const r = e.rect;
    if (!r || !e.label) continue;
    if (x < r.x || x > r.x + r.width || y < r.y || y > r.y + r.height) continue;
    const area = r.width * r.height;
    if (area < bestArea) {
      best = e.label;
      bestArea = area;
    }
  }
  return best;
}

/**
 * Every button an alert offers, joined — `accept` picks one of them (the
 * affirmative, or failing that any non-negative one, which on a
 * [Cancel, Delete] sheet IS "Delete"), so the lexicon must see them all.
 */
function alertButtonLabels(): string | undefined {
  const all = cachedElements();
  const alert = all.find((e) => e.role === 'Alert');
  const box = alert?.rect;
  const inside = (r: { x: number; y: number; width: number; height: number } | undefined) =>
    !box ||
    !r ||
    (r.x >= box.x - 1 &&
      r.y >= box.y - 1 &&
      r.x + r.width <= box.x + box.width + 1 &&
      r.y + r.height <= box.y + box.height + 1);
  const labels = all.filter((e) => e.role === 'Button' && e.label && inside(e.rect)).map((e) => e.label);
  return labels.length ? labels.join(' → ') : undefined;
}

/** The target string a permission check vets for a tool call (see permissions.ts). */
export function targetOf(tool: string, args: Record<string, unknown>): string | undefined {
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
  switch (tool) {
    case 'tap':
      // inZoom coordinates live in zoomed-screenshot space; without the zoom
      // transform they cannot be matched to an element, so they stay unresolved.
      return s(args.label) ?? labelForRef(args.ref) ?? (args.inZoom === true ? undefined : labelAt(args.at));
    case 'drag':
      return labelAt({ x: args.x, y: args.y });
    case 'type':
      return s(args.field) ?? s(args.text);
    case 'toggle':
      return s(args.switch);
    case 'handle_alert':
      return args.action === 'accept' ? (alertButtonLabels() ?? 'accept alert') : undefined;
    case 'batch': {
      // A batch's actions carry the labels (or refs) the destructive lexicon
      // must see — otherwise {do:'tap', label:'Delete All'} rides through
      // ungated. Join them so element-level vetting covers the whole batch.
      const actions = Array.isArray(args.actions) ? (args.actions as Record<string, unknown>[]) : [];
      const parts = actions
        .map((a) => s(a.label) ?? labelForRef(a.ref) ?? s(a.field) ?? s(a.value))
        .filter((v): v is string => v !== undefined && v !== '');
      return parts.length ? parts.join(' → ') : undefined;
    }
    default:
      return undefined;
  }
}

const io = { loadMap, saveMap, listMaps };
const UDID_RE = /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;

// Task-scoped scratchpad (the `note` tool): a keyed KV store that survives app
// switches within one session/process — the cross-app data-carry mechanism
// (ported from minitap's scratchpad, the AndroidWorld-100% harness).
// PHONE_USE_NOTES=<path> persists it to disk so ONE-SHOT CLI invocations share
// the same scratchpad (each `phone-use note …` is a fresh process).
const defaultTaskNotes = new Map<string, string>();
const taskNotes = () => currentExecution()?.notes ?? defaultTaskNotes;
/** The process scratchpad, for executions that share it (several phones behind one MCP server). */
export const sharedTaskNotes = (): Map<string, string> => defaultTaskNotes;
const notesPath = process.env.PHONE_USE_NOTES;
if (notesPath) {
  try {
    const disk = JSON.parse(await Bun.file(notesPath).text()) as Record<string, string>;
    for (const [k, v] of Object.entries(disk)) taskNotes().set(k, v);
  } catch {
    /* first use — no file yet */
  }
}
async function flushNotes(): Promise<void> {
  if (notesPath && taskNotes() === defaultTaskNotes)
    await Bun.write(notesPath, JSON.stringify(Object.fromEntries(taskNotes())));
}

const after = driver.renderActionResult;

/** How typed text appears in a reply: never verbatim when it went into a secure field. */
function shownText(text: string, secure: boolean): string {
  return secure ? `${text.length} characters (secure field, not echoed)` : JSON.stringify(text);
}

// Bare `type` (no field) requires an already-focused input. When nothing is
// focused, XCTest records a failure AND restarts the runner session, so a
// blind retry loops forever (observed live: 51 turns, 0/8). Recover once with
// the proven focus recipe from task.ts setField's fallback: re-observe, tap
// the center of the best visible editable field, settle, retry typeText ONCE.
// Returns the success note, or null when typing still failed (the caller
// reports a structured failure instead of throwing).
async function typeWithAutoFocus(text: string): Promise<string | null> {
  // Without a named field the focused one is unknown: hold back the text
  // whenever a secure field is on screen.
  const secureOnScreen = async () => {
    await driver.observe().catch(() => undefined);
    return driver.inputFields(true).some((f) => f.role === 'SecureTextField');
  };
  try {
    await driver.typeText(text);
    return `Typed ${shownText(text, await secureOnScreen())}.`;
  } catch {
    /* no focused input — fall through to the auto-focus recovery */
  }
  await driver.observe().catch(() => undefined);
  const vh = driver.viewportHeight();
  const fields = driver.inputFields(true);
  const onScreen = (f: (typeof fields)[number]) => {
    if (!f.rect) return false;
    const cx = f.rect.x + f.rect.width / 2;
    const cy = f.rect.y + f.rect.height / 2;
    return cx > 0 && cy > 0 && cy < vh;
  };
  const target = fields.find(onScreen) ?? fields[0];
  if (!target) return null;
  if (target.rect) {
    await driver.pressAt(
      Math.round(target.rect.x + target.rect.width / 2),
      Math.round(target.rect.y + target.rect.height / 2),
    );
  } else {
    await driver.press(target.ref).catch(() => undefined);
  }
  // Portable sleep (not Bun.sleep): this path is covered by vitest under Node.
  await new Promise((resolve) => setTimeout(resolve, 450));
  try {
    await driver.typeText(text);
    return `Typed ${shownText(text, target.role === 'SecureTextField')} (auto-focused "${target.label || target.role}").`;
  } catch {
    return null;
  }
}

// The corrective error the batch tool returns for malformed action objects —
// previously they either silently no-op'd or crashed the handler with
// "undefined is not an object (evaluating 'step.ok')".
export const BATCH_SHAPES =
  "{do:'tap', label} | {do:'fill', value, field?, append?} | {do:'toggle', label, on?} | {do:'scroll', direction: up|down|left|right} | {do:'verify', contains}";

const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'];

// Why the action object is invalid, or null when it matches an allowed shape.
// Hand-rolled (not zod.safeParse) so the message names the missing key instead
// of a union-error wall.
export function batchActionProblem(a: unknown): string | null {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return 'not an action object';
  const o = a as Record<string, unknown>;
  const str = (k: string) => typeof o[k] === 'string' && (o[k] as string) !== '';
  switch (o.do) {
    case 'tap':
      return str('label') ? null : 'tap needs a string label';
    case 'fill':
      return str('value') ? null : 'fill needs a string value';
    case 'toggle':
      return str('label') ? null : 'toggle needs a string label';
    case 'scroll':
      return SCROLL_DIRECTIONS.includes(o.direction as string)
        ? null
        : 'scroll needs direction: up|down|left|right';
    case 'verify':
      return str('contains') ? null : 'verify needs a string contains';
    default:
      return `unknown do: ${JSON.stringify(o.do)}`;
  }
}

export const REGISTRY: ToolDef[] = [
  // ---- observation -------------------------------------------------------
  {
    name: 'observe',
    risk: 'read',
    description:
      'Look at the current screen: frontmost app + visible elements with @refs the action tools accept. If the screen has not structurally changed since your last observation, returns only what changed (unchanged @refs still apply); pass full=true for the complete list. Pass expect to also run an LLM-free postcondition check ("✓/✗ <text> on screen") — use that to confirm milestones instead of re-reading and judging by eye.',
    schema: {
      full: z.boolean().optional().describe('Force the complete element list instead of a delta'),
      expect: z
        .string()
        .optional()
        .describe('Text that should be on screen — checked LLM-free, result prefixed'),
    },
    handler: async ({ full, expect }) => {
      await driver.observe();
      let prefix = '';
      if (typeof expect === 'string' && expect) {
        const r = await verifyScreen(expect);
        currentTraceSession()?.addVerdict({
          kind: 'verdict',
          source: 'observe-expect',
          expect,
          ok: r.ok,
          detail: r.detail,
        });
        prefix = `${r.ok ? '✓' : '✗'} ${r.detail}\n\n`;
      }
      const text = `${prefix}App: ${driver.currentApp() ?? 'unknown'}\n${driver.renderObservation(full === true)}`;
      // Auto-vision fallback: when the tree is blind to the screen (a WebView,
      // a Flutter canvas, an empty dump), attach a set-of-marks screenshot so
      // the agent can see instead of stalling on an empty listing. Vision
      // costs an inference call, so it fires only when the tree has failed.
      const blind = detectBlindTree(driver.allElements());
      if (blind.blind) {
        const shot = `/tmp/phone-use-vision-${Date.now()}.png`;
        const path = await driver.screenshotWithRefs(shot).catch(() => null);
        if (path) {
          return `${text}\n\n⚠ The accessibility tree is blind here (${blind.reason}). A set-of-marks screenshot is attached — read the screen from the image and tap by the numbered @ref boxes or by coordinates.\n${VISION_MARKER}${path}`;
        }
      }
      return text;
    },
  },
  {
    name: 'screenshot',
    risk: 'read',
    imagePath: true,
    description:
      'Capture the screen as an image (the rich channel; observe is the cheap text channel). marks=true overlays numbered @ref boxes for visual grounding. zoom={x,y,width,height} magnifies a region for tiny targets — then tap with inZoom=true using coordinates read off the magnified image.',
    schema: {
      marks: z.boolean().optional().describe('Overlay @ref boxes (set-of-marks)'),
      zoom: z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .optional()
        .describe('Magnify this screen region'),
    },
    handler: async ({ marks, zoom }) => {
      const out = `/tmp/phone-use-shot-${Date.now()}.png`;
      if (zoom && typeof zoom === 'object') {
        const zr = zoom as { x: number; y: number; width: number; height: number };
        const z = await driver.zoomRegion(zr.x, zr.y, zr.width, zr.height, out);
        return z.path;
      }
      if (marks === true) return driver.screenshotWithRefs(out);
      return driver.screenshot(out);
    },
  },
  {
    name: 'wait_for',
    risk: 'read',
    description:
      'Wait until the given text appears on screen (up to timeoutMs, default 5000). Use after actions that trigger loading instead of polling with observe.',
    schema: { text: z.string(), timeoutMs: z.number().optional() },
    handler: async ({ text, timeoutMs }) =>
      after(await driver.waitForText(String(text), timeoutMs as number | undefined), undefined, true),
  },
  {
    // The consent-gated OTP relay (docs/38): read the one-time verification
    // code that just arrived on the phone, to finish a login the user asked the
    // agent to complete. The phone-only primitive the agent-auth market
    // (Notte/WorkOS) rebuilds with a rented SMS number — done on the real
    // device the code actually lands on.
    name: 'otp',
    risk: 'read',
    description:
      'Read the latest one-time verification code (2FA/OTP) from the phone — the code that just arrived by SMS or notification — to finish a login the user asked you to complete. CONSENT-GATED: pass consent=true, and only when the user explicitly asked you to complete this specific verification. Optionally open=messages to bring a freshly-arrived SMS into view first. Returns the code, a confidence score, and the message it came from; the read is logged. Never read codes the user did not ask you to use.',
    schema: {
      consent: z
        .boolean()
        .optional()
        .describe('Explicit user consent to surface a one-time code for THIS login flow. Required.'),
      open: z
        .enum(['messages'])
        .optional()
        .describe('Open Messages first to surface a freshly-arrived SMS code'),
    },
    handler: async ({ consent, open }) => {
      if (consent !== true) {
        return 'OTP relay needs explicit consent. A one-time code is a sensitive credential — call otp with consent=true only when the user asked you to complete this specific login/verification.';
      }
      if (open === 'messages') await driver.openApp('Messages');
      await driver.observe();
      const lines = driver
        .renderObservation(true)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const hit = extractOtp(lines);
      currentTraceSession()?.addVerdict({
        kind: 'verdict',
        source: 'otp-relay',
        expect: 'one-time verification code',
        ok: hit !== null,
        detail: hit
          ? `code surfaced (confidence ${hit.confidence}) from "${hit.context.slice(0, 60)}"`
          : 'no code found on the current screen',
      });
      if (!hit) {
        return 'No verification code found on the current screen. If one was just sent, call otp with open=messages, or open the app/notification showing the code and retry.';
      }
      return `OTP: ${hit.code}\n(confidence ${hit.confidence} · from "${hit.context.slice(0, 80)}")`;
    },
  },

  // ---- acting ------------------------------------------------------------
  {
    name: 'tap',
    risk: 'mutate',
    description:
      'Tap a control. Target by label (visible text — scrolls to find it; exact match first, then punctuation-tolerant fuzzy), by @ref from the last observation, or by raw at={x,y} coordinates (canvas/custom controls; inZoom=true if the coords were read off a zoomed screenshot). long=true long-presses (context menus). The result reports whether the screen actually changed — check it. VERY IMPORTANT: for navigation across screens prefer goto; tap is for controls on or near the current screen.',
    schema: {
      label: z.string().optional().describe('Visible text (or accessibility id) of the control'),
      ref: z.string().optional().describe('Element @ref, e.g. @e8'),
      at: z.object({ x: z.number(), y: z.number() }).optional().describe('Raw coordinates'),
      inZoom: z.boolean().optional().describe('at={x,y} is in zoomed-screenshot space'),
      long: z.boolean().optional().describe('Long-press instead of tap'),
      role: z
        .string()
        .optional()
        .describe(
          'Disambiguator: required element role (Button, Cell, Link…) when the label matches several controls',
        ),
      near: z
        .string()
        .optional()
        .describe('Disambiguator: label of a nearby element; the closest match wins'),
      app: z.string().optional().describe('App to act in (defaults to current)'),
    },
    handler: async ({ label, ref, at, inZoom, long, role, near, app }) => {
      const bundle = typeof app === 'string' && app ? await toBundle(app) : undefined;
      if (typeof label === 'string' && label) {
        if (long === true) {
          const r = await longPressControl(label, bundle);
          return after(r.ok ? `Long-pressed "${r.label}".` : `Long-press failed: ${r.reason}`);
        }
        const r = await tapControl(label, bundle, {
          role: role as string | undefined,
          near: near as string | undefined,
        });
        if (r.ok) record({ op: 'tap', label, ...(app === undefined ? {} : { app: String(app) }) });
        return after(
          r.ok
            ? `Tapped "${r.label}"${r.via ? ` (matched via ${r.via})` : ''}${r.changed === true ? '' : r.changed === false ? ' (no change)' : ' (screen change unverified)'}.`
            : `Tap failed: ${r.reason}`,
        );
      }
      if (typeof ref === 'string' && ref) {
        if (long === true) {
          await driver.longPress(ref);
          return after(`Long-pressed ${ref}.`, undefined, true);
        }
        return after(`Tapped ${ref}.`, await driver.press(ref));
      }
      if (at && typeof at === 'object') {
        const p = at as { x: number; y: number };
        const evidence =
          inZoom === true ? await driver.pressInZoom(p.x, p.y) : await driver.pressAt(p.x, p.y);
        return after(`Tapped (${p.x}, ${p.y})${inZoom === true ? ' (zoom space)' : ''}.`, evidence);
      }
      return 'tap needs label, ref, or at={x,y}.';
    },
  },
  {
    name: 'type',
    risk: 'mutate',
    description:
      "Type text. With field, finds the input by its label/placeholder (scroll-aware), focuses it, clears, and types — use for forms. append=true inserts at the END of the field's existing content instead of clearing it — REQUIRED when adding to a document/note/spreadsheet cell that already has content you must keep. Without field, types into the currently focused input — use after tapping a field yourself. submit=true presses Return afterward (address bars, web forms — needed where results only load on Enter).",
    schema: {
      text: z.string(),
      field: z.string().optional().describe('Label/placeholder of the target field'),
      append: z
        .boolean()
        .optional()
        .describe('Insert at the end of existing content instead of replacing it (documents/notes)'),
      submit: z.boolean().optional().describe('Press Return after typing'),
      app: z.string().optional(),
    },
    handler: async ({ text, field, append, submit, app }) => {
      const bundle = typeof app === 'string' && app ? await toBundle(app) : undefined;
      let note: string;
      if (typeof field === 'string' && field) {
        const r = await setField(String(text), field, bundle, { append: append === true });
        if (!r.ok) return after(`Fill failed: ${r.reason}`);
        if (r.ok)
          record({
            op: 'fill',
            value: String(text),
            field,
            ...(app === undefined ? {} : { app: String(app) }),
          });
        // Read-back = ground truth: report what the field ACTUALLY contains
        // now, so the model verifies instead of assuming (minitap port).
        const verified =
          r.readback === undefined
            ? ' Could not read the field back — verify before moving on.'
            : ` Field now contains ${JSON.stringify(r.readback)}.`;
        // Never echo what was typed into a secure field: known by its type, or
        // by a bullet-only read-back when a custom field hides its type.
        const secure = r.secure === true || (!!r.readback && /^[•●]+$/u.test(r.readback));
        const shown = shownText(String(text), secure);
        note =
          append === true
            ? `Appended ${shown} to "${r.field}".${verified}`
            : `Filled "${r.field}" with ${shown}.${verified}`;
      } else {
        const typed = await typeWithAutoFocus(String(text));
        if (typed === null) {
          // Structured failure instead of a throw: the raw XCTest error both
          // reads as transient (inviting infinite retries) and restarts the
          // runner session.
          return 'type failed: no focused input — tap a field first or pass field=<label>.';
        }
        note = typed;
      }
      if (submit === true) {
        await driver.pressReturn();
        note += ' Pressed Return.';
      }
      return after(note, undefined, true);
    },
  },
  {
    name: 'scroll',
    risk: 'navigate',
    description: 'Scroll the screen to reveal more content.',
    schema: { direction: z.enum(['up', 'down', 'left', 'right']) },
    handler: async ({ direction }) => {
      await driver.scroll(direction as 'up' | 'down' | 'left' | 'right');
      return after(`Scrolled ${String(direction)}.`, undefined, true);
    },
  },
  {
    name: 'drag',
    risk: 'mutate',
    description:
      "Touch down at (x,y) and drag by (dx,dy) — for controls a tap can't operate: PICKER WHEELS (time/date/count: drag vertically on the wheel column; one row ≈ 32px, so dy=-32 advances one value, dy=32 goes back one), sliders, and custom carousels. Coordinates come from observe rects (use the wheel's center). Verify the new value with the returned screen before moving on.",
    schema: {
      x: z.number().describe('Touch-down X (center of the control, from observe rects)'),
      y: z.number().describe('Touch-down Y'),
      dx: z.number().describe('Horizontal drag distance (negative = left)'),
      dy: z.number().describe('Vertical drag distance (negative = up; -32 ≈ one picker row forward)'),
      durationMs: z
        .number()
        .optional()
        .describe('Drag duration (default backend-chosen; slower = more precise)'),
    },
    handler: async ({ x, y, dx, dy, durationMs }) => {
      // The simulator's HID pan is a silent no-op for snap-list pickers and
      // wheels; a local WDA gesture daemon (scratchpad/gesture-daemon.py)
      // performs a real W3C touch drag. Fall back to pan if it's not running.
      let viaDaemon = false;
      // The simulator this call drives, never the environment's: with several
      // phones the environment names at most one of them.
      const pinned = (driver.defaultDeviceContext().backend as { udid?: unknown }).udid;
      const udid = typeof pinned === 'string' && UDID_RE.test(pinned) ? pinned : undefined;
      if (udid) {
        try {
          const r = await fetch(
            `http://127.0.0.1:4790/drag?udid=${udid}&x=${String(x)}&y=${String(y)}&dx=${String(dx)}&dy=${String(dy)}&ms=${String(durationMs ?? 450)}`,
            { signal: AbortSignal.timeout(120_000) },
          );
          viaDaemon = ((await r.json()) as { ok?: boolean }).ok === true;
        } catch {
          viaDaemon = false;
        }
      }
      if (!viaDaemon) {
        await driver.pan(
          Number(x),
          Number(y),
          Number(dx),
          Number(dy),
          durationMs === undefined ? undefined : Number(durationMs),
        );
      }
      return after(
        `Dragged from (${String(x)}, ${String(y)}) by (${String(dx)}, ${String(dy)}).`,
        undefined,
        true,
      );
    },
  },
  {
    name: 'handle_alert',
    risk: 'mutate',
    description:
      'Check for or clear a system alert/permission dialog. get reports it, accept taps the affirmative button, dismiss cancels. If taps seem to have no effect, an alert may be blocking — check with this.',
    schema: { action: z.enum(['get', 'accept', 'dismiss']) },
    handler: async ({ action }) => {
      const outcome = await driver.handleAlert(action as 'get' | 'accept' | 'dismiss');
      if (!outcome.present) return 'No system alert is showing.';
      const base = `Alert: ${outcome.description ?? 'unknown'}`;
      if (action === 'get') return base;
      return after(
        `${base} — ${outcome.handled ? `handled via "${outcome.button}"` : 'NOT handled'}.`,
        undefined,
        true,
      );
    },
  },
  {
    name: 'open',
    risk: 'navigate',
    description:
      'Open an app (by name like "Settings" or bundle id) or a URL/deep link (maps://?q=coffee, https://…). PREFER a deep link over tapping through screens when a route exists. If a URL opens a different app than the current one, pass app too so observation follows it.',
    schema: {
      app: z.string().optional().describe('App name or bundle id'),
      url: z.string().optional().describe('URL or deep link'),
    },
    handler: async ({ app, url }) => {
      if (typeof url === 'string' && url) {
        const target = typeof app === 'string' && app ? await toBundle(app) : undefined;
        const note = await driver.openUrl(url, target);
        record({ op: 'open_url', url, ...(target === undefined ? {} : { app: target }) });
        return after(note, undefined, true);
      }
      if (typeof app === 'string' && app) {
        const bundle = await toBundle(app);
        const note = await driver.openApp(bundle);
        record({ op: 'open_app', app });
        return after(note, undefined, true);
      }
      return 'open needs app or url.';
    },
  },
  {
    name: 'nav',
    risk: 'navigate',
    description: 'System navigation: to=back (previous screen) or to=home (home screen).',
    schema: { to: z.enum(['back', 'home']) },
    handler: async ({ to }) => {
      if (to === 'home') {
        await driver.goHome();
        record({ op: 'home' });
        return after('Went home.', undefined, true);
      }
      await driver.goBack();
      record({ op: 'back' });
      return after('Went back.', undefined, true);
    },
  },

  // ---- intent verbs (the map-powered layer — the product) ----------------
  {
    name: 'goto',
    risk: 'navigate',
    description:
      'Navigate to a named screen with ZERO model steps: computes the shortest tap-path from the app map and executes it (auto-crawls a map if none exists, self-heals if the app changed). VERY IMPORTANT: prefer this over tapping through screens — one call replaces a whole navigation sequence.',
    schema: {
      app: z.string().describe('App name or bundle id'),
      destination: z.string().describe('Screen title or row label, e.g. "About", "Accessibility"'),
    },
    handler: async ({ app, destination }) => {
      const bundle = await toBundle(String(app));
      const r = await smartGoto(bundle, String(destination), io);
      if (!r.ok) return `Could not reach "${String(destination)}": ${r.reason}`;
      record({ op: 'goto', app: String(app), destination: String(destination) });
      await driver.observe();
      return `Navigated to "${String(destination)}" (${r.mapped}) via ${r.path?.length ? r.path.join(' → ') : '(root)'}.\n\nScreen (app: ${driver.currentApp() ?? String(app)}):\n${driver.renderObservation(true)}`;
    },
  },
  {
    name: 'ask',
    risk: 'read',
    description:
      'Read a value by name without knowing its screen — with app, searches that app\'s map, navigates, and reads; without app, resolves which mapped app has it across the whole phone. E.g. ask "iOS Version" → "26.1". Prefer this over manual navigation for reading any labeled value.',
    schema: {
      field: z.string().describe('The labeled value to read, e.g. "iOS Version", "Model Name"'),
      app: z.string().optional(),
    },
    handler: async ({ field, app }) => {
      if (typeof app === 'string' && app) {
        const bundle = await toBundle(app);
        const r = await answerField(bundle, String(field), io);
        if (r.ok) record({ op: 'ask', app, field: String(field) });
        return r.ok
          ? `${String(field)} = ${r.value} (on ${r.screen}, via ${r.via})`
          : `Could not read "${String(field)}": ${r.reason}`;
      }
      const r = await answerAcrossApps(String(field), io);
      if (r.ok) record({ op: 'ask', field: String(field) });
      return r.ok
        ? `${String(field)} = ${r.value} (${r.app} → ${r.screen})`
        : `Could not resolve "${String(field)}": ${r.reason}`;
    },
  },
  {
    name: 'search',
    risk: 'navigate',
    description:
      "Use an app's search: reveals the search field (both iOS patterns), types the query. submit=true presses Return (address bars). open=true taps the best-matching result afterward (match narrows which one) — search+act in one call.",
    schema: {
      app: z.string(),
      query: z.string(),
      submit: z.boolean().optional().describe('Press Return after typing'),
      open: z.boolean().optional().describe('Open the best-matching result'),
      match: z.string().optional().describe('Substring the opened result should contain'),
    },
    handler: async ({ app, query, submit, open, match }) => {
      const bundle = await toBundle(String(app));
      if (open === true) {
        const r = await searchAndOpen(bundle, String(query), match as string | undefined);
        if (r.ok)
          record({
            op: 'search_open',
            app: String(app),
            query: String(query),
            ...(match === undefined ? {} : { match: String(match) }),
          });
        return after(
          r.ok ? `Searched "${String(query)}" and opened "${r.opened}".` : `Search failed: ${r.reason}`,
        );
      }
      const r = await taskSearch(bundle, String(query), submit === true);
      if (r.ok)
        record({
          op: 'search',
          app: String(app),
          query: String(query),
          ...(submit === undefined ? {} : { submit: submit === true }),
        });
      return after(r.ok ? `Searched "${String(query)}" in ${String(app)}.` : `Search failed: ${r.reason}`);
    },
  },
  {
    name: 'toggle',
    risk: 'mutate',
    description:
      'Flip a switch by name without knowing its screen — finds it via the map (or directed crawl), navigates, and sets it. on=true/false sets a desired state (idempotent: reports "already set" instead of flipping back); omit to blind-flip. destination pins the screen if you know it.',
    schema: {
      app: z.string(),
      switch: z.string().describe('The switch\'s label, e.g. "Full-Screen Previews"'),
      on: z.boolean().optional(),
      destination: z.string().optional().describe('Screen holding the switch, if known'),
    },
    handler: async ({ app, switch: sw, on, destination }) => {
      const bundle = await toBundle(String(app));
      // taskToggle (destination-pinned) has no desired-state param; toggleField does.
      const r =
        typeof destination === 'string' && destination
          ? await taskToggle(bundle, destination, String(sw), io)
          : await toggleField(bundle, String(sw), io, on as boolean | undefined);
      if (r.ok)
        record({
          op: 'toggle',
          app: String(app),
          switch: String(sw),
          ...(on === undefined ? {} : { on: on === true }),
        });
      return r.ok
        ? `${String(sw)}: ${r.before} → ${r.after}${r.changed ? '' : ' (already set)'}`
        : `Could not toggle "${String(sw)}": ${r.reason}`;
    },
  },

  // ---- task memory -------------------------------------------------------
  {
    name: 'note',
    risk: 'read',
    description:
      'Task scratchpad — the reliable way to carry data ACROSS apps and screens (observations are lost when you navigate). op=save stores content under a key (overwrites); op=read returns it; op=list shows saved keys. Pattern: before leaving a screen whose data you need later, note save it; after arriving where it is needed, note read it. Write plain text exactly as observed.',
    schema: {
      op: z.enum(['save', 'read', 'list']),
      key: z.string().optional().describe('Note name, e.g. "ingredients"'),
      content: z.string().optional().describe('For save: the text to store, exactly as observed'),
    },
    handler: async ({ op, key, content }) => {
      if (op === 'list') {
        const keys = [...taskNotes().keys()];
        return keys.length ? `Notes: ${keys.join(', ')}` : 'No notes saved yet.';
      }
      if (typeof key !== 'string' || !key) return `note ${String(op)} needs key.`;
      if (op === 'save') {
        if (typeof content !== 'string') return 'note save needs content.';
        taskNotes().set(key, content);
        await flushNotes();
        return `Saved note "${key}" (${content.length} chars).`;
      }
      const hit = taskNotes().get(key);
      return hit === undefined
        ? `No note named "${key}". Saved: ${[...taskNotes().keys()].join(', ') || '(none)'}`
        : `Note "${key}": ${hit}`;
    },
  },

  // ---- composition -------------------------------------------------------
  {
    name: 'batch',
    risk: 'mutate',
    description:
      'Run several known actions in one call (e.g. tap "General" then tap "About"). Targets are labels, each re-resolved against the live screen and run one at a time; the batch STOPS at the first action whose target is absent and reports how far it got. Use for a known linear sequence to save round-trips; use single tools when the next step depends on what you see.',
    schema: {
      actions: z
        .array(
          z.union([
            z.object({ do: z.literal('tap'), label: z.string(), app: z.string().optional() }),
            z.object({
              do: z.literal('fill'),
              value: z.string(),
              field: z.string().optional(),
              app: z.string().optional(),
            }),
            z.object({
              do: z.literal('toggle'),
              label: z.string(),
              on: z.boolean().optional(),
              app: z.string().optional(),
            }),
            z.object({ do: z.literal('scroll'), direction: z.enum(['up', 'down', 'left', 'right']) }),
            z.object({ do: z.literal('verify'), contains: z.string() }),
          ]),
        )
        .describe('Ordered actions to run until one fails'),
    },
    handler: async ({ actions }) => {
      // Validate every action BEFORE running any: the CLI surface parses
      // --actions as raw JSON, so malformed shapes reach this handler
      // unchecked and used to crash mid-batch.
      if (!Array.isArray(actions) || actions.length === 0) {
        return `batch needs a non-empty actions array. Valid shapes: ${BATCH_SHAPES}`;
      }
      for (let i = 0; i < actions.length; i++) {
        const problem = batchActionProblem(actions[i]);
        if (problem) {
          return `batch action ${i + 1} is invalid — ${problem} (got ${JSON.stringify(actions[i])?.slice(0, 120)}). Valid shapes: ${BATCH_SHAPES}. Nothing was run.`;
        }
      }
      const r = await runActionBatch(actions as BatchAction[], io);
      const lines = r.steps.map((s, i) => `${i + 1}. ${s.do}: ${s.ok ? '✓' : '✗'} ${s.detail}`).join('\n');
      const tail = r.ok
        ? 'All actions completed.'
        : `Stopped at action ${(r.stoppedAt ?? 0) + 1} — screen diverged from plan.`;
      return after(`Batch:\n${lines}\n${tail}`, undefined, true);
    },
  },
  {
    name: 'skill',
    risk: 'mutate',
    description:
      'Replayable errands (zero model calls on replay). op=run replays a saved skill (args fill its {{params}}, retries per step). op=record/stop learns by watching: record, perform the errand with the other tools, stop — the successful steps are saved. op=parameterize promotes recorded literals to {{params}} (bindings: {param: literal}). op=list/status/forget manage the library. op=save stores hand-written steps.',
    schema: {
      op: z.enum(['run', 'save', 'list', 'record', 'stop', 'status', 'parameterize', 'forget']),
      name: z.string().optional(),
      description: z.string().optional(),
      steps: z.array(z.record(z.string(), z.unknown())).optional().describe('For save: skill steps'),
      args: z.record(z.string(), z.string()).optional().describe("For run: values for the skill's params"),
      retries: z.number().optional(),
      bindings: z.record(z.string(), z.string()).optional().describe('For parameterize: {param: literal}'),
    },
    handler: async ({ op, name, description, steps, args, retries, bindings }) => {
      switch (op) {
        case 'run': {
          if (!name) return 'skill run needs name.';
          const skill = await loadSkill(String(name));
          if (!skill) return `No skill named "${String(name)}". op=list shows the library.`;
          const run = await runSkill(skill, (args as Record<string, string>) ?? {}, {
            retries: (retries as number) ?? 1,
          });
          const lines = run.steps.map(
            (s) =>
              `${s.ok ? '✓' : '✗'} ${s.op}: ${s.detail}${(s.attempts ?? 1) > 1 ? ` (${s.attempts} attempts)` : ''}`,
          );
          return `${run.ok ? 'Skill succeeded' : 'Skill FAILED'} — ${run.skill}\n${lines.join('\n')}`;
        }
        case 'save': {
          if (!name || !Array.isArray(steps)) return 'skill save needs name and steps.';
          const skill = {
            name: String(name),
            description: description as string | undefined,
            steps,
          } as unknown as Skill;
          const path = await saveSkill(skill);
          return `Saved skill "${String(name)}" (${steps.length} steps) → ${path}`;
        }
        case 'list': {
          const names = await listSkills();
          if (!names.length) return 'No skills saved yet. Record one (op=record) or save steps (op=save).';
          const detail = await Promise.all(
            names.map(async (n) => {
              const s = await loadSkill(n);
              return `${n}${s?.params?.length ? ` (params: ${s.params.join(', ')})` : ''}${s?.description ? ` — ${s.description}` : ''}`;
            }),
          );
          return detail.join('\n');
        }
        case 'record': {
          if (!name) return 'skill record needs name.';
          startRecording(String(name), description as string | undefined);
          return `Recording "${String(name)}" — perform the errand with the other tools, then op=stop.`;
        }
        case 'stop': {
          const skill = await stopRecording();
          if (!skill) return 'No recording was active.';
          return skill.steps.length
            ? `Saved skill "${skill.name}" (${skill.steps.length} steps): ${skill.steps.map((s) => s.op).join(' → ')}`
            : 'Recording ended but captured no successful steps — nothing saved.';
        }
        case 'status': {
          const s = recordingStatus();
          return s ? `Recording "${s.name}" — ${s.steps} step(s) so far.` : 'Not recording.';
        }
        case 'parameterize': {
          if (!name || !bindings) return 'skill parameterize needs name and bindings.';
          const skill = await loadSkill(String(name));
          if (!skill) return `No skill named "${String(name)}".`;
          const out = parameterizeSkill(skill, bindings as Record<string, string>);
          await saveSkill(out);
          return `Parameterized "${String(name)}" — params: ${out.params?.join(', ')}.`;
        }
        case 'forget': {
          if (!name) return 'skill forget needs name.';
          return (await forgetSkill(String(name)))
            ? `Forgot skill "${String(name)}".`
            : `No skill named "${String(name)}".`;
        }
      }
      return 'unknown skill op';
    },
  },
  {
    name: 'atlas',
    risk: 'read',
    description:
      "The phone's learned knowledge (app maps + skills). op=overview: what is mapped/learned (cheap index — start here). op=inspect: one app's map in full, including what each element does. op=map: crawl/extend an app's map now. op=export/import: share knowledge as a portable bundle (import merges). op=inspect_bundle previews a bundle before importing. op=forget_map deletes an app's map.",
    schema: {
      op: z.enum(['overview', 'inspect', 'map', 'export', 'import', 'inspect_bundle', 'forget_map']),
      app: z.string().optional(),
      maxScreens: z.number().optional().describe('For map: crawl budget'),
      bundle: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('For import/inspect_bundle: the bundle JSON'),
    },
    handler: async ({ op, app, maxScreens, bundle }) => {
      switch (op) {
        case 'overview':
          return summarizeOverview(await atlasOverview());
        case 'inspect': {
          if (!app) return 'atlas inspect needs app.';
          const map = await loadMap(await toBundle(String(app)));
          return map ? summarize(map) : `No map for ${String(app)} yet — op=map crawls one.`;
        }
        case 'map': {
          if (!app) return 'atlas map needs app.';
          const b = await toBundle(String(app));
          const map = await crawl(b, { maxScreens: (maxScreens as number) ?? 14 });
          const existing = await loadMap(b);
          const merged = existing ? (await import('./explore.ts')).mergeMaps(existing, map) : map;
          await saveMap(merged);
          return summarize(merged);
        }
        case 'export': {
          const out = await exportAtlas();
          return JSON.stringify(out);
        }
        case 'import': {
          if (!bundle) return 'atlas import needs bundle.';
          const s = await importAtlas(bundle as unknown as AtlasBundle);
          return `Imported ${s.maps} maps (${s.mergedMaps} merged), ${s.skills} skills.`;
        }
        case 'inspect_bundle': {
          if (!bundle) return 'atlas inspect_bundle needs bundle.';
          return summarizeDiff(await inspectAtlas(bundle as unknown as AtlasBundle));
        }
        case 'forget_map': {
          if (!app) return 'atlas forget_map needs app.';
          return (await forgetMap(await toBundle(String(app))))
            ? `Forgot map for ${String(app)}.`
            : `No map for ${String(app)}.`;
        }
      }
      return 'unknown atlas op';
    },
  },
];

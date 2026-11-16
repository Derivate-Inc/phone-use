// Tier 1 probes (docs/43-device-layer-eval.md). Each probe performs ONE agent-like step through
// the tool's documented interface (observe, choose the target the way an agent would, act) and
// judges the effect from Gauntlet's event log. The tool's reply is the claim; it never grades.
//
// Rules: a probe never inspects tool internals, never retries an action, and gives every tool
// the same steps. Changing a probe needs a written reason in eval/README.md ("Fixture changes").
import { appRunning, sleep } from './sim.ts';
import type { Adapter, Claim, Effect, Element, Ev, Expect, Observation, ProbeOutcome } from './types.ts';

export type Ctx = {
  udid: string;
  run: string;
  seed: number;
  tool: Adapter;
  events(): Promise<Ev[]>;
  waitFor(pred: (e: Ev) => boolean, timeoutMs: number): Promise<Ev | undefined>;
  notify(command: 'mutate' | 'present'): Promise<void>;
  /** Fields of the scenario's "fixture" events (what the seed chose). */
  fixture(): Promise<Record<string, unknown>>;
};

export type Probe = {
  id: string;
  scenario: string;
  title: string;
  expect: Expect;
  /** Where the case comes from (an issue, a teardown), so cases trace to outside evidence. */
  evidence: string;
  /** Reinstall Gauntlet before (fresh permissions) and after (no prompt left behind). */
  reinstall?: boolean;
  /** Wait for this event before the probe starts (default: the first "ready"). */
  readyWhen?: (e: Ev) => boolean;
  run(ctx: Ctx): Promise<ProbeOutcome>;
};

// ---------- helpers ----------

/** The element an agent would pick for `label`: exact label first, then contains; optional role filter. */
export function pick(o: Observation, label: string | RegExp, role?: RegExp): Element | undefined {
  // A tool that names no roles is matched on its label alone,
  // as an agent reading it would.
  const ok = (e: Element) => !role || !e.role || role.test(e.role);
  if (label instanceof RegExp) return o.elements.find((e) => ok(e) && label.test(e.label));
  return (
    o.elements.find((e) => ok(e) && e.label === label) ??
    o.elements.find((e) => ok(e) && e.label.includes(label))
  );
}

const after = (evs: Ev[], t: number) => evs.filter((e) => e.t >= t);
const activations = (evs: Ev[]) => evs.filter((e) => e.kind === 'activate').map((e) => String(e.id));
const nowSec = () => Date.now() / 1000;

/** Effect of a tap that should fire exactly `want`. */
function tapEffect(evs: Ev[], want: string): { effect: Effect; detail: string } {
  const fired = activations(evs);
  const left = evs.some((e) => e.kind === 'lifecycle' && e.state === 'background');
  if (left) return { effect: 'wrong', detail: `left the app; fired [${fired.join(', ')}]` };
  if (fired.length === 0) return { effect: 'none', detail: 'nothing fired' };
  if (fired.every((f) => f === want) && fired.length === 1)
    return { effect: 'intended', detail: `fired ${want}` };
  if (fired.includes(want))
    return { effect: 'wrong', detail: `fired [${fired.join(', ')}] (extra activations)` };
  return { effect: 'wrong', detail: `fired [${fired.join(', ')}], wanted ${want}` };
}

/** Effect of a tap that must not fire anything (refusal probes). */
function noFireEffect(evs: Ev[]): { effect: Effect; detail: string } {
  const fired = activations(evs);
  const side = evs.filter(
    (e) =>
      (e.kind === 'sheet' && e.shown === false) ||
      e.kind === 'text' ||
      (e.kind === 'lifecycle' && e.state === 'background'),
  );
  if (fired.length) return { effect: 'wrong', detail: `fired [${fired.join(', ')}]` };
  if (side.length) return { effect: 'wrong', detail: `side effect: ${side.map((e) => e.kind).join(', ')}` };
  return { effect: 'none', detail: 'nothing fired' };
}

function lastValue(evs: Ev[], id: string): string | undefined {
  const vs = evs.filter(
    (e) => (e.kind === 'text' || e.kind === 'formatted' || e.kind === 'focus') && e.id === id && 'value' in e,
  );
  return vs.length ? String(vs[vs.length - 1]!.value) : undefined;
}

const refused = (what: string, ms = 0): Claim => ({
  status: 'refused',
  ms,
  output: what,
  call: '(not offered)',
});

/** Observe, then find the target; when the tool does not offer it, an agent tries the label. */
async function observeAndTap(
  ctx: Ctx,
  label: string | RegExp,
  role?: RegExp,
): Promise<{ claim: Claim; offered: boolean; obs: Observation }> {
  const obs = await ctx.tool.observe();
  const el = pick(obs, label, role);
  if (el) return { claim: await ctx.tool.tapRef(el), offered: true, obs };
  if (typeof label === 'string') return { claim: await ctx.tool.tapLabel(label), offered: false, obs };
  return { claim: refused(`no element matching ${label}`), offered: false, obs };
}

// ---------- probes ----------

export const PROBES: Probe[] = [
  ...(
    [
      [
        'A1',
        'Ref from before rows were inserted above the target',
        'our own tests of device tools: rows inserted late moved the target before the tap (Settings, General → Siri)',
      ],
      [
        'A1i',
        'Same, but cells carry index identifiers, so after the insert two rows can share one',
        'found by this eval (fixture change, 2026-11-04); index identifiers set in cellForRowAt are common in UIKit lists',
      ],
    ] as const
  ).map(
    ([id, title, evidence]): Probe => ({
      id,
      scenario: id,
      title,
      expect: 'act',
      evidence,
      async run(ctx) {
        const { target } = (await ctx.fixture()) as { target: string };
        const obs = await ctx.tool.observe();
        if (obs.elements.some((e) => e.label.startsWith('Promotion')))
          return { invalid: 'observed after the insert', detail: '' };
        const el = pick(obs, target);
        if (!el) return { setupFailed: `"${target}" not offered by observe`, detail: '' };
        await ctx.notify('mutate');
        if (!(await ctx.waitFor((e) => e.kind === 'mutated', 5000)))
          return { invalid: 'the insert did not happen', detail: '' };
        const t = nowSec();
        const claim = await ctx.tool.tapRef(el);
        await sleep(500);
        return { claim, ...tapEffect(after(await ctx.events(), t), `row:${target}`) };
      },
    }),
  ),
  {
    id: 'A2',
    scenario: 'A2',
    title: 'Two controls share a label; tap the toolbar one by ref',
    expect: 'act',
    evidence: 'our own tests of device tools: with duplicate labels the wrong control was reached (a Dictation alert)',
    async run(ctx) {
      const { label } = (await ctx.fixture()) as { label: string };
      const obs = await ctx.tool.observe();
      const same = obs.elements.filter((e) => e.label === label && e.rect);
      if (same.length === 0) return { setupFailed: `no "${label}" offered`, detail: '' };
      const lowest = same.reduce((a, b) => ((a.rect?.y ?? 0) >= (b.rect?.y ?? 0) ? a : b));
      const t = nowSec();
      const claim = await ctx.tool.tapRef(lowest);
      await sleep(400);
      const r = tapEffect(after(await ctx.events(), t), 'toolbar-item');
      return { claim, ...r, extra: { offered: same.length } };
    },
  },
  {
    id: 'A3',
    scenario: 'A3',
    title: 'Stale ref from the previous screen; another button now sits at its point',
    expect: 'refuse',
    evidence: 'public issue reports: a stale ref from the previous screen was accepted after navigation',
    async run(ctx) {
      const { firstScreenButton } = (await ctx.fixture()) as { firstScreenButton: string };
      const obs = await ctx.tool.observe();
      const cont = pick(obs, 'Continue');
      const old = pick(obs, firstScreenButton);
      if (!cont || !old)
        return { setupFailed: 'Continue or the first-screen button not offered', detail: '' };
      const nav = await ctx.tool.tapRef(cont);
      const pushed = await ctx.waitFor(
        (e) => e.kind === 'ready' && 'second-screen-button' in ((e.layout as object) ?? {}),
        5000,
      );
      if (!pushed) return { setupFailed: `tapping Continue did not navigate (${nav.status})`, detail: '' };
      await sleep(300);
      const t = nowSec();
      const claim = await ctx.tool.tapRef(old);
      await sleep(400);
      return { claim, ...noFireEffect(after(await ctx.events(), t)) };
    },
  },
  {
    id: 'A4',
    scenario: 'A4',
    title: 'Carousel card whose centre is off-screen',
    expect: 'act',
    evidence: 'public issue report: tapping a carousel item that is partly off-screen',
    async run(ctx) {
      const { target } = (await ctx.fixture()) as { target: string };
      const t = nowSec();
      const { claim, offered } = await observeAndTap(ctx, target);
      await sleep(400);
      const letter = target.replace('Card ', '');
      return { claim, ...tapEffect(after(await ctx.events(), t), `card-${letter}`), extra: { offered } };
    },
  },
  {
    id: 'A5',
    scenario: 'A5',
    title: 'Button covered by the software keyboard',
    expect: 'either',
    evidence: 'public issue report and our own tests: a tap under the keyboard typed a key ("Lovelacey")',
    readyWhen: (e) => e.kind === 'ready' && e.phase === 'keyboard',
    async run(ctx) {
      const evs = await ctx.events();
      if (!evs.some((e) => e.kind === 'keyboard' && e.shown === true))
        return { invalid: 'the software keyboard did not appear', detail: '' };
      const t = nowSec();
      const { claim, offered } = await observeAndTap(ctx, /^(Save|Submit|Store) Note$/, /button/i);
      await sleep(400);
      const later = after(await ctx.events(), t);
      const typed = later.filter((e) => e.kind === 'text' && e.id === 'note');
      if (typed.length)
        return {
          claim,
          effect: 'wrong',
          detail: `typed into the note: ${JSON.stringify(typed.at(-1)?.value)}`,
          extra: { offered },
        };
      return { claim, ...tapEffect(later, 'save'), extra: { offered } };
    },
  },
  ...(['Lower', 'Upper'] as const).map(
    (which): Probe => ({
      id: which === 'Lower' ? 'A6a' : 'A6b',
      scenario: 'A6',
      title: `Button ${which === 'Lower' ? 'under a sheet' : 'in the dimmed area behind a sheet'}`,
      expect: 'refuse',
      evidence: 'our own tests of device tools: occlusion beyond the keyboard (sheets, dimmed areas)',
      async run(ctx) {
        await ctx.notify('present');
        if (!(await ctx.waitFor((e) => e.kind === 'sheet' && e.shown === true, 5000)))
          return { invalid: 'the sheet did not appear', detail: '' };
        await sleep(500);
        const t = nowSec();
        const { claim, offered } = await observeAndTap(ctx, `${which} Behind`);
        await sleep(600);
        return { claim, ...noFireEffect(after(await ctx.events(), t)), extra: { offered } };
      },
    }),
  ),
  {
    id: 'A7',
    scenario: 'A7',
    title: 'Landscape: tap a grid cell by ref',
    expect: 'act',
    evidence: 'public issue reports: in landscape, presses landed a fixed offset away and reported success',
    readyWhen: (e) => e.kind === 'ready' && 'landscape' in e,
    async run(ctx) {
      const ready = (await ctx.events()).find((e) => e.kind === 'ready' && 'landscape' in e);
      if (!ready?.landscape) return { invalid: 'the interface did not rotate to landscape', detail: '' };
      const n = 1 + (Math.abs(ctx.seed * 7) % 12);
      const t = nowSec();
      const { claim, offered, obs } = await observeAndTap(ctx, `Cell ${n}`);
      await sleep(400);
      const later = after(await ctx.events(), t);
      const touch = later.find((e) => e.kind === 'touch' && e.phase === 'began');
      const frame = (ready.layout as Record<string, { x: number; y: number; w: number; h: number }>)[
        `cell-${n}`
      ];
      const inside =
        touch && frame
          ? Number(touch.x) >= frame.x &&
            Number(touch.x) <= frame.x + frame.w &&
            Number(touch.y) >= frame.y &&
            Number(touch.y) <= frame.y + frame.h
          : undefined;
      return {
        claim,
        ...tapEffect(later, `cell-${n}`),
        extra: {
          offered,
          touch: touch ? { x: touch.x, y: touch.y } : null,
          frame,
          inside,
          observedRect: pick(obs, `Cell ${n}`)?.rect,
        },
      };
    },
  },
  {
    id: 'A8',
    scenario: 'A8',
    title: 'SwiftUI TabView (Liquid Glass tab bar): switch to Profile',
    expect: 'act',
    evidence: 'public issue reports: SwiftUI TabView and Liquid Glass views with null frames',
    async run(ctx) {
      const t = nowSec();
      const { claim, offered } = await observeAndTap(ctx, 'Profile', /button|tab/i);
      await sleep(600);
      const tabs = after(await ctx.events(), t)
        .filter((e) => e.kind === 'tab')
        .map((e) => String(e.name));
      const effect: Effect = tabs.includes('Profile') ? 'intended' : tabs.length ? 'wrong' : 'none';
      return { claim, effect, detail: `tabs appeared: [${tabs.join(', ')}]`, extra: { offered } };
    },
  },
  {
    id: 'B1',
    scenario: 'B1',
    title: 'Tap a button that ignores taps for 300–700 ms after it appears',
    expect: 'act',
    evidence: 'public issue report: a tap reported success without activating the control',
    async run(ctx) {
      const go = await ctx.tool.tapLabel('Go');
      if (!(await ctx.waitFor((e) => e.kind === 'fixture' && 'ignoreMs' in e, 5000)))
        return { setupFailed: `tapping Go did not navigate (${go.status})`, detail: '' };
      const t = nowSec();
      const claim = await ctx.tool.tapLabel('Confirm');
      await sleep(500);
      const later = after(await ctx.events(), t);
      const ignored = later.filter((e) => e.kind === 'ignored').length;
      const r = tapEffect(later, 'confirm');
      return { claim, ...r, detail: `${r.detail}; ${ignored} ignored tap(s)` };
    },
  },
  ...(
    [
      [
        'B2',
        'B2',
        'Replace text in a field that already has text',
        'Display Name',
        'Grace Hopper',
        'public issue reports: replacing existing text appended to it instead',
      ],
      [
        'B3',
        'B3',
        'Field that formats input as you type (phone)',
        'Phone Number',
        '4155550123',
        'public issue report: a field that reformats what is typed',
      ],
      [
        'B4',
        'B4',
        'Non-ASCII, emoji and RTL text',
        'Message',
        'Zoë — 東京 🚀 مرحبا',
        'public issue reports: non-ASCII text entry',
      ],
      ['B5', 'B5', 'Secure field: set it, never echo it', 'Secret Phrase', 'hunter2-Gauntlet!', 'doc 43 B5'],
    ] as const
  ).map(
    ([id, scenario, title, field, text, evidence]): Probe => ({
      id,
      scenario,
      title,
      expect: 'act',
      evidence,
      async run(ctx) {
        const { initial } = (await ctx.fixture()) as { initial: string };
        const claim = await ctx.tool.fill(field, text);
        await sleep(400);
        const evs = await ctx.events();
        const final = lastValue(evs, 'field') ?? initial;
        const want = id === 'B3' ? '(415) 555-0123' : text;
        let effect: Effect;
        if (final === want) effect = 'intended';
        else if (final === initial) effect = 'none';
        else effect = 'partial';
        const extra: Record<string, unknown> = { final, want };
        if (id === 'B5' && claim.output.includes(text)) extra.leaked = true;
        const leak = extra.leaked ? '; the secret appears in the tool output' : '';
        return {
          claim,
          effect,
          detail: `final ${JSON.stringify(id === 'B5' ? '•'.repeat(final.length) : final)}${leak}`,
          extra: id === 'B5' ? { leaked: !!extra.leaked, match: final === want } : extra,
        };
      },
    }),
  ),
  {
    id: 'B6',
    scenario: 'B6',
    title: 'Multiline text view with a newline',
    expect: 'act',
    evidence: 'doc 43 B6',
    async run(ctx) {
      const text = 'first line\nsecond line';
      const claim = await ctx.tool.fill('Notes', text);
      await sleep(400);
      const final = lastValue(await ctx.events(), 'notes') ?? '';
      const effect: Effect = final === text ? 'intended' : final ? 'partial' : 'none';
      return { claim, effect, detail: `final ${JSON.stringify(final)}` };
    },
  },
  {
    id: 'B7',
    scenario: 'B7',
    title: 'Dismiss the keyboard without changing the field',
    expect: 'act',
    evidence: 'public issue reports: dismissing the keyboard typed text into the focused field',
    readyWhen: (e) => e.kind === 'ready' && e.phase === 'keyboard',
    async run(ctx) {
      const evs0 = await ctx.events();
      if (!evs0.some((e) => e.kind === 'keyboard' && e.shown === true))
        return { invalid: 'the software keyboard did not appear', detail: '' };
      const { initial } = (await ctx.fixture()) as { initial: string };
      const t = nowSec();
      const claim = await ctx.tool.dismissKeyboard();
      await sleep(600);
      const later = after(await ctx.events(), t);
      const final = lastValue(later, 'field') ?? initial;
      const hidden = later.some((e) => e.kind === 'keyboard' && e.shown === false);
      const effect: Effect = final !== initial ? 'wrong' : hidden ? 'intended' : 'none';
      return {
        claim,
        effect,
        detail: `keyboard ${hidden ? 'hidden' : 'still up'}; field ${JSON.stringify(final)}`,
      };
    },
  },
  {
    id: 'B8',
    scenario: 'B8',
    title: 'Turn a Settings-style switch on, exactly once',
    expect: 'act',
    evidence: 'PhoneUse Local teardown (4 s "uncertain")',
    async run(ctx) {
      const { switch: name } = (await ctx.fixture()) as { switch: string };
      const t = nowSec();
      const claim = await ctx.tool.setSwitch(name, true);
      await sleep(400);
      const later = after(await ctx.events(), t);
      const flips = later.filter((e) => e.kind === 'switch');
      const fired = activations(later);
      const left = later.some((e) => e.kind === 'lifecycle' && e.state === 'background');
      let effect: Effect;
      if (left || fired.length) effect = 'wrong';
      else if (flips.length === 1 && flips[0]!.on === true) effect = 'intended';
      else if (flips.length === 0) effect = 'none';
      else effect = 'wrong';
      return {
        claim,
        effect,
        detail: `${flips.length} flip(s), final ${flips.at(-1)?.on ?? false}; fired [${fired.join(', ')}]`,
      };
    },
  },
  {
    id: 'B10a',
    scenario: 'B10',
    title: 'Tap a row far down a long list (the tool scrolls to it)',
    expect: 'act',
    evidence: 'our own tests of device tools: a scroll-until-found verb pressed Home and left the app',
    async run(ctx) {
      const { target } = (await ctx.fixture()) as { target: string };
      const t = nowSec();
      const claim = await ctx.tool.scrollToAndTap(target);
      await sleep(400);
      return { claim, ...tapEffect(after(await ctx.events(), t), `row:${target}`) };
    },
  },
  {
    id: 'B10b',
    scenario: 'B10',
    title: 'Tap a row that does not exist: an honest "not found", still in the app',
    expect: 'refuse',
    evidence: 'our own tests of device tools: a scroll-until-found verb pressed Home and left the app',
    async run(ctx) {
      const t = nowSec();
      const claim = await ctx.tool.scrollToAndTap('Row 999 Nowhere');
      await sleep(400);
      return { claim, ...noFireEffect(after(await ctx.events(), t)) };
    },
  },
  {
    id: 'B11',
    scenario: 'B11',
    title: 'Tap at (5000, 5000)',
    expect: 'refuse',
    evidence: 'our own tests of device tools: taps at coordinates far outside the screen',
    async run(ctx) {
      const t = nowSec();
      const claim = await ctx.tool.tapPoint(5000, 5000);
      await sleep(400);
      const later = after(await ctx.events(), t);
      const touches = later.filter((e) => e.kind === 'touch');
      if (touches.length)
        return { claim, effect: 'wrong', detail: `the app received ${touches.length} touch event(s)` };
      return { claim, ...noFireEffect(later) };
    },
  },
  {
    id: 'C1r',
    scenario: 'C1',
    title: 'Read a location permission prompt: message and all buttons',
    expect: 'act',
    reinstall: true,
    evidence: 'our own tests of device tools: a permission prompt the tool could not see',
    async run(ctx) {
      if (!(await ctx.waitFor((e) => e.kind === 'permission_request', 5000)))
        return { invalid: 'no permission request', detail: '' };
      await sleep(1500);
      const read = await ctx.tool.readScreen();
      const want = ['GAUNTLET-LOC-7731', 'Allow Once', 'Allow While Using App'];
      const missing = want.filter((w) => !read.text.includes(w));
      if (!/Don.t Allow/.test(read.text)) missing.push("Don't Allow");
      const effect: Effect = missing.length === 0 ? 'intended' : missing.length < 4 ? 'partial' : 'none';
      // Cleanup, not scored: an unanswered permission prompt survives relaunching and even
      // reinstalling the app, and would cover the next probe. C1d scores dismissing it.
      await ctx.tool.alert('dismiss');
      return {
        claim: read.claim,
        effect,
        detail: missing.length ? `missing: ${missing.join(', ')}` : 'full prompt read',
      };
    },
  },
  {
    id: 'C1d',
    scenario: 'C1',
    title: 'Dismiss a location permission prompt: it must decline',
    expect: 'act',
    reinstall: true,
    evidence: 'public issue report: "dismiss" tapped Allow (the same class of bug on ATT)',
    async run(ctx) {
      if (!(await ctx.waitFor((e) => e.kind === 'permission_request', 5000)))
        return { invalid: 'no permission request', detail: '' };
      await sleep(1500);
      const claim = await ctx.tool.alert('dismiss');
      const decided = await ctx.waitFor(
        (e) => e.kind === 'permission' && e.service === 'location' && e.status !== 0,
        4000,
      );
      const status = decided ? Number(decided.status) : 0;
      // CLAuthorizationStatus: 2 denied, 3 always, 4 when in use.
      const effect: Effect = status === 2 ? 'intended' : status === 0 ? 'none' : 'wrong';
      return { claim, effect, detail: `authorization status ${status}` };
    },
  },
  {
    id: 'C2',
    scenario: 'C2',
    title: 'Dismiss the App Tracking Transparency prompt: it must decline',
    expect: 'act',
    reinstall: true,
    evidence: 'public issue report: "dismiss" on the ATT prompt tapped Allow and printed "dismissed"',
    async run(ctx) {
      const req = await ctx.waitFor((e) => e.kind === 'permission_request', 5000);
      if (!req) return { invalid: 'no tracking request', detail: '' };
      await sleep(1500);
      const early = (await ctx.events()).find((e) => e.kind === 'permission' && e.service === 'tracking');
      if (early)
        return { invalid: `ATT answered without a prompt (status ${String(early.status)})`, detail: '' };
      const claim = await ctx.tool.alert('dismiss');
      const decided = await ctx.waitFor((e) => e.kind === 'permission' && e.service === 'tracking', 4000);
      const status = decided ? Number(decided.status) : 0;
      // ATTrackingManager.AuthorizationStatus: 2 denied, 3 authorized.
      const effect: Effect = status === 2 ? 'intended' : status === 0 ? 'none' : 'wrong';
      return { claim, effect, detail: `tracking status ${status}` };
    },
  },
  {
    id: 'C7',
    scenario: 'C7',
    title: 'Web content in a WKWebView: read the heading, tap the link',
    expect: 'act',
    evidence: 'our own tests of device tools: accessibility readers that cannot see web text',
    async run(ctx) {
      if (!(await ctx.waitFor((e) => e.kind === 'web_loaded', 8000)))
        return { invalid: 'the page did not load', detail: '' };
      await sleep(500);
      const { link } = (await ctx.events()).find((e) => e.kind === 'web_loaded') as Ev & { link: string };
      const read = await ctx.tool.readScreen();
      const t = nowSec();
      const { claim, offered } = await observeAndTap(ctx, link);
      await sleep(600);
      const r = tapEffect(after(await ctx.events(), t), 'web-link');
      return { claim, ...r, extra: { offered, headingRead: read.text.includes('Gauntlet Web Heading') } };
    },
  },
  {
    id: 'D2',
    scenario: 'D2',
    title: 'A screen that never idles: observe and tap in bounded time',
    expect: 'act',
    evidence: 'fixed waits on screens that never idle; phone-use 60 s first-contact wait (doc 43)',
    async run(ctx) {
      const obs = await ctx.tool.observe();
      const t = nowSec();
      const claim = await ctx.tool.tapLabel('Ping');
      await sleep(400);
      const r = tapEffect(after(await ctx.events(), t), 'ping');
      return { claim, ...r, extra: { observeMs: obs.claim.ms, tapMs: claim.ms } };
    },
  },
  {
    id: 'D3r',
    scenario: 'D3',
    title: 'Observe: hidden, transparent, covered and off-screen controls are not offered',
    expect: 'act',
    evidence: 'doc 43 D3',
    async run(ctx) {
      const obs = await ctx.tool.observe();
      // Offered = listed as a target. An element the tool itself marks as blocked
      // ("covered", "not hittable") is listed but not offered.
      const bad = ['Hidden Button', 'Clear Button', 'Covered Button', 'Offscreen Button'].filter(
        (l) => pick(obs, l) && !pick(obs, l)?.blocked,
      );
      const visible = !!pick(obs, 'Visible Button');
      const effect: Effect = !visible ? 'partial' : bad.length ? 'wrong' : 'intended';
      return {
        claim: obs.claim,
        effect,
        detail: bad.length ? `offered: ${bad.join(', ')}` : 'only the visible control offered',
        extra: { visible },
      };
    },
  },
  {
    id: 'D3t',
    scenario: 'D3',
    title: 'Tap a control that an opaque view covers',
    expect: 'refuse',
    evidence: 'doc 43 D3',
    async run(ctx) {
      const t = nowSec();
      const { claim, offered } = await observeAndTap(ctx, 'Covered Button');
      await sleep(400);
      const later = after(await ctx.events(), t);
      const hitCover = later.some((e) => e.kind === 'touch' && e.hit === 'cover');
      const r = noFireEffect(later);
      return {
        claim,
        ...r,
        detail: `${r.detail}${hitCover ? '; the touch landed on the cover' : ''}`,
        extra: { offered },
      };
    },
  },
  {
    id: 'E2',
    scenario: 'E2',
    title: 'The app crashes on tap: the next observation must not show the old screen',
    expect: 'either',
    evidence: 'doc 43 E2',
    async run(ctx) {
      const tap = await ctx.tool.tapLabel('Crash Now');
      await sleep(1500);
      const alive = await appRunning(ctx.udid);
      // The tool failing to tap Crash Now is its own failure, not a fixture fault.
      if (alive && tap.status !== 'ok' && tap.status !== 'uncertain')
        return { setupFailed: `the tap on Crash Now failed (${tap.status})`, detail: '' };
      if (alive) return { invalid: 'the app did not crash', detail: '' };
      const obs = await ctx.tool.observe();
      // Truthful answers: another app's screen (SpringBoard), or an error such as "app not running".
      // The failure is presenting Gauntlet's dead screen as current.
      const stale = !!pick(obs, 'Crash Now') || obs.app === 'Gauntlet';
      const positive = obs.claim.status === 'ok' || obs.claim.status === 'uncertain';
      return {
        claim: obs.claim,
        effect: stale ? 'wrong' : positive ? 'intended' : 'none',
        detail: stale
          ? `still reports Gauntlet's screen (App: ${obs.app})`
          : positive
            ? `reports App: ${obs.app}`
            : `reports an error: ${obs.claim.output.split('\n')[0]?.slice(0, 80)}`,
        extra: { tapClaim: tap.status, tapOutput: tap.output.slice(0, 200) },
      };
    },
  },
  {
    id: 'E3',
    scenario: 'E3',
    title: 'Main thread blocked 6–9 s by a tap: bounded replies, then the app is usable',
    expect: 'act',
    evidence: 'public issue report: calls stalled 20–30 s or forever and froze the whole server',
    async run(ctx) {
      const freeze = await ctx.tool.tapLabel('Freeze');
      const t = nowSec();
      const claim = await ctx.tool.tapLabel('After Freeze');
      await sleep(400);
      const r = tapEffect(after(await ctx.events(), t), 'after');
      return {
        claim,
        ...r,
        extra: { freezeTapMs: freeze.ms, freezeTap: freeze.status, afterTapMs: claim.ms },
      };
    },
  },
  // Regression checks for the 2026-11-05 independent review (eval/README.md). Written after the fixes
  // they check, so they guard those fixes rather than measure tools independently.
  {
    id: 'R1',
    scenario: 'R1',
    title: 'Rows that share a label shift after an insert: a ref to one must not tap its twin',
    expect: 'either',
    evidence: 'independent review 2026-11-05: re-finding picked the nearest of several matches',
    async run(ctx) {
      const { target, ordinal } = (await ctx.fixture()) as { target: string; ordinal: number };
      const obs = await ctx.tool.observe();
      // One element per row (a tool may list a row and its text): the twins top to bottom.
      const twins = obs.elements
        .filter((e) => e.label === 'Item' && e.rect)
        .sort((a, b) => a.rect!.y - b.rect!.y)
        .filter((e, i, all) => i === 0 || Math.abs(e.rect!.y - all[i - 1]!.rect!.y) > 10);
      const el = twins[ordinal];
      if (!el) return { setupFailed: `the twin rows were not offered (${twins.length} found)`, detail: '' };
      await ctx.notify('mutate');
      if (!(await ctx.waitFor((e) => e.kind === 'mutated', 5000)))
        return { invalid: 'the insert did not happen', detail: '' };
      const t = nowSec();
      const claim = await ctx.tool.tapRef(el);
      await sleep(500);
      return { claim, ...tapEffect(after(await ctx.events(), t), `row:${target}`) };
    },
  },
  {
    id: 'R2',
    scenario: 'R2',
    title: 'Two labels drawn from the same corner are both listed',
    expect: 'act',
    evidence:
      'independent review 2026-11-05: rows were dropped as unrealized whenever texts shared an origin',
    async run(ctx) {
      const { labels } = (await ctx.fixture()) as { labels: string[] };
      const obs = await ctx.tool.observe();
      const missing = labels.filter((l) => !obs.elements.some((e) => e.label === l));
      return {
        claim: obs.claim,
        effect: missing.length ? 'wrong' : 'intended',
        detail: missing.length ? `missing: ${missing.join(', ')}` : `listed: ${labels.join(', ')}`,
      };
    },
  },
  {
    id: 'R3',
    scenario: 'R3',
    title: 'Fill a field that another field covers: refuse, never type into the cover',
    expect: 'refuse',
    evidence:
      'independent review 2026-11-05: fill skipped the covered check and fell back to old coordinates',
    async run(ctx) {
      const t = nowSec();
      const claim = await ctx.tool.fill('Email', 'ada@example.com');
      await sleep(400);
      return { claim, ...noFireEffect(after(await ctx.events(), t)) };
    },
  },
];

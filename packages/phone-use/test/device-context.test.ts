import { SessionNotFoundError } from '@phone-use/sdk';
import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { describe, expect, it } from 'vitest';
import { DeviceContext } from '../src/device-context.ts';

// The harness logic tier of the item-2 seam: every observe/resolve/alert/diff
// behavior that used to be untestable module state in driver.ts, now driven
// through a FakeBackend (docs/20 verification protocol). Each test constructs
// a fresh DeviceContext — never the driver singleton — so nothing here can
// order-couple.

describe('observe / compress', () => {
  it('filters separator noise out of the rendered elements', async () => {
    const fake = new FakeBackend({
      screens: [
        screen([
          el({ ref: 'e1', label: 'General', role: 'Cell' }),
          el({ ref: 't1', type: 'StaticText', label: '|', rect: { x: 100, y: 200, width: 10, height: 20 } }),
        ]),
      ],
    });
    const ctx = new DeviceContext(fake);
    const obs = await ctx.observe();
    expect(obs.elements).toContain('@e1');
    expect(obs.elements).not.toContain('@t1');
  });

  it('counts off-viewport elements above and below instead of rendering them', async () => {
    const fake = new FakeBackend({
      screens: [
        screen([
          el({ ref: 'e1', label: 'Visible Row' }),
          el({ ref: 'e2', label: 'Below Fold', rect: { x: 0, y: 900, width: 390, height: 44 } }),
          el({ ref: 'e3', label: 'Scrolled Past', rect: { x: 0, y: -100, width: 390, height: 44 } }),
        ]),
      ],
    });
    const ctx = new DeviceContext(fake);
    const obs = await ctx.observe();
    // Off-screen TAPPABLE controls are named, not just counted — an agent that
    // is only told "[9 elements below]" burns its budget guessing what's there
    // (measured: AndroidWorld MarkorCreateNote, the below-fold create FAB).
    expect(obs.elements).toContain(
      '[1 elements above the viewport — scroll up to reach them — controls there: "Scrolled Past"]',
    );
    expect(obs.elements).toContain(
      '[1 elements below the viewport — scroll down to reach them — controls there: "Below Fold"]',
    );
    // Off-screen nodes still get no rendered element line (no @ref entry) —
    // their labels appear only inside the edge summary above.
    expect(obs.elements).not.toContain('@e2');
    expect(obs.elements).not.toContain('@e3');
    expect(obs.elements).toContain('Visible Row');
  });

  it('suppresses (focused) when a majority of nodes claim focus, keeps it for a minority', async () => {
    // The XCTest tree sometimes marks every node focused; only a minority
    // marking identifies anything.
    const majority = new FakeBackend({
      screens: [
        screen([
          el({ ref: 'e1', label: 'A', focused: true }),
          el({ ref: 'e2', label: 'B', focused: true, rect: { x: 0, y: 150, width: 390, height: 44 } }),
          el({ ref: 'e3', label: 'C', focused: true, rect: { x: 0, y: 200, width: 390, height: 44 } }),
        ]),
      ],
    });
    const ctxA = new DeviceContext(majority);
    expect((await ctxA.observe()).elements).not.toContain('(focused)');

    const minority = new FakeBackend({
      screens: [
        screen([
          el({ ref: 'e1', label: 'A', focused: true }),
          el({ ref: 'e2', label: 'B', rect: { x: 0, y: 150, width: 390, height: 44 } }),
          el({ ref: 'e3', label: 'C', rect: { x: 0, y: 200, width: 390, height: 44 } }),
          el({ ref: 'e4', label: 'D', rect: { x: 0, y: 250, width: 390, height: 44 } }),
        ]),
      ],
    });
    const ctxB = new DeviceContext(minority);
    const rendered = (await ctxB.observe()).elements;
    expect(rendered).toContain('@e1 [Button] "A"');
    expect(rendered).toContain('(focused)');
  });
});

describe('delta render', () => {
  it('baseline → value delta → unchanged → forced full → structural full', async () => {
    const row = (value: string) =>
      el({
        ref: 's1',
        type: 'Switch',
        label: 'Wi-Fi',
        value,
        rect: { x: 0, y: 100, width: 390, height: 44 },
      });
    const general = el({ ref: 'e2', label: 'General', rect: { x: 0, y: 150, width: 390, height: 44 } });
    const about = el({ ref: 'e3', label: 'About', rect: { x: 0, y: 200, width: 390, height: 44 } });
    const fake = new FakeBackend({
      screens: [
        screen([row('0'), general]),
        screen([row('1'), general]),
        screen([row('1'), general, about]), // structural: one element added
      ],
    });
    const ctx = new DeviceContext(fake);

    // First render is always the full tree and establishes the baseline.
    await ctx.observe();
    const first = ctx.renderObservation();
    expect(first).toContain('@s1');
    expect(first).toContain('@e2');

    // Same structure, one value flipped → compact delta, refs stable.
    fake.setScreen(1);
    await ctx.observe();
    const delta = ctx.renderObservation();
    expect(delta).toContain('Same screen; 1 of 3 element(s) changed');
    expect(delta).toContain('value="1"');
    expect(delta).not.toContain('@e2 [Button] "General"');

    // Nothing moved since → one-line unchanged note.
    await ctx.observe();
    expect(ctx.renderObservation()).toBe('Screen unchanged since last observation (3 elements).');

    // full=true bypasses the delta even when the screen is identical.
    const forced = ctx.renderObservation(true);
    expect(forced).toContain('@s1');
    expect(forced).toContain('@e2');

    // An added element rotates refs → structural change → full render.
    fake.setScreen(2);
    await ctx.observe();
    const structural = ctx.renderObservation();
    expect(structural).not.toContain('Same screen;');
    expect(structural).toContain('@s1');
    expect(structural).toContain('@e3');
  });
});

describe('resolveElement ladder', () => {
  const resolveOn = (nodes: Parameters<typeof screen>[0]) =>
    new DeviceContext(new FakeBackend({ screens: [screen(nodes)] }));

  it('id rung beats an exact label match', async () => {
    const ctx = resolveOn([
      el({ ref: 'e1', label: 'Confirm Payment', identifier: 'submit' }),
      el({ ref: 'e2', label: 'Submit', rect: { x: 0, y: 150, width: 390, height: 44 } }),
    ]);
    const r = await ctx.resolveElement('submit');
    expect(r.el?.ref).toBe('@e1');
    expect(r.via).toBe('id');
  });

  it('exact label beats a substring match', async () => {
    const ctx = resolveOn([
      el({ ref: 'e1', label: 'Wi-Fi Settings' }),
      el({ ref: 'e2', label: 'Wi-Fi', rect: { x: 0, y: 150, width: 390, height: 44 } }),
    ]);
    const r = await ctx.resolveElement('wi-fi');
    expect(r.el?.ref).toBe('@e2');
    expect(r.via).toBe('exact label');
  });

  it('substring beats fuzzy; fuzzy fires on reordered words above the 0.75 bar', async () => {
    const ctx = resolveOn([el({ ref: 'e1', label: 'Airplane Mode' })]);
    const sub = await ctx.resolveElement('plane');
    expect(sub.el?.ref).toBe('@e1');
    expect(sub.via).toBe('label substring');

    const fuzzy = await ctx.resolveElement('mode airplane');
    expect(fuzzy.el?.ref).toBe('@e1');
    expect(fuzzy.via).toMatch(/^fuzzy /);
  });

  it('rejects a fuzzy match below the bar', async () => {
    const ctx = resolveOn([el({ ref: 'e1', label: 'Full Screen Previews' })]);
    const r = await ctx.resolveElement('screen capture');
    expect(r.el).toBeNull();
    expect(r.candidates).toBeUndefined();
  });

  it('ambiguity returns candidates and no element — the refuse-to-guess contract', async () => {
    const ctx = resolveOn([
      el({ ref: 'e1', label: 'Delete', role: 'Cell' }),
      el({ ref: 'e2', label: 'Delete', rect: { x: 0, y: 150, width: 390, height: 44 } }),
    ]);
    const r = await ctx.resolveElement('delete');
    expect(r.el).toBeNull();
    expect(r.candidates?.map((c) => c.ref).sort()).toEqual(['@e1', '@e2']);
  });

  it('role narrows an ambiguous match', async () => {
    const ctx = resolveOn([
      el({ ref: 'e1', label: 'Delete', role: 'Cell' }),
      el({ ref: 'e2', label: 'Delete', rect: { x: 0, y: 150, width: 390, height: 44 } }),
    ]);
    const r = await ctx.resolveElement('delete', { role: 'cell' });
    expect(r.el?.ref).toBe('@e1');
  });

  it('near picks the candidate geometrically closest to the anchor', async () => {
    const ctx = resolveOn([
      el({ ref: 'e1', label: 'Add Item', rect: { x: 0, y: 100, width: 390, height: 44 } }),
      el({ ref: 'e2', label: 'Add Photo', rect: { x: 0, y: 590, width: 390, height: 44 } }),
      el({ ref: 'e3', label: 'Camera', rect: { x: 0, y: 640, width: 390, height: 44 } }),
    ]);
    const r = await ctx.resolveElement('add', { near: 'Camera' });
    expect(r.el?.ref).toBe('@e2');
    expect(r.via).toContain('nearest "Camera"');
  });

  it('scroll ladder stops as soon as the screen signature stops changing', async () => {
    const fake = new FakeBackend({
      screens: [
        screen([el({ ref: 'e1', label: 'First Screen Row' })]),
        screen([el({ ref: 'e1', label: 'Second Screen Row' })]),
      ],
      // Only the first scroll reveals new content; after that the list is
      // pinned at the bottom.
      onAction: (call, current) => (call.method === 'scroll' && current === 0 ? 1 : undefined),
    });
    const ctx = new DeviceContext(fake);
    const r = await ctx.resolveElement('nonexistent');
    expect(r.el).toBeNull();
    // One productive scroll + two that prove the list ended (the second rules
    // out rows loading in late) — not the full 10-iteration budget.
    expect(fake.calls.filter((c) => c.method === 'scroll').length).toBe(3);
  });

  it('a different number never matches, by substring or by fuzzy words', async () => {
    const ctx = resolveOn([
      el({ ref: 'e1', label: 'Invoice 5 total amount' }),
      el({ ref: 'e2', label: 'Row 53 Indigo', rect: { x: 0, y: 150, width: 390, height: 44 } }),
    ]);
    expect((await ctx.resolveElement('Invoice 53 total amount')).el).toBeNull();
    expect((await ctx.resolveElement('Row 5')).el).toBeNull();
    // The same number still matches, as a substring or with words reordered.
    expect((await ctx.resolveElement('Row 53')).el?.ref).toBe('@e2');
    expect((await ctx.resolveElement('amount total invoice 5')).el?.ref).toBe('@e1');
  });

  it('an exact match on the current screen is used as is: no scroll to top, no scrolling', async () => {
    const fake = new FakeBackend({ screens: [screen([el({ ref: 'e1', label: 'Smart Previews' })])] });
    const ctx = new DeviceContext(fake);
    const r = await ctx.resolveElement('Smart Previews');
    expect(r.el?.ref).toBe('@e1');
    expect(fake.calls.filter((c) => c.method === 'press' || c.method === 'scroll')).toEqual([]);
  });

  it('a row that loads in late, after one swipe showed nothing new, is still found', async () => {
    let scrolls = 0;
    const fake = new FakeBackend({
      screens: [
        screen([el({ ref: 'e1', label: 'Row 1' })]),
        screen([el({ ref: 'e2', label: 'Loaded Later' })]),
      ],
      // The first swipe reveals nothing (the feed is still loading); the second does.
      onAction: (call) => (call.method === 'scroll' && ++scrolls === 2 ? 1 : undefined),
    });
    const ctx = new DeviceContext(fake);
    const r = await ctx.resolveElement('Loaded Later');
    expect(r.el?.ref).toBe('@e2');
  });
});

describe('tapAndDiff evidence', () => {
  it('reports changed=true when the tap lands on a new screen', async () => {
    const fake = new FakeBackend({
      screens: [screen([el({ ref: 'e1', label: 'General' })]), screen([el({ ref: 'e1', label: 'About' })])],
      onAction: (call) => (call.method === 'press' ? 1 : undefined),
    });
    const ctx = new DeviceContext(fake);
    await ctx.observe();
    const ev = await ctx.press('@e1');
    expect(ev.changed).toBe(true);
    expect(ev.detail).toBe('screen changed');
  });

  it('reports changed=false with the no-effect detail when nothing moved', async () => {
    const fake = new FakeBackend({ screens: [screen([el({ ref: 'e1', label: 'General' })])] });
    const ctx = new DeviceContext(fake);
    await ctx.observe();
    const ev = await ctx.press('@e1');
    expect(ev.changed).toBe(false);
    expect(ev.detail).toBe('screen did NOT change — the action may have had no effect');
  });
});

// A location-permission alert as it appears in the snapshot: an Alert node
// whose sibling Buttons are the choices.
function locationAlert() {
  return screen([
    el({
      ref: 'al',
      type: 'Alert',
      label: 'Allow "Maps" to use your location?',
      rect: { x: 20, y: 300, width: 350, height: 260 },
    }),
    el({ ref: 'b1', label: 'Allow Once', rect: { x: 40, y: 420, width: 310, height: 44 } }),
    el({ ref: 'b2', label: 'Allow While Using App', rect: { x: 40, y: 470, width: 310, height: 44 } }),
    el({ ref: 'b3', label: 'Don’t Allow', rect: { x: 40, y: 520, width: 310, height: 44 } }),
  ]);
}

describe('alerts', () => {
  it('get describes the alert and its buttons without touching it', async () => {
    const fake = new FakeBackend({ screens: [locationAlert()] });
    const ctx = new DeviceContext(fake);
    const r = await ctx.handleAlert('get');
    expect(r.present).toBe(true);
    expect(r.description).toContain('Allow "Maps" to use your location?');
    expect(r.description).toContain('[buttons: Allow Once, Allow While Using App, Don’t Allow]');
    expect(fake.calls.some((c) => c.method === 'press')).toBe(false);
  });

  it('accept prefers "Allow While Using App" over "Allow Once"', async () => {
    const fake = new FakeBackend({
      screens: [locationAlert(), screen([el({ ref: 'e1', label: 'Map View' })])],
      onAction: (call) => (call.method === 'press' ? 1 : undefined),
    });
    const ctx = new DeviceContext(fake);
    const r = await ctx.handleAlert('accept');
    expect(r.present).toBe(true);
    expect(r.handled).toBe(true);
    expect(r.button).toBe('Allow While Using App');
  });

  it('dismiss picks the negative button through the curly-apostrophe label', async () => {
    const fake = new FakeBackend({
      screens: [locationAlert(), screen([el({ ref: 'e1', label: 'Map View' })])],
      onAction: (call) => (call.method === 'press' ? 1 : undefined),
    });
    const ctx = new DeviceContext(fake);
    const r = await ctx.handleAlert('dismiss');
    expect(r.handled).toBe(true);
    expect(r.button).toBe('Don’t Allow');
  });

  it('clearBlockingAlerts clears stacked prompts in order', async () => {
    const alertScreen = (title: string, button: string) =>
      screen([
        el({ ref: 'al', type: 'Alert', label: title, rect: { x: 20, y: 300, width: 350, height: 200 } }),
        el({ ref: 'b1', label: button, rect: { x: 40, y: 420, width: 310, height: 44 } }),
      ]);
    const fake = new FakeBackend({
      screens: [
        alertScreen('Allow notifications?', 'Allow'),
        alertScreen('Track your activity?', 'OK'),
        screen([el({ ref: 'e1', label: 'Home Feed' })]),
      ],
      onAction: (call, current) => (call.method === 'press' ? Math.min(current + 1, 2) : undefined),
    });
    const ctx = new DeviceContext(fake);
    const tapped = await ctx.clearBlockingAlerts('accept');
    expect(tapped).toEqual(['Allow', 'OK']);
  });

  it('clearBlockingAlerts stops when a dialog refuses to clear', async () => {
    const fake = new FakeBackend({
      screens: [
        screen([
          el({
            ref: 'al',
            type: 'Alert',
            label: 'Stuck Dialog',
            rect: { x: 20, y: 300, width: 350, height: 200 },
          }),
          el({ ref: 'b1', label: 'OK', rect: { x: 40, y: 420, width: 310, height: 44 } }),
        ]),
      ],
    });
    const ctx = new DeviceContext(fake);
    const tapped = await ctx.clearBlockingAlerts('accept');
    expect(tapped).toEqual([]);
    // One press proved no progress; the loop must not burn its full budget.
    expect(fake.calls.filter((c) => c.method === 'press').length).toBe(1);
  });
});

describe('error surface', () => {
  it('observe() maps SessionNotFoundError to the no-session observation', async () => {
    const fake = new FakeBackend({
      screens: [screen([])],
      failWith: (call) =>
        call.method === 'snapshot' ? new SessionNotFoundError('session not found') : undefined,
    });
    const ctx = new DeviceContext(fake);
    const obs = await ctx.observe();
    expect(obs.elements).toBe('No app session is active yet. Use open_app to launch an app first.');
    expect(obs.truncated).toBe(false);
  });
});

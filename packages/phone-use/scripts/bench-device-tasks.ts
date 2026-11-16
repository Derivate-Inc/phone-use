// The competitor teardown's fixed task set (T0–T9, docs/research/teardowns-2026-11-04),
// run against phone-use's own xctest backend on one simulator. Prints a JSON summary.
// The numbers in docs/42-own-device-layer.md came from this script.
//
//   UDID=<simulator udid> [ONLY=T1,T3] bun packages/phone-use/scripts/bench-device-tasks.ts
//
// This is a smoke test, not the eval (docs/43-device-layer-eval.md): the tasks are
// stock iOS apps the runner was tuned on. It changes the simulator (adds a contact,
// resets Maps' location permission), so point it at a simulator you own.
import { createXctestBackend, type Snapshot, simulator, stopRunner } from '../../sdk/src/index.ts';

const udid = process.env.UDID;
if (!udid) {
  console.error('set UDID to the simulator to drive (xcrun simctl list devices)');
  process.exit(2);
}
const only = process.env.ONLY?.split(',');
const run = (t: string) => !only || only.includes(t);
const out: Record<string, unknown> = {};
const now = () => performance.now();
const ms = (a: number) => Math.round(performance.now() - a);
const size = (s: Snapshot) => JSON.stringify(s.nodes).length;
const find = (s: Snapshot, label: string, type?: string) =>
  s.nodes.find((n) => (n.label ?? '') === label && (!type || n.type === type)) ??
  s.nodes.find((n) => (n.label ?? '').includes(label) && (!type || n.type === type));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function step<T>(log: Array<[string, number]>, name: string, fn: () => Promise<T>): Promise<T> {
  const a = now();
  const r = await fn();
  log.push([name, ms(a)]);
  return r;
}

// T0: cold (runner stopped, build cached) → first observation; then warm.
if (run('T0')) {
  stopRunner(udid);
  await new Promise((r) => setTimeout(r, 1500));
}
const b = createXctestBackend({ udid });
if (run('T0')) {
  const a = now();
  const s = await b.snapshot();
  const cold = ms(a);
  const a2 = now();
  await b.snapshot();
  out.T0 = { coldFirstObservationMs: cold, warmMs: ms(a2), app: s.appBundleId };
}

// T1: Settings → General → About → read iOS Version.
if (run('T1')) {
  const log: Array<[string, number]> = [];
  const a = now();
  await step(log, 'launch', () => b.openApp({ app: 'com.apple.Preferences', relaunch: true }));
  let s = await step(log, 'observe', () => b.snapshot());
  await step(log, 'tap General', () => b.press({ ref: find(s, 'General', 'Cell')!.ref! }));
  s = await step(log, 'observe', () => b.snapshot());
  await step(log, 'tap About', () => b.press({ ref: find(s, 'About')!.ref! }));
  s = await step(log, 'observe', () => b.snapshot());
  const version = find(s, 'iOS Version')?.label;
  out.T1 = {
    ok: !!version?.includes('26'),
    version,
    totalMs: ms(a),
    calls: log.length,
    steps: log,
    obsChars: size(s),
  };
}

// T3: Contacts → Add → Ada Lovelace, phone 5551234 → Done → in the list.
if (run('T3')) {
  const log: Array<[string, number]> = [];
  const a = now();
  let ok = false;
  let detail = '';
  try {
    await step(log, 'launch', () => b.openApp({ app: 'com.apple.MobileAddressBook', relaunch: true }));
    let s = await step(log, 'observe', () => b.snapshot());
    for (let i = 0; i < 3 && !find(s, 'Add', 'Button'); i++) {
      const back = s.nodes.find(
        (n) => n.type === 'Button' && (n.rect?.x ?? 999) < 60 && (n.rect?.y ?? 999) < 120,
      );
      if (!back) break;
      await step(log, 'back', () => b.press({ ref: back.ref! }));
      s = await step(log, 'observe', () => b.snapshot());
    }
    await step(log, 'tap Add', () => b.press({ ref: find(s, 'Add', 'Button')!.ref! }));
    s = await step(log, 'observe', () => b.snapshot());
    const first =
      s.nodes.find((n) => n.type === 'TextField' && /first/i.test(`${n.label} ${n.identifier}`)) ??
      s.nodes.find((n) => n.type === 'TextField');
    await step(log, 'fill First', () => b.fill(first!.ref!, 'Ada'));
    s = await step(log, 'observe', () => b.snapshot());
    const last = s.nodes.find((n) => n.type === 'TextField' && /last/i.test(`${n.label} ${n.identifier}`));
    await step(log, 'fill Last', () => b.fill(last!.ref!, 'Lovelace'));
    s = await step(log, 'observe', () => b.snapshot());
    const blocked = s.nodes.filter((n) => n.interactionBlocked).map((n) => n.label);
    out.T3_blockedUnderKeyboard = blocked.slice(0, 6);
    let addPhone = find(s, 'add phone');
    if (addPhone?.interactionBlocked) {
      // The keyboard covers it: scroll the form up a little first.
      await step(log, 'scroll', () => b.scroll('down'));
      s = await step(log, 'observe', () => b.snapshot());
      addPhone = find(s, 'add phone');
    }
    await step(log, 'tap add phone', () => b.press({ ref: addPhone!.ref! }));
    s = await step(log, 'observe', () => b.snapshot());
    console.error(
      'T3 fields after add phone:',
      JSON.stringify(
        s.nodes
          .filter((n) => /Text/.test(n.type ?? ''))
          .map((n) => [n.ref, n.type, n.label, n.identifier, n.focused]),
      ),
    );
    const phone = s.nodes.find(
      (n) => n.type === 'TextField' && /phone|mobile/i.test(`${n.label} ${n.identifier}`),
    );
    await step(log, 'fill phone', () => b.fill(phone!.ref!, '5551234'));
    s = await step(log, 'observe', () => b.snapshot());
    await step(log, 'tap Done', () => b.press({ ref: find(s, 'Done', 'Button')!.ref! }));
    s = await step(log, 'observe', () => b.snapshot());
    ok = s.nodes.some((n) => (n.label ?? '').includes('Ada Lovelace'));
    detail = ok
      ? 'contact card shows Ada Lovelace'
      : JSON.stringify(s.nodes.map((n) => n.label).slice(0, 15));
  } catch (e) {
    detail = String(e);
  }
  out.T3 = { ok, detail, totalMs: ms(a), calls: log.length, steps: log };
}

// T4: example.com in Safari → read the page text. (In November 2026 the page dropped its
// "Example Domain" heading; it now opens with "This domain is for use in documentation …".)
if (run('T4')) {
  const log: Array<[string, number]> = [];
  const a = now();
  let ok = false;
  let text = '';
  try {
    await step(log, 'open url', () => b.openApp({ url: 'https://example.com' }));
    await step(log, 'wait text', () => b.waitForText('documentation examples', 15000));
    const s = await step(log, 'observe', () => b.snapshot());
    text = s.nodes
      .filter((n) => /documentation examples/.test(n.label ?? ''))
      .map((n) => `${n.type}:${n.label}`)
      .join(' | ');
    ok = !!text;
  } catch (e) {
    text = String(e);
  }
  out.T4 = { ok, text, totalMs: ms(a), calls: log.length, steps: log };
}

// T5: Settings root → scroll until "Privacy & Security" (General has no "Shut Down" on the 26.5 simulator).
if (run('T5')) {
  const log: Array<[string, number]> = [];
  const a = now();
  await step(log, 'launch', () => b.openApp({ app: 'com.apple.Preferences', relaunch: true }));
  let s = await step(log, 'observe', () => b.snapshot());
  let scrolls = 0;
  while (!find(s, 'Privacy & Security') && scrolls < 6) {
    await step(log, 'scroll', () => b.scroll('down'));
    scrolls++;
    s = await step(log, 'observe', () => b.snapshot());
  }
  out.T5 = { ok: !!find(s, 'Privacy & Security'), scrolls, totalMs: ms(a), steps: log };
}

// T6: Maps location prompt → read it → dismiss.
if (run('T6')) {
  const log: Array<[string, number]> = [];
  const a = now();
  let ok = false;
  let info: unknown;
  try {
    await step(log, 'reset location permission', () =>
      simulator(udid).permission('reset', 'location', 'com.apple.Maps'),
    );
    await step(log, 'launch Maps', () => b.openApp({ app: 'com.apple.Maps', relaunch: true }));
    let s = await step(log, 'observe', () => b.snapshot());
    for (let i = 0; i < 6 && !s.nodes.some((n) => n.type === 'Alert'); i++) {
      await new Promise((r) => setTimeout(r, 500));
      s = await step(log, 'observe', () => b.snapshot());
    }
    const alertNode = s.nodes.find((n) => n.type === 'Alert');
    info = await step(log, 'alert get', () => b.systemAlert('get'));
    const dismissed = await step(log, 'alert dismiss', () => b.systemAlert('dismiss'));
    ok = !!alertNode && !!dismissed.handled;
    out.T6_inSnapshot = alertNode?.label;
    out.T6_dismissedWith = dismissed.button;
  } catch (e) {
    info = String(e);
  }
  out.T6 = { ok, alert: info, totalMs: ms(a), calls: log.length, steps: log };
}

// T7: Home Screen → long-press an app icon → read the menu → dismiss.
if (run('T7')) {
  const log: Array<[string, number]> = [];
  const a = now();
  let ok = false;
  let menu: string[] = [];
  try {
    await step(log, 'home', () => b.home());
    let s = await step(log, 'observe', () => b.snapshot());
    const icon =
      s.nodes.find((n) => n.type === 'Icon') ?? s.nodes.find((n) => n.type === 'Button' && n.label);
    await step(log, `long press ${icon?.label}`, () => b.longPress(icon!.ref!, 1200));
    s = await step(log, 'observe', () => b.snapshot());
    menu = s.nodes
      .filter((n) => n.type === 'Button' || n.type === 'MenuItem' || n.type === 'Cell')
      .map((n) => n.label ?? '')
      .filter(Boolean)
      .slice(0, 8);
    ok = menu.some((l) => /Remove|Edit Home Screen|Share/i.test(l));
    await step(log, 'home (dismiss)', () => b.home());
  } catch (e) {
    menu = [String(e)];
  }
  out.T7 = { ok, menu, totalMs: ms(a), calls: log.length, steps: log };
}

// T8: Settings root ×5, interactive and full.
if (run('T8'))
  try {
    await b.openApp({ app: 'com.apple.Preferences', relaunch: true });
    const inter: number[] = [];
    const full: number[] = [];
    let si: Snapshot | undefined;
    let sf: Snapshot | undefined;
    for (let i = 0; i < 5; i++) {
      let a = now();
      si = await b.snapshot({ interactiveOnly: true });
      inter.push(ms(a));
      a = now();
      sf = await b.snapshot({ interactiveOnly: false });
      full.push(ms(a));
    }
    out.T8 = {
      interactiveMedianMs: median(inter),
      interactiveNodes: si!.nodes.length,
      interactiveChars: size(si!),
      fullMedianMs: median(full),
      fullNodes: sf!.nodes.length,
      fullChars: size(sf!),
    };
  } catch (e) {
    out.T8 = { error: String(e) };
  }

// T9: stale ref after the screen changed; coordinate out of bounds.
if (run('T9'))
  try {
    await b.openApp({ app: 'com.apple.Preferences', relaunch: true });
    const s = await b.snapshot();
    const general = find(s, 'General', 'Cell')!;
    const accessibility = find(s, 'Accessibility', 'Cell')!;
    await b.press({ ref: general.ref! }); // screen changes
    const stale = await b.press({ ref: accessibility.ref! }).then(
      () => 'tapped (wrong!)',
      (e: Error & { details?: { backendCode?: string; hint?: string } }) =>
        `${e.details?.backendCode}: ${e.message} — ${e.details?.hint}`,
    );
    const oob = await b.press({ x: 5000, y: 5000 }).then(
      () => 'tapped (wrong!)',
      (e: Error & { details?: { backendCode?: string } }) => `${e.details?.backendCode}: ${e.message}`,
    );
    out.T9 = { staleRef: stale, outOfBounds: oob };
  } catch (e) {
    out.T9 = { error: String(e) };
  }

console.log(JSON.stringify(out, null, 2));
process.exit(0);

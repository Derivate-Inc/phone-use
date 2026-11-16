import * as driver from './driver.ts';
import { runSkill, type Skill } from './skills.ts';

// A benchmark is a suite of representative phone tasks, each expressed as a
// self-verifying skill (it ends in a `verify` so pass/fail is objective, not a
// human eyeballing a screenshot). The harness runs each from a clean state,
// times it, and prints a scorecard — turning "verified live" anecdotes into a
// repeatable, measurable score across the capability classes: read, navigate,
// search+act, and create+confirm.

export type BenchTask = {
  name: string;
  klass: string;
  skill: Skill;
  args?: Record<string, string>;
  setup?: () => Promise<void>;
};
export type BenchResult = {
  name: string;
  klass: string;
  ok: boolean;
  ms: number;
  detail: string;
  attempts: number;
};

const SETTINGS = 'com.apple.Preferences';
const MAPS = 'com.apple.Maps';
const CONTACTS = 'com.apple.MobileAddressBook';

// Relaunch an app to a clean initial screen so a run doesn't inherit a prior
// task's sub-screen (the state-leak class we've hit repeatedly).
const fresh = (bundle: string) => async () => {
  await driver.openApp(bundle, true);
  await Bun.sleep(1000);
};

// Contacts restores whatever was last on screen (a contact detail, an unsaved
// Add form) rather than the list. Recovering to the list — where the "Add" (+)
// button lives — means walking the nav stack back AND clearing any modal /
// discard confirmation. goToRoot handles the nav stack; the loop clears modals.
// Stop as soon as the exact "Add" button is present.
const freshContacts = () => async () => {
  await driver.openApp(CONTACTS, true);
  await Bun.sleep(1000);
  for (let i = 0; i < 5; i++) {
    await driver.observe();
    const els = driver.interactiveElements();
    if (els.some((e) => e.label === 'Add')) return; // clean contact list reached
    const modal = ['Cancel', 'Discard Changes', 'Delete']
      .map((l) => els.find((e) => e.label === l))
      .find(Boolean);
    if (modal) {
      await driver.press(modal.ref);
      await Bun.sleep(700);
      continue;
    }
    // Contacts nests Lists → All Contacts → detail; the "Add" (+) button lives on
    // the All Contacts screen, so step into it if we're on the Lists root.
    const allContacts = els.find((e) => e.label === 'All Contacts');
    if (allContacts) {
      await driver.press(allContacts.ref);
      await Bun.sleep(800);
      continue;
    }
    await driver.goToRoot(CONTACTS); // walk back from a contact detail toward the list
    await Bun.sleep(500);
  }
};

export const SUITE: BenchTask[] = [
  {
    name: 'read-ios-version',
    klass: 'read',
    setup: fresh(SETTINGS),
    skill: {
      name: 'b-read',
      steps: [
        { op: 'goto', app: SETTINGS, destination: 'About' },
        // The row label, not a version number: the simulator's iOS version varies by host.
        { op: 'verify', contains: 'iOS Version' },
      ],
    },
  },
  {
    name: 'deep-nav-accessibility',
    klass: 'navigate',
    setup: fresh(SETTINGS),
    // "Vision" is the Accessibility landing section (visible without scrolling);
    // verifyScreen checks the current viewport, so the landmark must be on it.
    skill: {
      name: 'b-nav',
      steps: [
        { op: 'goto', app: SETTINGS, destination: 'Accessibility' },
        { op: 'verify', contains: 'Vision' },
      ],
    },
  },
  {
    name: 'search-open-maps',
    klass: 'search+act',
    setup: fresh(MAPS),
    skill: {
      name: 'b-search',
      steps: [
        { op: 'search_open', app: MAPS, query: 'coffee' },
        { op: 'verify', contains: 'Coffee' },
      ],
    },
  },
  {
    name: 'toggle-setting',
    klass: 'toggle',
    setup: fresh(SETTINGS),
    // No verify: the toggle step reports ok only if it found and set the switch
    // (idempotent on=true), so run.ok is the objective pass signal.
    skill: {
      name: 'b-toggle',
      // "Full-Screen Previews" (the 26.1 fixture) does not exist on the 26.5
      // simulator; Camera's Grid switch does.
      steps: [{ op: 'toggle', app: SETTINGS, switch: 'Grid', on: true }],
    },
  },
  {
    name: 'phone-wide-ask',
    klass: 'ask-anywhere',
    // No app given — resolves which mapped app holds "iOS Version" (Settings,
    // mapped by read-ios-version earlier in the suite) and reads it.
    skill: {
      name: 'b-ask',
      steps: [
        { op: 'ask', field: 'iOS Version' },
        // The row label, not a version number: the simulator's iOS version varies by host.
        { op: 'verify', contains: 'iOS Version' },
      ],
    },
  },
  {
    name: 'create-contact',
    klass: 'create',
    setup: freshContacts(),
    skill: {
      name: 'b-create',
      steps: [
        { op: 'tap', label: 'Add', app: CONTACTS },
        // verify-as-wait: the New Contact sheet animates in; poll until its
        // field is present before filling, so we don't race the animation.
        { op: 'verify', contains: 'First name' },
        { op: 'fill', field: 'First name', value: 'Alan' },
        { op: 'fill', field: 'Last name', value: 'Turing' },
        { op: 'tap', label: 'Done' },
        { op: 'verify', contains: 'Alan' },
      ],
    },
  },
];

async function runTask(task: BenchTask): Promise<Omit<BenchResult, 'name' | 'klass' | 'attempts'>> {
  try {
    if (task.setup) await task.setup();
    const t = performance.now();
    const run = await runSkill(task.skill, task.args ?? {}, { retries: 1 });
    const ms = Math.round(performance.now() - t);
    const failed = run.steps.find((s) => !s.ok);
    return { ok: run.ok, ms, detail: run.ok ? 'passed' : `failed at ${failed?.op}: ${failed?.detail}` };
  } catch (error) {
    return { ok: false, ms: 0, detail: `error: ${driver.describeError(error)}` };
  }
}

// Each task re-runs from its clean setup once on failure. The simulator/daemon
// occasionally stalls (a task spiking to 20-130s then failing), and a quality
// gate that flags those as regressions isn't trustworthy — a retry lets a
// transient stall self-correct, while a genuine failure (fails twice) still
// reports. `attempts` makes the transient rate visible rather than hidden.
export async function runBench(suite: BenchTask[] = SUITE): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  for (const task of suite) {
    let r = await runTask(task);
    let attempts = 1;
    if (!r.ok) {
      r = await runTask(task);
      attempts = 2;
    }
    results.push({ name: task.name, klass: task.klass, attempts, ...r });
  }
  return results;
}

export function scorecard(results: BenchResult[]): string {
  const pass = results.filter((r) => r.ok).length;
  const avg = results.length ? Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length) : 0;
  const retried = results.filter((r) => r.attempts > 1).length;
  const rows = results.map(
    (r) =>
      `  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(24)} ${r.klass.padEnd(11)} ${String(r.ms).padStart(6)}ms  ${r.detail}${r.attempts > 1 ? ' (retried)' : ''}`,
  );
  const note = retried ? ` · ${retried} retried (transient)` : '';
  return `Phone Use benchmark — ${pass}/${results.length} passed, avg ${avg}ms/task${note}\n${rows.join('\n')}`;
}

const XML_ESCAPES: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
  "'": '&apos;',
};
const xml = (s: string) => s.replace(/[<>&"']/g, (c) => XML_ESCAPES[c] as string);

/** JUnit XML for CI ingestion — `phone-use bench --format junit`. */
export function junitReport(results: BenchResult[]): string {
  const failures = results.filter((r) => !r.ok).length;
  const time = (results.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(3);
  const cases = results.map((r) => {
    const attrs = `classname="${xml(r.klass)}" name="${xml(r.name)}" time="${(r.ms / 1000).toFixed(3)}"`;
    return r.ok
      ? `    <testcase ${attrs}/>`
      : `    <testcase ${attrs}>\n      <failure message="${xml(r.detail)}"/>\n    </testcase>`;
  });
  const suite = `name="phone-use bench" tests="${results.length}" failures="${failures}" time="${time}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${results.length}" failures="${failures}" time="${time}">\n  <testsuite ${suite}>\n${cases.join('\n')}\n  </testsuite>\n</testsuites>\n`;
}

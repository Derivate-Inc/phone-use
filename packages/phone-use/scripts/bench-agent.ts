// Natural-language harness benchmark: the same capability classes as the
// deterministic suite (src/bench.ts), but phrased as GOALS and executed by a
// real LLM agent — headless Claude Code (subscription auth) driving our MCP
// server — so it scores the HARNESS (observation diffing, batch, verify tools,
// maps, prompts), not just the deterministic layer.
//
// Honest measurement rules:
// - Success is judged DETERMINISTICALLY after the run (driver re-observes and
//   checks state / expected text), never by trusting the agent's self-report.
//   Where the goal is a question, the answer must ALSO appear in the reply.
// - One driver process at a time (hard daemon rule): setup via our client →
//   closeSession → spawn claude (its MCP server owns the device) → after exit,
//   kill any leftover MCP server → verify via our client.
// - Reports wall-clock sec/task, agent turns, and token usage per task — the
//   sec/task table for a11y-first phone agents that doesn't exist publicly yet.
//
// Usage: bun scripts/bench-agent.ts [--json] [--model opus]

import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listMaps, loadMap, saveMap } from '../src/appmap.ts';
import * as driver from '../src/driver.ts';
import { toggleField, verifyScreen } from '../src/task.ts';
import { zipAppend } from '../src/zip.ts';

const io = { loadMap, saveMap, listMaps };
const MODEL = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1]! : 'opus';
const JSON_OUT = process.argv.includes('--json');
// --surface raw = ablation baseline: primitives only (no goto/ask/toggle/
// search/skill/atlas/batch). Measures what the harness layer contributes vs a
// raw LLM with bare screen control. --complex adds the harder task set.
const SURFACE = process.argv.includes('--surface')
  ? process.argv[process.argv.indexOf('--surface') + 1]!
  : 'full';
const COMPLEX = process.argv.includes('--complex');
const SETTINGS = 'com.apple.Preferences';
const CONTACTS = 'com.apple.MobileAddressBook';

// The harness prompt rules (mirrors src/agent.ts SYSTEM): milestones,
// two-strike, reflection-on-demand — injected so headless Claude Code runs the
// same harness discipline as the built-in loop.
const HARNESS_RULES_FULL = `You are operating a real iPhone through the phone-use tools.
Plan by desired END-STATES (milestones) and confirm each with observe's expect param instead of re-reading the screen and judging by eye.
TWO-STRIKE RULE: if the same action fails to have its expected effect twice, switch to a genuinely different mechanism (different element, scroll, handle_alert, search, goto, deep link) — never a third variation of the same failing action.
If an action's result is unexpected, stop and reflect for one step before continuing.
Prefer high-level tools (goto, ask, toggle, search, batch) over step-by-step tapping when they apply.
Isolate unpredictable actions: nav, open, and deep links must be the ONLY action that turn — observe before acting further.
Mark a milestone done only on OBSERVED evidence (an expect check or a value you read), never in advance.
Before leaving a screen whose data you need later, save it with the note tool exactly as observed; read it back where needed — do not trust recall across apps.
If a tool returns CONFIRMATION REQUIRED and the user's goal clearly authorizes that exact action, re-call it with the confirm token; otherwise stop and report.
When the goal is a question, end your reply with just the answer.`;

// Raw baseline gets the same discipline minus the tools that don't exist there.
const HARNESS_RULES_RAW = `You are operating a real iPhone through the phone-use tools.
Plan by desired END-STATES (milestones) and confirm each with observe's expect param instead of re-reading the screen and judging by eye.
TWO-STRIKE RULE: if the same action fails to have its expected effect twice, switch to a genuinely different mechanism (different element, scroll, handle_alert, deep link) — never a third variation of the same failing action.
If an action's result is unexpected, stop and reflect for one step before continuing.
If a tool returns CONFIRMATION REQUIRED and the user's goal clearly authorizes that exact action, re-call it with the confirm token; otherwise stop and report.
When the goal is a question, end your reply with just the answer.`;

const HARNESS_RULES = SURFACE === 'raw' ? HARNESS_RULES_RAW : HARNESS_RULES_FULL;

type AgentTask = {
  name: string;
  klass: string;
  goal: string;
  /** deterministic post-run check via our own driver (never agent self-report) */
  verify: () => Promise<{ ok: boolean; detail: string }>;
  /** expected substring in the agent's final reply (for question tasks) */
  answerContains?: string;
  setup?: () => Promise<void>;
  maxTurns?: number;
};

const RUN_TAG = `H${Date.now().toString(36).slice(-4)}`; // unique per run: create-task false-positive guard
// Per-task trace artifacts (docs/20 item 6): each spawned agent records a zip;
// passes are deleted, failures keep the zip + get the bench verdict appended.
const TRACE_DIR = join(homedir(), '.phone-use', 'traces', `bench-${RUN_TAG}`);

const SUITE: AgentTask[] = [
  {
    name: 'nl-read-version',
    klass: 'read',
    goal: 'What iOS version is this phone running?',
    answerContains: '26.1',
    // The question is answerable only by having actually navigated: verify the
    // phone is left on a screen showing the version, or accept the map-cached
    // path (ask tool) — deterministic floor: the ANSWER must be right.
    verify: async () => ({ ok: true, detail: 'graded by answerContains' }),
  },
  {
    name: 'nl-deep-nav',
    klass: 'navigate',
    goal: 'Open Settings and navigate to the Accessibility screen. Stay there.',
    verify: async () => {
      await driver.observe();
      const r = await verifyScreen('Motion');
      if (r.ok) return { ok: true, detail: 'Accessibility screen visible (Motion present)' };
      const r2 = await verifyScreen('Hover Text');
      return {
        ok: r2.ok,
        detail: r2.ok ? 'Accessibility screen visible (Hover Text present)' : 'not on Accessibility screen',
      };
    },
  },
  {
    name: 'nl-search-open',
    klass: 'search+act',
    goal: 'In Maps, search for coffee and open the first result so its details are showing.',
    verify: async () => {
      await driver.observe();
      const els = driver.currentElements().elements.toLowerCase();
      const ok = els.includes('coffee') || els.includes('café') || els.includes('cafe');
      return { ok, detail: ok ? 'Maps showing a coffee result' : 'no coffee result visible in Maps' };
    },
  },
  {
    name: 'nl-toggle',
    klass: 'toggle',
    goal: 'In Settings, turn ON the "Full-Screen Previews" switch.',
    setup: async () => {
      // Force it OFF first so "turn on" always requires a real state change.
      await toggleField(SETTINGS, 'Full-Screen Previews', io, false);
    },
    verify: async () => {
      // Read back the actual switch state.
      const el = await driver.findElement('Full-Screen Previews');
      const on = el?.value === '1';
      return { ok: on, detail: on ? 'switch reads 1 (on)' : `switch reads ${el?.value ?? 'not found'}` };
    },
  },
  {
    name: 'nl-phone-ask',
    klass: 'ask-anywhere',
    goal: 'Tell me the model name of this phone.',
    answerContains: 'iPhone 16e',
    verify: async () => ({ ok: true, detail: 'graded by answerContains' }),
  },
  {
    name: 'nl-create-contact',
    klass: 'create',
    goal: `Create a new contact whose first name is Ada and last name is ${RUN_TAG}, and save it.`,
    maxTurns: 40,
    setup: async () => {
      // Start from the Contacts list, not a leftover contact card from a prior
      // run — a stale detail screen was what tripped this task in the v1 run.
      await driver.openApp('com.apple.MobileAddressBook', true);
      await Bun.sleep(1200);
      await driver.observe();
      // If parked on a contact's card, back out to the list.
      for (let i = 0; i < 3; i++) {
        const onList =
          (await driver.findElement('Groups')) ||
          (await driver.findElement('All Contacts')) ||
          (await driver.findElement('Lists'));
        if (onList) break;
        try {
          await driver.goBack();
        } catch {
          break;
        }
        await driver.observe();
      }
    },
    verify: async () => {
      // The contact must actually exist: open Contacts fresh and look for it.
      await driver.openApp('com.apple.MobileAddressBook', true);
      await Bun.sleep(1500);
      await driver.observe();
      const el = await driver.findElement(RUN_TAG);
      return {
        ok: el != null,
        detail: el ? `contact "${el.label}" exists` : `no contact containing "${RUN_TAG}" found`,
      };
    },
  },
];

// Complex set (--complex): AndroidWorld task patterns translated to iOS
// first-party apps — event creation, timers/stopwatch state, destructive
// flows through the permission gate, and a cross-app value carry. Same
// deterministic-grading discipline.
const COMPLEX_SUITE: AgentTask[] = [
  {
    name: 'nl-calendar-event',
    klass: 'create (AndroidWorld: SimpleCalendarAddOneEvent)',
    goal: `In the Calendar app, create a new event today called "Standup ${RUN_TAG}" and save it.`,
    maxTurns: 40,
    verify: async () => {
      await driver.openApp('com.apple.mobilecal', true);
      await Bun.sleep(1500);
      await driver.observe();
      const el = await driver.findElement(RUN_TAG);
      return {
        ok: el != null,
        detail: el ? `event "${el.label}" visible in Calendar` : `no event containing "${RUN_TAG}" visible`,
      };
    },
  },
  {
    // Clock isn't installed on this sim; Maps directions is the multi-step
    // app-flow analog (AndroidWorld: MapsDirections family) on an installed app.
    name: 'nl-maps-directions',
    klass: 'multi-step act (Maps directions)',
    goal: 'In Maps, search for a coffee shop, open it, and start directions to it.',
    verify: async () => {
      await driver.openApp('com.apple.Maps');
      await Bun.sleep(1500);
      await driver.observe();
      const dir =
        (await driver.findElement('End Route')) ||
        (await driver.findElement('min')) ||
        (await driver.findElement('Directions')) ||
        (await driver.findElement('Route'));
      return {
        ok: dir != null,
        detail: dir
          ? `directions/route active ("${dir.label}" visible)`
          : 'no route/directions state visible',
      };
    },
  },
  {
    name: 'nl-safari-nav',
    klass: 'navigate+read (Safari)',
    goal: 'Open apple.com in Safari and tell me the text of the main heading on the page.',
    answerContains: 'apple',
    verify: async () => ({ ok: true, detail: 'graded by answerContains (must load the page and read it)' }),
  },
  {
    name: 'nl-contact-delete',
    klass: 'destructive (permission-gate live)',
    goal: `Delete the contact named Zed ${RUN_TAG} from Contacts.`,
    maxTurns: 40,
    setup: async () => {
      // Create the victim contact deterministically (zero-LLM skill).
      const { runSkill } = await import('../src/skills.ts');
      await driver.openApp(CONTACTS, true);
      await Bun.sleep(1200);
      await driver.observe();
      const r = await runSkill(
        {
          name: 'setup-zed',
          steps: [
            { op: 'tap', label: 'Add', app: CONTACTS },
            { op: 'verify', contains: 'First name' },
            { op: 'fill', field: 'First name', value: 'Zed' },
            { op: 'fill', field: 'Last name', value: RUN_TAG },
            { op: 'tap', label: 'Done' },
            { op: 'verify', contains: 'Zed' },
          ],
        },
        {},
        { retries: 1 },
      );
      if (!r.ok) throw new Error('setup failed to create the victim contact');
    },
    verify: async () => {
      await driver.openApp(CONTACTS, true);
      await Bun.sleep(1500);
      await driver.observe();
      const el = await driver.findElement(`Zed ${RUN_TAG}`);
      return {
        ok: el == null,
        detail: el
          ? `contact "${el.label}" still exists — not deleted`
          : 'contact gone (deleted through the gate)',
      };
    },
  },
  {
    name: 'nl-cross-app',
    klass: 'cross-app carry',
    goal: "Find this phone's model name in Settings, then create a new contact whose first name is exactly that model name, and save it.",
    maxTurns: 40,
    verify: async () => {
      await driver.openApp(CONTACTS, true);
      await Bun.sleep(1500);
      await driver.observe();
      const el = await driver.findElement('iPhone 16e');
      return {
        ok: el != null,
        detail: el
          ? `contact "${el.label}" exists (model name carried across apps)`
          : 'no contact named after the model',
      };
    },
  },
  {
    name: 'nl-settings-compound',
    klass: 'read+act compound',
    goal: 'In Settings, find the Full-Screen Previews switch. Tell me whether it was on or off when you found it, and make sure it ends up OFF.',
    answerContains: 'on',
    setup: async () => {
      const { toggleField } = await import('../src/task.ts');
      await toggleField(SETTINGS, 'Full-Screen Previews', io, true); // start ON so "was on, now off" is checkable
    },
    verify: async () => {
      const el = await driver.findElement('Full-Screen Previews');
      const off = el?.value === '0';
      return {
        ok: off,
        detail: off ? 'switch reads 0 (off) as required' : `switch reads ${el?.value ?? 'not found'}`,
      };
    },
  },
];

type AgentResult = {
  name: string;
  klass: string;
  ok: boolean;
  detail: string;
  answerOk?: boolean | undefined;
  stateOk: boolean;
  ms: number;
  agentMs?: number | undefined;
  turns?: number | undefined;
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  reply?: string | undefined;
  error?: string | undefined;
};

async function killLeftoverMcp(): Promise<void> {
  // The spawned claude's stdio MCP server should die with it; SIGKILL any
  // survivor — two live driver processes stall the daemon (hard-won lesson).
  const proc = Bun.spawn(['pgrep', '-f', 'index.ts mcp'], { stdout: 'pipe' });
  const out = await new Response(proc.stdout).text();
  for (const pid of out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

async function runAgentTask(task: AgentTask): Promise<AgentResult> {
  const started = performance.now();
  try {
    if (task.setup) await task.setup();
    // Release the device so the agent's MCP server is the only driver process.
    await driver.closeSession().catch(() => undefined);

    const args = [
      '-p',
      task.goal,
      '--model',
      MODEL,
      '--mcp-config',
      '.mcp.json',
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__phone-use',
      '--append-system-prompt',
      HARNESS_RULES,
      '--output-format',
      'json',
      '--max-turns',
      String(task.maxTurns ?? 30),
    ];
    const tracePath = join(TRACE_DIR, `${task.name}.zip`);
    mkdirSync(TRACE_DIR, { recursive: true });
    const env: Record<string, string | undefined> = {
      ...process.env,
      PHONE_USE_MODE: 'auto',
      PHONE_USE_SURFACE: SURFACE,
      PHONE_USE_TRACE_MODE: 'on',
      PHONE_USE_TRACE_OUT: tracePath,
    }; // trusted-autonomous: routine mutations free, destructive still gated
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const proc = Bun.spawn(['claude', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: env as Record<string, string>,
      cwd: `${import.meta.dir}/../../..`,
    });
    const timeout = setTimeout(() => proc.kill('SIGKILL'), 6 * 60 * 1000);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timeout);
    await killLeftoverMcp();

    let reply = '';
    let turns: number | undefined;
    let agentMs: number | undefined;
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    try {
      const j = JSON.parse(stdout);
      reply = String(j.result ?? '');
      turns = j.num_turns;
      agentMs = j.duration_ms;
      tokensIn =
        (j.usage?.input_tokens ?? 0) +
        (j.usage?.cache_read_input_tokens ?? 0) +
        (j.usage?.cache_creation_input_tokens ?? 0);
      tokensOut = j.usage?.output_tokens;
    } catch {
      reply = stdout.slice(0, 300);
    }

    // Deterministic post-verify with our own driver.
    const state = await task.verify();
    const answerOk = task.answerContains
      ? reply.toLowerCase().includes(task.answerContains.toLowerCase())
      : undefined;
    const ok = state.ok && (answerOk ?? true);
    if (ok) {
      // Happy path: the trace has no audience — delete it best-effort.
      try {
        unlinkSync(tracePath);
      } catch {
        /* may not exist (agent died before flushing) */
      }
    } else {
      // Failure: ride the bench verdict into the same artifact, keep the zip.
      try {
        zipAppend(tracePath, [
          {
            name: 'verdict.json',
            data: JSON.stringify(
              { source: 'bench', task: task.name, ok, detail: state.detail, answerOk },
              null,
              2,
            ),
          },
        ]);
      } catch {
        /* zip may be absent — never fail the bench over the trace */
      }
      if (!JSON_OUT && existsSync(tracePath)) console.log(`    trace: ${tracePath}`);
    }
    return {
      name: task.name,
      klass: task.klass,
      ok,
      detail: `${state.detail}${task.answerContains ? `; answer ${answerOk ? 'correct' : `WRONG (wanted "${task.answerContains}")`}` : ''}`,
      answerOk,
      stateOk: state.ok,
      ms: Math.round(performance.now() - started),
      agentMs,
      turns,
      tokensIn,
      tokensOut,
      reply: reply.slice(0, 200),
    };
  } catch (error) {
    await killLeftoverMcp();
    return {
      name: task.name,
      klass: task.klass,
      ok: false,
      stateOk: false,
      detail: 'run error',
      ms: Math.round(performance.now() - started),
      error: driver.describeError(error),
    };
  }
}

const results: AgentResult[] = [];
const ACTIVE_SUITE = COMPLEX ? COMPLEX_SUITE : SUITE;
for (const task of ACTIVE_SUITE) {
  if (!JSON_OUT) console.log(`▶ ${task.name} — "${task.goal}"`);
  const r = await runAgentTask(task);
  results.push(r);
  if (!JSON_OUT) {
    console.log(
      `  ${r.ok ? '✓' : '✗'} ${r.detail} — ${(r.ms / 1000).toFixed(1)}s wall (${r.agentMs ? `${(r.agentMs / 1000).toFixed(1)}s agent` : 'n/a'}, ${r.turns ?? '?'} turns)`,
    );
    if (!r.ok && r.reply) console.log(`    reply: ${r.reply}`);
    if (r.error) console.log(`    error: ${r.error}`);
  }
}

const passed = results.filter((r) => r.ok).length;
const avg = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);
if (JSON_OUT) {
  console.log(JSON.stringify({ model: MODEL, passed, total: results.length, avgMs: avg, results }, null, 2));
} else {
  console.log(
    `\nHarness benchmark (model=${MODEL}, surface=${SURFACE}) — ${passed}/${results.length} passed, avg ${(avg / 1000).toFixed(1)}s/task`,
  );
  console.log('task                      ok  wall(s)  agent(s)  turns  tokens(in/out)');
  for (const r of results) {
    console.log(
      `${r.name.padEnd(26)}${r.ok ? '✓' : '✗'}   ${(r.ms / 1000).toFixed(1).padStart(6)}  ${r.agentMs ? (r.agentMs / 1000).toFixed(1).padStart(8) : '     n/a'}  ${String(r.turns ?? '?').padStart(5)}  ${r.tokensIn ?? '?'}/${r.tokensOut ?? '?'}`,
    );
  }
}
process.exit(passed === results.length ? 0 : 1);

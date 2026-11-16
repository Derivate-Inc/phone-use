// Labyrinth benchmark — the NOVELTY test. A custom hard SwiftUI app (no
// training-data familiarity) that is hostile by design: 5-deep navigation,
// confusable sibling labels, decoy controls, a multi-step order wizard. Graded
// DETERMINISTICALLY by reading the app's own ground-truth state.json via
// `simctl get_app_container` (AndroidWorld-style; better than iOSWorld's
// LLM-judge). Runs the SAME tasks on the full harness vs the raw primitives-only
// surface, so we can see whether the map/intent layer is doing real work when
// the app is genuinely hard and unfamiliar.
//
//   bun scripts/bench-labyrinth.ts [--surface raw|full] [--model opus]

import { execFileSync } from 'node:child_process';
import { forgetMap } from '../src/appmap.ts';
import * as driver from '../src/driver.ts';

const BUNDLE = 'com.phoneuse.labyrinth';
const MODEL = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1]! : 'opus';
const SURFACE = process.argv.includes('--surface')
  ? process.argv[process.argv.indexOf('--surface') + 1]
  : 'full';
const UDID = process.env.PHONE_USE_UDID || 'booted';

type State = {
  telemetry: boolean;
  crashReports: boolean;
  telemetryLogging: boolean;
  favorites: string[];
  orders: { id: string; item: string; qty: number; address: string }[];
  licenseViewed: boolean;
  showCodes: boolean;
  vaultUnlocked: boolean;
  beaconClaimed: boolean;
};

function readState(): State | null {
  try {
    const container = execFileSync('xcrun', ['simctl', 'get_app_container', UDID, BUNDLE, 'data'], {
      encoding: 'utf8',
    }).trim();
    const path = `${container}/Documents/state.json`;
    return JSON.parse(require('node:fs').readFileSync(path, 'utf8')) as State;
  } catch {
    return null;
  }
}

function resetState(): void {
  try {
    const container = execFileSync('xcrun', ['simctl', 'get_app_container', UDID, BUNDLE, 'data'], {
      encoding: 'utf8',
    }).trim();
    require('node:fs').rmSync(`${container}/Documents/state.json`, { force: true });
  } catch {
    /* not installed / no state yet */
  }
}

const RULES = `You are operating an unfamiliar iPhone app called Labyrinth through the phone-use tools. Its labels are deliberately confusing: there are decoy controls and near-identical sibling names, so read carefully and verify you are on the RIGHT one before acting. Plan by desired END-STATES and confirm with observe's expect param. If the same action fails twice, switch mechanism. When the goal is a question, end with just the answer.${SURFACE === 'full' ? ' Prefer goto/ask/toggle/search over manual tapping when they apply.' : ''}`;

type Task = {
  name: string;
  goal: string;
  grade: (state: State | null, reply: string) => { ok: boolean; detail: string };
  maxTurns?: number;
};

const SUITE: Task[] = [
  {
    name: 'deep-toggle',
    goal: 'In Labyrinth, turn ON the Telemetry data-sharing setting. Note: there is a decoy "Telemetry Logging" switch elsewhere — that is NOT it; the real Telemetry switch is under Settings > General > Privacy.',
    grade: (s) => ({
      ok: s?.telemetry === true && s?.telemetryLogging === false,
      detail: s ? `telemetry=${s.telemetry}, decoy telemetryLogging=${s.telemetryLogging}` : 'no state',
    }),
  },
  {
    name: 'confusable-favorite',
    goal: 'In Labyrinth, add the exotic component "Quantum Flux Capacitor v2" to Favorites — the v2, not the plain one and not the Regulator.',
    grade: (s) => ({
      ok:
        !!s &&
        s.favorites.includes('Quantum Flux Capacitor v2') &&
        !s.favorites.includes('Quantum Flux Capacitor') &&
        !s.favorites.includes('Quantum Flux Regulator'),
      detail: s ? `favorites=[${s.favorites.join(', ')}]` : 'no state',
    }),
    maxTurns: 40,
  },
  {
    name: 'order-wizard',
    goal: 'In Labyrinth, place a new order for 3 units of "Nebula Widget Pro" shipped to "500 Fifth Ave", then tell me the order number.',
    maxTurns: 45,
    grade: (s, reply) => {
      const o = s?.orders.find(
        (x) => x.item === 'Nebula Widget Pro' && x.qty === 3 && x.address.includes('Fifth'),
      );
      const numMatches = o ? reply.includes(o.id) : false;
      return {
        ok: !!o && numMatches,
        detail: o
          ? `order ${o.id} correct; number ${numMatches ? 'reported' : 'NOT in reply'}`
          : `no matching order (orders=${s?.orders.length ?? 0})`,
      };
    },
  },
  {
    name: 'buried-license',
    goal: 'Find the License Key inside the Labyrinth app and tell it to me. (It is buried deep under Settings > About.)',
    maxTurns: 40,
    grade: (s, reply) => ({
      ok: reply.includes('PU-7X49-KM31') && s?.licenseViewed === true,
      detail: `licenseViewed=${s?.licenseViewed}; key ${reply.includes('PU-7X49-KM31') ? 'reported' : 'MISSING from reply'}`,
    }),
  },
  {
    // Cross-screen DEPENDENCY + carry: the access code is masked until "Show
    // Codes" is enabled on a different screen. Discover the dependency, enable
    // it, read the revealed code, carry it to the Door, type it, unlock.
    name: 'vault-dependency',
    goal: 'In the Labyrinth app, unlock the Vault door. The access code is hidden until you enable it, and you must find where to reveal it, then enter it at the door.',
    maxTurns: 50,
    grade: (s) => ({
      ok: s?.vaultUnlocked === true,
      detail: s ? `vaultUnlocked=${s.vaultUnlocked}, showCodes=${s.showCodes}` : 'no state',
    }),
  },
  {
    // 8-deep navigation stamina with plausible decoy doors: pick the door
    // numbered with the next prime each chamber, reach the sanctum, claim it.
    name: 'gauntlet-8deep',
    goal: 'In the Labyrinth app, enter the Gauntlet (under Home > Trials) and reach the Inner Sanctum. In each chamber, choose the door numbered with the next prime number (2, 3, 5, 7, 11, 13, 17, 19). Claim the Beacon at the end.',
    maxTurns: 60,
    grade: (s) => ({
      ok: s?.beaconClaimed === true,
      detail: s ? `beaconClaimed=${s.beaconClaimed}` : 'no state',
    }),
  },
];

async function killLeftoverMcp(): Promise<void> {
  try {
    const out = execFileSync('pgrep', ['-f', 'index.ts mcp'], { encoding: 'utf8' });
    for (const pid of out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  } catch {
    /* none */
  }
}

type Result = {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
  agentMs?: number | undefined;
  turns?: number | undefined;
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  reply?: string | undefined;
};

async function run(task: Task): Promise<Result> {
  const started = performance.now();
  resetState();
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
    RULES,
    '--output-format',
    'json',
    '--max-turns',
    String(task.maxTurns ?? 30),
  ];
  const env: Record<string, string | undefined> = {
    ...process.env,
    PHONE_USE_MODE: 'auto',
    PHONE_USE_SURFACE: SURFACE,
  };
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
  let turns: number | undefined,
    agentMs: number | undefined,
    tokensIn: number | undefined,
    tokensOut: number | undefined;
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
    reply = stdout.slice(0, 200);
  }

  const g = task.grade(readState(), reply);
  return {
    name: task.name,
    ok: g.ok,
    detail: g.detail,
    ms: Math.round(performance.now() - started),
    agentMs,
    turns,
    tokensIn,
    tokensOut,
    reply: reply.slice(0, 160),
  };
}

// Fresh map each full-surface session start would be unfair to compare against
// raw; but the whole point is that the harness CAN build+reuse a map. We forget
// Labyrinth's map once at the very start so the first task pays the crawl and
// later tasks reuse it — exactly the intended lifecycle.
await forgetMap(BUNDLE).catch(() => undefined);

const results: Result[] = [];
for (const task of SUITE) {
  console.log(`▶ [${SURFACE}] ${task.name} — ${task.goal.slice(0, 70)}…`);
  const r = await run(task);
  results.push(r);
  console.log(
    `  ${r.ok ? '✓' : '✗'} ${r.detail} — ${(r.ms / 1000).toFixed(1)}s, ${r.turns ?? '?'} turns, ${r.tokensIn ?? '?'} tok in`,
  );
  if (!r.ok && r.reply) console.log(`    reply: ${r.reply}`);
}

const passed = results.filter((r) => r.ok).length;
const totalTok = results.reduce((s, r) => s + (r.tokensIn ?? 0), 0);
const totalTurns = results.reduce((s, r) => s + (r.turns ?? 0), 0);
console.log(
  `\nLabyrinth (surface=${SURFACE}, model=${MODEL}) — ${passed}/${results.length} passed, ${totalTurns} turns, ${Math.round(totalTok / 1000)}k tokens total`,
);
process.exit(passed === results.length ? 0 : 1);

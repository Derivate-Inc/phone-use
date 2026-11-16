// Run iOSWorld tasks (github.com/ljang0/iOSWorld) with OUR stack:
// headless Claude Code (subscription auth) driving the phone-use MCP server
// against their 26 synthetic apps installed on the simulator.
//
// Their runners require API keys (and their judge requires OpenAI). We run the
// agent on subscription and grade two ways:
//   1. reply-side: the goal's asked-for facts must appear in the reply (many
//      tasks ask the agent to report something)
//   2. a Claude-as-judge pass over the rubric using headless claude
//      (subscription) — same LLM-judge approach as their GPT judge, disclosed.
// This is NOT their official verified pipeline; treat scores as informal.
//
//   bun scripts/bench-iosworld.ts --tasks caltrack-001,notes-002 [--model opus]
//   bun scripts/bench-iosworld.ts --category single_app --limit 5

import * as driver from '../src/driver.ts';

const IOSWORLD =
  process.env.IOSWORLD_DIR ??
  '/private/tmp/claude-501/-Users-rajmeet-Dev-phone-use/c5ba94cb-6cbd-4b76-9ed4-a0c8b6c4a473/scratchpad/iOSWorld';
const MODEL = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1]! : 'opus';
// Judge model is separate from the agent model: pinning the agent to an older
// model for leaderboard comparability shouldn't weaken the grader.
const JUDGE_MODEL = process.argv.includes('--judge-model')
  ? process.argv[process.argv.indexOf('--judge-model') + 1]!
  : 'haiku';
// Judge backend: 'codex' = GPT via Codex CLI on ChatGPT sign-in (closest to
// iOSWorld's own GPT judge, and avoids Claude-grading-Claude self-bias);
// 'claude' = Claude via the CLI.
const JUDGE = process.argv.includes('--judge') ? process.argv[process.argv.indexOf('--judge') + 1]! : 'codex';
const ONLY = process.argv.includes('--tasks')
  ? process.argv[process.argv.indexOf('--tasks') + 1]!.split(',')
  : null;
const CATEGORY = process.argv.includes('--category')
  ? process.argv[process.argv.indexOf('--category') + 1]!
  : null;
const LIMIT = process.argv.includes('--limit')
  ? Number(process.argv[process.argv.indexOf('--limit') + 1]!)
  : 10;
const ALL = process.argv.includes('--all');
const RESULTS = process.argv.includes('--results')
  ? process.argv[process.argv.indexOf('--results') + 1]!
  : null;
// --surface cli: the agent drives the phone via Bash + the phone-use CLI
// (one-shot verbs, ~200 tokens/action) instead of the MCP server. --device
// pins every verb (and judge screenshots) to one simulator; --shard k/n
// stripes the task list so two lanes on two sims run disjoint work.
const CLI_MODE =
  process.argv.includes('--surface') && process.argv[process.argv.indexOf('--surface') + 1] === 'cli';
const DEVICE = process.argv.includes('--device')
  ? process.argv[process.argv.indexOf('--device') + 1]!
  : undefined;
const SHARD = process.argv.includes('--shard')
  ? process.argv[process.argv.indexOf('--shard') + 1]!.split('/').map(Number)
  : null;

type IWTask = {
  name: string;
  goal: string;
  apps: string[];
  category: string;
  difficulty: string;
  rubric: { criterion: string }[];
};

// Pre-run disk check: a 97%-full disk crashed the XCTest runner mid-run
// (mem-001 lost a criterion to it). Refuse to start under 5GB free.
{
  const df = Bun.spawnSync(['df', '-g', '/System/Volumes/Data']).stdout.toString();
  const freeGb = Number(df.trim().split('\n').pop()?.split(/\s+/)[3] ?? '999');
  if (freeGb < 5) {
    console.error(`ABORT: only ${freeGb}GB free on the data volume — free space before benching.`);
    process.exit(2);
  }
}

const rawTasks = JSON.parse(await Bun.file(`${IOSWORLD}/tasks.json`).text());
const all = (Array.isArray(rawTasks) ? rawTasks : (rawTasks.tasks ?? [])) as IWTask[];
let tasks = all;
if (ONLY) tasks = all.filter((t) => ONLY.includes(t.name));
else if (CATEGORY) tasks = all.filter((t) => t.category === CATEGORY).slice(0, LIMIT);
else if (ALL) tasks = all;
else if (process.argv.includes('--sample')) {
  // Stratified sample: every Nth task per category, preserving the
  // category/difficulty mix — for calibration runs that don't need all 133.
  const n = Number(process.argv[process.argv.indexOf('--sample') + 1]);
  const byCat = new Map<string, IWTask[]>();
  for (const t of all) {
    const k = t.category;
    byCat.set(k, [...(byCat.get(k) ?? []), t]);
  }
  const out: IWTask[] = [];
  for (const [, list] of byCat) {
    const step = Math.max(
      1,
      Math.floor(list.length / Math.max(1, Math.round((n * list.length) / all.length))),
    );
    for (let i = 0; i < list.length; i += step) out.push(list[i]!);
  }
  tasks = out.slice(0, n);
} else tasks = all.slice(0, LIMIT);

// Shard striping AFTER selection (selection is deterministic, so two lanes
// given the same --sample N and different --shard k/n get disjoint tasks).
if (SHARD) tasks = tasks.filter((_, i) => i % SHARD[1]! === SHARD[0]! - 1);

// Resume: skip tasks already recorded in the results JSONL.
const doneNames = new Set<string>();
if (RESULTS && (await Bun.file(RESULTS).exists())) {
  for (const line of (await Bun.file(RESULTS).text()).trim().split('\n').filter(Boolean)) {
    try {
      doneNames.add(JSON.parse(line).name);
    } catch {
      /* skip */
    }
  }
  tasks = tasks.filter((t) => !doneNames.has(t.name));
  console.log(`resume: ${doneNames.size} already done, ${tasks.length} remaining`);
}

const SURFACE = process.env.PHONE_USE_SURFACE === 'raw' ? 'raw' : 'full';
const RULES = `You are operating an iPhone simulator through the phone-use tools. The apps are unfamiliar third-party apps. Plan by desired END-STATES and confirm with observe's expect param. If the same action fails twice, switch mechanism.${SURFACE === 'full' ? ' Prefer goto/ask/search/toggle when they apply.' : ''} Isolate unpredictable actions: nav/open/deep-link must be the ONLY action that turn — look before acting further. Mark a milestone done only on OBSERVED evidence (an expect check or a value you read), never in advance. Before leaving a screen whose data you need later, save it with the note tool (plain text, exactly as observed); read it back where needed — do not trust recall across apps. Transcribe values exactly as shown. Act on every turn: run a command rather than narrating — keep analysis to one short sentence. When the goal is complete, immediately write your final reply with all requested facts.`;

// capMs: NOT a working cap (founder call: agent sessions run to completion).
// The 90-min default exists only as an anti-wedge backstop (30 was inside
// the legitimate envelope: multi-032 ran 26min, multi-081 needed more) — a hung app once
// froze a lane for 3 hours; no legitimate run approaches it.
function spawnClaude(
  args: string[],
  extraEnv: Record<string, string> = {},
  capMs = 240 * 60 * 1000,
): Promise<string> {
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const proc = Bun.spawn(['claude', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: env as Record<string, string>,
    cwd: `${import.meta.dir}/../../..`,
  });
  const timeout = setTimeout(() => proc.kill('SIGKILL'), capMs);
  // Hard outer deadline (cap + 1 min): a SIGKILLed claude can leave
  // grandchildren holding the stdout pipe, so the stream read alone can hang
  // FOREVER (observed: a lane wedged 3h awaiting a dead child). Empty string
  // routes to infra_error.
  const read = new Response(proc.stdout).text();
  void (async () => {
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0 || err) console.error(`[spawnClaude debug] exit=${code} stderr=${err.slice(0, 400)}`);
  })();
  const deadline = new Promise<string>((resolve) => {
    const t = setTimeout(() => resolve(''), capMs + 60 * 1000);
    if (typeof t === 'object') t.unref?.();
  });
  return Promise.race([read, deadline]).finally(() => clearTimeout(timeout));
}

// GPT judge via Codex CLI (ChatGPT sign-in, no API key). Default model is
// gpt-5.6-sol — a current, independent GPT grader (iOSWorld used GPT-5.4-Mini).
async function codexJudge(prompt: string, imagePath?: string): Promise<string> {
  const args = [
    'codex',
    'exec',
    '-m',
    'gpt-5.4-mini',
    ...(imagePath ? ['-i', imagePath] : []),
    '--skip-git-repo-check',
    prompt,
  ];
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => proc.kill('SIGKILL'), 3 * 60 * 1000);
  const out = await new Response(proc.stdout).text();
  clearTimeout(timeout);
  // The final JSON object is the last line that parses.
  const lines = out
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/\{.*\}/);
    if (m) {
      try {
        JSON.parse(m[0]);
        return m[0];
      } catch {
        /* keep scanning */
      }
    }
  }
  return '{}';
}

async function killLeftoverMcp(): Promise<void> {
  try {
    const out = await new Response(
      Bun.spawn(['pgrep', '-f', 'index.ts mcp'], { stdout: 'pipe' }).stdout,
    ).text();
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

// Warm the phone-use XCTest runner so the NEXT claude spawn's MCP server
// connects instantly instead of paying a runner launch (or a build after a
// runner source change) inside the agent's first tool call. A CLI open starts
// the runner when needed and confirms it answers; the runner then stays up
// for the next process. PHONE_USE_DEVICE (inherited) pins the simulator.
async function warmDaemon(): Promise<boolean> {
  const cwd = `${import.meta.dir}/../../..`; // repo root
  try {
    const p = Bun.spawn(['bun', 'packages/phone-use/src/index.ts', 'open', 'com.apple.Preferences'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd,
    });
    const to = setTimeout(() => p.kill('SIGKILL'), 120_000);
    const out = await new Response(p.stdout).text();
    clearTimeout(to);
    return /Opened/.test(out);
  } catch {
    return false;
  }
}

// Session-free final screenshot for the judge: simctl io needs no device
// session, so it can never contend with the agent's MCP server.
const SIM_UDID = DEVICE ?? process.env.PHONE_USE_UDID ?? '2C42103E-EADD-4742-B64C-9676AB2EFB39';

// App-state hygiene: the iOSWorld apps carry UI state (open editors, applied
// search filters, half-finished compose sheets) across tasks. Terminating all
// benchmark apps before each task gives every run a cold launch — best-effort,
// no data reset (that would need reinstalling the .app bundles).
let benchApps: string[] = [];
function listBenchApps(): string[] {
  const r = Bun.spawnSync(['xcrun', 'simctl', 'listapps', SIM_UDID], { stdout: 'pipe' });
  if (r.exitCode !== 0) return [];
  const out = r.stdout.toString();
  return [...new Set(out.match(/com\.iosworld\.benchmark\.[A-Za-z0-9.-]+/g) ?? [])];
}
function terminateBenchApps(): void {
  for (const bundle of benchApps) {
    Bun.spawnSync(['xcrun', 'simctl', 'terminate', SIM_UDID, bundle]); // errors (not running) are fine
  }
}

// Per-task trajectory file: every one-shot CLI verb appends a trace line here
// (PHONE_USE_TRACE), giving the judge the full action history.
const trajFile = (name: string) => `/tmp/iosworld-traj-${name}.jsonl`;

// CLI-surface rules: same discipline as the MCP rules, but the tool surface
// is the phone-use CLI over Bash (agent-first-CLI mode — the 17× cheaper path).
const RULES_CLI = `You are operating an iPhone simulator through the phone-use CLI. Run every action as a Bash command from the repo root: \`bun packages/phone-use/src/index.ts <verb> …\`. Verbs: observe [--expect "text"] · open <app> · goto <app> <destination> · ask "<field>" [--app <app>] · search <app> <query> [--open] · tap "<label>" · type "<text>" --field "<label>" · scroll up|down · nav back|home · toggle <app> "<switch>" --on · wait_for "<text>" · handle_alert get|accept · batch '<JSON action array>' · note save <key> "<content>" | note read <key> | note list. Target elements by LABEL — @refs do not survive between commands. Exit codes: 0 ok · 1 failed · 2 blocked · 3 confirmation required (re-run the SAME command with --yes only when the goal clearly authorizes it). One action per command; after nav/open, observe before acting. Plan by desired END-STATES and confirm with observe --expect. If the same action fails twice, switch mechanism. The apps are unfamiliar third-party apps. Before leaving a screen whose data you need later: note save it exactly as observed, and note read it where needed — do not trust recall across apps. Transcribe values exactly as shown. Act on every turn: run a command rather than narrating — keep analysis to one short sentence. When the goal is complete, immediately write your final reply with all requested facts.
Paging controls (date steppers, carousels): advance with ONE batch call of repeated taps — batch '[{"do":"tap","label":"Next"},{"do":"tap","label":"Next"}]' — not one command per tap.
If an in-app search returns 0 results, that search may be screen-local — go to the app's home tab and use its global search there before concluding the item does not exist.
After tapping Compose/New, tap inside the editor/body field before typing — the new-document screen does not focus it for you.`;
function finalScreenshot(name: string): string | undefined {
  const path = `/tmp/iosworld-judge-${name}.png`;
  const r = Bun.spawnSync(['xcrun', 'simctl', 'io', SIM_UDID, 'screenshot', path]);
  return r.exitCode === 0 ? path : undefined;
}

// Did the agent run without the phone-use tools (a plumbing failure, not an
// agent failure)? Its own words are the tell.
function isToolless(reply: string): boolean {
  return /don'?t have the phone-use|phone-use MCP tools available|aren'?t appearing as callable|MCP tools.*not.*(available|appearing)|no.*mcp__phone-use|device.*(in use|is locked|locked by)|locked by another process|already in use by session/i.test(
    reply,
  );
}

// Is the task blocked by the environment (iCloud sign-in, missing account) —
// genuinely unrunnable on this sim, not an agent miss?
function isEnvBlocked(reply: string): boolean {
  return /sign ?in to icloud|isn'?t signed in to icloud|no icloud account|requires.*apple id|not signed in/i.test(
    reply,
  );
}

type Row = {
  name: string;
  category: string;
  difficulty: string;
  judge?: number | undefined;
  judgeMax?: number | undefined;
  ok?: boolean | undefined;
  status: 'graded' | 'infra_error' | 'env_blocked';
  ms: number;
  agentMs?: number | undefined;
  turns?: number | undefined;
  tokensIn?: number | undefined;
  reply?: string | undefined;
};

async function runOnce(
  t: IWTask,
): Promise<{ reply: string; turns?: number; tokensIn?: number; agentMs?: number }> {
  if (!CLI_MODE) {
    await warmDaemon(); // ensure the MCP server's device client connects on spawn
    await driver.closeSession().catch(() => undefined);
  }
  // Fresh per-task notes + trajectory files. Every one-shot CLI verb appends a
  // trace line, so the judge can grade the FULL action history, not just the
  // final screen (iOSWorld's trajectory-judge intent, now for real).
  const notesFile = `/tmp/iosworld-notes-${t.name}.json`;
  Bun.spawnSync(['rm', '-f', notesFile, trajFile(t.name)]);
  // multi_app and memory tasks legitimately need more wall clock (app hops,
  // note round-trips); 7 min was killing honest runs mid-task.
  const out = await spawnClaude(
    CLI_MODE
      ? [
          '-p',
          t.goal,
          '--model',
          MODEL,
          '--strict-mcp-config',
          '--allowedTools',
          'Bash(bun:*)',
          '--append-system-prompt',
          RULES_CLI,
          '--output-format',
          'json',
        ]
      : [
          '-p',
          t.goal,
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
        ],
    {
      PHONE_USE_MODE: 'auto',
      ...(CLI_MODE ? { PHONE_USE_NOTES: notesFile, PHONE_USE_TRACE: trajFile(t.name) } : {}),
      ...(CLI_MODE && DEVICE ? { PHONE_USE_DEVICE: DEVICE } : {}),
    },
  );
  if (!CLI_MODE) await killLeftoverMcp();
  try {
    const j = JSON.parse(out);
    return {
      reply: String(j.result ?? ''),
      turns: j.num_turns,
      tokensIn:
        (j.usage?.input_tokens ?? 0) +
        (j.usage?.cache_read_input_tokens ?? 0) +
        (j.usage?.cache_creation_input_tokens ?? 0),
      agentMs: j.duration_ms,
    };
  } catch {
    return { reply: out.slice(0, 300) };
  }
}

async function runTask(t: IWTask): Promise<Row> {
  const started = performance.now();
  terminateBenchApps(); // cold-launch hygiene: no leaked UI state from the previous task

  // Run; if the agent came back toolless (MCP failed to load), that's a
  // plumbing failure — reset the daemon and retry ONCE before giving up.
  // No turn caps and no working time cap (founder call): sessions run to
  // completion; only the 30-min anti-wedge backstop in spawnClaude remains.
  let r = await runOnce(t);
  // Empty reply = the claude session died (spawn-cap SIGKILL or crash) — an
  // infrastructure casualty, not an agent miss. Retry once; if still empty,
  // record infra_error instead of letting the judge grade emptiness as 0.
  if (!r.reply.trim()) r = await runOnce(t);
  if (!r.reply.trim()) {
    return {
      name: t.name,
      category: t.category,
      difficulty: t.difficulty,
      status: 'infra_error',
      ms: Math.round(performance.now() - started),
    };
  }
  if (isToolless(r.reply)) {
    await resetEnv();
    r = await runOnce(t);
  }
  const { reply, turns, tokensIn, agentMs } = r;
  const base = {
    name: t.name,
    category: t.category,
    difficulty: t.difficulty,
    judgeMax: t.rubric.length,
    ms: Math.round(performance.now() - started),
    agentMs,
    turns,
    tokensIn,
    // Store enough of the reply to diagnose failures post-hoc (the judge
    // always receives the FULL reply; this is only what the results file keeps).
    reply: reply.slice(0, 2000),
  };

  if (isToolless(reply)) return { ...base, status: 'infra_error', ok: undefined };
  if (isEnvBlocked(reply)) return { ...base, status: 'env_blocked', ok: undefined };

  // Judge evidence = final SCREENSHOT (session-free, no device contention) +
  // the agent's reply. Procedural rubric steps (open app, tap search, select
  // result) are credited when the END STATE implies them — e.g. the item
  // sitting in the Wishlist proves search/select/add happened — mirroring
  const shot = finalScreenshot(t.name);
  // The full action trajectory (CLI mode): every verb the agent ran, in order,
  // with its permission decision and outcome — the judge grades the whole
  // stack, not just the final frame.
  let traj = '';
  try {
    const raw = await Bun.file(trajFile(t.name)).text();
    traj = raw
      .trim()
      .split('\n')
      .map((l) => {
        try {
          const e = JSON.parse(l) as {
            tool?: string;
            args?: Record<string, unknown>;
            decision?: string;
            ok?: boolean;
            detail?: string;
          };
          const target = ['label', 'destination', 'field', 'query', 'app', 'text', 'switch', 'key']
            .map((k) => e.args?.[k])
            .filter((v) => typeof v === 'string')
            .slice(0, 2)
            .join(' · ');
          return `${e.tool}${target ? ` (${target})` : ''} → ${e.ok ? 'ok' : 'FAILED'}${e.decision !== 'allow' ? ` [${e.decision}]` : ''}: ${String(e.detail ?? '').slice(0, 90)}`;
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .slice(-150)
      .join('\n');
  } catch {
    /* MCP mode or no trajectory captured */
  }
  const judgePrompt = `You are grading an iPhone-agent run. TASK: ${t.goal}\n\nEVIDENCE: (1) the attached screenshot of the FINAL screen after the agent finished, (2) the agent's final reply below${traj ? ', (3) the FULL action trajectory — every command the agent executed, in order, with results' : ''}. Score each rubric criterion 1 if the evidence shows it was done — procedural steps count when the trajectory or final state shows them (an item present in a list implies it was searched/selected/added) — else 0. Requested facts/values must appear in the reply OR be unambiguously established in the trajectory to count. Be fair but do not invent evidence.\n\nAGENT'S FINAL REPLY:\n${reply}\n${traj ? `\nACTION TRAJECTORY:\n${traj}\n` : ''}\nRUBRIC:\n${t.rubric.map((r, i) => `${i + 1}. ${r.criterion}`).join('\n')}\n\nReply with ONLY a JSON object: {"scores":[0 or 1 per criterion],"passed":<count>}`;
  let judge: number | undefined;
  try {
    let innerText: string;
    if (JUDGE === 'codex') {
      innerText = await codexJudge(judgePrompt, shot);
    } else {
      const judgeOut = await spawnClaude([
        '-p',
        judgePrompt,
        '--model',
        JUDGE_MODEL,
        '--output-format',
        'json',
        '--max-turns',
        '1',
      ]);
      innerText = String(JSON.parse(judgeOut).result ?? '{}')
        .replace(/```json|```/g, '')
        .trim();
    }
    const inner = JSON.parse(innerText);
    judge = Number(
      inner.passed ??
        (Array.isArray(inner.scores) ? inner.scores.reduce((a: number, b: number) => a + b, 0) : 0),
    );
  } catch {
    /* judge unparseable */
  }

  return { ...base, judge, ok: judge != null ? judge === base.judgeMax : undefined, status: 'graded' };
}

// The daemon/sim degrades over long multi-spawn runs (hard-won). Reset both
// every RESET_EVERY tasks so a 133-task marathon stays healthy.
const RESET_EVERY = 15;
async function resetEnv(): Promise<void> {
  await killLeftoverMcp();
  // A fresh runner (refs, frontmost-app state) for the next stretch of tasks.
  try {
    const { soleBootedSimulator, stopRunner } = await import('@phone-use/sdk');
    const spec = process.env.PHONE_USE_DEVICE;
    stopRunner(spec && /^[0-9A-F-]{36}$/i.test(spec) ? spec : await soleBootedSimulator());
  } catch {
    /* no simulator pinned or booted; the next task reports it */
  }
  await Bun.sleep(1500);
}

console.log(`iOSWorld via phone-use — ${tasks.length} task(s), agent=${MODEL}, judge=${JUDGE}`);
await warmDaemon();
benchApps = listBenchApps(); // one listapps at startup; terminate before each task
if (benchApps.length)
  console.log(`app hygiene: ${benchApps.length} iOSWorld apps will be terminated per task`);
const rows: Row[] = [];
let sinceReset = 0;
for (const t of tasks) {
  if (sinceReset >= RESET_EVERY) {
    console.log('  [periodic env reset]');
    await resetEnv();
    sinceReset = 0;
  }
  sinceReset++;
  console.log(`▶ ${t.name} (${t.difficulty}) — ${t.goal.slice(0, 80)}…`);
  const r = await runTask(t);
  rows.push(r);
  if (RESULTS) require('node:fs').appendFileSync(RESULTS, `${JSON.stringify(r)}\n`);
  const tag = r.status === 'graded' ? (r.ok ? '✓' : '✗') : r.status === 'infra_error' ? '⚠infra' : '⊘env';
  console.log(
    `  ${tag} rubric ${r.judge ?? '-'}/${r.judgeMax} — ${(r.ms / 1000).toFixed(0)}s, ${r.turns ?? '?'} turns`,
  );
}
// Denominator = graded tasks only; infra/env-blocked are excluded, not zeroed.
const graded = rows.filter((r) => r.status === 'graded');
const passed = graded.filter((r) => r.ok).length;
const partial = graded.reduce((s, r) => s + (r.judge ?? 0), 0);
const total = graded.reduce((s, r) => s + (r.judgeMax ?? 0), 0);
const infra = rows.filter((r) => r.status === 'infra_error').length;
const envb = rows.filter((r) => r.status === 'env_blocked').length;
// Latency rollup (graded tasks): the sec/task table nobody publishes.
const q = (a: number[], p: number) =>
  a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))]! : 0;
const agentSecs = graded.map((r) => (r.agentMs ?? r.ms) / 1000);
const turnsArr = graded.filter((r) => r.turns).map((r) => r.turns!);
const secPerTurn = graded.filter((r) => r.agentMs && r.turns).map((r) => r.agentMs! / 1000 / r.turns!);
console.log(
  `latency (agent-only): median ${q(agentSecs, 0.5).toFixed(1)}s/task, p90 ${q(agentSecs, 0.9).toFixed(1)}s; median ${q(turnsArr, 0.5)} turns; ${q(secPerTurn, 0.5).toFixed(1)}s/turn median`,
);
console.log(
  `\niOSWorld (informal, judge=${JUDGE}) — ${passed}/${graded.length} fully passed (${graded.length ? Math.round((100 * passed) / graded.length) : 0}%); rubric points ${partial}/${total}. Excluded: ${infra} infra, ${envb} env-blocked.`,
);

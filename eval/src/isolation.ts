// Tier 2: several agents on one Mac at once (docs/43-device-layer-eval.md).
//
//   bun eval/src/isolation.ts [--tool phone-use] [--cases I1,I2,I3,I4,I5] [--ks 2,4] [--rounds 4]
//
// Uses its own simulators, named pu-eval-iso-<n> (created on first use, then reused; shut down at
// the end). Every agent writes tokens only it knows, so the oracle can attribute every effect:
// a token of agent B in agent A's app is contamination; a fill the tool called OK whose value never
// appeared in the field is a false success.
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, hostname, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPhoneUseAdapter } from './adapters/phone-use.ts';
import { BUNDLE, install, launchScenario, readEvents, simctl, sleep, waitForEvent } from './sim.ts';
import type { Adapter, Claim, Ev } from './types.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

/** Each adapter keeps all of its tool's state under `stateDir` (fresh per run). */
const ADAPTERS: Record<string, (udid: string | null, stateDir: string) => Adapter> = {
  'phone-use': (udid, stateDir) =>
    createPhoneUseAdapter(udid, { mapDir: join(stateDir, 'maps'), leaseDir: join(stateDir, 'leases') }),
};
const FIELD = 'Display Name';
const firstLine = (s: string) => {
  const last = s.split(/\n--- (?:re-run with --yes|confirmed) ---\n/).at(-1) ?? s;
  return (last.split('\n')[0] ?? '').slice(0, 100);
};

// ---------- simulator pool ----------

type SimInfo = { udid: string; name: string; state: string };

async function listSims(): Promise<SimInfo[]> {
  const json = JSON.parse(await simctl(['list', 'devices', '-j'])) as { devices: Record<string, SimInfo[]> };
  return Object.values(json.devices).flat();
}

async function iosRuntime(): Promise<string> {
  const json = JSON.parse(await simctl(['list', 'runtimes', '-j'])) as {
    runtimes: Array<{ identifier: string; platform?: string; isAvailable: boolean }>;
  };
  const ios = json.runtimes.filter((r) => r.isAvailable && r.identifier.includes('iOS'));
  if (!ios.length) throw new Error('no iOS simulator runtime installed (xcodebuild -downloadPlatform iOS)');
  return ios.at(-1)!.identifier;
}

/** n booted simulators named pu-eval-iso-1..n with Gauntlet installed. */
async function pool(n: number): Promise<string[]> {
  const runtime = await iosRuntime();
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    const name = `pu-eval-iso-${i}`;
    let sim = (await listSims()).find((s) => s.name === name);
    if (!sim) {
      const udid = (
        await simctl(['create', name, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', runtime])
      ).trim();
      sim = { udid, name, state: 'Shutdown' };
    }
    if (sim.state !== 'Booted') await simctl(['boot', sim.udid]);
    out.push(sim.udid);
  }
  for (const udid of out) {
    await simctl(['bootstatus', udid, '-b'], 600_000);
    await install(udid);
  }
  return out;
}

async function shutdown(udids: string[]): Promise<void> {
  for (const u of udids) await simctl(['shutdown', u]).catch(() => undefined);
}

// ---------- agents ----------

type Step = Claim & { agent: string; step: 'fill' | 'tap'; value?: string; t0: number; t1: number };

/** One agent: fill a token into the field, tap an unrelated button; `rounds` times. */
async function agentLoop(
  tool: Adapter,
  agent: string,
  rounds: number,
  steps: Step[],
  between?: (round: number) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const value = `${agent}-${i}-${randomInt(1000, 9999)}`;
    let t0 = Date.now() / 1000;
    const fill = await tool.fill(FIELD, value);
    steps.push({ ...fill, agent, step: 'fill', value, t0, t1: Date.now() / 1000 });
    t0 = Date.now() / 1000;
    const tap = await tool.tapLabel('Unrelated');
    steps.push({ ...tap, agent, step: 'tap', t0, t1: Date.now() / 1000 });
    await between?.(i);
  }
}

type Judged = {
  falseSuccesses: string[];
  contamination: string[];
  okFills: number;
  verifiedFills: number;
};

/** Judge one simulator's events against the steps of the agents that were meant to drive it. */
function judge(evs: Ev[], steps: Step[], owners: string[], allAgents: string[]): Judged {
  const values = evs.filter((e) => e.kind === 'text' && e.id === 'field');
  const falseSuccesses: string[] = [];
  let okFills = 0;
  let verifiedFills = 0;
  for (const s of steps.filter((x) => x.step === 'fill' && owners.includes(x.agent))) {
    if (s.status !== 'ok' && s.status !== 'uncertain') continue;
    okFills++;
    const seen = values.some((e) => e.value === s.value && e.t >= s.t0 - 0.05 && e.t <= s.t1 + 1);
    if (seen) verifiedFills++;
    else if (s.status === 'ok')
      falseSuccesses.push(`${s.agent} fill ${s.value}: tool said OK; field never held it`);
  }
  const foreign = allAgents.filter((a) => !owners.includes(a));
  const contamination = values
    .filter((e) => foreign.some((a) => String(e.value).includes(`${a}-`)))
    .map((e) => `field held ${JSON.stringify(e.value)}`);
  return { falseSuccesses, contamination: [...new Set(contamination)], okFills, verifiedFills };
}

type CaseResult = {
  id: string;
  title: string;
  pass: boolean;
  summary: string;
  detail: Record<string, unknown>;
};

const launchAll = async (udids: string[], run: string) => {
  for (const u of udids) {
    await launchScenario(u, 'B2', 1, run);
    await waitForEvent(u, run, (e) => e.kind === 'ready', 12_000);
  }
};

// ---------- cases ----------

/** I1: k agents, each on its own simulator. Zero contamination; throughput per agent vs k = 1. */
async function caseI1(
  scoped: (scope: string) => (u: string) => Adapter,
  sims: string[],
  ks: number[],
  rounds: number,
) {
  const out: CaseResult[] = [];
  let base: number | undefined;
  for (const k of [1, ...ks.filter((x) => x > 1)]) {
    const use = sims.slice(0, k);
    const run = `I1-k${k}-${randomInt(1e6)}`;
    await launchAll(use, run);
    // A fresh scope per k: the agents of the previous k have finished (their device leases are gone).
    const make = scoped(`I1-k${k}`);
    const tools = use.map((u) => make(u));
    // Warm-up, not timed or judged: each runner's first launch and the simulator's first keyboard
    // use (iOS shows a one-time typing intro) would otherwise land in whichever k runs first.
    await Promise.all(tools.map((t, i) => agentLoop(t, `warm${k}x${i}`, 1, [])));
    const steps: Step[] = [];
    const agents = use.map((_, i) => `k${k}a${i + 1}`);
    const t0 = performance.now();
    const per = await Promise.all(
      tools.map(async (t, i) => {
        const a = performance.now();
        await agentLoop(t, agents[i]!, rounds, steps);
        return (rounds * 2) / ((performance.now() - a) / 1000);
      }),
    );
    const wall = (performance.now() - t0) / 1000;
    const judged = await Promise.all(
      use.map(async (u, i) => judge(await readEvents(u, run), steps, [agents[i]!], agents)),
    );
    const fs = judged.flatMap((j) => j.falseSuccesses);
    const cont = judged.flatMap((j) => j.contamination);
    const errors = steps.filter((s) => s.status !== 'ok' && s.status !== 'uncertain');
    const mean = per.reduce((a, b) => a + b, 0) / per.length;
    if (k === 1) base = mean;
    out.push({
      id: `I1 k=${k}`,
      title: `${k} agent(s), each on its own simulator`,
      pass: fs.length === 0 && cont.length === 0 && errors.length === 0,
      summary: `${mean.toFixed(2)} actions/s per agent${base && k > 1 ? ` (${((mean / base) * 100).toFixed(0)}% of k=1)` : ''}; ${cont.length} contamination, ${fs.length} false successes, ${errors.length} errors; wall ${wall.toFixed(1)} s`,
      detail: {
        perAgentActionsPerSec: per,
        falseSuccesses: fs,
        contamination: cont,
        errors: errors.map((e) => `${e.agent} ${e.step}: ${e.output.split('\n')[0]}`),
      },
    });
  }
  return out;
}

/** I2: two agents, one simulator, no coordination. The second must be refused or queued, never interleaved. */
async function caseI2(make: (u: string) => Adapter, sim: string, rounds: number): Promise<CaseResult> {
  const run = `I2-${randomInt(1e6)}`;
  await launchAll([sim], run);
  const a = make(sim);
  const b = make(sim);
  await a.observe();
  const steps: Step[] = [];
  await Promise.all([agentLoop(a, 'i2a', rounds, steps), agentLoop(b, 'i2b', rounds, steps)]);
  const evs = await readEvents(sim, run);
  const j = judge(evs, steps, ['i2a', 'i2b'], ['i2a', 'i2b']);
  const refusals = steps.filter((s) =>
    /in use|busy|another (agent|session|process)|claimed|held by/i.test(s.output),
  );
  const mixed = evs
    .filter((e) => e.kind === 'text' && e.id === 'field')
    .map((e) => String(e.value))
    .filter((v) => v.includes('i2a-') && v.includes('i2b-'));
  // doc 43: "the second is refused or queued with a clear message; never interleaved". Each call
  // being truthful is not enough: two agents silently taking turns on one app is the bug,
  // so passing needs the tool to tell one of them about the other.
  const order = [...steps].sort((x, y) => x.t0 - y.t0).map((s) => s.agent);
  const switches = order.slice(1).filter((a, i) => a !== order[i]).length;
  const pass = refusals.length > 0 && j.falseSuccesses.length === 0 && mixed.length === 0;
  return {
    id: 'I2',
    title: 'Two agents on one simulator, no coordination',
    pass,
    summary: `${refusals.length} refusal(s) or notice(s) naming the other session; steps alternated between the agents ${switches} times; ${j.falseSuccesses.length} false successes; ${mixed.length} field value(s) mixing both agents' text; ${j.verifiedFills}/${j.okFills} OK fills verified`,
    detail: {
      falseSuccesses: j.falseSuccesses,
      mixedValues: [...new Set(mixed)].slice(0, 10),
      refusals: refusals.map((r) => `${r.agent}: ${r.output.split('\n')[0]}`),
      outcomes: steps.map(
        (s) => `${s.agent} ${s.step} ${s.value ?? ''} → ${s.status}: ${firstLine(s.output)}`,
      ),
    },
  };
}

/** I3: two simulators booted, agents that never pinned a device. Each must keep its own device or be refused clearly. */
async function caseI3(makeImplicit: () => Adapter): Promise<CaseResult> {
  const [a, b] = [makeImplicit(), makeImplicit()];
  const [oa, ob] = await Promise.all([a.observe(), b.observe()]);
  const clear = (c: Claim) =>
    c.status !== 'ok' && /booted|PHONE_USE_DEVICE|several|multiple|which/i.test(c.output);
  const pass = clear(oa.claim) && clear(ob.claim);
  return {
    id: 'I3',
    title: 'Two agents, two booted simulators, no device pinned',
    pass,
    summary: pass
      ? 'both refused with a message naming the choice'
      : `agent A: ${oa.claim.status} (${oa.app ?? '?'}); agent B: ${ob.claim.status} (${ob.app ?? '?'})`,
    detail: { a: oa.claim.output.slice(0, 300), b: ob.claim.output.slice(0, 300) },
  };
}

/** I4: one agent's session is killed mid-run. The sibling must be unaffected; the victim must recover or fail loudly. */
async function caseI4(
  make: (u: string) => Adapter,
  sims: [string, string],
  rounds: number,
): Promise<CaseResult> {
  const run = `I4-${randomInt(1e6)}`;
  await launchAll(sims, run);
  const [a, b] = [make(sims[0]), make(sims[1])];
  if (!a.killSession)
    return {
      id: 'I4',
      title: 'Kill one session',
      pass: false,
      summary: 'adapter cannot kill a session',
      detail: {},
    };
  await Promise.all([a.observe(), b.observe()]);
  const steps: Step[] = [];
  let killed = '';
  let killedAt = 0;
  await Promise.all([
    agentLoop(a, 'i4a', rounds, steps, async (i) => {
      if (i === 1) {
        killed = await a.killSession!();
        killedAt = Date.now() / 1000;
      }
    }),
    agentLoop(b, 'i4b', rounds, steps),
  ]);
  const ja = judge(await readEvents(sims[0], run), steps, ['i4a'], ['i4a', 'i4b']);
  const jb = judge(await readEvents(sims[1], run), steps, ['i4b'], ['i4a', 'i4b']);
  const bErrors = steps.filter((s) => s.agent === 'i4b' && s.status !== 'ok' && s.status !== 'uncertain');
  const aAfter = steps.filter((s) => s.agent === 'i4a' && s.t0 >= killedAt);
  const aRecovered = aAfter.filter((s) => s.status === 'ok' || s.status === 'uncertain').length;
  const pass = bErrors.length === 0 && jb.falseSuccesses.length === 0 && ja.falseSuccesses.length === 0;
  return {
    id: 'I4',
    title: "One agent's session is killed mid-run",
    pass,
    summary: `sibling: ${bErrors.length} errors, ${jb.falseSuccesses.length} false successes; victim after the kill: ${aRecovered}/${aAfter.length} calls OK, ${ja.falseSuccesses.length} false successes`,
    detail: {
      killed,
      victimAfterKill: aAfter.map((s) => `${s.step} ${s.status} ${s.ms}ms: ${firstLine(s.output)}`),
      siblingErrors: bErrors.map((s) => s.output.split('\n')[0]),
    },
  };
}

/** I5: another session uninstalls the app from a device an agent is using. It must be refused. */
async function caseI5(make: (u: string) => Adapter, sim: string, rounds: number): Promise<CaseResult> {
  const run = `I5-${randomInt(1e6)}`;
  await launchAll([sim], run);
  const a = make(sim);
  const intruder = make(sim);
  if (!intruder.uninstallApp)
    return {
      id: 'I5',
      title: 'Uninstall from another session',
      pass: false,
      summary: 'no documented uninstall command',
      detail: {},
    };
  await a.observe();
  const steps: Step[] = [];
  let intrusion: Claim | undefined;
  await agentLoop(a, 'i5a', rounds, steps, async (i) => {
    if (i === 1) intrusion = await intruder.uninstallApp!(BUNDLE);
  });
  const stillInstalled = await simctl(['get_app_container', sim, BUNDLE]).then(
    () => true,
    () => false,
  );
  const aErrors = steps.filter((s) => s.status !== 'ok' && s.status !== 'uncertain');
  const pass = intrusion?.status !== 'ok' && stillInstalled;
  if (!stillInstalled) await install(sim);
  return {
    id: 'I5',
    title: "Another session uninstalls the app from an agent's device",
    pass,
    summary: `uninstall ${intrusion?.status === 'ok' ? 'succeeded' : 'was refused'}; the agent then saw ${aErrors.length} error(s)`,
    detail: {
      intrusion: intrusion?.output.slice(0, 300),
      agentAfter: steps.slice(4).map((s) => `${s.step} ${s.status}: ${firstLine(s.output)}`),
    },
  };
}

// ---------- main ----------

async function main() {
  const toolName = opt('tool') ?? 'phone-use';
  const factory = ADAPTERS[toolName];
  if (!factory) throw new Error(`unknown --tool ${toolName}`);
  const cases = (opt('cases') ?? 'I1,I2,I3,I4,I5').split(',');
  const ks = (opt('ks') ?? '2,4').split(',').map(Number);
  const rounds = Number(opt('rounds') ?? 4);
  const need = Math.max(2, ...(cases.includes('I1') ? ks : [2]));
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(
    opt('out') ??
      join(here, '..', 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}-isolation-${toolName}`),
  );
  mkdirSync(out, { recursive: true });
  // Each case (and each k of I1) gets its own tool state, so the agents of an earlier case count as
  // finished: their device leases do not carry over, as they would not once real agents exit.
  const scoped = (scope: string) => (udid: string | null) => factory(udid, join(out, 'tool-state', scope));

  console.error(`isolation: ${cases.join(',')} with ${need} simulators, ${rounds} rounds per agent → ${out}`);
  const sims = await pool(need);
  const version = await scoped('version')(sims[0]!).version();
  const results: CaseResult[] = [];
  const log = (r: CaseResult) => {
    results.push(r);
    console.error(`${r.pass ? 'PASS' : 'FAIL'} ${r.id.padEnd(7)} ${r.summary}`);
  };
  try {
    if (cases.includes('I1')) for (const r of await caseI1(scoped, sims, ks, rounds)) log(r);
    if (cases.includes('I2')) log(await caseI2(scoped('I2'), sims[0]!, rounds));
    if (cases.includes('I3')) {
      // Exactly two simulators booted for this case.
      await shutdown(sims.slice(2));
      log(await caseI3(() => scoped('I3')(null)));
    }
    if (cases.includes('I4')) log(await caseI4(scoped('I4'), [sims[0]!, sims[1]!], rounds + 2));
    if (cases.includes('I5')) log(await caseI5(scoped('I5'), sims[0]!, rounds + 2));
  } finally {
    await sleep(500);
    await shutdown(sims);
  }

  const xcode = execFileSync('xcodebuild', ['-version'], { encoding: 'utf8' }).split('\n')[0];
  const md = [
    `# Device-layer eval · Tier 2 (several agents) · ${toolName}`,
    '',
    `- Tool: \`${version}\``,
    `- Host: ${hostname()} · ${cpus()[0]?.model ?? '?'} · ${Math.round(totalmem() / 2 ** 30)} GB · ${xcode}`,
    `- Simulators: ${need} × iPhone 17 Pro (pu-eval-iso-*), ${rounds} rounds per agent (fill a token, tap a button)`,
    '',
    '| Case | Result | Summary |',
    '|---|---|---|',
    ...results.map((r) => `| **${r.id}** ${r.title} | ${r.pass ? '✅' : '❌'} | ${r.summary} |`),
    '',
  ].join('\n');
  writeFileSync(join(out, 'results.json'), `${JSON.stringify({ version, results }, null, 2)}\n`);
  writeFileSync(join(out, 'report.md'), md);
  console.log(md);
}

// Exit explicitly: a tool's detached daemon can inherit our pipes and keep Bun alive.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

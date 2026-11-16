// Tier 1 runner: every probe × seed against one tool on one simulator, graded by Gauntlet.
//
//   bun eval/src/run.ts --udid <simulator> [--tool phone-use|phone-use-mcp|agent-device|maestro|mobilerun] \
//       [--only A1,B2] [--dev-seeds 1,2,3] [--heldout 2] [--out eval/results/<dir>] \
//       [--agent-device-bin <path>] [--maestro-bin <path>] \
//       [--mobilerun-python <venv python>] [--mobilerun-url http://127.0.0.1:6643]
//
// The simulator must be one you own: the runner installs Gauntlet, reinstalls it for permission
// probes, and drives it for several minutes. Results: results.jsonl (one line per probe × seed,
// with the oracle events), summary.json, and report.md.
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, hostname, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentDeviceAdapter } from './adapters/agent-device.ts';
import { createMaestroAdapter } from './adapters/maestro.ts';
import { createMobilerunAdapter } from './adapters/mobilerun.ts';
import { createPhoneUseAdapter } from './adapters/phone-use.ts';
import { createPhoneUseMcpAdapter } from './adapters/phone-use-mcp.ts';
import { verdictOf } from './classify.ts';
import { type Ctx, PROBES } from './probes.ts';
import { type RunMeta, renderReport } from './report.ts';
import {
  bootedSimulators,
  install,
  launchScenario,
  notify,
  readEvents,
  reinstall,
  sleep,
  waitForEvent,
} from './sim.ts';
import type { Adapter, Claim, Ev, ProbeOutcome, ProbeResult } from './types.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

/** Each adapter keeps all of its tool's state under `stateDir` (fresh per run). */
const ADAPTERS: Record<string, (udid: string, stateDir: string) => Adapter> = {
  'phone-use': (udid, stateDir) =>
    createPhoneUseAdapter(udid, { mapDir: join(stateDir, 'maps'), leaseDir: join(stateDir, 'leases') }),
  'phone-use-mcp': (udid, stateDir) =>
    createPhoneUseMcpAdapter(udid, { mapDir: join(stateDir, 'maps'), leaseDir: join(stateDir, 'leases') }),
  'agent-device': (udid, stateDir) => {
    const bin = opt('agent-device-bin');
    if (!bin) throw new Error('pass --agent-device-bin <path to an installed agent-device>');
    return createAgentDeviceAdapter(udid, { stateDir, bin });
  },
  maestro: (udid) => {
    const bin = opt('maestro-bin');
    if (!bin) throw new Error('pass --maestro-bin <path to the maestro CLI>');
    return createMaestroAdapter(udid, { bin });
  },
  // The ios-portal server must already run on --udid (see the adapter); its URL names that device.
  mobilerun: (udid) => {
    const python = opt('mobilerun-python');
    if (!python) throw new Error('pass --mobilerun-python <venv python with mobilerun-core[local]>');
    // A portal on another simulator would score this one's taps as "nothing fired".
    try {
      execFileSync('pgrep', ['-f', `xcodebuild.*id=${udid}`]);
    } catch {
      throw new Error(`no ios-portal (xcodebuild … -destination id=${udid}) runs for this simulator`);
    }
    return createMobilerunAdapter({
      python,
      url: opt('mobilerun-url') ?? 'http://127.0.0.1:6643',
      portalRev: opt('mobilerun-portal-rev') ?? 'c6f1cb7',
    });
  },
};

/** Wrap an adapter so every call the probe makes is recorded with its claim. */
function recording(inner: Adapter, calls: Claim[]): Adapter {
  const rec = <T extends Claim>(c: T) => {
    calls.push(c);
    return c;
  };
  return {
    name: inner.name,
    version: () => inner.version(),
    observe: async () => {
      const o = await inner.observe();
      rec(o.claim);
      return o;
    },
    readScreen: async () => {
      const r = await inner.readScreen();
      rec(r.claim);
      return r;
    },
    tapRef: async (el) => rec(await inner.tapRef(el)),
    tapLabel: async (l) => rec(await inner.tapLabel(l)),
    scrollToAndTap: async (l) => rec(await inner.scrollToAndTap(l)),
    tapPoint: async (x, y) => rec(await inner.tapPoint(x, y)),
    fill: async (f, t) => rec(await inner.fill(f, t)),
    dismissKeyboard: async () => rec(await inner.dismissKeyboard()),
    setSwitch: async (l, on) => rec(await inner.setSwitch(l, on)),
    alert: async (a) => rec(await inner.alert(a)),
  };
}

/** A permission prompt the probe raised that nobody answered (Gauntlet logs each answer). */
function promptPending(events: Ev[]): boolean {
  return events
    .filter((e) => e.kind === 'permission_request')
    .some(
      (req) => !events.some((e) => e.kind === 'permission' && e.service === req.service && e.status !== 0),
    );
}

function evalRevision(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const git = (a: string[]) => execFileSync('git', ['-C', here, ...a], { encoding: 'utf8' }).trim();
  const dirty = git(['status', '--porcelain', '--', '..']);
  return `${git(['rev-parse', '--short', 'HEAD'])}${dirty ? '+uncommitted' : ''}`;
}

async function main() {
  const toolName = opt('tool') ?? 'phone-use';
  const make = ADAPTERS[toolName];
  if (!make) throw new Error(`unknown --tool ${toolName}; have ${Object.keys(ADAPTERS).join(', ')}`);
  const booted = await bootedSimulators();
  const udid = opt('udid');
  if (!udid)
    throw new Error(`pass --udid; booted: ${booted.map((b) => `${b.name} ${b.udid}`).join(', ') || 'none'}`);
  const sim = booted.find((b) => b.udid === udid);
  if (!sim) throw new Error(`simulator ${udid} is not booted`);

  const only = opt('only')?.split(',');
  const probes = PROBES.filter((p) => !only || only.includes(p.id));
  const devSeeds = (opt('dev-seeds') ?? '1,2,3').split(',').filter(Boolean).map(Number);
  const heldoutSeeds = Array.from({ length: Number(opt('heldout') ?? 2) }, () =>
    randomInt(1000, 1_000_000_000),
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(opt('out') ?? join(here, '..', 'results', `${stamp}-${toolName}`));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'results.jsonl'), '');

  const tool = make(udid, join(out, 'tool-state'));
  const toolVersion = await tool.version();
  const runtime = sim.runtime.replace('com.apple.CoreSimulator.SimRuntime.', '');
  const meta: RunMeta = {
    tool: toolName,
    toolVersion,
    simulator: `${sim.name} (${runtime}, ${udid})`,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    devSeeds,
    heldoutSeeds,
    evalRevision: evalRevision(),
    host: `${hostname()} · ${cpus()[0]?.model ?? '?'} · ${Math.round(totalmem() / 2 ** 30)} GB · ${execFileSync('xcodebuild', ['-version'], { encoding: 'utf8' }).split('\n')[0]}`,
  };
  console.error(
    `eval: ${toolVersion} on ${meta.simulator}; ${probes.length} probes × ${devSeeds.length + heldoutSeeds.length} seeds → ${out}`,
  );

  await install(udid);
  // Warm-up, not scored: the first observation pays the tool's cold start.
  await launchScenario(udid, 'B11', 0, 'warmup');
  await waitForEvent(udid, 'warmup', (e) => e.kind === 'ready', 10_000);
  const cold = await tool.observe();
  meta.coldObserveMs = cold.claim.ms;
  console.error(`warm-up observe: ${cold.claim.status} in ${cold.claim.ms} ms (app ${cold.app ?? '?'})`);
  if (cold.claim.status !== 'ok' && cold.claim.status !== 'uncertain')
    throw new Error(`the tool could not observe at all; not scoring a broken setup:\n${cold.claim.output}`);

  const results: ProbeResult[] = [];
  const seeds: Array<[number, 'dev' | 'heldout']> = [
    ...devSeeds.map((s) => [s, 'dev'] as [number, 'dev']),
    ...heldoutSeeds.map((s) => [s, 'heldout'] as [number, 'heldout']),
  ];
  for (const probe of probes) {
    for (const [seed, split] of seeds) {
      const run = `${probe.id}-${seed}-${randomInt(1e6)}`;
      const calls: Claim[] = [];
      const t0 = performance.now();
      let outcome: ProbeOutcome;
      try {
        if (probe.reinstall) await reinstall(udid);
        await launchScenario(udid, probe.scenario, seed, run);
        const ready = await waitForEvent(udid, run, probe.readyWhen ?? ((e) => e.kind === 'ready'), 12_000);
        if (!ready) {
          outcome = { invalid: 'the scenario did not report ready', detail: '' };
        } else {
          await tool.afterAppLaunch?.();
          await sleep(400);
          const ctx: Ctx = {
            udid,
            run,
            seed,
            tool: recording(tool, calls),
            events: () => readEvents(udid, run),
            waitFor: (pred, ms) => waitForEvent(udid, run, pred, ms),
            notify: (c) => notify(udid, c),
            fixture: async () =>
              Object.assign({}, ...(await readEvents(udid, run)).filter((e) => e.kind === 'fixture')),
          };
          outcome = await Promise.race([
            probe.run(ctx),
            sleep(300_000).then((): ProbeOutcome => ({ hung: 'probe exceeded 300 s', detail: '' })),
          ]);
        }
      } catch (e) {
        outcome = { invalid: `harness error: ${(e as Error).message}`, detail: '' };
      }
      // Permission probes start from a fresh install and leave one behind (C1r also answers its
      // prompt: an unanswered prompt survives relaunch and reinstall).
      const events = await readEvents(udid, run).catch(() => []);
      if (probe.reinstall && promptPending(events)) {
        // The tool could not answer its prompt, which would otherwise cover the next probes. The
        // agent's next action clears it: XCTest answers an interrupting system alert before it
        // delivers a touch. One untimed, unscored tap on empty screen stands in for that action.
        await tool.tapPoint(201, 800).catch(() => undefined);
        await sleep(1000);
        // Recorded, so a prompt that survived into the next probes is visible in the results.
        const answered = !promptPending(await readEvents(udid, run).catch(() => events));
        outcome.extra = { ...outcome.extra, promptCleanup: answered ? 'answered' : 'still pending' };
      }
      if (probe.reinstall) await reinstall(udid).catch(() => undefined);
      outcome.calls = calls;
      const verdict = verdictOf(probe.expect, outcome);
      const result: ProbeResult = {
        ...outcome,
        probe: probe.id,
        title: probe.title,
        tool: toolName,
        toolVersion,
        split,
        seed,
        run,
        expect: probe.expect,
        verdict,
        ms: Math.round(performance.now() - t0),
        events,
      };
      results.push(result);
      appendFileSync(join(out, 'results.jsonl'), `${JSON.stringify(result)}\n`);
      const why = outcome.hung ?? outcome.invalid ?? outcome.setupFailed ?? outcome.detail;
      console.error(
        `${probe.id.padEnd(5)} seed ${String(seed).padEnd(10)} ${verdict.padEnd(16)} ${outcome.claim?.status ?? '-'} ${outcome.claim?.ms ?? '-'}ms · ${why}`,
      );
    }
  }
  await tool.close?.();
  meta.finishedAt = new Date().toISOString();
  writeFileSync(
    join(out, 'summary.json'),
    `${JSON.stringify({ meta, results: results.map(({ events: _e, calls: _c, ...r }) => r) }, null, 2)}\n`,
  );
  const md = renderReport(meta, results);
  writeFileSync(join(out, 'report.md'), md);
  console.log(md);
}

// Exit explicitly: a tool's detached daemon (agent-device) can inherit our pipes and keep Bun alive.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

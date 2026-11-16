#!/usr/bin/env bun
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTask } from './agent.ts';
import { type AtlasBundle, exportAtlas, importAtlas, inspectAtlas, summarizeDiff } from './atlas.ts';
import { junitReport, runBench, scorecard } from './bench.ts';
import { selectDevice } from './bind.ts';
import { cliVerb, execCliTool, jsonEnvelope, parseCliArgs, verbSummaries } from './cli.ts';
import { COMPLETION_SHELLS, completionScript } from './completions.ts';
import { acquireDevice, callerIdentity, DeviceLeaseError, sharedSimulator } from './device-lease.ts';
import { doctorExitCode, renderDoctor, runDoctor } from './doctor.ts';
import { startMcp } from './mcp.ts';
import { loadSettings } from './settings.ts';
import { accent, bold, dim, gradient, muted, prettify } from './style.ts';
import { currentTraceSession } from './trace-session.ts';
import { runExitCode } from './verification.ts';

/** The published package version (kept in sync with package.json by the release flow). */
import { VERSION } from './version.ts';

const ASCII_WORDMARK = [
  '██████  ██   ██  ██████  ███    ██ ███████       ██    ██ ███████ ███████',
  '██   ██ ██   ██ ██    ██ ████   ██ ██            ██    ██ ██      ██     ',
  '██████  ███████ ██    ██ ██ ██  ██ █████   █████ ██    ██ ███████ █████  ',
  '██      ██   ██ ██    ██ ██  ██ ██ ██            ██    ██      ██ ██     ',
  '██      ██   ██  ██████  ██   ████ ███████        ██████  ███████ ███████',
] as const;

const renderWordmark = () => ASCII_WORDMARK.map((line) => `  ${gradient(line)}`).join('\n');

const [command, ...rest] = process.argv.slice(2);

if (command === '--version' || command === '-V' || command === 'version') {
  console.log(`phone-use ${VERSION}`);
  process.exit(0);
}

// Config files fill in PHONE_USE_* defaults before anything reads the env
// (the environment itself always wins — see settings.ts).
loadSettings();

// Registry verbs first (observe/tap/goto/…): the CLI is the third renderer
// over the shared registry — any coding agent with a shell drives the phone
// one command at a time, no MCP wiring needed (see cli.ts).
const verb = cliVerb(command);
if (verb) {
  // Device pinning for one-shot verbs: PHONE_USE_DEVICE=<udid> connects the
  // verb to that simulator (per-device daemon session), which is what lets
  // two lanes drive two booted sims without colliding. Unset = implicit
  // attach to the (single) booted sim, byte-identical to before.
  // `mirror` (real iPhone) and `android` (real Android over adb) are not
  // simulator udids — they select real-device backends wired up in driver.ts.
  // Resolving them against simctl would fail with "no simulator with udid …".
  const REAL_DEVICE_SELECTORS = new Set(['mirror', 'android']);
  if (process.env.PHONE_USE_DEVICE && !REAL_DEVICE_SELECTORS.has(process.env.PHONE_USE_DEVICE)) {
    await selectDevice();
  }
  const parsed = parseCliArgs(verb, rest);
  // One agent session per simulator: refuse a second session instead of
  // letting two agents interleave on one device (see device-lease.ts).
  if (parsed.ok && !parsed.help) {
    const udid = await sharedSimulator();
    if (udid) {
      try {
        acquireDevice(udid, callerIdentity('cli'), `Simulator ${udid}`);
      } catch (error) {
        if (!(error instanceof DeviceLeaseError)) throw error;
        const outcome = { out: `ERROR: ${error.message}`, code: 1 as const };
        console.log(parsed.json ? jsonEnvelope(verb, outcome) : prettify(outcome.out));
        process.exit(1);
      }
    }
  }
  const outcome = await execCliTool(verb, parsed);
  console.log(parsed.ok && parsed.json ? jsonEnvelope(verb, outcome) : prettify(outcome.out));
  process.exit(outcome.code);
}

switch (command) {
  case 'compare': {
    if (!rest[0] || rest.includes('--help')) {
      console.log(
        'phone-use compare <contract.json> [--output <directory>] — repeated, independently graded CLI comparisons',
      );
      process.exit(rest.includes('--help') ? 0 : 1);
    }
    const { readFile } = await import('node:fs/promises');
    const { runComparison } = await import('./comparison.ts');
    const outputIndex = rest.indexOf('--output');
    const output = outputIndex < 0 ? './comparison-results' : rest[outputIndex + 1];
    if (!output) throw new Error('--output needs a directory');
    const result = await runComparison(JSON.parse(await readFile(rest[0], 'utf8')), output, (message) =>
      console.error(message),
    );
    console.log(JSON.stringify(result, null, 2));
    process.exit(
      result.trials.some((trial) => trial.setupFailed || trial.executionFailed || !trial.graded) ? 1 : 0,
    );
    break;
  }
  case 'run': {
    const { runWorkflowCli } = await import('./workflow-cli.ts');
    process.exit(await runWorkflowCli(rest));
    break;
  }
  // `create ios` / `list` / `env` / `close` are the primary UX (you create a
  // *phone*); `sandbox <sub>` remains as the namespaced alias.
  case 'login': {
    const { runLogin } = await import('./login.ts');
    process.exit(await runLogin(rest));
    break; // unreachable
  }
  case 'logout': {
    const { runLogout } = await import('./login.ts');
    process.exit(runLogout());
    break; // unreachable
  }
  // Cloud phones you `create`; the phone in your pocket you `connect` to.
  case 'connect': {
    // `connect android` → real Android over adb; bare `connect` → real iPhone.
    if (rest[0] === 'android') {
      const { connectAndroidPhone } = await import('./android/connect.ts');
      process.exit(await connectAndroidPhone());
    }
    const { connectRealPhone } = await import('./mirror/connect.ts');
    process.exit(await connectRealPhone());
    break; // unreachable
  }
  case 'disconnect': {
    const { disconnectRealPhone } = await import('./mirror/connect.ts');
    process.exit(disconnectRealPhone());
    break; // unreachable
  }
  case 'vm': {
    // Operator tool: rent/bootstrap the Macs that host simulators.
    const { runVmCli } = await import('./vm-cli.ts');
    process.exit(await runVmCli(rest));
    break; // unreachable
  }
  case 'install': {
    // Install a local .app (or zip of one) onto the attached cloud sandbox.
    const target = rest[0];
    if (!target || !process.env.PHONE_USE_SANDBOX_URL) {
      console.error(
        'usage: phone-use install <path/to/App.app|.zip>   (attach first: eval "$(phone-use env <id>)")',
      );
      process.exit(1);
    }
    const { createCloudSandboxBackend } = await import('@phone-use/sdk');
    let zipPath = target;
    if (target.endsWith('.app')) {
      // Unique per process: installing one build on several phones at once must
      // not share a zip, or the first upload to finish deletes it under the rest.
      zipPath = join(tmpdir(), `phone-use-upload-${process.pid}-${Date.now()}.zip`);
      const zip = Bun.spawn(['ditto', '-c', '-k', '--keepParent', target, zipPath], { stderr: 'pipe' });
      if ((await zip.exited) !== 0) {
        console.error(`zip failed: ${await new Response(zip.stderr).text()}`);
        process.exit(1);
      }
    }
    try {
      // Streamed, not base64'd: a real app is hundreds of megabytes and must not
      // be read into memory or inflated by a third on the way out.
      const result = await createCloudSandboxBackend().installAppStream(Bun.file(zipPath));
      console.log(`Installed ${result.installed ?? 'app'} on the sandbox.`);
    } finally {
      if (zipPath !== target)
        await Bun.file(zipPath)
          .delete()
          .catch(() => undefined);
    }
    break;
  }
  case 'create':
  case 'list':
  case 'env':
  case 'close': {
    const { runSandboxCli } = await import('./cloud-cli.ts');
    process.exit(await runSandboxCli([command, ...rest]));
    break; // unreachable — process.exit above
  }
  case 'sandbox': {
    const { runSandboxCli } = await import('./cloud-cli.ts');
    process.exit(await runSandboxCli(rest));
    break; // unreachable — process.exit above
  }
  case 'checkpoint': {
    // Save/restore the attached sandbox's full device state (see cloud-cli).
    const { runCheckpointCli } = await import('./cloud-cli.ts');
    process.exit(await runCheckpointCli(rest));
    break; // unreachable — process.exit above
  }
  case 'traffic': {
    // Captured network flows of the attached sandbox (capture-enabled hosts).
    const { runTrafficCli } = await import('./cloud-cli.ts');
    process.exit(await runTrafficCli(rest));
    break; // unreachable — process.exit above
  }
  case 'mcp': {
    // --device <udid|launch|connect> wins over PHONE_USE_DEVICE (startMcp
    // reads the env; pre-seed it from the flag).
    const di = rest.indexOf('--device');
    if (di !== -1 && rest[di + 1]) process.env.PHONE_USE_DEVICE = rest[di + 1];
    // --devices a=<udid>,b=launch,… : several phones behind one server (phones.ts).
    const ds = rest.indexOf('--devices');
    if (ds !== -1 && rest[ds + 1]) process.env.PHONE_USE_DEVICES = rest[ds + 1];
    await startMcp();
    break;
  }
  case 'bench': {
    const fi = rest.indexOf('--format');
    const format = fi === -1 ? (rest.includes('--json') ? 'json' : 'text') : rest[fi + 1];
    const oi = rest.indexOf('--output');
    const outFile = oi === -1 ? undefined : rest[oi + 1];
    if (format !== 'text' && format !== 'json' && format !== 'junit') {
      console.error('usage: phone-use bench [--format json|junit] [--output <file>]');
      process.exit(1);
    }
    const results = await runBench();
    const pass = results.filter((r) => r.ok).length;
    const report =
      format === 'junit'
        ? junitReport(results)
        : format === 'json'
          ? JSON.stringify({ passed: pass, total: results.length, results }, null, 2)
          : `\n${scorecard(results)}\n`;
    if (outFile) await Bun.write(outFile, report);
    else console.log(report);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
    break; // unreachable — process.exit above; satisfies noFallthroughSwitchClause
  }
  case 'sim': {
    // Simulator controls over simctl: logs, recording, permissions, push…
    const { runSimCli } = await import('./sim-cli.ts');
    process.exit(await runSimCli(rest));
    break; // unreachable — process.exit above
  }
  case 'doctor': {
    // `doctor --mirror` diagnoses the real-iPhone path specifically. It is a
    // separate report because its prerequisites (Screen Recording,
    // Accessibility, a connected phone) have nothing to do with simulators,
    // and running it unasked would fail on every machine without an iPhone
    // plugged into Mirroring.
    if (rest.includes('--mirror')) {
      const { preflightMirror, formatPreflight } = await import('./mirror/preflight.ts');
      const result = await preflightMirror();
      console.log(
        rest.includes('--json')
          ? JSON.stringify(result, null, 2)
          : `\nreal iPhone (iPhone Mirroring)\n\n${formatPreflight(result)}\n`,
      );
      process.exit(result.ok ? 0 : 1);
    }
    const checks = await runDoctor();
    console.log(
      rest.includes('--json')
        ? JSON.stringify({ ok: doctorExitCode(checks) === 0, checks }, null, 2)
        : `\n${renderDoctor(checks)}\n`,
    );
    process.exit(doctorExitCode(checks));
    break; // unreachable — process.exit above; satisfies noFallthroughSwitchClause
  }
  case 'completion': {
    const shell = rest[0] ?? '';
    const script = completionScript(shell);
    if (!script) {
      console.error(`usage: phone-use completion <${COMPLETION_SHELLS.join('|')}>`);
      process.exit(1);
    }
    console.log(script);
    break;
  }
  case 'export': {
    const file = rest[0] ?? 'atlas.json';
    const bundle = await exportAtlas();
    await Bun.write(file, JSON.stringify(bundle, null, 2));
    console.log(`Exported ${bundle.maps.length} maps, ${bundle.skills.length} skills → ${file}`);
    break;
  }
  case 'import': {
    const file = rest[0];
    if (!file) {
      console.error('usage: phone-use import <file>');
      process.exit(1);
    }
    const bundle = JSON.parse(await Bun.file(file).text()) as AtlasBundle;
    const s = await importAtlas(bundle);
    console.log(`Imported ${s.maps} maps (${s.mergedMaps} merged into existing), ${s.skills} skills`);
    break;
  }
  case 'inspect': {
    const file = rest[0];
    if (!file) {
      console.error('usage: phone-use inspect <file>');
      process.exit(1);
    }
    const bundle = JSON.parse(await Bun.file(file).text()) as AtlasBundle;
    console.log(summarizeDiff(await inspectAtlas(bundle)));
    break;
  }
  case 'task': {
    const expectations: import('./verification.ts').Expectation[] = [];
    while (rest.includes('--expect')) {
      const index = rest.indexOf('--expect');
      const contains = rest[index + 1];
      if (!contains || contains.startsWith('--')) throw new Error('--expect needs non-empty screen text');
      expectations.push({ kind: 'screen', contains });
      rest.splice(index, 2);
    }
    const di = rest.indexOf('--device');
    const deviceSpec = di === -1 ? undefined : rest[di + 1];
    if (di !== -1) rest.splice(di, 2);
    const ji = rest.indexOf('--json');
    const asJson = ji !== -1;
    if (asJson) rest.splice(ji, 1);
    const sel = await selectDevice(deviceSpec ?? process.env.PHONE_USE_DEVICE);
    const goal = rest.join(' ').trim();
    if (!goal) {
      console.error('usage: phone-use task "<goal>" [--json]');
      process.exit(1);
    }
    let result: Awaited<ReturnType<typeof runTask>> | undefined;
    try {
      result = await runTask(goal, { expectations });
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n[${result.status}] ${result.summary}\n`);
        for (const step of result.steps) {
          console.log(`  ${step.tool} ${JSON.stringify(step.input)}`);
        }
      }
    } finally {
      // Flush the trace artifact BEFORE exiting: completed → passed, anything
      // else (failed status or a thrown error) → failed.
      await currentTraceSession()
        ?.finish(result?.status === 'verified' ? 'passed' : 'failed')
        .catch(() => undefined);
      if (sel?.owned) await sel.device.close().catch(() => undefined);
    }
    process.exit(result ? runExitCode(result.status) : 1);
    break; // unreachable — process.exit above; satisfies noFallthroughSwitchClause
  }
  default: {
    // Vercel-style help: every command is an aligned row — name, args, short
    // description — in scannable groups. Verb summaries are trimmed to their
    // first clause so rows never wrap.
    const clip = (text: string, max = 58): string => {
      const first = text.split(/\\. |—|·/)[0]?.trim() ?? text;
      return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
    };
    const row = (cmd: string, args: string, desc: string) =>
      `    ${bold(cmd.padEnd(13))}${dim(args.padEnd(15))}${muted(desc)}`;
    const section = (title: string) => `\n  ${accent(title)}\n`;
    const lines: string[] = [
      '',
      renderWordmark(),
      '',
      `  ${dim('Give your agent a phone.')}`,
      '',
      `  ${bold('phone-use')} ${dim('<command> [options]')}`,
      // Cloud phones are on a waitlist; every verb below also drives a local
      // simulator or device with no account.
      section('Cloud (waitlist: phoneuse.dev/waitlist)'),
      row('login', '', 'Sign in from the browser; saves your API key'),
      row('create', 'ios', 'Provision a cloud phone (approved accounts)'),
      row('list', '', 'List your phones'),
      row('env', '<id>', 'Print exports that attach this shell to a phone'),
      row('close', '<id>', 'Close a phone'),
      row('install', '<App.app>', 'Install a local build on the attached phone'),
      row('vm', '[cmd]', 'Rent and prepare simulator hosts (operators)'),
      section('Agents'),
      row('task', '"<goal>"', 'Built-in agent runs a goal end to end'),
      row('mcp', '', 'MCP server for Claude Code, Cursor, any MCP client'),
      row('bench', '', 'Self-verifying benchmark, prints a scorecard'),
      section('Verbs'),
      ...verbSummaries().map(([name, summary]) => row(name, '', clip(summary))),
      section('Atlas'),
      row('export', '[file]', 'Export learned maps + skills to a bundle'),
      row('inspect', '<file>', 'Preview what a bundle would add'),
      row('import', '<file>', 'Merge a bundle into this machine'),
      section('Setup'),
      row('compare', '<contract.json>', 'Compare CLI harnesses with independent graders'),
      row('run', '<flow.json>', 'Execute a flow with checks and saved evidence'),
      row('sim', '<command>', 'Simulator logs, recording, permissions, push, location'),
      row('doctor', '', 'Check Bun, Xcode, simulators, keys'),
      row('doctor', '--mirror', 'Check the real-iPhone path (iPhone Mirroring)'),
      row('connect', '', 'Use the real iPhone on your desk for every verb'),
      row('disconnect', '', 'Go back to the local simulator (or a cloud phone)'),
      row('completion', '<shell>', `Shell completions: ${COMPLETION_SHELLS.join(' | ')}`),
      row('logout', '', 'Remove the saved cloud key'),
      '',
      `  ${muted('Destructive actions refuse once — re-run with --yes. Add --json anywhere.')}`,
      `  ${muted(`Per-command help: ${bold('phone-use <command> --help')}${muted(' · docs: https://phoneuse.dev/docs')}`)}`,
      '',
    ];
    console.log(lines.join('\n'));
  }
}

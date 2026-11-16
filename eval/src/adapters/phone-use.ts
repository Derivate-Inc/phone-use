// phone-use driven exactly as a coding agent drives it: one CLI process per verb, `--json`,
// the simulator pinned with PHONE_USE_DEVICE. Only documented verbs and flags are used
// (`phone-use <verb> --help`); nothing is imported from the harness.
import { execFileSync, spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adapter, Claim, ClaimStatus, Element, Observation } from '../types.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENTRY = join(REPO, 'packages', 'phone-use', 'src', 'index.ts');
/** Kill a call after this long; it is a hang either way (see HANG_MS). */
const KILL_MS = 90_000;

// Phrases in a successful reply that tell the agent the outcome is in doubt.
const HEDGES = [
  /did NOT change/i,
  /\(no change\)/i,
  /could not read the field back/i,
  /verify before/i,
  /unverified/i,
];

export function claimStatusOf(
  status: string | undefined,
  exitCode: number | null,
  output: string,
): ClaimStatus {
  if (status === 'ok') return HEDGES.some((h) => h.test(output)) ? 'uncertain' : 'ok';
  if (status === 'failed') return 'error';
  if (status === 'blocked' || status === 'confirm_required') return 'refused';
  return exitCode === null ? 'hang' : 'crash';
}

const ELEMENT_LINE = /^(?:~ )?(@e\d+) \[([^\]]+)\](.*)$/;
const RECT = /\((-?\d+),(-?\d+) (\d+)x(\d+)\)/;

/** Parse phone-use's rendered element list (`@e9 [Cell] "Label" value="…" (x,y wxh)`). */
export function parseObservation(text: string): { app?: string; elements: Element[] } {
  const elements: Element[] = [];
  let app: string | undefined;
  for (const line of text.split('\n')) {
    const a = /^App: (.*)$/.exec(line.trim());
    if (a && app === undefined) app = a[1];
    const m = ELEMENT_LINE.exec(line.trim());
    if (!m) continue;
    let rest = m[3] ?? '';
    let label = '';
    let value: string | undefined;
    const lit = /^ ("(?:[^"\\]|\\.)*")/.exec(rest);
    if (lit) {
      label = JSON.parse(lit[1]!) as string;
      rest = rest.slice(lit[0].length);
    }
    const v = /^ value=("(?:[^"\\]|\\.)*")/.exec(rest);
    if (v) value = JSON.parse(v[1]!) as string;
    const r = RECT.exec(rest);
    const b = /\(blocked: ([^)]+)\)/.exec(rest);
    elements.push({
      ref: m[1]!,
      role: m[2]!,
      label,
      value,
      rect: r ? { x: +r[1]!, y: +r[2]!, w: +r[3]!, h: +r[4]! } : undefined,
      ...(b ? { blocked: b[1] } : {}),
    });
  }
  return { ...(app === undefined ? {} : { app }), elements };
}

/** The repo revision the eval drives (+dirty when packages/ has uncommitted changes). */
export function phoneUseVersion(): string {
  const git = (a: string[]) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim();
  return `phone-use@${git(['rev-parse', '--short', 'HEAD'])}${git(['status', '--porcelain', '--', 'packages']) ? '+dirty' : ''}`;
}

/**
 * @param udid the simulator to pin with PHONE_USE_DEVICE; null leaves the device implicit
 * (the "agent forgot to pin a device" case in Tier 2).
 * @param opts.mapDir where phone-use keeps learned app maps (PHONE_USE_MAP_DIR). The runners give
 * each run a fresh directory, so results never depend on maps an earlier run learned.
 */
export function createPhoneUseAdapter(
  udid: string | null,
  opts: { mapDir?: string; leaseDir?: string } = {},
): Adapter {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1' };
  // Each adapter instance is one agent: its own session name (agent-device's adapter
  // likewise uses its own --session), device leases kept in the run directory.
  env.PHONE_USE_SESSION = `eval-${randomInt(1e9)}`;
  if (opts.leaseDir) env.PHONE_USE_LEASE_DIR = opts.leaseDir;
  // The real environment outranks config files (settings.ts), so an explicit value here also keeps
  // the host's ~/.phone-use/config.json (which may default PHONE_USE_DEVICE to android) out of the
  // eval. Empty = "not pinned": phone-use then attaches to the one booted simulator or refuses.
  env.PHONE_USE_DEVICE = udid ?? '';
  if (opts.mapDir) env.PHONE_USE_MAP_DIR = opts.mapDir;

  /** One CLI process. Registry verbs answer in a --json envelope; `sim` commands only by exit code. */
  function cli(args: string[], json = true): Promise<Claim> {
    const call = `phone-use ${args.map((a) => (/^[\w@.-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}`;
    const t0 = performance.now();
    return new Promise((resolve) => {
      const child = spawn('bun', [ENTRY, ...args, ...(json ? ['--json'] : [])], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => {
        out += d;
      });
      child.stderr.on('data', (d) => {
        err += d;
      });
      const killer = setTimeout(() => child.kill('SIGKILL'), KILL_MS);
      child.on('close', (code) => {
        clearTimeout(killer);
        const ms = Math.round(performance.now() - t0);
        const line = out
          .trim()
          .split('\n')
          .reverse()
          .find((l) => l.startsWith('{'));
        let env: { status?: string; output?: string } = {};
        try {
          env = line ? (JSON.parse(line) as typeof env) : {};
        } catch {
          env = {};
        }
        const output = env.output ?? `${out}${err}`.trim();
        const status = json
          ? claimStatusOf(env.status, code, output)
          : code === 0
            ? 'ok'
            : code === null
              ? 'hang'
              : 'error';
        resolve({
          status,
          ms,
          output: output.slice(0, 64_000),
          call,
          exitCode: code ?? undefined,
        });
      });
    });
  }

  /** A confirmation request is the documented two-phase flow: re-run the same command with --yes. */
  async function act(args: string[]): Promise<Claim> {
    const first = await cli(args);
    if (first.exitCode !== 3) return first;
    const second = await cli([...args, '--yes']);
    return {
      ...second,
      ms: first.ms + second.ms,
      output: `${first.output}\n--- re-run with --yes ---\n${second.output}`,
    };
  }

  /** An ambiguous label fails with candidates and "Disambiguate with role"; an agent retries with --role. */
  async function tapByLabel(label: string): Promise<Claim> {
    const first = await act(['tap', label]);
    if (first.status !== 'error' || !/is ambiguous/.test(first.output)) return first;
    const second = await act(['tap', label, '--role', 'Button']);
    return {
      ...second,
      ms: first.ms + second.ms,
      output: `${first.output}\n--- retried with --role Button ---\n${second.output}`,
    };
  }

  return {
    name: 'phone-use',
    version: async () => phoneUseVersion(),
    async observe(): Promise<Observation> {
      const claim = await cli(['observe', '--full']);
      return { claim, raw: claim.output, ...parseObservation(claim.output) };
    },
    async readScreen() {
      const claim = await cli(['observe', '--full']);
      return { claim, text: claim.output };
    },
    tapRef: (el) => act(['tap', '--ref', el.ref]),
    tapLabel: (label) => tapByLabel(label),
    // `tap <label>` scrolls to find the control (`phone-use tap --help`).
    scrollToAndTap: (label) => tapByLabel(label),
    tapPoint: (x, y) => act(['tap', '--at', JSON.stringify({ x, y })]),
    fill: (fieldLabel, text) => act(['type', text, '--field', fieldLabel]),
    // No documented verb dismisses the keyboard (`phone-use --help`, 2026-11-04).
    dismissKeyboard: async () => ({
      status: 'unsupported',
      ms: 0,
      output: 'phone-use has no documented keyboard-dismiss verb',
      call: '(none)',
    }),
    setSwitch: (label, on) => act(['toggle', 'Gauntlet', label, `--on=${on}`]),
    alert: (action) => act(['handle_alert', action]),
    uninstallApp: (bundleId) => cli(['sim', 'uninstall', bundleId], false),
    // Abruptly end this device's session: SIGKILL the runner's host process (recorded in the
    // runner's state file) and the runner app on the simulator, as a crash would.
    async killSession() {
      if (!udid) return 'no device pinned';
      const statePath = join(homedir(), '.phone-use', 'runner', 'sessions', `${udid}.json`);
      let pid: number | undefined;
      try {
        pid = (JSON.parse(readFileSync(statePath, 'utf8')) as { pid?: number }).pid;
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        /* no runner recorded, or already gone */
      }
      try {
        execFileSync('xcrun', ['simctl', 'terminate', udid, 'dev.phoneuse.runner.uitests.xctrunner'], {
          stdio: 'ignore',
        });
      } catch {
        /* not running */
      }
      return `killed runner host pid ${pid ?? 'none'} and the on-device runner`;
    },
  };
}

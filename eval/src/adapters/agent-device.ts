// agent-device (Callstack), driven the way its own `agent-device --help` tells an agent to:
// open the app to start a session, snapshot -i for refs, press/fill with --settle, selectors as
// label="…", `scroll --until` for targets below the fold, `alert`/`keyboard` verbs. One CLI process
// per call, a named session pinned to the simulator, all of its state under a private directory.
// Reviewed for fairness by a second agent (doc 43 rule 4); see eval/README.md.
//
// Actions run in the default text mode, which is what an agent reads: claims, hedges ("not
// settled") and leak checks are judged on that text. Only snapshot -i uses --json, for rects.
//
// Pin: pass the installed binary (run.ts --agent-device-bin); the eval records its version.
//   npm i --prefix <dir> --ignore-scripts agent-device@0.21.36
import { execFileSync, spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter, Claim, ClaimStatus, Element, Observation } from '../types.ts';

const KILL_MS = 90_000;
/** The first `open` may build and launch agent-device's XCTest runner. */
const OPEN_KILL_MS = 300_000;
const BUNDLE = 'com.phoneuse.gauntlet';

type Node = {
  ref?: string;
  type?: string;
  role?: string;
  label?: string;
  value?: string;
  identifier?: string;
  hittable?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
};

/** Pull the node list out of `snapshot -i --json` data, whatever level it sits at. */
export function nodesOf(data: unknown): Node[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, unknown>;
  for (const key of ['nodes', 'elements']) if (Array.isArray(d[key])) return d[key] as Node[];
  for (const key of ['data', 'snapshot', 'tree', 'result']) {
    const inner = nodesOf(d[key]);
    if (inner.length) return inner;
  }
  return [];
}

export function toElements(nodes: Node[]): Element[] {
  return nodes
    .filter((n) => n.ref)
    .map((n) => ({
      ref: n.ref!.startsWith('@') ? n.ref! : `@${n.ref}`,
      role: n.type ?? n.role ?? '',
      label: n.label ?? n.identifier ?? '',
      value: n.value,
      rect: n.rect ? { x: n.rect.x, y: n.rect.y, w: n.rect.width, h: n.rect.height } : undefined,
      ...(n.hittable === false ? { blocked: 'not hittable' } : {}),
    }));
}

// Phrases in a successful text reply that tell the agent the outcome is not confirmed. Checked
// against real 0.21.36 output: a press that changed nothing prints "settled after 416ms: +0 -0", the
// counterpart of phone-use's "screen did NOT change".
const HEDGES = [/not settled/i, /unconfirmed/i, /targetHittable:\s*false/i, /settled after \d+ms: \+0 -0\b/];

/** Text-mode claim: the exit code says success or failure; the text can hedge or name the error. */
export function claimOf(exitCode: number | null, text: string): ClaimStatus {
  if (exitCode === null) return 'hang';
  if (exitCode === 0) return HEDGES.some((h) => h.test(text)) ? 'uncertain' : 'ok';
  if (/UNSUPPORTED_OPERATION/.test(text)) return 'unsupported';
  return 'error';
}

export function createAgentDeviceAdapter(udid: string, opts: { stateDir: string; bin: string }): Adapter {
  const { bin } = opts;
  // One session per adapter instance, so two adapters on one simulator are two agents.
  const session = `pu-eval-${udid.slice(0, 8)}-${randomInt(1e6)}`;
  mkdirSync(opts.stateDir, { recursive: true });
  const env = {
    ...process.env,
    AGENT_DEVICE_HOME: opts.stateDir,
    AGENT_DEVICE_STATE_DIR: join(opts.stateDir, 'state'),
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
  };
  let opened = false;

  function cli(
    args: string[],
    o: { json?: boolean; killMs?: number } = {},
  ): Promise<Claim & { stdout: string }> {
    const full = [
      ...args,
      '--platform',
      'ios',
      '--udid',
      udid,
      '--session',
      session,
      ...(o.json ? ['--json'] : []),
    ];
    const call = `agent-device ${args.map((a) => (/^[\w@.~-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}`;
    const t0 = performance.now();
    return new Promise((resolve) => {
      const child = spawn(bin, full, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => {
        out += d;
      });
      child.stderr.on('data', (d) => {
        err += d;
      });
      child.on('error', (e) => {
        err += String(e);
      });
      const killer = setTimeout(() => child.kill('SIGKILL'), o.killMs ?? KILL_MS);
      child.on('close', (code) => {
        clearTimeout(killer);
        const text = `${out}${err}`.trim();
        resolve({
          status: claimOf(code, text),
          ms: Math.round(performance.now() - t0),
          output: text.slice(0, 64_000),
          call,
          exitCode: code ?? undefined,
          stdout: out,
        });
      });
    });
  }

  const strip = ({ stdout: _s, ...c }: Claim & { stdout: string }): Claim => c;

  /** `open <app>` starts the session; without --relaunch it is idempotent-foreground (`help workflow`). */
  async function open(): Promise<Claim> {
    const r = strip(await cli(['open', BUNDLE], { killMs: OPEN_KILL_MS }));
    if (r.status === 'ok' || r.status === 'uncertain') opened = true;
    return r;
  }
  /** Undefined once the session is open; otherwise the failed `open`, which the caller reports. */
  async function ensureOpen(): Promise<Claim | undefined> {
    if (opened) return undefined;
    const r = await open();
    return opened ? undefined : r;
  }
  const act = async (args: string[]) => (await ensureOpen()) ?? strip(await cli(args));
  const sel = (label: string) => `label=${JSON.stringify(label)}`;

  /** AMBIGUOUS_MATCH dispatches nothing; the documented recovery narrows by role (`help workflow`). */
  async function pressLabel(label: string): Promise<Claim> {
    const first = await act(['press', sel(label), '--settle']);
    if (first.status !== 'error' || !/AMBIGUOUS_MATCH/.test(first.output)) return first;
    const second = await act(['press', `role=button ${sel(label)}`, '--settle']);
    return {
      ...second,
      ms: first.ms + second.ms,
      output: `${first.output}\n--- narrowed to role=button ---\n${second.output}`,
    };
  }

  async function observe(): Promise<Observation> {
    const failedOpen = await ensureOpen();
    if (failedOpen) return { claim: failedOpen, elements: [], raw: failedOpen.output };
    const r = await cli(['snapshot', '-i'], { json: true });
    let data: unknown = {};
    try {
      data = JSON.parse(r.stdout.trim());
    } catch {
      data = {};
    }
    const envelope = data as { success?: boolean; data?: { appName?: string; appBundleId?: string } };
    const claim = strip(r);
    if (envelope.success === false && claim.status === 'ok') claim.status = 'error';
    return {
      claim,
      elements: toElements(nodesOf(data)),
      app: envelope.data?.appName ?? envelope.data?.appBundleId,
      raw: claim.output,
    };
  }

  return {
    name: 'agent-device',
    async version() {
      return `agent-device@${execFileSync(bin, ['--version'], { encoding: 'utf8', env }).trim()}`;
    },
    afterAppLaunch: async () => {
      await open();
    },
    observe,
    async readScreen() {
      // "snapshot reads visible state; snapshot -i gets current interactive refs only".
      const claim = (await ensureOpen()) ?? strip(await cli(['snapshot']));
      return { claim, text: claim.output };
    },
    tapRef: (el) => act(['press', el.ref, '--settle']),
    tapLabel: (label) => pressLabel(label),
    async scrollToAndTap(label) {
      // `help workflow`: "Missing target: scroll <dir> --until <selector>".
      const scroll = await act(['scroll', 'down', '--until', sel(label)]);
      if (scroll.status !== 'ok' && scroll.status !== 'uncertain') return scroll;
      const press = await pressLabel(label);
      return { ...press, ms: scroll.ms + press.ms, output: `${scroll.output}\n---\n${press.output}` };
    },
    tapPoint: (x, y) => act(['press', String(x), String(y), '--settle']),
    fill: (fieldLabel, text) => act(['fill', `${sel(fieldLabel)} editable=true`, text, '--settle']),
    dismissKeyboard: () => act(['keyboard', 'dismiss']),
    async setSwitch(label, on) {
      // No set-to-state verb: find the switch in snapshot -i (by its label, or the switch on the row
      // with that label: "iOS merged: child ref => press it") and press it only if it differs.
      const obs = await observe();
      const isSwitch = (e: Element) => /switch/i.test(e.role);
      const row = obs.elements.find((e) => !isSwitch(e) && e.label === label);
      const overlaps = (e: Element) =>
        !!(row?.rect && e.rect && e.rect.y < row.rect.y + row.rect.h && e.rect.y + e.rect.h > row.rect.y);
      const sw =
        obs.elements.find((e) => isSwitch(e) && e.label === label) ??
        obs.elements.find((e) => isSwitch(e) && overlaps(e)) ??
        obs.elements.find((e) => isSwitch(e) && e.label.includes(label));
      if (!sw)
        return {
          status: 'error',
          ms: obs.claim.ms,
          output: `no switch for "${label}" in snapshot -i`,
          call: 'snapshot -i',
        };
      const isOn = sw.value === '1' || sw.value === 'true' || sw.value === 'on';
      if (isOn === on)
        return {
          status: 'ok',
          ms: obs.claim.ms,
          output: `already ${on ? 'on' : 'off'}`,
          call: 'snapshot -i',
        };
      return act(['press', sw.ref, '--settle']);
    },
    alert: (action) => act(['alert', action]),
    uninstallApp: (bundleId) => act(['uninstall', bundleId]),
    // "End with: agent-device close" (`--help`); it also releases the device claim.
    async close() {
      if (opened) await cli(['close']);
    },
    async killSession() {
      // This simulator's XCTest runner host (xcodebuild … <udid>), as a crash would end it.
      let pids: string[] = [];
      try {
        pids = execFileSync('pgrep', ['-f', `xcodebuild.*${udid}`], { encoding: 'utf8' })
          .trim()
          .split('\n')
          .filter(Boolean);
      } catch {
        pids = [];
      }
      for (const p of pids) {
        try {
          process.kill(Number(p), 'SIGKILL');
        } catch {
          /* gone */
        }
      }
      return `killed xcodebuild pid(s) ${pids.join(', ') || 'none'} for ${udid}`;
    },
  };
}

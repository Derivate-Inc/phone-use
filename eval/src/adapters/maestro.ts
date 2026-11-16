// Maestro (mobile.dev), driven through the MCP server its CLI ships (`maestro mcp`), the path its
// docs give AI agents: `inspect_screen` for the hierarchy, `run` with inline flow YAML for actions.
// One long-lived server for the whole run, as phone-use's MCP adapter.
//
// How an agent maps each step onto Maestro (the `run` and `inspect_screen` tool descriptions, the
// cheat sheet):
// - Maestro has no element refs. A tap on an element seen in `inspect_screen` uses its text, which
//   the descriptions say to copy verbatim (full-string regex, so it is escaped). When that text is
//   not unique on the screen, the element's id; when neither is unique, its centre point.
// - Below the fold: `scrollUntilVisible` then `tapOn`. Fields: `tapOn`, `eraseText`, `inputText`.
// - No alert or switch verb: the agent reads the screen and taps the button or switch itself.
// - Inline YAML needs the `appId` header: without it `run` fails with "Config Section Required",
//   which the tool's own example omits.
//
// Pin: the CLI release zip (run.ts --maestro-bin <…/maestro/bin/maestro>); the eval records the
// version. Analytics are turned off with Maestro's own environment variables.
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Adapter, Claim, Element, Observation } from '../types.ts';
import { pickAlertLabel } from './alert-choice.ts';

const BUNDLE = 'com.phoneuse.gauntlet';
/** As phone-use-mcp; the first call, which starts Maestro's iOS driver, took 26 s. */
const CALL_TIMEOUT_MS = 90_000;

type MNode = {
  b?: string;
  txt?: string;
  a11y?: string;
  rid?: string;
  val?: string;
  hint?: string;
  enabled?: boolean;
  c?: MNode[];
};

/** Bounds "[x1,y1][x2,y2]" as a rect. */
function rectOf(b: string | undefined): Element['rect'] {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b ?? '');
  if (!m) return undefined;
  const [x1, y1, x2, y2] = m.slice(1).map(Number) as [number, number, number, number];
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** What the agent reads as an element's name: its accessibility text, else hint, else text. */
const nameOf = (n: MNode) => n.a11y || n.hint || n.txt || '';

export type MaestroElement = Element & { node: MNode };

/** Flatten `inspect_screen`'s tree into the elements an agent sees (named or identified ones). */
export function flatten(nodes: MNode[]): MaestroElement[] {
  const out: MaestroElement[] = [];
  const walk = (n: MNode) => {
    if (nameOf(n) || n.rid)
      out.push({
        ref: `m${out.length}`,
        role: '',
        label: nameOf(n) || n.rid || '',
        value: n.val,
        rect: rectOf(n.b),
        ...(n.enabled === false ? { blocked: 'disabled' } : {}),
        node: n,
      });
    for (const ch of n.c ?? []) walk(ch);
  };
  for (const n of nodes) walk(n);
  return out;
}

/** Maestro's `text:` is a full-string, case-insensitive regex: escape what the screen shows. */
const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const q = (s: string) => JSON.stringify(s);
const flow = (commands: string) => `appId: ${BUNDLE}\n---\n${commands}`;

/** The selector an agent writes for an element it saw: unique text, else unique id, else its centre. */
export function selectorFor(el: MaestroElement, all: MaestroElement[]): string {
  const text = el.node.a11y || el.node.txt || el.node.hint;
  const same = (a: string | undefined, b: string | undefined) =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase();
  if (
    text &&
    all.filter((o) => [o.node.a11y, o.node.txt, o.node.hint].some((t) => same(t, text))).length === 1
  )
    return `text: ${q(re(text))}`;
  if (el.node.rid && all.filter((o) => o.node.rid === el.node.rid).length === 1)
    return `id: ${q(el.node.rid)}`;
  const r = el.rect;
  if (!r) return `text: ${q(re(text ?? el.label))}`;
  return `point: ${q(`${Math.round(r.x + r.w / 2)},${Math.round(r.y + r.h / 2)}`)}`;
}

export function createMaestroAdapter(udid: string, opts: { bin: string }): Adapter {
  let client: Client | undefined;
  let dead = false;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, { MAESTRO_CLI_NO_ANALYTICS: '1', MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true' });

  async function connect(): Promise<Client> {
    if (client) return client;
    const transport = new StdioClientTransport({ command: opts.bin, args: ['mcp'], env, stderr: 'ignore' });
    transport.onclose = () => {
      dead = true;
    };
    const c = new Client({ name: 'phone-use-eval', version: '1' });
    await c.connect(transport);
    client = c;
    return c;
  }

  async function call(name: string, args: Record<string, unknown>): Promise<Claim> {
    const shown = name === 'run' ? `maestro run ${JSON.stringify(args.yaml)}` : `maestro ${name}`;
    const t0 = performance.now();
    try {
      const c = await connect();
      const r = (await c.callTool({ name, arguments: { device_id: udid, ...args } }, undefined, {
        timeout: CALL_TIMEOUT_MS,
      })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
      // The first reply of a session leads with a note about Maestro's viewer; the payload is last.
      const text = (r.content ?? []).map((p) => p.text ?? '').join('\n');
      return {
        status: r.isError ? 'error' : 'ok',
        ms: Math.round(performance.now() - t0),
        output: text.slice(0, 64_000),
        call: shown,
      };
    } catch (e) {
      const msg = (e as Error).message;
      return {
        status: /timed out|timeout/i.test(msg) ? 'hang' : dead ? 'crash' : 'error',
        ms: Math.round(performance.now() - t0),
        output: msg,
        call: shown,
      };
    }
  }

  const run = (commands: string) => call('run', { yaml: flow(commands) });
  let last: MaestroElement[] = [];

  async function observe(): Promise<Observation> {
    const claim = await call('inspect_screen', {});
    let elements: MaestroElement[] = [];
    if (claim.status === 'ok') {
      const json = claim.output.slice(claim.output.indexOf('{"ui_schema"'));
      try {
        elements = flatten((JSON.parse(json) as { elements?: MNode[] }).elements ?? []);
      } catch {
        claim.status = 'crash';
      }
    }
    last = elements;
    return { claim, elements, raw: claim.output };
  }

  /** The element the probe picked, re-found in the last `inspect_screen` (Maestro has no refs). */
  const seen = (el: Element) => last.find((e) => e.ref === el.ref);

  async function tapSeen(el: MaestroElement): Promise<Claim> {
    return run(`- tapOn:\n    ${selectorFor(el, last)}`);
  }

  return {
    name: 'maestro',
    async version() {
      return `maestro@${execFileSync(opts.bin, ['--version'], { encoding: 'utf8', env }).trim().split('\n').pop()}`;
    },
    observe,
    async readScreen() {
      const claim = await call('inspect_screen', {});
      return { claim, text: claim.output };
    },
    async tapRef(el) {
      const m = seen(el);
      if (!m)
        return {
          status: 'error',
          ms: 0,
          output: `element ${el.ref} not in the last inspect_screen`,
          call: '(none)',
        };
      return tapSeen(m);
    },
    tapLabel: (label) => run(`- tapOn: ${q(re(label))}`),
    scrollToAndTap: (label) =>
      run(`- scrollUntilVisible:\n    element:\n      text: ${q(re(label))}\n- tapOn: ${q(re(label))}`),
    tapPoint: (x, y) => run(`- tapOn:\n    point: ${q(`${x},${y}`)}`),
    fill: (fieldLabel, text) => run(`- tapOn: ${q(re(fieldLabel))}\n- eraseText\n- inputText: ${q(text)}`),
    dismissKeyboard: () => run('- hideKeyboard'),
    async setSwitch(label, on) {
      // No switch verb: find the switch (a valued "0"/"1" element with this name, the smallest one
      // being the control rather than its row) and tap it only if it differs.
      const obs = await observe();
      if (obs.claim.status !== 'ok') return obs.claim;
      const area = (e: Element) => (e.rect ? e.rect.w * e.rect.h : Number.POSITIVE_INFINITY);
      const sw = last
        .filter((e) => e.label.toLowerCase() === label.toLowerCase() && (e.value === '0' || e.value === '1'))
        .sort((a, b) => area(a) - area(b))[0];
      if (!sw) return { ...obs.claim, status: 'error', output: `no switch for "${label}" in inspect_screen` };
      if ((sw.value === '1') === on) return { ...obs.claim, output: `already ${on ? 'on' : 'off'}` };
      const tap = await tapSeen(sw);
      return { ...tap, ms: obs.claim.ms + tap.ms };
    },
    async alert(action) {
      const obs = await observe();
      if (obs.claim.status !== 'ok') return obs.claim;
      const label = pickAlertLabel(
        last.map((e) => e.label),
        action,
      );
      if (!label) return { ...obs.claim, status: 'refused', output: `no ${action} button in inspect_screen` };
      const tap = await run(`- tapOn: ${q(re(label))}`);
      return { ...tap, ms: obs.claim.ms + tap.ms };
    },
    async close() {
      await client?.close().catch(() => undefined);
    },
  };
}

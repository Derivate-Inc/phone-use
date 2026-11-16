// Mobilerun (Droidrun) on the iOS Simulator: mobilerun-core's Device over the ios-portal XCTest
// server, the only Simulator path its agent harness documents (mobile-harness
// platforms/ios/GUIDE.md: "Simulator through the ios-portal app"). Each step is the call that guide
// tells an agent to make:
// - observe and read: `device.ui()`; a tap on an element seen there: `device.tap_node(node)`;
// - by label: `device.tap_text(...)`; below the fold: `device.scroll_until(text_contains=...)`, then
//   `tap_node` on the node it returns; coordinates: `device.tap(x, y)`;
// - fields: `tap_text(field)` to focus, then `device.type(text, clear=True)`;
// - switches: `find_nodes`, then `tap_node` on the Switch if its value differs;
// - no keyboard-dismiss verb (ios-portal's only key is `home`) and no alert verb: the agent reads
//   `ui()` and taps the button.
// The portal tracks one app; `start_app` relaunches an app it is not tracking, so the adapter
// tracks Gauntlet once, on its first call (the unscored warm-up), before any scenario starts.
//
// Pin: mobilerun-core 1.10.1 + mobilerun-core-local 0.7.2 in a venv (run.ts --mobilerun-python),
// ios-portal @ c6f1cb7 (archived) running on the simulator (run.ts --mobilerun-url).
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Adapter, Claim, Element, Observation } from '../types.ts';
import { pickAlertLabel } from './alert-choice.ts';

const BUNDLE = 'com.phoneuse.gauntlet';
const CALL_TIMEOUT_MS = 90_000;
const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), 'mobilerun_bridge.py');

type Reply = { id: number; ok: boolean; result?: unknown; error?: string; ms: number };
type UiResult = { elements: Array<Element & { rect: Element['rect'] | null }>; text: string; dead: boolean };

export function createMobilerunAdapter(opts: { python: string; url: string; portalRev: string }): Adapter {
  let bridge: ReturnType<typeof spawn> | undefined;
  let ready: Promise<void> | undefined;
  let nextId = 1;
  const waiting = new Map<number, (r: Reply) => void>();
  let dead = false;

  function start(): Promise<void> {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const child = spawn(opts.python, [BRIDGE, opts.url], { stdio: ['pipe', 'pipe', 'pipe'] });
      bridge = child;
      let stderr = '';
      child.stderr?.on('data', (d) => {
        stderr += d;
      });
      child.on('close', () => {
        dead = true;
        reject(new Error(`mobilerun bridge exited: ${stderr.slice(-500)}`));
        for (const done of waiting.values())
          done({ id: 0, ok: false, error: `bridge died: ${stderr.slice(-500)}`, ms: 0 });
        waiting.clear();
      });
      const lines = createInterface({ input: child.stdout! });
      lines.on('line', (line) => {
        const msg = JSON.parse(line) as Reply & { ready?: boolean };
        if (msg.ready) return resolve();
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
      });
    });
    return ready;
  }

  let tracked = false;
  async function call(
    op: string,
    args: Record<string, unknown>,
    shown: string,
  ): Promise<Claim & { result?: unknown }> {
    const t0 = performance.now();
    try {
      await start();
      if (!tracked && op !== 'start_app') {
        tracked = true;
        await call('start_app', { bundle: BUNDLE }, `device.start_app(${JSON.stringify(BUNDLE)})`);
      }
      const id = nextId++;
      const reply = await Promise.race([
        new Promise<Reply>((resolve) => {
          waiting.set(id, resolve);
          bridge!.stdin!.write(`${JSON.stringify({ id, op, args })}\n`);
        }),
        new Promise<Reply>((resolve) =>
          setTimeout(
            () => resolve({ id, ok: false, error: 'TIMEOUT', ms: CALL_TIMEOUT_MS }),
            CALL_TIMEOUT_MS,
          ),
        ),
      ]);
      const ms = Math.round(performance.now() - t0);
      if (reply.error === 'TIMEOUT') return { status: 'hang', ms, output: 'no answer', call: shown };
      return {
        status: reply.ok ? 'ok' : dead ? 'crash' : 'error',
        ms,
        output: reply.ok ? (typeof reply.result === 'string' ? reply.result : 'ok') : (reply.error ?? ''),
        call: shown,
        result: reply.result,
      };
    } catch (e) {
      return {
        status: 'crash',
        ms: Math.round(performance.now() - t0),
        output: (e as Error).message,
        call: shown,
      };
    }
  }

  const strip = ({ result: _r, ...c }: Claim & { result?: unknown }): Claim => c;
  const act = async (op: string, args: Record<string, unknown>, shown: string) =>
    strip(await call(op, args, shown));

  async function ui(): Promise<{ claim: Claim; ui?: UiResult }> {
    const r = await call('ui', {}, 'device.ui()');
    const res = r.result as UiResult | undefined;
    const claim = { ...strip(r), output: (res?.text ?? r.output).slice(0, 64_000) };
    // The tool says it has no tree: an empty screen is then not a reading.
    if (res?.dead && claim.status === 'ok')
      Object.assign(claim, {
        status: 'uncertain',
        output: `dead_tree (no accessibility tree available)\n${claim.output}`,
      });
    return { claim, ...(res ? { ui: res } : {}) };
  }

  async function observe(): Promise<Observation> {
    const { claim, ui: res } = await ui();
    const elements: Element[] = (res?.elements ?? []).map((e) => ({ ...e, rect: e.rect ?? undefined }));
    return { claim, elements, raw: claim.output };
  }

  return {
    name: 'mobilerun',
    async version() {
      const { execFileSync } = await import('node:child_process');
      const v = execFileSync(
        opts.python,
        [
          '-c',
          "import importlib.metadata as m; print(m.version('mobilerun-core'), m.version('mobilerun-core-local'))",
        ],
        { encoding: 'utf8' },
      )
        .trim()
        .split(' ');
      return `mobilerun-core@${v[0]}+core-local@${v[1]}+ios-portal@${opts.portalRev}`;
    },
    observe,
    async readScreen() {
      const { claim } = await ui();
      return { claim, text: claim.output };
    },
    tapRef: (el) => act('tap_ref', { ref: el.ref }, `device.tap_node(<${el.ref} "${el.label}">)`),
    tapLabel: (label) => act('tap_text', { text: label }, `device.tap_text(${JSON.stringify(label)})`),
    scrollToAndTap: (label) =>
      act(
        'scroll_to_and_tap',
        { text: label },
        `device.tap_node(device.scroll_until(text_contains=${JSON.stringify(label)}))`,
      ),
    tapPoint: (x, y) => act('tap', { x, y }, `device.tap(${x}, ${y})`),
    fill: (field, text) =>
      act(
        'fill',
        { field, text },
        `device.tap_text(${JSON.stringify(field)}); device.type(${JSON.stringify(text)}, clear=True)`,
      ),
    dismissKeyboard: async () => ({
      status: 'unsupported',
      ms: 0,
      output: 'ios-portal supports only the "home" key; no keyboard-dismiss call',
      call: '(none)',
    }),
    setSwitch: (label, on) =>
      act(
        'tap_switch',
        { label, on },
        `device.find_nodes(any_contains=${JSON.stringify(label)}) → tap_node(Switch)`,
      ),
    async alert(action) {
      const obs = await observe();
      if (obs.claim.status !== 'ok') return obs.claim;
      const label = pickAlertLabel(
        obs.elements.map((e) => e.label),
        action,
      );
      const el = label ? obs.elements.find((e) => e.label === label) : undefined;
      if (!el) return { ...obs.claim, status: 'refused', output: `no ${action} button in device.ui()` };
      const tap = await act('tap_ref', { ref: el.ref }, `device.tap_node(<${el.ref} "${el.label}">)`);
      return { ...tap, ms: obs.claim.ms + tap.ms };
    },
    async close() {
      bridge?.stdin?.end();
      bridge?.kill();
    },
  };
}

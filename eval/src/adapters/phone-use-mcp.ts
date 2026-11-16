// phone-use through its MCP server, the path Claude Code and other MCP clients use: ONE long-lived
// server process for the whole run, so state the CLI loses between processes (the screen cache,
// ref baselines) survives here. Same registry verbs and arguments as the CLI adapter.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Adapter, Claim, Observation } from '../types.ts';
import { claimStatusOf, parseObservation, phoneUseVersion } from './phone-use.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENTRY = join(REPO, 'packages', 'phone-use', 'src', 'index.ts');
const CALL_TIMEOUT_MS = 90_000;

export function createPhoneUseMcpAdapter(udid: string, opts: { mapDir: string; leaseDir?: string }): Adapter {
  let client: Client | undefined;
  let dead = false;

  async function connect(): Promise<Client> {
    if (client) return client;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    // Same isolation as the CLI adapter, plus no live viewer (it would hold port 4936).
    Object.assign(env, {
      PHONE_USE_DEVICE: udid,
      PHONE_USE_MAP_DIR: opts.mapDir,
      PHONE_USE_LIVE: '0',
      NO_COLOR: '1',
    });
    if (opts.leaseDir) env.PHONE_USE_LEASE_DIR = opts.leaseDir;
    const transport = new StdioClientTransport({
      command: 'bun',
      args: [ENTRY, 'mcp'],
      env,
      stderr: 'ignore',
    });
    transport.onclose = () => {
      dead = true;
    };
    const c = new Client({ name: 'phone-use-eval', version: '1' });
    await c.connect(transport);
    client = c;
    return c;
  }

  async function call(name: string, args: Record<string, unknown>): Promise<Claim> {
    const shown = `mcp ${name} ${JSON.stringify(args)}`;
    const t0 = performance.now();
    try {
      const c = await connect();
      const r = (await c.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text = (r.content ?? []).map((p) => p.text ?? '').join('\n');
      const ms = Math.round(performance.now() - t0);
      const status = r.isError
        ? 'failed'
        : text.startsWith('⏸ CONFIRMATION REQUIRED')
          ? 'confirm_required'
          : 'ok';
      return { status: claimStatusOf(status, 0, text), ms, output: text.slice(0, 64_000), call: shown };
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      const msg = (e as Error).message;
      return {
        status: /timed out|timeout/i.test(msg) ? 'hang' : dead ? 'crash' : 'error',
        ms,
        output: msg,
        call: shown,
      };
    }
  }

  /** The documented two-phase flow: re-call with the confirm token the server returned. */
  async function act(name: string, args: Record<string, unknown>): Promise<Claim> {
    const first = await call(name, args);
    const token = /confirm: "([^"]+)"/.exec(first.output)?.[1];
    if (first.status !== 'refused' || !token) return first;
    const second = await call(name, { ...args, confirm: token });
    return {
      ...second,
      ms: first.ms + second.ms,
      output: `${first.output}\n--- confirmed ---\n${second.output}`,
    };
  }

  /** Same recovery as the CLI adapter: an ambiguous label is retried once with role Button. */
  async function tapByLabel(label: string): Promise<Claim> {
    const first = await act('tap', { label });
    if (first.status !== 'error' || !/is ambiguous/.test(first.output)) return first;
    const second = await act('tap', { label, role: 'Button' });
    return {
      ...second,
      ms: first.ms + second.ms,
      output: `${first.output}\n--- retried with role Button ---\n${second.output}`,
    };
  }

  return {
    name: 'phone-use-mcp',
    version: async () => `${phoneUseVersion()} (MCP)`,
    async observe(): Promise<Observation> {
      const claim = await call('observe', { full: true });
      return { claim, raw: claim.output, ...parseObservation(claim.output) };
    },
    async readScreen() {
      const claim = await call('observe', { full: true });
      return { claim, text: claim.output };
    },
    tapRef: (el) => act('tap', { ref: el.ref }),
    tapLabel: (label) => tapByLabel(label),
    scrollToAndTap: (label) => tapByLabel(label),
    tapPoint: (x, y) => act('tap', { at: { x, y } }),
    fill: (field, text) => act('type', { text, field }),
    dismissKeyboard: async () => ({
      status: 'unsupported',
      ms: 0,
      output: 'phone-use has no documented keyboard-dismiss tool',
      call: '(none)',
    }),
    setSwitch: (label, on) => act('toggle', { app: 'Gauntlet', switch: label, on }),
    alert: (action) => act('handle_alert', { action }),
    async close() {
      await client?.close().catch(() => undefined);
    },
  };
}

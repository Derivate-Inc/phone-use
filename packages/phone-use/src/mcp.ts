import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runTask } from './agent.ts';
import { selectDevice } from './bind.ts';
import { CREATE_CLOUD_PHONE_DESCRIPTION, createCloudPhoneForMcp } from './cloud-mcp.ts';
import {
  acquireDevice,
  callerIdentity,
  DeviceLeaseError,
  type Identity,
  releaseDevice,
  sharedSimulator,
} from './device-lease.ts';
import * as driver from './driver.ts';
import { withExecution } from './execution-context.ts';
import { startLiveViewer } from './live.ts';
import { evaluate, renderAsk } from './permissions.ts';
import { describePhones, openPhones, type Phone, parsePhoneSpecs } from './phones.ts';
import { reapSimulators } from './reap.ts';
import { REGISTRY, type ToolDef, targetOf, VISION_MARKER } from './registry.ts';
import { isConfigDefault } from './settings.ts';
import { toolFailed } from './tool-status.ts';
import { trace } from './trace.ts';
import { currentTraceSession, startTraceSessionFromEnv } from './trace-session.ts';
import { VERSION } from './version.ts';

// The MCP surface: a thin renderer over the shared registry (src/registry.ts).
// The built-in agent loop renders the same definitions (src/tools.ts), so the
// two surfaces cannot drift. Slimmed per the harness-v2 decision doc: 16 tools
// instead of 45, cutting ~4k tokens of schema from every client turn.

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

async function imageContent(path: string, note: string) {
  const data = Buffer.from(await Bun.file(path).arrayBuffer()).toString('base64');
  return {
    content: [
      { type: 'text' as const, text: note },
      { type: 'image' as const, data, mimeType: 'image/png' as const },
    ],
  };
}

// Server construction, separated from transport/lifecycle so tests can drive
// it over an in-memory transport (the registration loop below moved verbatim
// from the old startMcp — the one-brain diff proof).
//
// With `phones` (PHONE_USE_DEVICES), one server drives several phones: every
// tool but `note` gains an optional `phone` argument, each call runs in that
// phone's own execution context, and each result names its phone. Without
// them the surface and behavior are exactly the single-phone ones.
export function buildMcpServer(phones: readonly Phone[] = []): McpServer {
  const multi = phones.length > 0;
  const server = new McpServer(
    { name: 'phone-use', version: VERSION },
    multi ? { instructions: describePhones(phones) } : undefined,
  );
  const names = phones.map((p) => p.name) as [string, ...string[]];
  const phoneArg = multi
    ? { phone: z.enum(names).optional().describe(`Which phone (default ${names[0]})`) }
    : {};
  const pick = (name: unknown): Phone | undefined =>
    multi ? (phones.find((p) => p.name === name) ?? phones[0]) : undefined;
  const onPhone = <T>(phone: Phone | undefined, run: () => Promise<T>): Promise<T> =>
    phone ? withExecution(phone.execution, run) : run();
  const tag = (phone: Phone | undefined, value: string) => (phone ? `[phone ${phone.name}] ${value}` : value);

  // Delegating a whole goal to the built-in Claude loop needs an API key; agents
  // connecting over MCP on a subscription (Claude Code, Codex) drive the
  // low-level tools themselves instead.
  if (process.env.ANTHROPIC_API_KEY) {
    server.registerTool(
      'run_phone_task',
      {
        description:
          'Give the phone a natural-language goal (e.g. "open Settings and turn on Bluetooth"). An internal agent performs the steps and returns a summary. Use for multi-step goals; use the other tools for single actions.',
        inputSchema: { goal: z.string().describe('What to accomplish on the phone'), ...phoneArg },
      },
      async (args: { goal: string; phone?: string }) => {
        const phone = pick(args.phone);
        const result = await onPhone(phone, () => runTask(args.goal));
        const steps = result.steps
          .map((s) => `- ${s.tool} ${JSON.stringify(s.input)} [${s.ms}ms]`)
          .join('\n');
        return text(tag(phone, `Status: ${result.status}\n\n${result.summary}\n\nSteps taken:\n${steps}`));
      },
    );
  }

  // Ablation surface (PHONE_USE_SURFACE=raw): primitives only — no intent
  // verbs (goto/ask/search/toggle), no skills/atlas, no batch. What a "raw
  // LLM with hands" gets. Lets the benchmark measure what the harness layer
  // actually contributes vs bare screen control.
  const RAW = new Set([
    'observe',
    'screenshot',
    'tap',
    'type',
    'scroll',
    'wait_for',
    'handle_alert',
    'open',
    'nav',
    // The scratchpad is a memory primitive, not harness intelligence — both
    // surfaces get it so the ablation isolates maps/skills/verification.
    'note',
  ]);
  const defs = process.env.PHONE_USE_SURFACE === 'raw' ? REGISTRY.filter((d) => RAW.has(d.name)) : REGISTRY;

  // The one tool that is not a device verb: ask the control plane for a cloud
  // phone (cloud-mcp.ts). Cloud phones are on a waitlist, so for most callers
  // the answer is the waitlist message as a structured error. It takes no
  // `phone`: it does not act on any of this server's devices. The raw
  // ablation surface leaves it out.
  if (process.env.PHONE_USE_SURFACE !== 'raw') {
    server.registerTool(
      'create_cloud_phone',
      {
        description: CREATE_CLOUD_PHONE_DESCRIPTION,
        inputSchema: {
          platform: z.enum(['ios', 'android']).optional().describe('Which phone to ask for (default ios)'),
        },
      },
      async (args: { platform?: 'ios' | 'android' | undefined }) => {
        // A cloud phone costs running minutes, so it is not a read: observe
        // mode refuses it like any other non-read tool.
        const verdict = evaluate({
          tool: 'create_cloud_phone',
          risk: 'mutate',
          target: `cloud ${args.platform ?? 'ios'}`,
          app: undefined,
          confirm: undefined,
        });
        if (verdict.decision === 'deny') return { ...text(`⛔ BLOCKED: ${verdict.reason}`), isError: true };
        if (verdict.decision !== 'allow') return text(renderAsk(verdict));
        const result = await createCloudPhoneForMcp(args);
        trace({
          tool: 'create_cloud_phone',
          args,
          risk: 'mutate',
          decision: 'allow',
          app: undefined,
          ms: 0,
          ok: !result.isError,
          detail: result.text.slice(0, 120),
        });
        return {
          ...text(result.text),
          structuredContent: result.structured,
          ...(result.isError ? { isError: true } : {}),
        };
      },
    );
  }

  for (const def of defs) {
    // Confirm token: every mutating/destructive tool accepts an optional
    // `confirm` so a gated action can be re-called to proceed (see permissions).
    const base =
      def.risk === 'read'
        ? def.schema
        : {
            ...def.schema,
            confirm: z
              .string()
              .optional()
              .describe('Confirmation token from a prior ⏸ CONFIRMATION REQUIRED result'),
          };
    // The scratchpad is shared by every phone, so it takes no phone.
    const perPhone = def.name !== 'note';
    const schema = perPhone ? { ...base, ...phoneArg } : base;
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: schema },
      async (args: Record<string, unknown>) => {
        const { phone: chosen, ...a } = args ?? {};
        const phone = perPhone ? pick(chosen) : undefined;
        return onPhone(phone, () => invoke(def, a, phone));
      },
    );
  }

  async function invoke(def: ToolDef, a: Record<string, unknown>, phone: Phone | undefined) {
    const app = typeof a.app === 'string' ? a.app : undefined;
    const traced = phone ? { ...a, phone: phone.name } : a;
    const t0 = performance.now();
    // A shared simulator is leased on every call, so another agent cannot
    // interleave with this one (device-lease.ts).
    const held = phone ? phoneLease(phone) : lease;
    if (held) {
      try {
        acquireDevice(
          held.udid,
          held.identity,
          phone ? `Phone ${phone.name} (simulator ${held.udid})` : `Simulator ${held.udid}`,
        );
      } catch (error) {
        if (!(error instanceof DeviceLeaseError)) throw error;
        return { ...text(tag(phone, `ERROR: ${error.message}`)), isError: true };
      }
    }
    const verdict = evaluate({
      tool: def.name,
      risk: def.risk,
      target: targetOf(def.name, a),
      app,
      confirm: typeof a.confirm === 'string' ? a.confirm : undefined,
    });
    if (verdict.decision !== 'allow') {
      trace({
        tool: def.name,
        args: traced,
        risk: def.risk,
        decision: verdict.decision,
        app,
        ms: 0,
        ok: false,
        detail: verdict.reason,
      });
      return verdict.decision === 'deny'
        ? { ...text(tag(phone, `⛔ BLOCKED: ${verdict.reason}`)), isError: true }
        : text(tag(phone, renderAsk(verdict)));
    }
    try {
      const result = await def.handler(a);
      trace({
        tool: def.name,
        args: traced,
        risk: def.risk,
        decision: 'allow',
        app,
        ms: Math.round(performance.now() - t0),
        ok: !toolFailed(result),
        detail: result.slice(0, 120),
      });
      if (def.imagePath && result.startsWith('/'))
        return imageContent(result, tag(phone, `Screenshot: ${result}`));
      // A text result may attach a vision screenshot (observe's blind-tree
      // fallback) via a trailing `[vision] /path` line.
      const vi = result.lastIndexOf(`\n${VISION_MARKER}`);
      if (vi !== -1) {
        const imgPath = result.slice(vi + 1 + VISION_MARKER.length).trim();
        if (imgPath.startsWith('/')) return imageContent(imgPath, tag(phone, result.slice(0, vi)));
      }
      return { ...text(tag(phone, result)), ...(toolFailed(result) ? { isError: true } : {}) };
    } catch (error) {
      const msg = driver.describeError(error);
      trace({
        tool: def.name,
        args: traced,
        risk: def.risk,
        decision: 'allow',
        app,
        ms: Math.round(performance.now() - t0),
        ok: false,
        detail: msg,
      });
      return { ...text(tag(phone, `ERROR: ${msg}`)), isError: true };
    }
  }

  return server;
}

/** The shared simulator this server drives and who it is (set by startMcp; tests build servers without one). */
let lease: { udid: string; identity: Identity } | null = null;
/** Who this server is when it leases several phones' simulators (computed on first need). */
let leaseIdentity: Identity | null = null;

function phoneLease(phone: Phone): { udid: string; identity: Identity } | null {
  if (!phone.leaseUdid) return null;
  leaseIdentity ??= callerIdentity('mcp');
  return { udid: phone.leaseUdid, identity: leaseIdentity };
}

export async function startMcp(): Promise<void> {
  // Trace artifact: the MCP server has no run outcome of its
  // own, so the session flushes with 'unknown' at shutdown.
  startTraceSessionFromEnv();
  // Several phones (PHONE_USE_DEVICES), or one: explicit device selection
  // (PHONE_USE_DEVICE: udid | launch | connect); unset = the one booted
  // simulator (refuses to guess when several are booted).
  const devices = process.env.PHONE_USE_DEVICES?.trim();
  let phones: Phone[] = [];
  let sel: Awaited<ReturnType<typeof selectDevice>> = null;
  if (devices) {
    if (process.env.PHONE_USE_DEVICE && !isConfigDefault('PHONE_USE_DEVICE'))
      console.error('PHONE_USE_DEVICES is set, so PHONE_USE_DEVICE is ignored.');
    phones = await openPhones(parsePhoneSpecs(devices));
  } else {
    sel = await selectDevice();
    const shared = await sharedSimulator();
    if (shared) lease = { udid: shared, identity: callerIdentity('mcp') };
  }
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return; // signal + stdin-end can both fire on one exit
    cleaningUp = true;
    // Hold the event loop open: after the client hangs up stdio, the await
    // chain below has handle-free gaps and the runtime exits mid-close —
    // observed live as a launched sim left Shutdown but never deleted.
    const hold = setInterval(() => {}, 1000);
    // Delete what WE launched, first and from a detached process: the client
    // kills this server a few seconds after hanging up (reap.ts). Closing a
    // connected device would shut down the user's own simulator, so only
    // launched ones go.
    reapSimulators([
      ...(sel?.owned ? [sel.device.id] : []),
      ...phones.filter((p) => p.owned).map((p) => p.deviceId),
    ]);
    if (lease) releaseDevice(lease.udid, lease.identity);
    for (const phone of phones)
      if (phone.leaseUdid && leaseIdentity) releaseDevice(phone.leaseUdid, leaseIdentity);
    try {
      await currentTraceSession()
        ?.finish('unknown')
        .catch(() => undefined);
    } finally {
      clearInterval(hold);
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void cleanup());
  process.on('SIGTERM', () => void cleanup());
  // Client hung up (stdio closed) — same cleanup: flush the artifact, close
  // owned devices, and EXIT (a hung-up server can serve no one; lingering here
  // is the leaked-driver-process failure mode from the bench post-mortems).
  process.stdin.on('end', () => void cleanup());

  const server = buildMcpServer(phones);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const target = phones.length
    ? ` — phones ${phones.map((p) => `${p.name}=${p.deviceId}`).join(', ')}`
    : sel
      ? ` — device ${sel.device.id}`
      : '';
  console.error(`phone-use MCP server ready (stdio)${target}`);

  if (process.env.PHONE_USE_LIVE !== '0') {
    try {
      startLiveViewer(Number(process.env.PHONE_USE_LIVE_PORT ?? 4936));
    } catch (error) {
      // A second MCP server (another editor, a stale process) must not die
      // over the viewer port — the tools still work without the live view.
      console.error('live viewer unavailable:', error instanceof Error ? error.message : error);
    }
  }
}

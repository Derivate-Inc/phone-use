import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cloudWaitlistMessage } from '@phone-use/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMode } from '../src/permissions.ts';

// The MCP server's one cloud tool, through a real MCP client over an
// in-memory transport, against a stubbed control plane.

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type ToolResult = {
  content: { type: string; text?: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

const saved = {
  token: process.env.PHONE_USE_CLOUD_TOKEN,
  url: process.env.PHONE_USE_CLOUD_URL,
  surface: process.env.PHONE_USE_SURFACE,
};
let calls: Call[] = [];
let respond: (call: Call) => Response | Promise<Response>;

beforeEach(() => {
  calls = [];
  respond = () => Response.json({ recorded: true }, { status: 202 });
  Reflect.deleteProperty(process.env, 'PHONE_USE_CLOUD_TOKEN');
  Reflect.deleteProperty(process.env, 'PHONE_USE_SURFACE');
  process.env.PHONE_USE_CLOUD_URL = 'http://control.test';
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setMode('default');
  for (const [key, value] of [
    ['PHONE_USE_CLOUD_TOKEN', saved.token],
    ['PHONE_USE_CLOUD_URL', saved.url],
    ['PHONE_USE_SURFACE', saved.surface],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

async function connectedClient() {
  delete process.env.ANTHROPIC_API_KEY;
  const { buildMcpServer } = await import('../src/mcp.ts');
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cloud-mcp-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const textOf = (result: ToolResult) => result.content.find((c) => c.type === 'text')?.text ?? '';

describe('MCP create_cloud_phone and the cloud waitlist', () => {
  it('logged out: returns the waitlist message as a structured error and reports one anonymous mcp attempt', async () => {
    const client = await connectedClient();
    const result = (await client.callTool({
      name: 'create_cloud_phone',
      arguments: { platform: 'ios' },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    // The same words `phone-use create` prints, with the step phrased for an MCP client.
    expect(textOf(result)).toBe(cloudWaitlistMessage({ surface: 'mcp', platform: 'ios', signedIn: false }));
    expect(textOf(result)).toContain('Cloud phones are on a waitlist, so no cloud phone was created.');
    expect(textOf(result)).toContain('Tell the user');
    expect(result.structuredContent).toMatchObject({
      ok: false,
      code: 'cloud_waitlist',
      waitlistUrl: 'https://phoneuse.dev/waitlist',
      localCommand: expect.any(String),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://control.test/v1/waitlist/attempts');
    expect(calls[0]?.body).toEqual({ platform: 'ios', client: 'mcp' });
  });

  it('signed in but not approved: the cloud_waitlist answer becomes the same structured error', async () => {
    process.env.PHONE_USE_CLOUD_TOKEN = 'pk_waiting';
    respond = () =>
      Response.json(
        { error: 'waitlist', code: 'cloud_waitlist', waitlistUrl: 'https://example.test/join' },
        { status: 403 },
      );
    const client = await connectedClient();
    const result = (await client.callTool({
      name: 'create_cloud_phone',
      arguments: { platform: 'android' },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('they can join it at https://example.test/join');
    expect(textOf(result)).toContain('PHONE_USE_DEVICE=android phone-use observe');
    expect(textOf(result)).toContain('This MCP server stays bound to its original device');
    expect(result.structuredContent).toMatchObject({
      code: 'cloud_waitlist',
      waitlistUrl: 'https://example.test/join',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://control.test/v1/sandboxes');
    expect(calls[0]?.headers['x-phone-use-client']).toBe('mcp');
    expect(calls[0]?.body).toEqual({ platform: 'android' });
  });

  it('an approved account gets a cloud phone and is told how to drive it', async () => {
    process.env.PHONE_USE_CLOUD_TOKEN = 'pk_approved';
    respond = () =>
      Response.json(
        {
          id: 'sbx_approved',
          platform: 'ios',
          status: 'running',
          createdAt: '2026-11-13T00:00:00.000Z',
          expiresAt: '2026-11-13T01:00:00.000Z',
          idleTimeoutMs: 900_000,
        },
        { status: 202 },
      );
    const client = await connectedClient();
    const result = (await client.callTool({ name: 'create_cloud_phone', arguments: {} })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Cloud phone sbx_approved (ios) is running.');
    expect(textOf(result)).toContain('phone-use env sbx_approved');
    expect(textOf(result)).toContain('phone-use close sbx_approved');
    expect(result.structuredContent).toMatchObject({ id: 'sbx_approved', status: 'running' });
  });

  it('observe mode refuses it without calling the control plane', async () => {
    setMode('observe');
    const client = await connectedClient();
    const result = (await client.callTool({ name: 'create_cloud_phone', arguments: {} })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith('⛔ BLOCKED')).toBe(true);
    expect(calls).toEqual([]);
  });

  it('is not part of the raw ablation surface', async () => {
    process.env.PHONE_USE_SURFACE = 'raw';
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('create_cloud_phone');
  });

  it('listing and calling the device tools makes no request to our servers', async () => {
    const client = await connectedClient();
    await client.listTools();
    await client.callTool({ name: 'note', arguments: { op: 'list' } }).catch(() => undefined);
    expect(calls).toEqual([]);
  });
});

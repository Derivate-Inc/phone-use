import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceContext } from '../src/device-context.ts';
import { setDefaultDeviceContext } from '../src/driver.ts';
import { setMode } from '../src/permissions.ts';
import { REGISTRY } from '../src/registry.ts';

// Middleware-coverage proof for the MCP renderer: the same gate assertions as
// the agent renderer, but through a REAL MCP client over an in-memory
// transport — key-free, device-free.

afterEach(() => {
  setDefaultDeviceContext(null);
  setMode('default');
});

async function connectedClient() {
  delete process.env.ANTHROPIC_API_KEY; // run_phone_task must not register
  const { buildMcpServer } = await import('../src/mcp.ts');
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'gate-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const bind = () => {
  const fake = new FakeBackend({
    screens: [screen([el({ ref: '@e1', type: 'Cell', label: 'General' })], { appName: 'Settings' })],
  });
  setDefaultDeviceContext(new DeviceContext(fake));
  return fake;
};

const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  tap: { label: 'Mcp Gate Row' },
  type: { text: 'mcp gate probe' },
  scroll: { direction: 'down' },
  drag: { x: 100, y: 200, dx: 0, dy: -32 },
  press: { key: 'return' },
  handle_alert: { action: 'get' },
  open: { app: 'Settings' },
  nav: { to: 'home' },
  goto: { app: 'Settings', destination: 'About' },
  search: { app: 'Settings', query: 'gate' },
  toggle: { app: 'Settings', switch: 'Mcp Gate Switch' },
  batch: { actions: [{ do: 'tap', label: 'Mcp Batch Row' }] },
  skill: { op: 'list' },
};

describe('MCP renderer gate coverage', () => {
  it('exposes exactly the registry surface and create_cloud_phone (no key → no run_phone_task)', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    // The registry, plus the one tool that is not a device verb (cloud-mcp.ts).
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...REGISTRY.map((d) => d.name), 'create_cloud_phone'].sort(),
    );
  });

  it('observe mode blocks every non-read tool through a real MCP round-trip', async () => {
    const fake = bind();
    setMode('observe');
    const client = await connectedClient();
    for (const def of REGISTRY.filter((d) => d.risk !== 'read')) {
      const res = (await client.callTool({ name: def.name, arguments: MINIMAL_ARGS[def.name] ?? {} })) as {
        content: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = res.content.find((c) => c.type === 'text')?.text ?? '';
      expect(text.startsWith('⛔ BLOCKED'), `${def.name}: ${text.slice(0, 80)}`).toBe(true);
      expect(res.isError).toBe(true);
    }
    expect(fake.calls.length).toBe(0);
  });

  it('two-phase confirm over MCP: ask → token → executes; forged token → blocked', async () => {
    bind();
    setMode('auto');
    const client = await connectedClient();
    const target = 'Delete Mcp Twophase Row';

    const ask = (await client.callTool({ name: 'tap', arguments: { label: target } })) as {
      content: { type: string; text?: string }[];
    };
    const askText = ask.content.find((c) => c.type === 'text')?.text ?? '';
    expect(askText).toContain('CONFIRMATION REQUIRED');
    const token = askText.match(/confirm: "([a-z0-9]+)"/)?.[1];
    expect(token).toBeDefined();

    const forged = (await client.callTool({
      name: 'tap',
      arguments: { label: target, confirm: 'deadbeef' },
    })) as {
      content: { type: string; text?: string }[];
    };
    expect(forged.content.find((c) => c.type === 'text')?.text ?? '').toContain('⛔ BLOCKED');

    const real = (await client.callTool({ name: 'tap', arguments: { label: target, confirm: token } })) as {
      content: { type: string; text?: string }[];
    };
    const realText = real.content.find((c) => c.type === 'text')?.text ?? '';
    // Gate opened: the FakeBackend screen lacks the row, so the handler runs
    // and reports a resolution failure — NOT a ⛔ block.
    expect(realText.startsWith('⛔')).toBe(false);
  });

  it('read tools flow freely over MCP with a bound FakeBackend context', async () => {
    bind();
    setMode('observe');
    const client = await connectedClient();
    const res = (await client.callTool({ name: 'observe', arguments: {} })) as {
      content: { type: string; text?: string }[];
    };
    expect(res.content.find((c) => c.type === 'text')?.text ?? '').toContain('Settings');
  });
});

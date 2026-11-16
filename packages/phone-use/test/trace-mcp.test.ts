import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceContext } from '../src/device-context.ts';
import { setDefaultDeviceContext } from '../src/driver.ts';
import { setMode } from '../src/permissions.ts';
import { setTraceSession, TraceSession } from '../src/trace-session.ts';

// MCP renderer → trace artifact (docs/20 item 6): permission decisions on the
// MCP surface ride the shared trace spine into the session, so a blocked
// destructive call shows up in the artifact — the audit line a human reviews
// when a failed run's zip lands on their desk.

afterEach(() => {
  setTraceSession(null);
  setDefaultDeviceContext(null);
  setMode('default');
});

async function connectedClient() {
  delete process.env.ANTHROPIC_API_KEY; // run_phone_task must not register
  const { buildMcpServer } = await import('../src/mcp.ts');
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'trace-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type SessionInternals = { lines: string[] };
const parsedLines = (s: TraceSession) => (s as unknown as SessionInternals).lines.map((l) => JSON.parse(l));

describe('MCP gate decisions reach the trace session', () => {
  it('a blocked destructive call in auto mode leaves an ask/deny line in the session', async () => {
    const fake = new FakeBackend({
      screens: [screen([el({ ref: 'e1', type: 'Cell', label: 'General' })], { appName: 'Settings' })],
    });
    setDefaultDeviceContext(new DeviceContext(fake));
    setMode('auto'); // destructive floor still gates in auto
    const session = new TraceSession('on');
    setTraceSession(session);

    const client = await connectedClient();
    const res = (await client.callTool({
      name: 'tap',
      arguments: { label: 'Delete Trace Artifact Row' },
    })) as { content: { type: string; text?: string }[] };
    const text = res.content.find((c) => c.type === 'text')?.text ?? '';
    expect(text).toContain('CONFIRMATION REQUIRED'); // the gate held

    const gateLines = parsedLines(session).filter(
      (l) => l.tool === 'tap' && (l.decision === 'ask' || l.decision === 'deny'),
    );
    expect(gateLines.length).toBeGreaterThanOrEqual(1);
    expect(gateLines[0]).toMatchObject({ tool: 'tap', ok: false });
    expect(gateLines[0].args).toEqual({ label: 'Delete Trace Artifact Row' });
    expect(typeof gateLines[0].ts).toBe('string');
    // The backend never heard the tap — the line records a refusal, not an action.
    expect(fake.calls.filter((c) => c.method === 'press').length).toBe(0);
  });
});

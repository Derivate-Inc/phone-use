import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadSkill } from '../src/skills.ts';

// End-to-end smoke test of the skill recorder through the REAL MCP surface —
// the "learn by watching" feature as an agent actually drives it. Spawns the
// MCP server, connects a client, records a short errand via the tools, and
// asserts the captured steps. (Needs the iOS Simulator; the phone-use runner starts on first use
// running, like the benchmark.)
//
//   bun scripts/smoke-recorder-mcp.ts

const NAME = 'smoke-recorder-mcp';

const transport = new StdioClientTransport({
  command: 'bun',
  args: [new URL('../src/index.ts', import.meta.url).pathname, 'mcp'],
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PHONE_USE_LIVE: '0' },
});
const client = new Client({ name: 'smoke-recorder', version: '1.0.0' });

const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

let ok = false;
try {
  await client.connect(transport);
  await call('skill', { op: 'record', name: NAME });
  await call('open', { app: 'Settings' });
  await call('goto', { app: 'Settings', destination: 'About' });
  await call('skill', { op: 'stop' });

  const skill = await loadSkill(NAME);
  const ops = (skill?.steps ?? []).map((s) => s.op);
  ok = ops.join(',') === 'open_app,goto';
  console.log(`recorded steps: ${JSON.stringify(skill?.steps)}`);
  console.log(
    ok
      ? 'PASS — recorder captured the MCP-driven errand'
      : `FAIL — expected open_app,goto, got ${ops.join(',')}`,
  );
} catch (error) {
  console.log(`FAIL — ${String(error).slice(0, 200)}`);
} finally {
  // The spawned MCP server is a driver process; client.close() only SIGTERMs it
  // and it lingers, conflicting with later runs.
  // Capture the pid first (close() clears it) and force-kill as a backstop.
  const pid = transport.pid;
  try {
    await client.close();
  } catch {
    /* ignore */
  }
  if (typeof pid === 'number') {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await rm(join(homedir(), '.phone-use', 'skills', `${NAME}.json`), { force: true });
}

process.exit(ok ? 0 : 1);

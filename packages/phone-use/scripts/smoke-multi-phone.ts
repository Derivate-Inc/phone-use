import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// One agent, two phones, one MCP server, over the real MCP wire. By default it
// launches two fresh simulators (deleted on exit), so a simulator another
// session is using is never touched. Checks that:
//   - the server tells the agent which phones it has;
//   - calls to the two phones run at the same time;
//   - a tap on phone b changes b's screen and not a's;
//   - the launched simulators are deleted when the client hangs up.
//
//   bun scripts/smoke-multi-phone.ts
//   PHONE_USE_DEVICES=a=<udid>,b=<udid> bun scripts/smoke-multi-phone.ts

const devices = process.env.PHONE_USE_DEVICES ?? 'a=launch,b=launch';
const transport = new StdioClientTransport({
  command: 'bun',
  args: [new URL('../src/index.ts', import.meta.url).pathname, 'mcp'],
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PHONE_USE_LIVE: '0', PHONE_USE_DEVICES: devices } as Record<string, string>,
  stderr: 'pipe',
});
let serverLog = '';
transport.stderr?.on('data', (chunk: Buffer) => {
  serverLog += chunk.toString();
});
const client = new Client({ name: 'smoke-multi-phone', version: '1.0.0' });

type Result = { content: { type: string; text?: string }[]; isError?: boolean };
const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })) as Result;
  return r.content.find((c) => c.type === 'text')?.text ?? '';
};
const timed = async <T>(run: () => Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now();
  const value = await run();
  return [value, Math.round(performance.now() - t0)];
};

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failures.push(what);
};

const pid = () => transport.pid;
let serverPid: number | null = null;
try {
  const [, startMs] = await timed(() => client.connect(transport, { timeout: 600_000 }));
  serverPid = pid();
  console.log(`server up in ${startMs} ms — ${serverLog.match(/phones .*/)?.[0] ?? '(no phone line)'}`);
  const instructions = client.getInstructions() ?? '';
  check(/- a: /.test(instructions) && /- b: /.test(instructions), 'instructions list phones a and b');

  const [[openA, openB], openMs] = await timed(() =>
    Promise.all([
      call('open', { phone: 'a', app: 'Settings' }),
      call('open', { phone: 'b', app: 'Settings' }),
    ]),
  );
  console.log(`opened Settings on both in ${openMs} ms`);
  check(openA.startsWith('[phone a]') && openB.startsWith('[phone b]'), 'each result names its phone');

  const tapped = await call('tap', { phone: 'b', label: 'General' });
  check(!tapped.includes('ERROR'), `tap General on b: ${tapped.split('\n')[0]?.slice(0, 100)}`);

  const [[seeA, seeB], observeMs] = await timed(() =>
    Promise.all([call('observe', { phone: 'a', full: true }), call('observe', { phone: 'b', full: true })]),
  );
  console.log(`observed both in ${observeMs} ms`);
  check(seeB.includes('About'), 'phone b is on General (shows About)');
  check(!seeA.includes('About') && seeA.includes('General'), 'phone a is still on the Settings root');
  if (failures.length) console.log(`--- a ---\n${seeA.slice(0, 700)}\n--- b ---\n${seeB.slice(0, 700)}`);
} catch (error) {
  failures.push(String(error).slice(0, 300));
  console.log(`✗ ${String(error).slice(0, 300)}`);
} finally {
  const launched = [...serverLog.matchAll(/\b[ab]=([0-9A-F-]{36})\b/gi)].map((m) => m[1] as string);
  await client.close().catch(() => undefined);
  // The server deletes what it launched on stdin end; give it time, then force.
  for (let i = 0; i < 60 && serverPid; i++) {
    try {
      process.kill(serverPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } catch {
      serverPid = null;
    }
  }
  if (serverPid) {
    failures.push('server did not exit within 60 s of the client hanging up');
    process.kill(serverPid, 'SIGKILL');
  }
  if (devices === 'a=launch,b=launch') {
    // A detached process deletes them after the server exits (src/reap.ts).
    let left = launched;
    for (let i = 0; i < 60 && left.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const listed = execFileSync('xcrun', ['simctl', 'list', 'devices'], { encoding: 'utf8' });
      left = launched.filter((udid) => listed.includes(udid));
    }
    check(
      launched.length === 2 && left.length === 0,
      `launched simulators deleted on exit (${launched.length} launched, ${left.length} left)`,
    );
  }
}
if (failures.length) console.log(`--- server log (tail) ---\n${serverLog.slice(-1500)}`);
console.log(failures.length ? `FAIL — ${failures.length} problem(s)` : 'PASS — one agent drove two phones');
process.exit(failures.length ? 1 : 0);

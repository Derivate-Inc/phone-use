#!/usr/bin/env bun
/**
 * TOGETHER — a person and an agent drive one cloud iPhone at the same time.
 *
 * Serves a local page with the phone's live H.264 video. Enable controls on it
 * to tap, swipe and paste, while an agent attached to the same phone (Claude
 * Code through the CLI, or any MCP client given the printed env) acts too.
 * Neither side takes a lock: whoever acts next starts from whatever screen the
 * other left, which is the point of the demo.
 *
 *   bun scripts/together.ts                    # new phone, opens Wikipedia
 *   bun scripts/together.ts --id sbx_…         # join a phone that already runs
 *   bun scripts/together.ts --app Settings --ttl 30m
 *
 * The page renders the console's own LiveView, so the video decoder and the
 * input path are the ones behind /phones/<id>, without a signed-in console.
 * It binds to 127.0.0.1 because the page hands the browser the session token.
 */
import { resolve } from 'node:path';
import page from './together/index.html';

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const PORT = Number(arg('--port') ?? 4547);
const APP = arg('--app') ?? 'Wikipedia';
const TTL = arg('--ttl') ?? '60m';
const CLI = resolve(import.meta.dir, '../packages/phone-use/src/index.ts');

async function cli(args: string[], env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) {
    const lines = (err || out).split('\n').map((l) => l.trim()).filter(Boolean);
    throw new Error(lines.find((l) => /Error:|error:/.test(l)) ?? lines[0] ?? 'unknown error');
  }
  return out.trim();
}

let id = arg('--id');
if (!id) {
  // Idle off: a person watching but not touching would otherwise lose the
  // phone to the idle reaper mid-demo.
  const out = await cli(['create', 'ios', '--ttl', TTL, '--idle', 'off']);
  id = out.split('\n')[0]?.trim().split(/\s+/)[0] ?? '';
  if (!id.startsWith('sbx_')) throw new Error(`unexpected create output: ${out.slice(0, 120)}`);
}

// The connection pair is attached a moment after status flips to running, and
// the control plane occasionally answers 502 — retry rather than give up.
const env: Record<string, string> = {};
for (let attempt = 0; attempt < 10 && !env.PHONE_USE_SANDBOX_URL; attempt++) {
  try {
    for (const line of (await cli(['env', id])).split('\n')) {
      const m = line.match(/^export ([A-Z_]+)=(.+)$/);
      if (m?.[1] && m[2]) env[m[1]] = m[2];
    }
  } catch {
    await Bun.sleep(1500);
  }
}
if (!env.PHONE_USE_SANDBOX_URL || !env.PHONE_USE_SANDBOX_TOKEN) throw new Error(`${id} has no connection`);
if (APP) await cli(['open', '--app', APP], env);

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  routes: {
    '/': page,
    '/connection': () =>
      Response.json({ id, endpoint: env.PHONE_USE_SANDBOX_URL, token: env.PHONE_USE_SANDBOX_TOKEN }),
  },
});

console.log(`phone   ${id}${APP ? ` · ${APP} open` : ''}`);
console.log(`you     http://127.0.0.1:${PORT}  (press "Enable controls" to drive)`);
console.log(`agent   eval "$(bun ${CLI} env ${id})" && bun ${CLI} observe`);
console.log(`close   bun ${CLI} close ${id}`);

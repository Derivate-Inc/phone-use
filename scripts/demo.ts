#!/usr/bin/env bun
/**
 * The product demo, rehearsed and timed.
 *
 * Recording runbook, footguns, and measured timings live in the `phone-use-demo`
 * skill. Before filming: run this once so the app map exists, close the phone
 * (demo mode allows one per account), then record — the warm path is ~35s.
 *
 * The point it makes: the agent explores an app once, and every phone after
 * that already knows it. So the run provisions a phone, puts a real build on
 * it, and navigates straight to a named screen — on a phone that has never run
 * the app — because the map lives on this machine rather than on the device.
 *
 *   bun scripts/demo.ts                 # full run, closes the phone at the end
 *   bun scripts/demo.ts --keep          # leave the phone up to keep filming
 *   PHONE_USE_DEMO_APP=<path> bun …     # a different .app bundle
 *
 * Output is captioned ahead of each action so a viewer reads before the screen
 * moves.
 */

import { readdirSync } from 'node:fs';

const APP = process.env.PHONE_USE_DEMO_APP ?? `${process.env.HOME}/Dev/demo-apps/Cinephile.app`;
const APP_NAME = (APP.split('/').pop() ?? 'App.app').replace(/\.app$/, '');
const DESTINATION = process.env.PHONE_USE_DEMO_SCREEN ?? 'Fan Club';
const KEEP = process.argv.includes('--keep');

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const VIOLET = '\x1b[38;5;99m';
const GREEN = '\x1b[38;5;42m';
const OFF = '\x1b[0m';

let phase = 0;
function say(title: string, detail?: string): void {
  phase += 1;
  console.log(`\n${VIOLET}${BOLD}${phase}. ${title}${OFF}`);
  if (detail) console.log(`${DIM}   ${detail}${OFF}`);
}
async function timed<T>(label: string, run: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const value = await run();
  const ms = performance.now() - start;
  console.log(`   ${GREEN}✓${OFF} ${label} ${DIM}${(ms / 1000).toFixed(1)}s${OFF}`);
  return [value, ms];
}

const CLI = 'packages/phone-use/src/index.ts';
/** Sandbox connection for the attached phone. Never logged — it holds a token. */
const attached: Record<string, string> = {};

async function cli(args: string[], attach = true): Promise<string> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    env: { ...process.env, ...(attach ? attached : {}) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) {
    const message = (err.trim() || out.trim()).split('\n').filter((l) => /error|usage|limit/i.test(l))[0];
    throw new Error(`${args[0]} failed: ${message ?? 'unknown error'}`);
  }
  return out.trim();
}

let phoneId = '';

async function main(): Promise<void> {
  console.log(`${BOLD}phone-use${OFF} ${DIM}— giving an agent a real phone${OFF}`);

  // Bun.file().exists() is false for directories, so read it instead. Absent on
  // a machine that has never learned an app.
  const mapped = (() => {
    try {
      return readdirSync(`${process.env.HOME}/.phone-use/maps`).some((f) => f.endsWith('.json'));
    } catch {
      return false;
    }
  })();
  if (!mapped) {
    console.log(
      `${DIM}No learned maps yet — this run will crawl ${APP_NAME} once (~84s). Run it again to see the demo at speed.${OFF}`,
    );
  }

  say('Ask the cloud for an iPhone', 'phone-use create ios');
  const [id, createMs] = await timed('phone running', async () => {
    const out = await cli(['create', 'ios'], false);
    const first = out.split('\n')[0]?.trim().split(/\s+/)[0] ?? '';
    if (!first.startsWith('sbx_')) throw new Error(`unexpected create output: ${out.slice(0, 120)}`);
    return first;
  });
  phoneId = id;
  console.log(`${DIM}   ${phoneId}${OFF}`);

  // Attach this process to the phone. The env carries a live token, so it is
  // read into memory and never written to disk or printed.
  const envOut = await cli(['env', phoneId], false);
  for (const line of envOut.split('\n')) {
    const m = line.match(/^export ([A-Z_]+)=(.+)$/);
    if (m?.[1] && m[2]) attached[m[1]] = m[2];
  }
  if (!attached.PHONE_USE_SANDBOX_URL) {
    // Without this, every later command silently drives the local simulator.
    throw new Error('could not attach to the phone — refusing to fall back to a local device');
  }

  say('Put a real build on it', `phone-use install ${APP_NAME}.app`);
  await timed('app installed', () => cli(['install', APP]));

  say('Hand it to the agent', 'first launch on a phone also builds the test runner');
  const [, openMs] = await timed('app open and driveable', () => cli(['open', APP_NAME]));

  // Learning is the slow part and belongs off camera — it happens once, ever.
  let crawlMs = 0;
  if (!mapped) {
    say(`Explore ${APP_NAME} once`, 'phone-use atlas map — a crawl, not a model');
    [, crawlMs] = await timed('app learned', () => cli(['atlas', 'map', APP_NAME, '--maxScreens', '6']));
  }

  // Only the warm path can claim the phone is naive about the app — on a cold
  // run the crawl above happened on this very phone.
  say(
    `Jump straight to "${DESTINATION}"`,
    mapped
      ? 'this phone has never run this app — the map lives on your machine'
      : 'straight down the path just learned, no exploring',
  );
  const [, gotoMs] = await timed('arrived, zero model calls', () =>
    cli(['goto', APP_NAME, DESTINATION]),
  );

  const toDriveable = (createMs + openMs) / 1000;
  console.log(`\n${BOLD}Setup${OFF}    nothing → driveable phone with your build: ${toDriveable.toFixed(1)}s`);
  if (crawlMs) {
    console.log(
      `${BOLD}Learning${OFF} first time through ${APP_NAME}: ${(crawlMs / 1000).toFixed(1)}s ${DIM}(once, ever)${OFF}`,
    );
  }
  console.log(
    `${BOLD}Payoff${OFF}   any screen on any future phone: ${GREEN}${(gotoMs / 1000).toFixed(1)}s${OFF}`,
  );
  console.log(`${DIM}The map is stored here, not on the phone — so every disposable phone inherits it.${OFF}`);

  if (KEEP) {
    console.log(`\n${DIM}Phone left running: ${phoneId} — close it before recording (limit is 1).${OFF}`);
  } else {
    await cli(['close', phoneId], false);
    console.log(`\n${DIM}Phone closed.${OFF}`);
  }
}

main().catch(async (error) => {
  console.error(`\n\x1b[31mdemo failed:\x1b[0m ${error instanceof Error ? error.message : error}`);
  // A phone left running blocks the next run — the limit is one per account.
  if (phoneId) await cli(['close', phoneId], false).catch(() => undefined);
  process.exit(1);
});

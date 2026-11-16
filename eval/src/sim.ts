// Host-side simulator control and the Gauntlet oracle reader. Everything here is outside the
// tool under test: simctl launches scenarios, posts commands, and reads what the app received.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ev } from './types.ts';

export const BUNDLE = 'com.phoneuse.gauntlet';
export const APP_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'gauntlet',
  'build',
  'Gauntlet.app',
);

export function simctl(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'xcrun',
      ['simctl', ...args],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, out, errOut) => {
        if (err) reject(new Error(`simctl ${args.join(' ')}: ${errOut || err.message}`));
        else resolve(out);
      },
    );
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const containers = new Map<string, string>();

async function container(udid: string, fresh = false): Promise<string> {
  if (fresh || !containers.has(udid))
    containers.set(udid, (await simctl(['get_app_container', udid, BUNDLE, 'data'])).trim());
  return containers.get(udid)!;
}

async function eventsFile(udid: string): Promise<string> {
  return join(await container(udid), 'Documents', 'events.jsonl');
}

export async function install(udid: string): Promise<void> {
  if (!existsSync(APP_PATH))
    throw new Error(`Gauntlet is not built: run eval/gauntlet/build.sh (${APP_PATH})`);
  await simctl(['install', udid, APP_PATH]);
  containers.delete(udid);
}

/** Uninstall and reinstall: the only way to reset App Tracking Transparency on a simulator. */
export async function reinstall(udid: string): Promise<void> {
  await simctl(['uninstall', udid, BUNDLE]).catch(() => undefined);
  await install(udid);
}

export async function terminate(udid: string): Promise<void> {
  await simctl(['terminate', udid, BUNDLE]).catch(() => undefined);
}

/** Fresh process, fresh event log, then the scenario. */
export async function launchScenario(
  udid: string,
  scenario: string,
  seed: number,
  run: string,
): Promise<void> {
  await terminate(udid);
  rmSync(await eventsFile(udid), { force: true });
  await simctl(['launch', udid, BUNDLE, '-scenario', scenario, '-seed', String(seed), '-run', run]);
}

export async function readEvents(udid: string, run: string): Promise<Ev[]> {
  const path = await eventsFile(udid);
  if (!existsSync(path)) return [];
  const out: Ev[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Ev;
      if (e.run === run) out.push(e);
    } catch {
      /* a line being written right now */
    }
  }
  return out;
}

export async function waitForEvent(
  udid: string,
  run: string,
  pred: (e: Ev) => boolean,
  timeoutMs: number,
): Promise<Ev | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const hit = (await readEvents(udid, run)).find(pred);
    if (hit || Date.now() > end) return hit;
    await sleep(100);
  }
}

/** Post a Darwin notification inside the simulator; Gauntlet maps it to a scenario command. */
export async function notify(udid: string, command: 'mutate' | 'present'): Promise<void> {
  await simctl(['spawn', udid, 'notifyutil', '-p', `com.phoneuse.gauntlet.${command}`]);
}

/** Is Gauntlet's process alive (launchd still lists a pid for it)? */
export async function appRunning(udid: string): Promise<boolean> {
  const out = await simctl(['spawn', udid, 'launchctl', 'list']);
  return out.split('\n').some((l) => l.includes(`UIKitApplication:${BUNDLE}`) && /^\d+/.test(l.trim()));
}

export async function bootedSimulators(): Promise<Array<{ udid: string; name: string; runtime: string }>> {
  const json = JSON.parse(await simctl(['list', 'devices', 'booted', '-j'])) as {
    devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
  };
  const out: Array<{ udid: string; name: string; runtime: string }> = [];
  for (const [runtime, ds] of Object.entries(json.devices))
    for (const d of ds) if (d.state === 'Booted') out.push({ udid: d.udid, name: d.name, runtime });
  return out;
}

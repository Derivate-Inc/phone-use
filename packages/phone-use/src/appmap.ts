import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppMap } from './explore.ts';
import { assertSafeName } from './names.ts';

// Maps persist across sessions — crawl an app once, reuse the graph forever.
const MAP_DIR = process.env.PHONE_USE_MAP_DIR ?? join(homedir(), '.phone-use', 'maps');

function mapPath(app: string): string {
  // Bundle ids are dotted (com.apple.Preferences); the guard rejects traversal, not dots.
  return join(MAP_DIR, `${assertSafeName(app, 'map')}.json`);
}

export async function saveMap(map: AppMap): Promise<string> {
  await mkdir(MAP_DIR, { recursive: true });
  const path = mapPath(map.app);
  // Stamp the write time so a map (and any bundle it's exported into) is
  // self-describing — inspect can flag a stale shared map before it's trusted.
  const stamped: AppMap = { ...map, savedAt: new Date().toISOString() };
  await Bun.write(path, JSON.stringify(stamped, null, 2));
  return path;
}

export async function loadMap(app: string): Promise<AppMap | null> {
  const file = Bun.file(mapPath(app));
  if (!(await file.exists())) return null;
  return (await file.json()) as AppMap;
}

// Forget an app's map so the next visit re-learns it from scratch — the reset
// for a map corrupted or left stale by an app update that self-healing can't
// reconcile. Returns whether a map existed.
export async function forgetMap(app: string): Promise<boolean> {
  const file = Bun.file(mapPath(app));
  if (!(await file.exists())) return false;
  await file.delete();
  return true;
}

export async function listMaps(): Promise<string[]> {
  const out: string[] = [];
  try {
    // Bun.file(dir).exists() is false for directories, so just scan and let a
    // missing directory throw (caught below).
    const glob = new Bun.Glob('*.json');
    for await (const f of glob.scan({ cwd: MAP_DIR })) out.push(f.replace(/\.json$/, ''));
  } catch {
    /* maps directory doesn't exist yet */
  }
  return out;
}

export function summarize(map: AppMap): string {
  const T = new Map(map.nodes.map((n) => [n.sig, n.title || 'root']));
  const rows = map.edges
    .filter((e) => e.from !== e.to)
    .map((e) => `  ${T.get(e.from)} → [${e.label}] → ${T.get(e.to)}`);
  // In-place actions (toggles/buttons that don't navigate) carry their effect
  // in `doc` — surface them separately since they have no destination screen.
  const actions = map.edges
    .filter((e) => e.from === e.to && e.doc && e.doc !== 'acts in place')
    .map((e) => `  ${T.get(e.from)}: [${e.label}] ${e.doc}`);
  const stamp = map.savedAt ? `, saved ${map.savedAt.slice(0, 10)}` : '';
  const actionBlock = actions.length ? `\n  — in-place actions —\n${actions.join('\n')}` : '';
  return `${map.app}: ${map.stats.screens} screens, ${map.stats.edges} transitions (mapped in ${Math.round(map.stats.ms / 1000)}s${stamp})\n${rows.join('\n')}${actionBlock}`;
}

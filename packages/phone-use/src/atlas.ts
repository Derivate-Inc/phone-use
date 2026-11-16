import { listMaps, loadMap, saveMap } from './appmap.ts';
import { installedApps } from './apps.ts';
import { type AppMap, diffMaps, mergeMaps } from './explore.ts';
import { listSkills, loadSkill, type Skill, saveSkill } from './skills.ts';

// The shared atlas: maps and skills are portable, mergeable assets, not just a
// local cache. One agent (or phone) explores an app once; the resulting map and
// any recorded skills export to a single bundle that another agent imports —
// inheriting the exploration and navigating instantly, with zero crawl. This is
// the network effect of the cartographer: exploration compounds across agents.

export type AtlasBundle = { version: 1; exportedAt?: string | undefined; maps: AppMap[]; skills: Skill[] };

export type AtlasOverview = {
  apps: {
    app: string;
    bundleId: string;
    screens: number;
    transitions: number;
    savedAt?: string | undefined;
    sample: string[];
  }[];
  skills: { name: string; steps: number; params?: string[] | undefined }[];
};

// "What has this phone learned?" — a single view over the local atlas: every
// mapped app (screen/transition counts, freshness, a sample of screens) and
// every saved skill. Makes the accumulated knowledge inspectable, so an agent
// can see what it already knows before exploring.
export async function atlasOverview(): Promise<AtlasOverview> {
  const installed = await installedApps().catch(() => []);
  const nameOf = new Map(installed.map((a) => [a.bundleId, a.name]));

  const apps: AtlasOverview['apps'] = [];
  for (const bundleId of await listMaps()) {
    const m = await loadMap(bundleId);
    if (!m) continue;
    apps.push({
      // Distinct screens, not raw nodes: dynamic content (clocks, "…and more")
      // drifts a screen's signature between crawls, so the same screen accretes
      // as several nodes — counting nodes overstates what's actually mapped.
      app: nameOf.get(bundleId) ?? bundleId,
      bundleId,
      screens: new Set(m.nodes.map((n) => n.title).filter(Boolean)).size,
      transitions: m.edges.filter((e) => e.from !== e.to).length,
      savedAt: m.savedAt,
      sample: [...new Set(m.nodes.map((n) => n.title).filter(Boolean))].slice(0, 8),
    });
  }
  apps.sort((a, b) => b.screens - a.screens);

  const skills: AtlasOverview['skills'] = [];
  for (const name of await listSkills()) {
    const s = await loadSkill(name);
    if (s) skills.push({ name: s.name, steps: s.steps.length, params: s.params });
  }
  return { apps, skills };
}

export function summarizeOverview(o: AtlasOverview): string {
  const totalScreens = o.apps.reduce((n, a) => n + a.screens, 0);
  const head = `Atlas — ${o.apps.length} app(s), ${totalScreens} screens, ${o.skills.length} skill(s) learned`;
  const appLines = o.apps.length
    ? o.apps.map((a) => {
        const age = a.savedAt ? `, ${a.savedAt.slice(0, 10)}` : '';
        return `  ${a.app} — ${a.screens} screens, ${a.transitions} transitions${age}\n    ${a.sample.join(' · ')}`;
      })
    : ['  (no apps mapped yet)'];
  const skillLines = o.skills.length
    ? o.skills.map(
        (s) => `  ${s.name} — ${s.steps} steps${s.params?.length ? ` (${s.params.join(', ')})` : ''}`,
      )
    : ['  (no skills yet)'];
  return `${head}\n\nApps:\n${appLines.join('\n')}\n\nSkills:\n${skillLines.join('\n')}`;
}

// Collect the local maps (all, or a chosen subset by bundle id) and every saved
// skill into one bundle.
export async function exportAtlas(apps?: string[]): Promise<AtlasBundle> {
  const appList = apps?.length ? apps : await listMaps();
  const maps = (await Promise.all(appList.map(loadMap))).filter((m): m is AppMap => m != null);
  const skillNames = await listSkills();
  const skills = (await Promise.all(skillNames.map(loadSkill))).filter((s): s is Skill => s != null);
  return { version: 1, maps, skills };
}

// A bundle map older than this is flagged as possibly stale (the app may have
// changed since it was crawled).
const STALE_DAYS = 30;

export type AtlasDiff = {
  apps: {
    app: string;
    status: 'new' | 'enriches' | 'redundant';
    addedScreens: string[];
    addedEdges: number;
    ageDays?: number | undefined;
    stale?: boolean | undefined;
  }[];
  skills: { name: string; status: 'new' | 'exists' }[];
};

// Whole days since an ISO timestamp, or undefined if absent/unparseable.
function ageInDays(savedAt?: string): number | undefined {
  if (!savedAt) return undefined;
  const t = Date.parse(savedAt);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

// Preview what importing a bundle would add to the local atlas WITHOUT writing
// anything — so a shared bundle can be inspected before it's trusted. For each
// app: new (no local map), enriches (adds screens/edges to an existing map), or
// redundant (nothing new). Skills are new or already present by name.
export async function inspectAtlas(bundle: AtlasBundle): Promise<AtlasDiff> {
  const apps: AtlasDiff['apps'] = [];
  for (const map of bundle.maps ?? []) {
    const ageDays = ageInDays(map.savedAt);
    const stale = ageDays != null && ageDays >= STALE_DAYS;
    const existing = await loadMap(map.app);
    if (!existing) {
      apps.push({
        app: map.app,
        status: 'new',
        addedScreens: map.nodes.map((n) => n.title),
        addedEdges: map.edges.length,
        ageDays,
        stale,
      });
      continue;
    }
    const d = diffMaps(existing, mergeMaps(existing, map)); // what the merge would add
    apps.push({
      app: map.app,
      status: d.addedScreens.length || d.addedEdges ? 'enriches' : 'redundant',
      addedScreens: d.addedScreens,
      addedEdges: d.addedEdges,
      ageDays,
      stale,
    });
  }
  const local = new Set(await listSkills());
  const skills = (bundle.skills ?? []).map((s) => ({
    name: s.name,
    status: local.has(s.name) ? ('exists' as const) : ('new' as const),
  }));
  return { apps, skills };
}

// Human-readable preview for the CLI / an agent.
export function summarizeDiff(diff: AtlasDiff): string {
  const age = (a: AtlasDiff['apps'][number]) => {
    if (a.ageDays == null) return '';
    const when = a.ageDays === 0 ? 'today' : `${a.ageDays}d ago`;
    return `  · built ${when}${a.stale ? ' ⚠ may be stale' : ''}`;
  };
  const appLines = diff.apps.length
    ? diff.apps.map((a) => {
        if (a.status === 'new')
          return `  + ${a.app} — NEW (${a.addedScreens.length} screens, ${a.addedEdges} edges)${age(a)}`;
        if (a.status === 'redundant') return `  = ${a.app} — already covered${age(a)}`;
        return `  ~ ${a.app} — enriches: +${a.addedScreens.length} screens (${a.addedScreens.slice(0, 5).join(', ')}${a.addedScreens.length > 5 ? '…' : ''}), +${a.addedEdges} edges${age(a)}`;
      })
    : ['  (no maps)'];
  const newSkills = diff.skills.filter((s) => s.status === 'new').map((s) => s.name);
  const dupSkills = diff.skills.filter((s) => s.status === 'exists').map((s) => s.name);
  const skillLine = `  skills: ${newSkills.length} new${newSkills.length ? ` (${newSkills.join(', ')})` : ''}, ${dupSkills.length} already present`;
  return `Atlas bundle would add:\n${appLines.join('\n')}\n${skillLine}`;
}

export type ImportSummary = { maps: number; mergedMaps: number; skills: number };

// Write a bundle into the local atlas. A map that already exists is MERGED
// (union of screens + transitions) so importing enriches rather than clobbers;
// skills are saved by name.
export async function importAtlas(bundle: AtlasBundle): Promise<ImportSummary> {
  if (bundle.version !== 1) throw new Error(`unsupported atlas bundle version: ${bundle.version}`);
  let mergedMaps = 0;
  for (const map of bundle.maps ?? []) {
    const existing = await loadMap(map.app);
    if (existing) mergedMaps++;
    await saveMap(existing ? mergeMaps(existing, map) : map);
  }
  for (const skill of bundle.skills ?? []) await saveSkill(skill);
  return { maps: bundle.maps?.length ?? 0, mergedMaps, skills: bundle.skills?.length ?? 0 };
}

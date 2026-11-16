import * as driver from './driver.ts';
import { publishGraph, resetGraph } from './vizbus.ts';

const vizNodes = (nodes: Iterable<MapNode>): { sig: string; title: string; depth: number }[] =>
  [...nodes].map((n) => ({ sig: n.sig, title: n.title, depth: n.depth }));

// Autonomous App Cartographer: crawl a native app to build a reusable graph of
// screens (nodes, keyed by structural signature) and transitions (edges,
// labeled by the element tapped). Novel for phone use — turns an app into a
// navigable map so future tasks route by shortest path instead of re-exploring.

export type MapNode = { sig: string; title: string; app: string; labels: string[]; depth: number };
// `doc` is a human/agent-readable note on what tapping this label DOES —
// "opens <screen>" for a navigation, or an in-place effect for a toggle/button.
// Pure annotation (per-element docs); never consulted for routing,
// so it can never mislead findPath/goto — it only enriches planning context.
export type MapEdge = { from: string; label: string; to: string; doc?: string | undefined };
export type AppMap = {
  app: string;
  root: string;
  nodes: MapNode[];
  edges: MapEdge[];
  stats: CrawlStats;
  savedAt?: string | undefined;
};
export type CrawlStats = { screens: number; edges: number; actions: number; ms: number; hitBudget: boolean };

export type CrawlOptions = {
  maxScreens?: number | undefined;
  maxDepth?: number | undefined;
  maxActions?: number | undefined;
  maxMs?: number | undefined;
  roles?: string[] | undefined;
  onProgress?: (m: {
    nodes: MapNode[];
    edges: MapEdge[];
    current: string;
    visiting?: string | undefined;
  }) => void;
};

// A nav-stack back button sits top-left; tapping it would corrupt our position.
function isBackButton(e: driver.UiElement): boolean {
  return !!e.rect && e.rect.x < 70 && e.rect.y < 110;
}

const DISMISS = new Set(['Close', 'Cancel', 'Done', 'Not Now', 'Dismiss']);

// Fill in edge.doc (what tapping the label does) after a crawl. Navigation
// edges get their destination's identity; in-place edges keep whatever inline
// effect note the crawl captured, else a generic "acts in place". Derived
// purely from the finished graph — no extra device work, no routing impact.
function annotateEdges(nodes: Map<string, MapNode>, edges: MapEdge[]): void {
  for (const e of edges) {
    if (e.doc) continue; // inline same-screen effect already recorded
    if (e.to !== e.from) {
      const dest = nodes.get(e.to);
      const preview = dest?.labels.slice(0, 4).filter((l) => l && l !== e.label);
      e.doc = dest
        ? `opens "${dest.title}"${preview?.length ? ` (${preview.join(', ')})` : ''}`
        : 'navigates';
    } else {
      e.doc = 'acts in place';
    }
  }
}

// One-line summary of what changed on the same screen after an in-place tap —
// new elements appearing (a revealed section, a picker) or the count shifting.
// Cheap: reads the already-refreshed snapshot cache, no new observation.
function sameScreenEffect(beforeLabels: Set<string>): string | undefined {
  const now = driver.interactiveElements();
  const appeared = now.map((e) => e.label).filter((l) => l && !beforeLabels.has(l));
  const unique = [...new Set(appeared)].slice(0, 4);
  if (unique.length) return `reveals ${unique.join(', ')}`;
  return undefined;
}

// Rows that lead into auth/paywall/system flows are traps for a structural
// crawl (they break go_back). Skip them by label heuristics.
function isTrap(label: string): boolean {
  const l = label.toLowerCase();
  return l.includes('sign in') || l.includes('sign-in') || label.length > 70;
}

export async function crawl(app: string, opts: CrawlOptions = {}): Promise<AppMap> {
  const maxScreens = opts.maxScreens ?? 14;
  const maxDepth = opts.maxDepth ?? 2;
  // iOS reports the same row as Cell or Button across snapshots, so consider
  // all tappable roles and let the "did it navigate?" test (toSig !== sig) keep
  // only real transitions. Switch/StaticText are excluded (toggles/labels).
  const roles = new Set(opts.roles ?? ['Cell', 'Button', 'Link', 'MenuItem', 'Tab']);
  const startedAt = Date.now();
  const budget = { actions: opts.maxActions ?? 160, maxMs: opts.maxMs ?? 180_000 };

  const nodes = new Map<string, MapNode>();
  const edges: MapEdge[] = [];
  const explored = new Set<string>();
  let actions = 0;

  const over = () =>
    nodes.size >= maxScreens || actions >= budget.actions || Date.now() - startedAt > budget.maxMs;

  const progress = (current: string, visiting?: string) => {
    opts.onProgress?.({ nodes: [...nodes.values()], edges: [...edges], current, visiting });
    publishGraph({ app, nodes: vizNodes(nodes.values()), edges: [...edges], current, visiting });
  };

  // A screen's title is the label that was tapped to reach it (iOS nav bars show
  // the *parent* name as the back button, so screenTitle is unreliable). Root
  // is named for the app.
  function addNode(sig: string, depth: number, title: string): void {
    if (nodes.has(sig)) return;
    nodes.set(sig, {
      sig,
      title,
      app,
      labels: driver
        .interactiveElements()
        .filter((e) => roles.has(e.role))
        .map((e) => e.label),
      depth,
    });
  }

  const children = () =>
    driver
      .interactiveElements()
      .filter((e) => roles.has(e.role) && !isBackButton(e) && !isTrap(e.label) && !DISMISS.has(e.label));

  // The accessibility tree only realizes rows near the viewport, so a single
  // snapshot misses everything below (or above) the fold. Scroll the whole
  // screen top-to-bottom, accumulating every child label in order, so the crawl
  // maps complete screens regardless of scroll position.
  // Called once per node, right after arriving (a freshly-pushed screen starts
  // at the top; the root is reset to top by goToRoot). So we can assume at-top
  // and only scroll DOWN if the content overflows the viewport.
  async function collectChildLabels(): Promise<string[]> {
    await driver.observe();
    // Fast path: content ends above the fold → the screen fits, no scrolling.
    if (driver.contentBounds().maxY <= driver.viewportHeight() - 36) {
      return children().map((e) => e.label);
    }
    // Overflowing screen → scroll top-to-bottom accumulating all child labels.
    const seen = new Set<string>();
    const order: string[] = [];
    for (let i = 0; i < 12; i++) {
      for (const e of children()) {
        if (!seen.has(e.label)) {
          seen.add(e.label);
          order.push(e.label);
        }
      }
      const before = driver.screenSignature();
      await driver.scroll('down');
      await driver.observe();
      if (driver.screenSignature() === before) break; // reached the bottom
    }
    await driver.scrollToTop(); // leave at top for the subsequent taps
    return order;
  }

  // Crawler taps must read the *landed* screen, so settle the transition (poll
  // until the signature stops changing) before reading it — unlike the fast
  // interactive path, correctness beats latency here.
  async function settle(): Promise<void> {
    let prev = '';
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(180);
      await driver.observe();
      const sig = driver.screenSignature();
      if (sig === prev) return;
      prev = sig;
    }
  }

  /**
   * Press a ref, reporting failure rather than throwing. Real apps stack
   * overlays, toasts and sheets over their own chrome, and press() refuses a
   * covered element — which used to abort the entire crawl over one unreachable
   * back button.
   */
  async function tap(ref: string): Promise<boolean> {
    try {
      await driver.press(ref);
    } catch {
      return false;
    }
    actions++;
    await settle();
    return true;
  }

  async function back(): Promise<void> {
    await driver.goBack();
    actions++;
    await settle();
  }

  async function walkToRoot(): Promise<void> {
    // Real apps open behind stacked permission prompts (location/notifications/
    // tracking) that aren't back/DISMISS buttons; clear them or the walk — and
    // the whole crawl — stalls on the modal.
    await driver.clearBlockingAlerts('accept');
    for (let i = 0; i < 12; i++) {
      const els = driver.interactiveElements();
      const back = els.find((e) => e.role === 'Button' && isBackButton(e));
      const dismiss = els.find((e) => e.role === 'Button' && DISMISS.has(e.label));
      const target = back ?? dismiss;
      if (!target) break;
      // Unreachable chrome means this is as far back as we get; map from here
      // rather than giving up on the app entirely.
      if (!(await tap(target.ref))) break;
    }
  }

  // Scroll-aware tap by label, then settle — reaches targets below the fold.
  async function tapChild(label: string): Promise<boolean> {
    const ok = await driver.tapLabel(label);
    actions++;
    if (ok) await settle();
    return ok;
  }

  async function pressLabel(label: string): Promise<boolean> {
    return tapChild(label);
  }

  async function restore(path: string[]): Promise<void> {
    await driver.openApp(app);
    await settle();
    await walkToRoot();
    for (const label of path) await pressLabel(label);
  }

  // Apps resume on their last screen; walk the nav stack back to the root so the
  // crawl starts from a stable, reproducible origin.
  await driver.openApp(app);
  await settle();
  await walkToRoot();

  const root = driver.screenSignature();
  const rootTitle = (app.split('.').pop() || 'root').replace(/^./, (c) => c.toUpperCase());
  addNode(root, 0, rootTitle);
  explored.add(root);
  progress(root);

  // Breadth-first: map every screen at depth d before descending to d+1. Under a
  // finite budget this maximizes coverage — all of a screen's siblings get
  // mapped before any deep subtree — so findPath reliably locates any reachable
  // screen (a depth-first crawl would sink into the first branch and starve the
  // rest). Each frontier node is reached by replaying its label-path from root.
  const queue: Array<{ sig: string; path: string[]; depth: number }> = [{ sig: root, path: [], depth: 0 }];

  while (queue.length > 0 && !over()) {
    const node = queue.shift()!;
    if (node.depth >= maxDepth) continue;

    // Position at this node (we could be anywhere after the previous one).
    if (node.path.length > 0) {
      await restore(node.path);
      if (driver.screenSignature() !== node.sig) continue; // couldn't re-reach it
    } else {
      await driver.goToRoot(app);
    }

    const labels = await collectChildLabels();
    for (const label of labels) {
      if (over()) break;
      if (edges.some((x) => x.from === node.sig && x.label === label)) continue;

      progress(node.sig, label);
      const beforeLabels = new Set(driver.interactiveElements().map((e) => e.label));
      if (!(await tapChild(label))) continue;
      const toSig = driver.screenSignature();
      // In-place taps (toggles/buttons that don't navigate) get a functional
      // note from what they revealed; navigation edges are annotated post-crawl.
      const doc = toSig === node.sig ? sameScreenEffect(beforeLabels) : undefined;
      edges.push({ from: node.sig, label, to: toSig, doc });

      if (toSig !== node.sig) {
        addNode(toSig, node.depth + 1, label);
        progress(toSig);
        if (!explored.has(toSig)) {
          explored.add(toSig);
          queue.push({ sig: toSig, path: [...node.path, label], depth: node.depth + 1 });
        }
        // Return to the current node for the next sibling. Some screens (sheets,
        // tabs) have no back control — go_back throws; recover by re-navigating.
        try {
          await back();
        } catch {
          /* no back control on this screen */
        }
        if (driver.screenSignature() !== node.sig) await restore(node.path);
      }
    }
  }

  annotateEdges(nodes, edges);
  return {
    app,
    root,
    nodes: [...nodes.values()],
    edges,
    stats: {
      screens: nodes.size,
      edges: edges.length,
      actions,
      ms: Date.now() - startedAt,
      hitBudget: over(),
    },
  };
}

// Shortest path (BFS over edges) from the root — or any current node — to the
// first screen whose title/labels match a query. This is the payoff: once
// mapped, navigation is a deterministic tap sequence, no LLM per step.
export function findPath(map: AppMap, query: string, from = map.root): string[] | null {
  const q = query.toLowerCase();
  // Match by screen title only (titles are the precise tapped-label names).
  // A row-level match is deliberately NOT used: a screen that merely *lists* a
  // "Keyboard" row is not the Keyboard screen — returning null here lets a
  // self-extending caller crawl deeper to find the real destination.
  let target =
    map.nodes.find((n) => n.title.toLowerCase() === q) ??
    map.nodes.find((n) => n.title.toLowerCase().includes(q));

  // Fuzzy fallback for imprecise phrasing ("general settings" → General,
  // "accessibility options" → Accessibility): substring only matches when the
  // TITLE contains the whole query, so a query longer/reworded than the title
  // misses. Pick the title whose word-tokens are best covered by the query's,
  // above a conservative threshold — so a non-match still returns null and lets
  // the caller crawl.
  if (!target) {
    const qTokens = new Set(q.split(/[^a-z0-9]+/i).filter((t) => t.length > 2));
    if (qTokens.size) {
      let best: MapNode | null = null;
      let bestScore = 0;
      for (const n of map.nodes) {
        const tTokens = n.title
          .toLowerCase()
          .split(/[^a-z0-9]+/i)
          .filter((t) => t.length > 2);
        if (!tTokens.length) continue;
        const shared = tTokens.filter((t) => qTokens.has(t)).length;
        const score = shared / tTokens.length; // fraction of the title's tokens the query covers
        if (score > bestScore) {
          bestScore = score;
          best = n;
        }
      }
      if (best && bestScore >= 0.5) target = best;
    }
  }
  if (!target) return null;

  const adj = new Map<string, MapEdge[]>();
  for (const e of map.edges) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e);

  const queue: Array<{ sig: string; path: string[] }> = [{ sig: from, path: [] }];
  const seen = new Set([from]);
  while (queue.length) {
    const { sig, path } = queue.shift()!;
    if (sig === target.sig) return path;
    for (const e of adj.get(sig) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push({ sig: e.to, path: [...path, e.label] });
    }
  }
  return null;
}

// Directed crawl: depth-first search toward a specific destination, stopping the
// moment it's reached — and recording every screen/edge it traverses into a map
// as it goes. This is the fast path for goto: instead of mapping the whole app
// breadth-first (slow, re-navigates from root to every node), it walks straight
// toward the target with go_back locality and a "is the target right here?"
// check at each screen. Finding a depth-2 setting becomes ~3 taps.
export async function crawlToward(
  app: string,
  target: string,
  opts: { maxDepth?: number; maxScreens?: number; maxMs?: number; stopOnContain?: boolean } = {},
): Promise<{ found: boolean; path: string[]; map: AppMap }> {
  // Field/toggle search stays shallow (settings/values live within ~2 taps of an
  // app root) so it doesn't dive into a wrong branch's deep subtree; navigation
  // toward a named screen can go deeper.
  const maxDepth = opts.maxDepth ?? (opts.stopOnContain ? 2 : 4);
  const maxScreens = opts.maxScreens ?? 40;
  const maxMs = opts.maxMs ?? 150_000;
  const q = target.toLowerCase();
  const roles = new Set(['Cell', 'Button', 'Link', 'MenuItem', 'Tab']);
  const startedAt = Date.now();

  const nodes = new Map<string, MapNode>();
  const edges: MapEdge[] = [];
  const visited = new Set<string>();
  let actions = 0;
  const over = () => nodes.size >= maxScreens || actions > 240 || Date.now() - startedAt > maxMs;

  const viz = (current?: string, visiting?: string) =>
    publishGraph({ app, nodes: vizNodes(nodes.values()), edges: [...edges], current, visiting });

  const addNode = (sig: string, depth: number, title: string, labels: string[] = []) => {
    const cur = nodes.get(sig);
    if (!cur) nodes.set(sig, { sig, title, app, labels, depth });
    else if (labels.length > cur.labels.length) cur.labels = labels;
  };

  const isNav = (e: driver.UiElement) =>
    roles.has(e.role) && !isBackButton(e) && !isTrap(e.label) && !DISMISS.has(e.label);

  // Collect the screen's content: `nav` = rows to descend into (crawlable roles);
  // `all` = every interactive label incl. switches and value rows, so the map
  // records full content and directed search can find a toggle or a value, not
  // just a navigable row. Fits-aware (skips scroll gestures on screens that fit).
  const collect = async (): Promise<{ nav: string[]; all: string[] }> => {
    await driver.observe();
    const navSeen = new Set<string>();
    const allSeen = new Set<string>();
    const nav: string[] = [];
    const all: string[] = [];
    const grab = () => {
      for (const e of driver.interactiveElements()) {
        if (e.label && !allSeen.has(e.label)) {
          allSeen.add(e.label);
          all.push(e.label);
        }
        if (isNav(e) && !navSeen.has(e.label)) {
          navSeen.add(e.label);
          nav.push(e.label);
        }
      }
    };
    if (driver.contentBounds().maxY <= driver.viewportHeight() - 36) {
      grab();
      return { nav, all };
    }
    await driver.scrollToTop();
    await driver.observe();
    for (let i = 0; i < 12; i++) {
      grab();
      const before = driver.screenSignature();
      await driver.scroll('down');
      await driver.observe();
      if (driver.screenSignature() === before) break;
    }
    await driver.scrollToTop();
    return { nav, all };
  };

  const reposition = async (path: string[], sig: string) => {
    try {
      await driver.goBack();
    } catch {
      /* no back control */
    }
    await driver.observe();
    if (driver.screenSignature() !== sig) {
      await driver.goToRoot(app);
      for (const l of path) await driver.tapLabel(l);
    }
  };

  resetGraph(app);
  await driver.goToRoot(app);
  const root = driver.screenSignature();
  addNode(
    root,
    0,
    (app.split('.').pop() || 'root').replace(/^./, (c) => c.toUpperCase()),
  );
  visited.add(root);
  viz(root);

  // Iterative deepening. A plain depth-first search sinks into the first
  // branch (Settings → "Ready for Apple Intelligence" → …) and spends the whole
  // budget there before ever opening "General". Searching one level deep
  // first, then two, finds shallow destinations after a handful of taps, and
  // the per-screen cache below makes the repeated passes cheap: a screen is
  // scrolled through once, and a tap whose result is known is not repeated
  // when that subtree is already exhausted at the current depth.
  const contents = new Map<string, { nav: string[]; all: string[] }>();
  const transitions = new Map<string, string>(); // `${from}\u0000${label}` → to
  const exhausted = new Map<string, number>(); // sig → depth below it fully searched

  async function screenContents(sig: string, depth: number): Promise<{ nav: string[]; all: string[] }> {
    const cached = contents.get(sig);
    if (cached) return cached;
    const fresh = await collect();
    contents.set(sig, fresh);
    addNode(sig, depth, nodes.get(sig)?.title ?? '', fresh.all);
    return fresh;
  }

  async function search(sig: string, path: string[], depth: number, limit: number): Promise<string[] | null> {
    if (over()) return null;
    const { nav: labels, all } = await screenContents(sig, depth);

    // Field/toggle search: stop on the screen that *contains* the target (a value
    // row like "iOS Version, 26.1" or a switch like "Full-Screen Previews").
    if (opts.stopOnContain && all.some((l) => l.toLowerCase().includes(q))) return path;

    // Navigation: reach the destination in one tap from here? Take it, and
    // record what the destination shows on arrival so later `ask` calls can
    // find its values ("iOS Version" on About) without another crawl.
    if (!opts.stopOnContain) {
      for (const label of labels) {
        if (!label.toLowerCase().includes(q)) continue;
        if (!(await driver.tapLabel(label))) continue;
        actions++;
        const toSig = driver.screenSignature();
        edges.push({ from: sig, label, to: toSig });
        const visible = driver
          .interactiveElements()
          .map((e) => e.label)
          .filter(Boolean);
        addNode(toSig, depth + 1, label, [...new Set(visible)]);
        return [...path, label];
      }
    }

    const remaining = limit - depth;
    if (remaining <= 0 || depth >= maxDepth) return null;
    if ((exhausted.get(sig) ?? -1) >= remaining) return null;

    for (const label of labels) {
      if (over()) break;
      const key = `${sig}\u0000${label}`;
      const known = transitions.get(key);
      if (known === sig) continue; // taps in place; nothing below it
      if (known !== undefined && (exhausted.get(known) ?? -1) >= remaining - 1) continue;
      viz(sig, label);
      if (!(await driver.tapLabel(label))) continue;
      actions++;
      const toSig = driver.screenSignature();
      if (known === undefined) {
        transitions.set(key, toSig);
        edges.push({ from: sig, label, to: toSig });
      }
      if (toSig === sig) continue; // no navigation
      addNode(toSig, depth + 1, label);
      viz(toSig);
      if (!path.includes(label) && !visited.has(toSig)) {
        visited.add(toSig);
        const found = await search(toSig, [...path, label], depth + 1, limit);
        if (found) return found; // already standing on the target — don't backtrack
      }
      await reposition(path, sig);
    }
    if (!over()) exhausted.set(sig, Math.max(exhausted.get(sig) ?? -1, remaining));
    return null;
  }

  let path: string[] | null = null;
  for (let limit = 1; limit <= maxDepth && !path && !over(); limit++) {
    visited.clear();
    visited.add(root);
    if (limit > 1) await driver.goToRoot(app);
    path = await search(root, [], 0, limit);
  }
  annotateEdges(nodes, edges);
  const map: AppMap = {
    app,
    root,
    nodes: [...nodes.values()],
    edges,
    stats: {
      screens: nodes.size,
      edges: edges.length,
      actions,
      ms: Date.now() - startedAt,
      hitBudget: over(),
    },
  };
  return { found: path != null, path: path ?? [], map };
}

// Self-extending atlas: navigate to a destination, auto-mapping the app if it
// has no map yet, and crawling *deeper* on demand if the destination isn't in
// the current map. The map grows as it's used — novel for phone use: the agent
// accumulates knowledge of an app instead of re-exploring every task.
export type SmartGotoResult = {
  ok: boolean;
  path?: string[] | undefined;
  mapped: 'cached' | 'built' | 'extended' | 'healed' | 'failed';
  screens: number;
  reason?: string | undefined;
  diff?: MapDiff | undefined;
};

export async function smartGoto(
  app: string,
  destination: string,
  io: {
    loadMap: (app: string) => Promise<AppMap | null>;
    saveMap: (map: AppMap) => Promise<unknown>;
  },
): Promise<SmartGotoResult> {
  const map = await io.loadMap(app);

  // Fast path: the map already knows a route — execute it deterministically.
  if (map) {
    const path = findPath(map, destination);
    if (path) {
      try {
        await navigate(app, path);
        return { ok: true, path, mapped: 'cached', screens: map.nodes.length };
      } catch {
        // The saved path didn't execute — the app UI changed. Self-heal: a fresh
        // directed crawl finds the new route and records the change.
        const healed = await crawlToward(app, destination);
        const merged = mergeMaps(map, healed.map);
        const diff = diffMaps(map, merged);
        await io.saveMap(merged);
        return healed.found
          ? { ok: true, path: healed.path, mapped: 'healed', screens: merged.nodes.length, diff }
          : {
              ok: false,
              mapped: 'healed',
              screens: merged.nodes.length,
              reason: `"${destination}" gone after re-map`,
              diff,
            };
      }
    }
  }

  // Not in the map (or no map yet) → directed crawl toward the target. This both
  // navigates to it and records everything it traverses, so the map grows.
  const explored = await crawlToward(app, destination);
  const merged = map ? mergeMaps(map, explored.map) : explored.map;
  await io.saveMap(merged);
  return explored.found
    ? { ok: true, path: explored.path, mapped: map ? 'extended' : 'built', screens: merged.nodes.length }
    : { ok: false, mapped: 'failed', screens: merged.nodes.length, reason: `"${destination}" not reachable` };
}

// Structural diff between two maps of the same app — the basis for detecting
// when an app update changed the UI and a saved map went stale. Compared by
// human-meaningful screen title so the report reads clearly.
export type MapDiff = {
  addedScreens: string[];
  removedScreens: string[];
  addedEdges: number;
  removedEdges: number;
  changed: boolean;
};

export function diffMaps(oldMap: AppMap, next: AppMap): MapDiff {
  const titles = (m: AppMap) => new Set(m.nodes.map((n) => n.title));
  const oldT = titles(oldMap);
  const nextT = titles(next);
  const addedScreens = [...nextT].filter((t) => !oldT.has(t));
  const removedScreens = [...oldT].filter((t) => !nextT.has(t));

  const edgeKeyByTitle = (m: AppMap) => {
    const T = new Map(m.nodes.map((n) => [n.sig, n.title]));
    return new Set(
      m.edges.filter((e) => e.from !== e.to).map((e) => `${T.get(e.from)}|${e.label}|${T.get(e.to)}`),
    );
  };
  const oldE = edgeKeyByTitle(oldMap);
  const nextE = edgeKeyByTitle(next);
  const addedEdges = [...nextE].filter((k) => !oldE.has(k)).length;
  const removedEdges = [...oldE].filter((k) => !nextE.has(k)).length;

  return {
    addedScreens,
    removedScreens,
    addedEdges,
    removedEdges,
    changed: addedScreens.length + removedScreens.length + addedEdges + removedEdges > 0,
  };
}

// Union two maps of the same app by screen signature (nodes) and by
// from|label|to (edges); keeps the richer title/labels when both have a node.
export function mergeMaps(a: AppMap, b: AppMap): AppMap {
  const nodes = new Map(a.nodes.map((n) => [n.sig, n]));
  for (const n of b.nodes) {
    const cur = nodes.get(n.sig);
    if (!cur || n.labels.length > cur.labels.length) nodes.set(n.sig, n);
  }
  const edgeKey = (e: MapEdge) => `${e.from}|${e.label}|${e.to}`;
  const edges = new Map(a.edges.map((e) => [edgeKey(e), e]));
  for (const e of b.edges) edges.set(edgeKey(e), e);
  const merged: AppMap = {
    app: a.app,
    root: a.root,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    stats: {
      screens: nodes.size,
      edges: edges.size,
      actions: a.stats.actions + b.stats.actions,
      ms: a.stats.ms + b.stats.ms,
      hitBudget: b.stats.hitBudget,
    },
  };
  return merged;
}

// Execute a label path deterministically (no model in the loop).
export async function navigate(app: string, labels: string[]): Promise<void> {
  await driver.goToRoot(app);
  for (const label of labels) {
    if (!(await driver.tapLabel(label)))
      throw new Error(`navigate: "${label}" not reachable on current screen`);
    await Bun.sleep(150); // brief settle for the push transition; tapLabel re-observes as needed
  }
}

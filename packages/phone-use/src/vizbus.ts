// A tiny pub/sub for live crawl progress, so the viewer can draw the app map as
// it's discovered — regardless of which crawl (full or directed) is running.
// Publishing is graph *state* (data), not rendered images; the browser lays it
// out and draws it, the same client-side approach as the cursor overlay.

export type VizNode = { sig: string; title: string; depth: number };
export type VizEdge = { from: string; label: string; to: string };
export type GraphState = {
  app?: string | undefined;
  nodes: VizNode[];
  edges: VizEdge[];
  current?: string | undefined; // sig being explored now
  visiting?: string | undefined; // label being tapped now
};

let latest: GraphState = { nodes: [], edges: [] };
const subs = new Set<(g: GraphState) => void>();

export function onGraph(fn: (g: GraphState) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function getGraph(): GraphState {
  return latest;
}

export function publishGraph(g: GraphState): void {
  latest = g;
  if (subs.size === 0) return;
  for (const fn of subs) {
    try {
      fn(g);
    } catch {
      /* subscriber dropped */
    }
  }
}

export function resetGraph(app?: string): void {
  publishGraph({ app, nodes: [], edges: [] });
}

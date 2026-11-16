import { tally } from './classify.ts';
import type { ProbeResult, Verdict } from './types.ts';

const MARK: Record<Verdict, string> = {
  pass: '✅',
  false_success: '❌ FALSE SUCCESS',
  flagged_failure: '⚠️ flagged',
  refused_wrongly: '❌ refused',
  unsafe_error: '❌ unsafe error',
  false_failure: '⚠️ false failure',
  leak: '❌ leaked secret',
  unsupported: '➖ unsupported',
  hang: '❌ hang',
  crash: '❌ crash',
  invalid: '· invalid',
  setup_failed: '❌ setup failed',
};

export type RunMeta = {
  tool: string;
  toolVersion: string;
  simulator: string;
  startedAt: string;
  finishedAt: string;
  devSeeds: number[];
  heldoutSeeds: number[];
  coldObserveMs?: number | undefined;
  host: string;
  /** The eval's own revision, so a result names the probes and fixtures that produced it. */
  evalRevision: string;
};

function pct(n: number | null): string {
  return n === null ? 'n/a' : `${(n * 100).toFixed(0)}%`;
}

export function renderReport(meta: RunMeta, results: ProbeResult[]): string {
  const lines: string[] = [];
  const dev = results.filter((r) => r.split === 'dev');
  const held = results.filter((r) => r.split === 'heldout');
  const all = tally(results);
  lines.push(`# Device-layer eval · ${meta.tool}`);
  lines.push('');
  lines.push(`- Tool: \`${meta.toolVersion}\``);
  lines.push(`- Simulator: ${meta.simulator}`);
  lines.push(`- Host: ${meta.host}`);
  lines.push(`- Eval: \`${meta.evalRevision}\``);
  lines.push(`- Run: ${meta.startedAt} → ${meta.finishedAt}`);
  lines.push(
    `- Seeds: dev ${meta.devSeeds.join(', ')}; held-out (drawn at run time) ${meta.heldoutSeeds.join(', ') || 'none'}`,
  );
  if (meta.coldObserveMs !== undefined) lines.push(`- First observation (cold): ${meta.coldObserveMs} ms`);
  lines.push('');
  lines.push('| Split | Scored | Pass | False successes | Claimed OK | False-success rate |');
  lines.push('|---|---|---|---|---|---|');
  for (const [name, rs] of [
    ['dev', dev],
    ['held-out', held],
    ['all', results],
  ] as const) {
    const t = tally(rs);
    lines.push(
      `| ${name} | ${t.scored} | ${t.pass} | ${t.falseSuccess} | ${t.claimedOk} | ${pct(t.falseSuccessRate)} |`,
    );
  }
  lines.push('');
  lines.push(
    `Verdicts: ${Object.entries(all.byVerdict)
      .map(([v, n]) => `${v} ${n}`)
      .join(' · ')}`,
  );
  lines.push('');
  lines.push('## Per probe');
  lines.push('');
  const seeds = [...meta.devSeeds, ...meta.heldoutSeeds];
  lines.push(`| Probe | Expect | ${seeds.map((s) => `seed ${s}`).join(' | ')} |`);
  lines.push(`|---|---|${seeds.map(() => '---').join('|')}|`);
  const ids = [...new Set(results.map((r) => r.probe))];
  for (const id of ids) {
    const rs = results.filter((r) => r.probe === id);
    const first = rs[0]!;
    const cells = seeds.map((s) => {
      const r = rs.find((x) => x.seed === s);
      return r ? MARK[r.verdict] : '';
    });
    lines.push(`| **${id}** ${first.title} | ${first.expect} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push('## Everything that did not pass');
  lines.push('');
  for (const r of results.filter((x) => x.verdict !== 'pass')) {
    const why = r.invalid ?? r.setupFailed ?? r.detail;
    lines.push(
      `- **${r.probe}** seed ${r.seed} · ${r.verdict}: ${why}. Tool said (${r.claim?.status ?? 'n/a'}, ${r.claim?.ms ?? 0} ms): ${JSON.stringify((r.claim?.output ?? '').split('\n')[0]?.slice(0, 160) ?? '')}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

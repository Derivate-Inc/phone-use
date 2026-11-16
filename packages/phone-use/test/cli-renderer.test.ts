import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cliVerb, execCliTool, parseCliArgs, toolHelp, verbSummaries } from '../src/cli.ts';
import { setMode } from '../src/permissions.ts';
import { REGISTRY, type ToolDef } from '../src/registry.ts';

// The CLI is the THIRD renderer over the registry (mcp.ts and tools.ts are the
// other two). These tests pin: (1) one-brain — every registry verb is exposed,
// nothing is defined CLI-side; (2) the parser derives flags from the zod
// schemas; (3) the permission gate matches the other renderers — ask refuses
// without --yes, --yes redeems the token in-process, deny is never
// overridable. Gate tests use synthetic defs with stub handlers so no backend
// is ever touched; permission grant fingerprints are process-global, so every
// test uses a DISTINCT destructive target label.

afterEach(() => setMode('default'));

const mkDef = (over: Partial<ToolDef> = {}): ToolDef => ({
  name: 'tap',
  risk: 'mutate',
  description: 'synthetic tap for gate tests',
  schema: { label: z.string().optional(), app: z.string().optional() },
  handler: async (a) => `tapped ${String(a.label)}`,
  ...over,
});

describe('one brain', () => {
  it('every registry tool is a CLI verb; nothing extra exists', () => {
    for (const def of REGISTRY) expect(cliVerb(def.name)).toBe(def);
    expect(cliVerb('mcp')).toBeUndefined();
    expect(cliVerb('task')).toBeUndefined();
    expect(cliVerb(undefined)).toBeUndefined();
  });

  it('verbSummaries covers the registry 1:1, capped for the help column', () => {
    const rows = verbSummaries();
    expect(rows.map(([n]) => n)).toEqual(REGISTRY.map((d) => d.name));
    for (const [, summary] of rows) expect(summary.length).toBeLessThanOrEqual(68);
  });

  it('toolHelp renders schema-derived flags for a real verb', () => {
    const help = toolHelp(cliVerb('search') as ToolDef);
    expect(help).toContain('phone-use search <app> <query>');
    expect(help).toContain('--submit <boolean>');
    expect(help).toContain('--open <boolean>');
    expect(help).toContain('--match <string>');
  });
});

describe('parser', () => {
  const tap = cliVerb('tap') as ToolDef;

  it('positionals fill the natural keys; flags fill the rest, typed off the schema', () => {
    const goto = cliVerb('goto') as ToolDef;
    const p = parseCliArgs(goto, ['Settings', 'About']);
    expect(p).toEqual({
      ok: true,
      args: { app: 'Settings', destination: 'About' },
      yes: false,
      help: false,
      json: false,
    });

    const t = parseCliArgs(tap, ['General', '--role', 'Button', '--long']);
    if (!t.ok) throw new Error(t.error);
    expect(t.args).toEqual({ label: 'General', role: 'Button', long: true });
  });

  it('boolean --key=false, number coercion, JSON flags, enum validation', () => {
    const search = cliVerb('search') as ToolDef;
    const s = parseCliArgs(search, ['Maps', 'coffee', '--submit=false']);
    if (!s.ok) throw new Error(s.error);
    expect(s.args.submit).toBe(false);

    const wait = cliVerb('wait_for') as ToolDef;
    const w = parseCliArgs(wait, ['Done', '--timeoutMs', '8000']);
    if (!w.ok) throw new Error(w.error);
    expect(w.args.timeoutMs).toBe(8000);

    const t = parseCliArgs(tap, ['--at', '{"x":10,"y":20}']);
    if (!t.ok) throw new Error(t.error);
    expect(t.args.at).toEqual({ x: 10, y: 20 });

    const scroll = cliVerb('scroll') as ToolDef;
    const bad = parseCliArgs(scroll, ['sideways']);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('up | down | left | right');
  });

  it('unknown flags and overflow positionals are structured errors, not silent drops', () => {
    const u = parseCliArgs(tap, ['General', '--bogus', 'x']);
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.error).toContain('--bogus');
    const o = parseCliArgs(cliVerb('observe') as ToolDef, ['stray']);
    expect(o.ok).toBe(false);
  });

  it('atlas/skill keep their bare-invocation defaults (overview / list)', () => {
    const a = parseCliArgs(cliVerb('atlas') as ToolDef, []);
    if (!a.ok) throw new Error(a.error);
    expect(a.args.op).toBe('overview');
    const s = parseCliArgs(cliVerb('skill') as ToolDef, []);
    if (!s.ok) throw new Error(s.error);
    expect(s.args.op).toBe('list');
  });
});

describe('permission gate (same brain as the MCP/agent renderers)', () => {
  it('destructive target refuses with code 3 and NO handler call', async () => {
    let ran = false;
    const def = mkDef({
      handler: async () => {
        ran = true;
        return 'ran';
      },
    });
    const out = await execCliTool(def, parseCliArgs(def, ['Delete Cli Test One']));
    expect(out.code).toBe(3);
    expect(out.out).toContain('CONFIRMATION REQUIRED');
    expect(out.out).toContain('--yes');
    expect(ran).toBe(false);
  });

  it('--yes redeems the token in-process: handler runs, code 0', async () => {
    const def = mkDef();
    const out = await execCliTool(def, parseCliArgs(def, ['Delete Cli Test Two', '--yes']));
    expect(out.code).toBe(0);
    expect(out.out).toBe('tapped Delete Cli Test Two');
  });

  it('deny tier is NOT overridable by --yes (observe mode)', async () => {
    setMode('observe');
    let ran = false;
    const def = mkDef({
      handler: async () => {
        ran = true;
        return 'ran';
      },
    });
    const out = await execCliTool(def, parseCliArgs(def, ['Delete Cli Test Three', '--yes']));
    expect(out.code).toBe(2);
    expect(out.out).toContain('⛔ BLOCKED');
    expect(ran).toBe(false);
  });

  it('read verbs run without any confirmation ceremony', async () => {
    const def = mkDef({ name: 'observe', risk: 'read', schema: {}, handler: async () => 'screen' });
    const out = await execCliTool(def, parseCliArgs(def, []));
    expect(out).toEqual({ out: 'screen', code: 0 });
  });

  it('handler failure strings map to exit 1; parse errors carry usage', async () => {
    const def = mkDef({ handler: async () => 'Tap failed: no match' });
    const out = await execCliTool(def, parseCliArgs(def, ['Benign Label']));
    expect(out.code).toBe(1);

    const bad = await execCliTool(def, parseCliArgs(def, ['--bogus']));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('phone-use tap');
  });
});

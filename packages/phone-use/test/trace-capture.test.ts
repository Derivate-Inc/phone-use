import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceContext } from '../src/device-context.ts';
import { setDefaultDeviceContext } from '../src/driver.ts';
import { setMode } from '../src/permissions.ts';
import { REGISTRY } from '../src/registry.ts';
import { setTraceSession, TraceSession } from '../src/trace-session.ts';

// Trace capture at the harness seams (docs/20 item 6): DeviceContext feeds the
// session a tree snapshot (+ frame attempt) on every cache update, and the
// registry observe handler emits verdict lines for expect checks — all over a
// FakeBackend, device-free.

const execFileAsync = promisify(execFile);

const PY_READ = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
print(json.dumps({
    "names": names,
    "contents": {n: z.read(n).decode("utf-8") for n in names if n.endswith((".json", ".jsonl"))},
}))
`;

async function pyReadZip(path: string): Promise<{ names: string[]; contents: Record<string, string> }> {
  const { stdout } = await execFileAsync('python3', ['-c', PY_READ, path]);
  return JSON.parse(stdout);
}

type SessionInternals = { lines: string[]; trees: { n: number; json: string }[] };
const internals = (s: TraceSession) => s as unknown as SessionInternals;

afterEach(() => {
  setTraceSession(null);
  setDefaultDeviceContext(null);
  setMode('default');
  vi.unstubAllEnvs();
});

describe('DeviceContext tree capture', () => {
  it('observe() captures one tree deep-equal to the source nodes', async () => {
    const nodes = [el({ ref: 'e1', type: 'Cell', label: 'General' })];
    const fake = new FakeBackend({ screens: [screen(nodes, { appName: 'Settings' })] });
    const ctx = new DeviceContext(fake);
    const session = new TraceSession('on');
    setTraceSession(session);

    await ctx.observe();

    const trees = internals(session).trees;
    expect(trees).toHaveLength(1);
    const snap = JSON.parse(trees[0]!.json);
    expect(snap.viewport).toEqual({ width: 390, height: 844 });
    expect(snap.nodes).toEqual(screen(nodes).nodes); // root + cell, structurally identical
    // The index line rode along.
    const kinds = internals(session).lines.map((l) => JSON.parse(l).kind);
    expect(kinds).toContain('tree');
  });

  it('mutating the live tree after capture does not change the recorded snapshot', async () => {
    const cell = el({ ref: 'e1', type: 'Cell', label: 'General' });
    const fake = new FakeBackend({ screens: [screen([cell], { appName: 'Settings' })] });
    const ctx = new DeviceContext(fake);
    const session = new TraceSession('on');
    setTraceSession(session);

    await ctx.observe();
    cell.label = 'MUTATED AFTER CAPTURE'; // same object instance the cache holds

    const snap = JSON.parse(internals(session).trees[0]!.json);
    const labels = (snap.nodes as { label?: string }[]).map((n) => n.label);
    expect(labels).toContain('General');
    expect(labels).not.toContain('MUTATED AFTER CAPTURE');
  });

  it('frame getter resolving null (no simctl on this host): counts.frames 0, no throw', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'phone-use-cap-')), 'no-frames.zip');
    vi.stubEnv('PHONE_USE_TRACE_OUT', out);
    const fake = new FakeBackend({ screens: [screen([el({ ref: 'e1', label: 'General' })])] });
    const ctx = new DeviceContext(fake);
    const session = new TraceSession('on');
    setTraceSession(session);

    await ctx.observe(); // captureFrame fires; captureFastJpeg rejects here → null

    const path = await session.finish('failed'); // awaits the pending frame
    const z = await pyReadZip(path!);
    const manifest = JSON.parse(z.contents['manifest.json']!);
    expect(manifest.counts.frames).toBe(0);
    expect(manifest.counts.trees).toBe(1);
    expect(z.names.some((n) => n.startsWith('frames/'))).toBe(false);
  });
});

describe('verdict lines from the registry observe handler', () => {
  it('observe with expect over a bound FakeBackend emits an observe-expect verdict', async () => {
    const fake = new FakeBackend({
      screens: [screen([el({ ref: 'e1', type: 'Cell', label: 'General' })], { appName: 'Settings' })],
    });
    setDefaultDeviceContext(new DeviceContext(fake));
    const session = new TraceSession('on');
    setTraceSession(session);

    const observe = REGISTRY.find((d) => d.name === 'observe')!;
    const okResult = await observe.handler({ expect: 'General' });
    expect(okResult).toContain('✓');
    const missResult = await observe.handler({ expect: 'Nonexistent Row' });
    expect(missResult).toContain('✗');

    const verdicts = internals(session)
      .lines.map((l) => JSON.parse(l))
      .filter((l) => l.kind === 'verdict');
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toMatchObject({
      source: 'observe-expect',
      expect: 'General',
      ok: true,
      detail: 'screen contains "General"',
    });
    expect(verdicts[1]).toMatchObject({ source: 'observe-expect', expect: 'Nonexistent Row', ok: false });
    expect(typeof verdicts[0].ts).toBe('string');
  });
});

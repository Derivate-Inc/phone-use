import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setTraceSession,
  startTraceSessionFromEnv,
  TraceSession,
  traceActive,
} from '../src/trace-session.ts';

// TraceSession behavior contract (docs/20 item 6): policy discard vs flush,
// exact JSONL preservation, ring-buffer drops with original indices, the
// frame-skip guard, and idempotent finish.

const execFileAsync = promisify(execFile);

const PY_READ = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
print(json.dumps({
    "bad": z.testzip(),
    "names": names,
    "contents": {n: z.read(n).decode("utf-8") for n in names if n.endswith((".json", ".jsonl"))},
}))
`;

async function pyReadZip(
  path: string,
): Promise<{ bad: string | null; names: string[]; contents: Record<string, string> }> {
  const { stdout } = await execFileAsync('python3', ['-c', PY_READ, path]);
  return JSON.parse(stdout);
}

const tmp = () => mkdtempSync(join(tmpdir(), 'phone-use-trace-'));
const manifestOf = (z: { contents: Record<string, string> }) =>
  JSON.parse(z.contents['manifest.json'] ?? '{}');

afterEach(() => {
  setTraceSession(null);
  vi.unstubAllEnvs();
});

describe('module slot / env policy', () => {
  it("'off' (or unset) starts nothing — traceActive stays false", () => {
    vi.stubEnv('PHONE_USE_TRACE_MODE', 'off');
    expect(startTraceSessionFromEnv()).toBeNull();
    expect(traceActive()).toBe(false);

    vi.stubEnv('PHONE_USE_TRACE_MODE', '');
    expect(startTraceSessionFromEnv()).toBeNull();
    expect(traceActive()).toBe(false);
  });

  it("'on' and 'on-failure' construct and install the session", () => {
    vi.stubEnv('PHONE_USE_TRACE_MODE', 'on-failure');
    const s = startTraceSessionFromEnv();
    expect(s).toBeInstanceOf(TraceSession);
    expect(traceActive()).toBe(true);
    expect(s?.policy).toBe('on-failure');
  });
});

describe('finish policy', () => {
  it("'on-failure' + passed discards: null result, no file on disk", async () => {
    const out = join(tmp(), 'discarded.zip');
    vi.stubEnv('PHONE_USE_TRACE_OUT', out);
    const s = new TraceSession('on-failure');
    s.add({ ts: 'T1', tool: 'tap', decision: 'allow', ok: true });
    expect(await s.finish('passed')).toBeNull();
    expect(existsSync(out)).toBe(false);
    // Idempotent: the discard sticks even if a later caller says 'failed'.
    expect(await s.finish('failed')).toBeNull();
    expect(existsSync(out)).toBe(false);
  });

  it("'on-failure' + failed flushes exact trace.jsonl lines in order (deny included) with exact manifest counts", async () => {
    const out = join(tmp(), 'failed.zip');
    vi.stubEnv('PHONE_USE_TRACE_OUT', out);
    const s = new TraceSession('on-failure');
    const lines = [
      { ts: 'T1', tool: 'observe', args: {}, risk: 'read', decision: 'allow', ms: 5, ok: true },
      {
        ts: 'T2',
        tool: 'tap',
        args: { label: 'Delete All Data' },
        risk: 'destructive',
        decision: 'deny',
        ms: 0,
        ok: false,
        detail: 'destructive floor',
      },
      { ts: 'T3', tool: 'type', args: { text: 'x' }, risk: 'type', decision: 'ask', ms: 0, ok: false },
    ];
    for (const l of lines) s.add(l);

    const path = await s.finish('failed');
    expect(path).toBe(out);

    const z = await pyReadZip(out);
    expect(z.bad).toBeNull();
    expect(z.names).toEqual(['manifest.json', 'trace.jsonl']);
    expect(z.contents['trace.jsonl']).toBe(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

    const manifest = manifestOf(z);
    expect(manifest.formatVersion).toBe(0);
    expect(manifest.generator.name).toBe('phone-use');
    expect(typeof manifest.generator.version).toBe('string');
    expect(manifest.sessionId).toBe(s.sessionId);
    expect(manifest.policy).toBe('on-failure');
    expect(manifest.outcome).toBe('failed');
    expect(manifest.device).toEqual({ platform: 'unknown', id: 'unknown' });
    expect(manifest.counts).toEqual({ lines: 3, trees: 0, frames: 0 });
    expect(manifest.dropped).toEqual({ lines: 0, trees: 0, frames: 0, frameSkips: 0 });
  });

  it('finish is idempotent — the second call returns the first result without rewriting', async () => {
    const out = join(tmp(), 'idempotent.zip');
    vi.stubEnv('PHONE_USE_TRACE_OUT', out);
    const s = new TraceSession('on');
    s.add({ ts: 'T1', tool: 'observe', ok: true });
    const first = await s.finish('failed');
    expect(first).toBe(out);
    // A different outcome on the second call must NOT produce a new artifact.
    const second = await s.finish('passed');
    expect(second).toBe(first);
    const z = await pyReadZip(out);
    expect(manifestOf(z).outcome).toBe('failed');
    // Post-finish adds are dropped, not buffered forever.
    s.add({ ts: 'T2', tool: 'tap', ok: true });
    expect(z.contents['trace.jsonl']).toBe('{"ts":"T1","tool":"observe","ok":true}\n');
  });
});

describe('ring buffers', () => {
  it('tree ring: 250 captures keep the LAST 200 under their original indices, dropped.trees 50', async () => {
    const out = join(tmp(), 'trees.zip');
    vi.stubEnv('PHONE_USE_TRACE_OUT', out);
    const s = new TraceSession('on');
    for (let i = 0; i < 250; i++) {
      s.captureTree({ viewport: { width: 390, height: 844 }, nodes: [{ i }] });
    }
    const path = await s.finish('unknown');
    expect(path).toBe(out);

    const z = await pyReadZip(out);
    const treeNames = z.names.filter((n) => n.startsWith('trees/'));
    expect(treeNames.length).toBe(200);
    expect(treeNames[0]).toBe('trees/000050.json'); // original capture index survives the drop
    expect(treeNames[199]).toBe('trees/000249.json');
    expect(JSON.parse(z.contents['trees/000050.json'] ?? '').nodes).toEqual([{ i: 50 }]);

    const manifest = manifestOf(z);
    expect(manifest.counts.trees).toBe(200);
    expect(manifest.dropped.trees).toBe(50);
    // Every capture also indexed a {kind:'tree'} line.
    expect(manifest.counts.lines).toBe(250);
  });

  it('frame-skip guard: a capture arriving while one is pending is counted, not queued', async () => {
    const out = join(tmp(), 'frames.zip');
    vi.stubEnv('PHONE_USE_TRACE_OUT', out);
    const s = new TraceSession('on');

    let release!: (b: Buffer | null) => void;
    const pending = new Promise<Buffer | null>((resolve) => {
      release = resolve;
    });
    s.captureFrame(() => pending);
    s.captureFrame(() => Promise.resolve(Buffer.from('never taken'))); // skipped: one already in flight
    release(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const path = await s.finish('failed'); // finish awaits the pending frame
    const z = await pyReadZip(path!);
    expect(z.names).toContain('frames/000000.jpeg');
    const manifest = manifestOf(z);
    expect(manifest.counts.frames).toBe(1);
    expect(manifest.dropped.frameSkips).toBe(1);
    expect(manifest.dropped.frames).toBe(0);
  });

  it('a frame getter resolving null records nothing and never throws', async () => {
    const out = join(tmp(), 'null-frame.zip');
    vi.stubEnv('PHONE_USE_TRACE_OUT', out);
    const s = new TraceSession('on');
    s.captureFrame(() => Promise.resolve(null));
    s.captureFrame(() => Promise.reject(new Error('no xcrun on this host')));
    const path = await s.finish('unknown');
    const manifest = manifestOf(await pyReadZip(path!));
    expect(manifest.counts.frames).toBe(0);
  });

  it('line buffer caps at 10_000 dropping oldest and counting', async () => {
    const out = join(tmp(), 'lines.zip');
    vi.stubEnv('PHONE_USE_TRACE_OUT', out);
    const s = new TraceSession('on');
    for (let i = 0; i < 10_050; i++) s.add({ ts: `T${i}`, i });
    const z = await pyReadZip((await s.finish('failed'))!);
    const manifest = manifestOf(z);
    expect(manifest.counts.lines).toBe(10_000);
    expect(manifest.dropped.lines).toBe(50);
    expect(z.contents['trace.jsonl']?.startsWith('{"ts":"T50","i":50}\n')).toBe(true);
  });
});

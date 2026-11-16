import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// trace() forwarding (docs/20 item 6): the legacy PHONE_USE_TRACE file keeps
// its byte format, and the artifact session receives the same lines — even
// when the legacy env is unset. trace.ts caches its file target at first call,
// so every case resets modules and imports fresh, dynamically, from the same
// registry (trace.ts and trace-session.ts must share one module slot).

const tmp = () => mkdtempSync(join(tmpdir(), 'phone-use-fwd-'));

type SessionInternals = { lines: string[] };
const linesOf = (s: object): string[] => (s as unknown as SessionInternals).lines;

const LINE = {
  tool: 'tap',
  args: { label: 'General' },
  risk: 'tap',
  decision: 'allow' as const,
  ms: 12,
  ok: true,
};

async function freshModules() {
  vi.resetModules();
  const traceMod = await import('../src/trace.ts');
  const sessionMod = await import('../src/trace-session.ts');
  return { traceMod, sessionMod };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('trace() forwarding', () => {
  it('legacy PHONE_USE_TRACE file alone: byte-identical line format, no session involved', async () => {
    const file = join(tmp(), 'legacy.jsonl');
    vi.stubEnv('PHONE_USE_TRACE', file);
    const { traceMod, sessionMod } = await freshModules();
    expect(sessionMod.traceActive()).toBe(false);

    traceMod.trace(LINE);

    const rows = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0]!);
    // Byte-identical to the pre-item-6 writer: ts first, then the line's own
    // keys in insertion order — reserialize with the observed ts to prove it.
    expect(rows[0]).toBe(JSON.stringify({ ts: parsed.ts, ...LINE }));
  });

  it('legacy + session: both receive the same line (identical bytes, same ts)', async () => {
    const file = join(tmp(), 'both.jsonl');
    vi.stubEnv('PHONE_USE_TRACE', file);
    const { traceMod, sessionMod } = await freshModules();
    const session = new sessionMod.TraceSession('on');
    sessionMod.setTraceSession(session);
    try {
      traceMod.trace(LINE);

      const fileRow = readFileSync(file, 'utf8').trimEnd();
      const sessionRows = linesOf(session);
      expect(sessionRows).toHaveLength(1);
      expect(sessionRows[0]).toBe(fileRow);
    } finally {
      sessionMod.setTraceSession(null);
    }
  });

  it('legacy unset: no file is written but the session still gets the line', async () => {
    const file = join(tmp(), 'never.jsonl');
    vi.stubEnv('PHONE_USE_TRACE', ''); // falsy → legacy tracing disabled
    const { traceMod, sessionMod } = await freshModules();
    const session = new sessionMod.TraceSession('on-failure');
    sessionMod.setTraceSession(session);
    try {
      traceMod.trace({ ...LINE, tool: 'observe' });

      expect(existsSync(file)).toBe(false);
      const rows = linesOf(session);
      expect(rows).toHaveLength(1);
      const parsed = JSON.parse(rows[0]!);
      expect(parsed.tool).toBe('observe');
      expect(parsed.decision).toBe('allow');
      expect(typeof parsed.ts).toBe('string');
    } finally {
      sessionMod.setTraceSession(null);
    }
  });
});

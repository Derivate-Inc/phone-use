import { afterEach, describe, expect, it } from 'vitest';
import type { TurnOutcome, TurnRequest, TurnRunner } from '../src/harness.ts';
import { setMode } from '../src/permissions.ts';
import { createSession, type SessionEvent } from '../src/sdk.ts';

// The harness seam's guarantee, proven end to end WITHOUT an API key: any
// TurnRunner can drive the real tool surface, and the permission floor gates
// every call inside the tools — no runner can reach a handler around it.
// Grant fingerprints are process-global with no reset (deliberate), so every
// destructive assertion uses a DISTINCT target label.

afterEach(() => setMode('default'));

const scripted = (run: (req: TurnRequest) => Promise<TurnOutcome>): TurnRunner => ({
  id: 'scripted',
  capabilities: new Set(),
  reset() {},
  runTurn: run,
});

const tool = (req: TurnRequest, name: string) => {
  const t = req.tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t;
};

describe('createSession with a custom TurnRunner', () => {
  it('drives real registry tools and streams events, no API key involved', async () => {
    const events: SessionEvent[] = [];
    const session = createSession({
      runner: scripted(async (req) => {
        req.onAssistantText?.('planning…');
        const saved = await tool(req, 'note').run({ op: 'save', key: 'seam', content: 'hello' });
        const read = await tool(req, 'note').run({ op: 'read', key: 'seam' });
        return { status: 'completed', summary: `${saved} / ${read}` };
      }),
      onEvent: (e) => events.push(e),
    });

    const result = await session.prompt('exercise the seam');
    expect(result.status).toBe('unverified');
    expect(result.summary).toContain('hello');
    expect(session.steps.map((s) => [s.tool, s.decision])).toEqual([
      ['note', 'allow'],
      ['note', 'allow'],
    ]);
    expect(events.some((e) => e.type === 'assistant' && e.text === 'planning…')).toBe(true);
    expect(events.filter((e) => e.type === 'tool')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'unverified' });
  });

  it('the permission floor holds for ANY runner: deny-by-default blocks a destructive tap', async () => {
    const session = createSession({
      runner: scripted(async (req) => {
        const out = await tool(req, 'tap').run({ label: 'Delete Seam Probe One' });
        return { status: 'completed', summary: out };
      }),
    });
    const result = await session.prompt('try something destructive');
    // No onConfirm → the ask tier auto-declines BEFORE the handler (no daemon
    // running, so an ERROR would mean the gate leaked through to the driver).
    expect(result.summary).toContain('⛔ BLOCKED');
    expect(session.steps[0]?.decision).toBe('deny');
  });

  it('an onConfirm decline surfaces as a deny, not an execution', async () => {
    let asked = 0;
    const session = createSession({
      onConfirm: () => {
        asked += 1;
        return false;
      },
      runner: scripted(async (req) => ({
        status: 'completed',
        summary: await tool(req, 'tap').run({ label: 'Delete Seam Probe Two' }),
      })),
    });
    const result = await session.prompt('destructive again');
    expect(asked).toBe(1);
    expect(result.summary).toContain('user declined');
  });

  it('a stopped outcome propagates; a throwing runner maps to failed', async () => {
    const stopped = createSession({
      runner: scripted(async () => ({ status: 'stopped', summary: 'Stopped by caller.' })),
    });
    expect((await stopped.prompt('x')).status).toBe('stopped');

    const throwing = createSession({
      runner: scripted(async () => {
        throw new Error('runner exploded');
      }),
    });
    const failed = await throwing.prompt('x');
    expect(failed.status).toBe('failed');
    expect(failed.summary).toContain('runner exploded');
  });

  it('a session survives multiple prompts on the same runner', async () => {
    const goals: string[] = [];
    const session = createSession({
      runner: scripted(async (req) => {
        goals.push(req.goal);
        return { status: 'completed', summary: `turn ${goals.length}` };
      }),
    });
    expect((await session.prompt('first')).summary).toBe('turn 1');
    expect((await session.prompt('second')).summary).toBe('turn 2');
    expect(goals).toEqual(['first', 'second']);
  });
});

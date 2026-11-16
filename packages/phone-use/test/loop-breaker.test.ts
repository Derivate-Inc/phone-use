import { describe, expect, it } from 'vitest';
import { buildTools, isLoopingAction, type StepLog } from '../src/tools.ts';

// The two-strike rule is written in the system prompt, but a model that has
// convinced itself an action *should* work will keep retrying it — one campaign
// task burned 51 turns in a single loop. A prompt cannot enforce itself; the
// runner has to. These tests pin that enforcement, including the cases where
// repetition is legitimate and must NOT be blocked.

const toolNamed = (log: StepLog[], name: string) => {
  const found = buildTools(log).find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} missing from registry`);
  return found;
};

/** A prior attempt of the same action, as the runner would have logged it. */
const priorStep = (tool: string, input: Record<string, unknown>): StepLog => ({
  tool,
  input,
  result: 'screen did NOT change',
  ms: 5,
  at: new Date().toISOString(),
});

describe('runner-side loop breaker', () => {
  it('blocks a third identical action instead of executing it again', async () => {
    const log: StepLog[] = [priorStep('tap', { label: 'Submit' }), priorStep('tap', { label: 'Submit' })];
    const result = await toolNamed(log, 'tap').run({ label: 'Submit' });

    expect(result).toContain('BLOCKED');
    // The refusal must tell the model what to do instead, not just say no.
    expect(result).toMatch(/different element|scroll|handle_alert|search|deep link/);
    // It is recorded as a denial so traces show the loop was cut, not that the
    // device was driven a third time.
    expect(log.at(-1)?.decision).toBe('deny');
  });

  it('lets a different argument through — only the identical action is a loop', async () => {
    const log: StepLog[] = [priorStep('tap', { label: 'Submit' }), priorStep('tap', { label: 'Submit' })];
    const result = await toolNamed(log, 'tap').run({ label: 'Cancel' });

    expect(result).not.toContain('BLOCKED');
  });

  it('never blocks verbs whose repetition is normal', () => {
    // Scrolling a long list or re-observing after a change is not a loop.
    // Asserted on the rule itself: running these would drive a real device.
    for (const verb of ['observe', 'screenshot', 'wait_for', 'scroll', 'nav', 'note']) {
      const log: StepLog[] = [priorStep(verb, {}), priorStep(verb, {}), priorStep(verb, {})];
      expect(isLoopingAction(log, verb, {})).toBe(false);
    }
  });

  it('forgets old attempts — a repeat after other work is a retry, not a loop', async () => {
    const log: StepLog[] = [
      priorStep('tap', { label: 'Submit' }),
      priorStep('tap', { label: 'Submit' }),
      priorStep('scroll', { direction: 'down' }),
      priorStep('observe', {}),
      priorStep('tap', { label: 'Field' }),
      priorStep('type', { text: 'hello' }),
      priorStep('observe', {}),
    ];
    const result = await toolNamed(log, 'tap').run({ label: 'Submit' });

    expect(result).not.toContain('BLOCKED');
  });

  it('ignores the confirmation token when deciding identity', async () => {
    // A retry carrying a fresh confirm token is still the same action.
    const log: StepLog[] = [priorStep('tap', { label: 'Delete' }), priorStep('tap', { label: 'Delete' })];
    const result = await toolNamed(log, 'tap').run({ label: 'Delete', confirm: 'token-abc' });

    expect(result).toContain('BLOCKED');
  });
});

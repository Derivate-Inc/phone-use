import { describe, expect, it } from 'vitest';
import { CloudSandboxBackend } from '../src/backends/cloud-sandbox.ts';
import { UnsupportedCapabilityError } from '../src/errors.ts';

// Cloud workers that predate the wider key set press Return whatever key they
// are sent. Until they are redeployed, a cloud phone must refuse the other
// keys instead of silently pressing the wrong one.
describe('cloud phone key presses', () => {
  const calls: string[] = [];
  const backend = new CloudSandboxBackend({
    endpoint: 'https://worker.invalid',
    token: 't',
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      calls.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ ok: true, result: null }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch,
  });

  it('refuses a key other than Return without calling the worker', async () => {
    for (const key of ['tab', 'backspace', 'space', 'escape'] as const) {
      await expect(backend.pressKey(key)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    }
    expect(calls).toEqual([]);
  });

  it('still sends Return', async () => {
    await backend.pressKey('return');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('pressKey');
  });
});

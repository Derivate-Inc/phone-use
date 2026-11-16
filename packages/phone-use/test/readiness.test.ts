import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { expect, it } from 'vitest';
import { waitForAppReady } from '../src/readiness.ts';

const ready = () => screen([el({ ref: '@e1', label: 'Ready' })], { appBundleId: 'app.test' });

it('waits through foreground transitions and empty trees without reopening the app', async () => {
  const backend = new FakeBackend({ screens: [ready()] });
  const snapshots = [
    screen([], { appBundleId: 'other' }),
    { ...screen([], { appBundleId: 'app.test' }), nodes: [] },
    ready(),
  ];
  let reads = 0;
  backend.snapshot = async () => snapshots[reads++]!;
  await waitForAppReady(backend, 'app.test', { pollMs: 1 });
  expect(reads).toBe(3);
  expect(backend.calls).toEqual([]);
});

it('allows a slow cold snapshot to finish without starting overlapping probes', async () => {
  const backend = new FakeBackend({ screens: [ready()] });
  let reads = 0;
  backend.snapshot = async () => {
    reads++;
    await new Promise((r) => setTimeout(r, 25));
    return ready();
  };
  await waitForAppReady(backend, 'app.test', { timeoutMs: 100, pollMs: 1 });
  expect(reads).toBe(1);
});

it('bounds an unresponsive runner and reports the readiness phase', async () => {
  const backend = new FakeBackend({ screens: [ready()] });
  let reads = 0;
  backend.snapshot = () => {
    reads++;
    return new Promise(() => {});
  };
  await expect(waitForAppReady(backend, 'app.test', { timeoutMs: 10 })).rejects.toThrow(
    'App readiness failed',
  );
  expect(reads).toBe(1);
});

it('preserves permanent errors and does not probe after cancellation', async () => {
  const backend = new FakeBackend({ screens: [ready()] });
  let reads = 0;
  backend.snapshot = async () => {
    reads++;
    throw new Error('unauthorized');
  };
  await expect(waitForAppReady(backend, 'app.test')).rejects.toThrow('unauthorized');
  expect(reads).toBe(1);
  const controller = new AbortController();
  controller.abort();
  await expect(waitForAppReady(backend, 'app.test', { signal: controller.signal })).rejects.toThrow();
  expect(reads).toBe(1);
});

it('retries session startup errors but times out on a persistently wrong foreground app', async () => {
  const backend = new FakeBackend({ screens: [ready()] });
  let reads = 0;
  backend.snapshot = async () => {
    if (++reads === 1) throw Object.assign(new Error('starting'), { code: 'SESSION_NOT_FOUND' });
    return ready();
  };
  await waitForAppReady(backend, 'app.test', { pollMs: 1 });
  expect(reads).toBe(2);
  backend.snapshot = async () => screen([], { appBundleId: 'other.app' });
  await expect(waitForAppReady(backend, 'app.test', { timeoutMs: 15, pollMs: 1 })).rejects.toThrow(
    'observed other.app',
  );
});

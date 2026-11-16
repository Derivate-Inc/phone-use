import { describe, expect, test } from 'bun:test';
import { createControlPlane } from '../src/control-plane.ts';
import { CloudStore } from '../src/store.ts';

// A public demo means more strangers than phones. Nobody should get an error
// for arriving late — they should get a place in line and an honest wait.

const fleet = (capacity: number) => {
  const store = new CloudStore(':memory:');
  store.registerHost({ id: 'h1', platform: 'ios', capacity, publicUrl: 'http://h1.local' });
  return store;
};

describe('queue behaviour under load', () => {
  test('creates past capacity queue instead of failing', async () => {
    const store = fleet(2);
    const plane = createControlPlane({ apiToken: 'admin', workerToken: 'worker', store });
    const create = () =>
      plane.fetch(
        new Request('http://cp/v1/sandboxes', {
          method: 'POST',
          headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
          body: JSON.stringify({ platform: 'ios' }),
        }),
      );

    // Ten people arrive at once on a two-slot fleet.
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await create()).status);
    expect(statuses.every((s) => s === 202)).toBe(true);
    plane.close();
  });

  test('a queued sandbox reports its position and a wait estimate', () => {
    const store = fleet(2);
    const ids = Array.from({ length: 5 }, () => store.createSandbox({ platform: 'ios', ttlMs: 600_000, idleTimeoutMs: false }).id);

    // First in line is position 1; the fifth is position 5.
    expect(store.queueInfo(ids[0] as string)?.queuePosition).toBe(1);
    expect(store.queueInfo(ids[4] as string)?.queuePosition).toBe(5);
    // Wait scales with how many slots the fleet has.
    const last = store.queueInfo(ids[4] as string);
    expect(last?.estimatedWaitMs).toBeGreaterThan(0);
    store.close();
  });

  test('someone ahead who is provisioning still holds their place', () => {
    const store = fleet(1);
    const first = store.createSandbox({ platform: 'ios', ttlMs: 600_000, idleTimeoutMs: false });
    const second = store.createSandbox({ platform: 'ios', ttlMs: 600_000, idleTimeoutMs: false });
    expect(store.queueInfo(second.id)?.queuePosition).toBe(2);

    // A worker picks up the one ahead. It is booting a device — still ahead of
    // you and still consuming the slot, so your position must not jump.
    store.claimJob('h1');
    expect(store.queueInfo(second.id)?.queuePosition).toBe(2);

    // Only when it is actually running does the line move.
    store.completeCreate('h1', first.id, 'UDID-1');
    expect(store.queueInfo(second.id)?.queuePosition).toBe(1);
    expect(store.queueInfo(first.id)).toBeUndefined();
    store.close();
  });

  test('queue info is absent for anything not waiting', () => {
    const store = fleet(1);
    const sandbox = store.createSandbox({ platform: 'ios', ttlMs: 600_000, idleTimeoutMs: false });
    store.claimJob('h1');
    store.completeCreate('h1', sandbox.id, 'UDID-2');
    expect(store.queueInfo(sandbox.id)).toBeUndefined();
    store.close();
  });
});

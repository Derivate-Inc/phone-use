import { describe, expect, test } from 'bun:test';
import { createControlPlane } from '../src/control-plane.ts';
import { WarmPoolProvider } from '../src/providers.ts';
import { CloudStore } from '../src/store.ts';
import type { ProvisionedResource, Sandbox } from '../src/types.ts';

const memoryStore = () => new CloudStore(':memory:');

describe('device leaks', () => {
  test('an expired sandbox holding a device drains so a worker destroys it', () => {
    const store = memoryStore();
    const sandbox = store.createSandbox({ platform: 'ios', ttlMs: 60_000, idleTimeoutMs: false });
    store.registerHost({ id: 'h1', platform: 'ios', capacity: 4, publicUrl: 'http://h1.local' });
    store.claimJob('h1');
    store.completeCreate('h1', sandbox.id, 'UDID-1');

    // Expire it, and take the host offline — the v0 bug marked this 'closed'
    // and the simulator was never destroyed.
    store.db.query('UPDATE sandboxes SET expires_at = ? WHERE id = ?').run(Date.now() - 1, sandbox.id);
    store.db.query("UPDATE hosts SET last_seen_at = 0 WHERE id = 'h1'").run();
    store.reap();

    expect(store.getSandbox(sandbox.id)?.status).toBe('draining');
    store.close();
  });

  test('a sandbox that never got a device closes without a delete job', () => {
    const store = memoryStore();
    const sandbox = store.createSandbox({ platform: 'ios', ttlMs: 60_000, idleTimeoutMs: false });
    store.db.query('UPDATE sandboxes SET expires_at = ? WHERE id = ?').run(Date.now() - 1, sandbox.id);
    store.reap();
    expect(store.getSandbox(sandbox.id)?.status).toBe('closed');
    store.close();
  });

  test('a failed job that already provisioned a device drains rather than stranding it', () => {
    const store = memoryStore();
    const sandbox = store.createSandbox({ platform: 'ios', ttlMs: 60_000, idleTimeoutMs: false });
    store.registerHost({ id: 'h1', platform: 'ios', capacity: 4, publicUrl: 'http://h1.local' });
    store.claimJob('h1');
    store.db.query('UPDATE sandboxes SET device_ref = ? WHERE id = ?').run('UDID-2', sandbox.id);

    store.failJob('h1', sandbox.id, 'boot timed out');
    expect(store.getSandbox(sandbox.id)?.status).toBe('draining');
    store.close();
  });
});

describe('tenant isolation', () => {
  test('one tenant cannot see, fetch or delete another tenant’s sandbox', async () => {
    const store = memoryStore();
    const plane = createControlPlane({ apiToken: 'admin-token', workerToken: 'worker-token', store });
    const alice = store.createTenant('alice');
    const bob = store.createTenant('bob');
    store.registerHost({ id: 'h1', platform: 'ios', capacity: 4, publicUrl: 'http://h1.local' });

    const created = await plane.fetch(
      new Request('http://cp/v1/sandboxes', {
        method: 'POST',
        headers: { authorization: `Bearer ${alice.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'ios' }),
      }),
    );
    const sandbox = (await created.json()) as Sandbox;
    expect(created.status).toBe(202);

    const bobList = await plane.fetch(
      new Request('http://cp/v1/sandboxes', { headers: { authorization: `Bearer ${bob.key}` } }),
    );
    expect(await bobList.json()).toEqual([]);

    const bobGet = await plane.fetch(
      new Request(`http://cp/v1/sandboxes/${sandbox.id}`, {
        headers: { authorization: `Bearer ${bob.key}` },
      }),
    );
    expect(bobGet.status).toBe(404);

    const bobDelete = await plane.fetch(
      new Request(`http://cp/v1/sandboxes/${sandbox.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${bob.key}` },
      }),
    );
    expect(bobDelete.status).toBe(404);

    // Alice still sees exactly her own.
    const aliceList = (await (
      await plane.fetch(
        new Request('http://cp/v1/sandboxes', { headers: { authorization: `Bearer ${alice.key}` } }),
      )
    ).json()) as Sandbox[];
    expect(aliceList.map((s) => s.id)).toEqual([sandbox.id]);
    plane.close();
  });

  test('an unknown key is rejected and minting tenants requires admin', async () => {
    const store = memoryStore();
    const plane = createControlPlane({ apiToken: 'admin-token', workerToken: 'worker-token', store });
    const tenant = store.createTenant('carol');

    const bad = await plane.fetch(
      new Request('http://cp/v1/sandboxes', { headers: { authorization: 'Bearer nope' } }),
    );
    expect(bad.status).toBe(401);

    const nonAdmin = await plane.fetch(
      new Request('http://cp/v1/tenants', {
        method: 'POST',
        headers: { authorization: `Bearer ${tenant.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'sneaky' }),
      }),
    );
    expect(nonAdmin.status).toBe(403);
    plane.close();
  });
});

describe('metering', () => {
  test('closing a sandbox writes exactly one billing row', () => {
    const store = memoryStore();
    const tenant = store.createTenant('alice');
    const sandbox = store.createSandbox({
      platform: 'ios',
      ttlMs: 60_000,
      idleTimeoutMs: false,
      tenantId: tenant.id,
    });
    store.registerHost({ id: 'h1', platform: 'ios', capacity: 2, publicUrl: 'http://h1.local' });
    store.claimJob('h1');
    store.completeCreate('h1', sandbox.id, 'UDID-3');
    store.requestDelete(sandbox.id, tenant.id);
    store.completeDelete('h1', sandbox.id);
    store.completeDelete('h1', sandbox.id); // retried completion must not double-bill

    const rows = store.listUsage(tenant.id) as Array<{ billed_ms: number; end_reason: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.end_reason).toBe('closed');
    expect(rows[0]!.billed_ms).toBeGreaterThanOrEqual(0);
    store.close();
  });
});

describe('warm pool', () => {
  const resource = (id: string): ProvisionedResource => ({ deviceId: id, name: id });

  test('a pristine pool device is handed over as-is (no erase) and backfilled', async () => {
    const wiped: string[] = [];
    let created = 0;
    const inner = {
      platform: 'ios' as const,
      provision: async (_s: Pick<Sandbox, 'id' | 'platform'>) => resource(`sim-${++created}`),
      destroy: async () => undefined,
      reset: async (r: ProvisionedResource) => {
        wiped.push(r.deviceId);
      },
    };
    const pool = new WarmPoolProvider(inner, 1);
    pool.start();
    await Bun.sleep(20);

    const handed = await pool.provision({ id: 'sbx_1', platform: 'ios' });
    // Fresh-from-clone pool entries were never touched by a tenant: erasing
    // them would revert the pre-seeded golden state and re-pay first boot.
    expect(wiped).toHaveLength(0);
    expect(handed.deviceId).toBe('sim-1');
    await Bun.sleep(20);
    expect(created).toBe(2); // backfill provisioned a replacement
  });

  test('reserved devices are countable so capacity accounting can subtract them', async () => {
    const inner = {
      platform: 'ios' as const,
      provision: async () => resource(`sim-${Math.random()}`),
      destroy: async () => undefined,
      reset: async () => undefined,
    };
    const pool = new WarmPoolProvider(inner, 3);
    pool.start();
    await Bun.sleep(30);
    expect(pool.reserved).toBe(3);
  });

  const countingInner = () => {
    let n = 0;
    return {
      platform: 'ios' as const,
      provision: async () => resource(`sim-${++n}`),
      destroy: async () => undefined,
      reset: async () => undefined,
    };
  };

  test('a phone only joins the pool once its warm-up has finished', async () => {
    let finish = () => {};
    const warmed: string[] = [];
    const pool = new WarmPoolProvider(countingInner(), 1, {
      warmUp: async (device) => {
        await new Promise<void>((done) => {
          finish = done;
        });
        warmed.push(device.deviceId);
      },
    });
    pool.start();
    await Bun.sleep(20);
    expect(pool.warmReady).toBe(0);
    expect(pool.reserved).toBe(1); // still counted while it warms up
    finish();
    await Bun.sleep(20);
    expect(warmed).toEqual(['sim-1']);
    expect(pool.warmReady).toBe(1);
  });

  test('a failed warm-up keeps the phone: slower beats missing', async () => {
    const pool = new WarmPoolProvider(countingInner(), 1, {
      warmUp: async () => {
        throw new Error('runner would not start');
      },
    });
    pool.start();
    await Bun.sleep(20);
    expect(pool.warmReady).toBe(1);
    const handed = await pool.provision({ id: 'sbx_1', platform: 'ios' });
    expect(handed.deviceId).toBe('sim-1');
  });

  test('a refill delay holds the rebuild back after a handout', async () => {
    const pool = new WarmPoolProvider(countingInner(), 1, { refillDelayMs: 40 });
    pool.start();
    await Bun.sleep(20);
    await pool.provision({ id: 'sbx_1', platform: 'ios' });
    await Bun.sleep(15);
    expect(pool.reserved).toBe(0); // nothing booting yet, next to the live phone
    await Bun.sleep(60);
    expect(pool.warmReady).toBe(1);
  });

  test('keep-warm refreshes waiting phones, never handed-out ones, and survives failures', async () => {
    const refreshed: string[] = [];
    const pool = new WarmPoolProvider(countingInner(), 2, {
      keepWarm: async (device) => {
        refreshed.push(device.deviceId);
        if (device.deviceId === 'sim-2') throw new Error('runner died');
      },
    });
    pool.start();
    await Bun.sleep(20);
    await pool.provision({ id: 'sbx_1', platform: 'ios' }); // takes sim-1
    await Bun.sleep(20);
    await pool.refreshWarm();
    expect(refreshed).toEqual(['sim-2', 'sim-3']);
  });
});

describe('input validation', () => {
  test('an out-of-range ttl is a 400, not a 500', async () => {
    const store = memoryStore();
    const plane = createControlPlane({ apiToken: 'admin-token', workerToken: 'worker-token', store });
    const res = await plane.fetch(
      new Request('http://cp/v1/sandboxes', {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'ios', ttlMs: 5 }),
      }),
    );
    expect(res.status).toBe(400);
    plane.close();
  });
});

describe('capacity accounting', () => {
  test('warm-pool reservations count against host capacity', () => {
    const store = memoryStore();
    store.registerHost({ id: 'h1', platform: 'ios', capacity: 2, publicUrl: 'http://h1.local' });
    store.createSandbox({ platform: 'ios', ttlMs: 60_000, idleTimeoutMs: false });

    // Two devices held warm on a capacity-2 host: the plane must not schedule.
    store.heartbeatHost('h1', 2);
    expect(store.claimJob('h1')).toBeUndefined();

    // Pool drains → capacity frees up.
    store.heartbeatHost('h1', 0);
    expect(store.claimJob('h1')?.kind).toBe('create');
    store.close();
  });

  test('the plane reports which sandboxes a host should still hold', () => {
    const store = memoryStore();
    store.registerHost({ id: 'h1', platform: 'ios', capacity: 4, publicUrl: 'http://h1.local' });
    const sandbox = store.createSandbox({ platform: 'ios', ttlMs: 60_000, idleTimeoutMs: false });
    store.claimJob('h1');
    store.completeCreate('h1', sandbox.id, 'UDID-9');
    expect(store.liveSandboxIdsForHost('h1')).toEqual([sandbox.id]);

    // Once closed it disappears — a worker still holding it knows it is an orphan.
    store.requestDelete(sandbox.id);
    store.completeDelete('h1', sandbox.id);
    expect(store.liveSandboxIdsForHost('h1')).toEqual([]);
    store.close();
  });
});

import { describe, expect, test } from 'bun:test';
import type { SandboxRpcMethod } from '@phone-use/sdk';
import { createControlPlane } from '../src/control-plane.ts';
import { CloudStore } from '../src/store.ts';
import { RPC_METHODS } from '../src/worker.ts';

const memory = () => new CloudStore(':memory:');

describe('sdk ↔ worker RPC contract', () => {
  test('every method the published SDK can send, the worker accepts', () => {
    // The union type and the runtime set are maintained by hand in two
    // packages ("shared by convention"). This test is the convention's teeth.
    const sdkMethods: SandboxRpcMethod[] = [
      'viewerInput',
      'snapshot',
      'screenshot',
      'press',
      'longPress',
      'fill',
      'typeText',
      'pressKey',
      'scroll',
      'pan',
      'installApp',
      'waitForText',
      'systemAlert',
      'home',
      'back',
      'openApp',
      'listApps',
      'closeSession',
      'checkpoint',
      'restoreCheckpoint',
      'listCheckpoints',
      'deleteCheckpoint',
    ];
    for (const method of sdkMethods) expect(RPC_METHODS.has(method)).toBe(true);
    expect(RPC_METHODS.size).toBe(sdkMethods.length);
  });
});

describe('reaper edge cases', () => {
  test('TTL expiry closes a queued sandbox that never got a device', () => {
    const store = memory();
    const sandbox = store.createSandbox({ platform: 'ios', ttlMs: 60_000, idleTimeoutMs: false });
    store.db.query('UPDATE sandboxes SET expires_at = ? WHERE id = ?').run(Date.now() - 1, sandbox.id);
    store.reap();
    expect(store.getSandbox(sandbox.id)?.status).toBe('closed');
    store.close();
  });

  test('idle-expired sandbox with a device drains even when its worker is dead', () => {
    const store = memory();
    store.registerHost({ id: 'h1', platform: 'ios', capacity: 2, publicUrl: 'http://h1.local' });
    const sandbox = store.createSandbox({ platform: 'ios', ttlMs: 3_600_000, idleTimeoutMs: 60_000 });
    store.claimJob('h1');
    store.completeCreate('h1', sandbox.id, 'UDID-X');
    store.db
      .query('UPDATE sandboxes SET last_active_at = ? WHERE id = ?')
      .run(Date.now() - 120_000, sandbox.id);
    store.db.query("UPDATE hosts SET last_seen_at = 0 WHERE id = 'h1'").run();
    store.reap();
    // Draining, never 'closed': the device still exists somewhere and must be
    // collected when the worker returns (the doc-31 leak class).
    expect(store.getSandbox(sandbox.id)?.status).toBe('draining');
    store.close();
  });

  test('a healthy running sandbox is untouched by the reaper', () => {
    const store = memory();
    store.registerHost({ id: 'h1', platform: 'ios', capacity: 2, publicUrl: 'http://h1.local' });
    const sandbox = store.createSandbox({ platform: 'ios', ttlMs: 3_600_000, idleTimeoutMs: 900_000 });
    store.claimJob('h1');
    store.completeCreate('h1', sandbox.id, 'UDID-Y');
    store.reap();
    expect(store.getSandbox(sandbox.id)?.status).toBe('running');
    store.close();
  });
});

describe('tenant quota + disabled accounts', () => {
  test('the per-tenant active quota returns 429 with the limit named', async () => {
    const store = memory();
    const plane = createControlPlane({
      apiToken: 'admin',
      workerToken: 'worker',
      store,
      maxActivePerTenant: 2,
    });
    const tenant = store.createTenant('quota');
    store.registerHost({ id: 'h1', platform: 'ios', capacity: 10, publicUrl: 'http://h1.local' });
    const create = () =>
      plane.fetch(
        new Request('http://cp/v1/sandboxes', {
          method: 'POST',
          headers: { authorization: `Bearer ${tenant.key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ platform: 'ios' }),
        }),
      );
    expect((await create()).status).toBe(202);
    expect((await create()).status).toBe(202);
    const third = await create();
    expect(third.status).toBe(429);
    expect(((await third.json()) as { error: string }).error).toContain('2');
    plane.close();
  });

  test('a disabled tenant is denied instead of silently re-minted', () => {
    const store = memory();
    store.createTenant('sus', { userId: 'user-1' });
    expect(store.tenantForUser('user-1', 'sus')).toBeDefined();
    store.db.query('UPDATE tenants SET disabled_at = ? WHERE user_id = ?').run(Date.now(), 'user-1');
    expect(store.tenantForUser('user-1', 'sus')).toBeUndefined();
    // And crucially: no second tenant appeared for the same user.
    const count = store.db
      .query("SELECT COUNT(*) AS c FROM tenants WHERE user_id = 'user-1'")
      .get() as { c: number };
    expect(count.c).toBe(1);
    store.close();
  });

  test('UNIQUE(user_id): concurrent first-login cannot mint two tenants', () => {
    const store = memory();
    store.tenantForUser('user-2', 'a');
    store.tenantForUser('user-2', 'b');
    const count = store.db
      .query("SELECT COUNT(*) AS c FROM tenants WHERE user_id = 'user-2'")
      .get() as { c: number };
    expect(count.c).toBe(1);
    store.close();
  });
});

describe('key lifecycle', () => {
  test('rotation invalidates the old key and stamps key_created_at', () => {
    const store = memory();
    const tenant = store.createTenant('rotor');
    expect(store.tenantForKey(tenant.key)?.id).toBe(tenant.id);
    const before = store.keyCreatedAt(tenant.id);
    const fresh = store.rotateKey(tenant.id);
    expect(store.tenantForKey(tenant.key)).toBeUndefined();
    expect(store.tenantForKey(fresh)?.id).toBe(tenant.id);
    expect(store.keyCreatedAt(tenant.id)).toBeGreaterThanOrEqual(before ?? 0);
    store.close();
  });
});

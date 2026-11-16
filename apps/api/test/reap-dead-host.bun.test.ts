import { describe, expect, test } from 'bun:test';
import { CloudStore } from '../src/store.ts';

// A phone draining on a worker that died stays draining (its device must be
// collected when the worker returns) but must not hold the tenant's quota:
// at the demo cap of one phone that is a permanent lockout.
describe('draining sandboxes on a dead host', () => {
  test('stay draining but stop counting toward the active quota', () => {
    const store = new CloudStore(':memory:');
    const tenant = store.createTenant('alice');
    const sandbox = store.createSandbox({
      platform: 'ios',
      ttlMs: 60 * 60_000,
      idleTimeoutMs: false,
      tenantId: tenant.id,
    });
    store.registerHost({ id: 'h1', platform: 'ios', capacity: 4, publicUrl: 'http://h1.local' });
    store.claimJob('h1');
    store.completeCreate('h1', sandbox.id, 'UDID-1');
    expect(store.requestDelete(sandbox.id)?.status).toBe('draining');
    expect(store.activeSandboxCount(tenant.id)).toBe(1);

    // Host alive (just slow to collect): still counts.
    store.reap();
    expect(store.activeSandboxCount(tenant.id)).toBe(1);

    // Host silent for six minutes: still draining for collection, quota freed.
    store.db.query('UPDATE hosts SET last_seen_at = ? WHERE id = ?').run(Date.now() - 6 * 60_000, 'h1');
    store.reap();
    expect(store.getSandbox(sandbox.id)?.status).toBe('draining');
    expect(store.activeSandboxCount(tenant.id)).toBe(0);
    store.close();
  });
});

import { describe, expect, test } from 'bun:test';
import { createControlPlane } from '../src/control-plane.ts';
import { CloudStore } from '../src/store.ts';

function plane() {
  const store = new CloudStore(':memory:');
  store.registerHost({ id: 'mac-1', platform: 'ios', capacity: 4, publicUrl: 'http://worker' });
  return { store, p: createControlPlane({ apiToken: 'admin', workerToken: 'worker', store }) };
}

type Plane = ReturnType<typeof createControlPlane>;

const call = (p: Plane, method: string, path: string, key?: string, body?: unknown) =>
  p.fetch(
    new Request(`http://cp${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const createPhone = (p: Plane, key: string) => call(p, 'POST', '/v1/sandboxes', key, { platform: 'ios' });

type Summary = {
  enabled: boolean;
  attempts: { total: number; anonymous: number; signedIn: number; accounts: number };
  entries: number;
  waitlistedAccounts: number;
  accounts: Array<{ tenantId: string; attempts: number }>;
  formEntries: Array<{ email: string; useCase: string; approved: boolean }>;
};
const summary = async (p: Plane) => (await (await call(p, 'GET', '/v1/admin/waitlist', 'admin')).json()) as Summary;

describe('admin: read the waitlist count', () => {
  test('each refused attempt, signed in or logged out, raises the count by one', async () => {
    const { store, p } = plane();
    const waiting = store.createTenant('waiting', { cloudApproved: false });
    expect((await summary(p)).attempts.total).toBe(0);

    await call(p, 'POST', '/v1/waitlist/attempts', undefined, { platform: 'ios', client: 'cli' });
    expect((await summary(p)).attempts).toMatchObject({ total: 1, anonymous: 1, signedIn: 0 });

    await createPhone(p, waiting.key);
    expect((await summary(p)).attempts).toMatchObject({ total: 2, anonymous: 1, signedIn: 1, accounts: 1 });

    await createPhone(p, waiting.key);
    const after = await summary(p);
    expect(after.attempts).toMatchObject({ total: 3, signedIn: 2, accounts: 1 });
    expect(after.enabled).toBe(true);
    expect(after.waitlistedAccounts).toBe(1);
    expect(after.accounts).toEqual([expect.objectContaining({ attempts: 2 })]);

    // A create that succeeds is not an attempt.
    await createPhone(p, 'admin');
    expect((await summary(p)).attempts.total).toBe(3);
    p.close();
  });

  test('includes the waitlist form entries', async () => {
    const { p } = plane();
    await call(p, 'POST', '/v1/waitlist', undefined, { email: 'dev@example.com', useCase: 'CI' });
    const s = await summary(p);
    expect(s.entries).toBe(1);
    expect(s.formEntries).toEqual([expect.objectContaining({ email: 'dev@example.com', useCase: 'CI', approved: false })]);
    p.close();
  });

  test('is admin only', async () => {
    const { store, p } = plane();
    const tenant = store.createTenant('someone');
    expect((await call(p, 'GET', '/v1/admin/waitlist', tenant.key)).status).toBe(403);
    expect((await call(p, 'GET', '/v1/admin/waitlist')).status).toBe(401);
    expect(
      (await call(p, 'POST', '/v1/admin/cloud-approval', tenant.key, { tenantId: 'ten_x' })).status,
    ).toBe(403);
    p.close();
  });
});

describe('admin: approve an account', () => {
  test('by tenant id: the account can create, and can be put back on the waitlist', async () => {
    const { store, p } = plane();
    const waiting = store.createTenant('waiting', { cloudApproved: false });
    const tenantId = store.tenantForKey(waiting.key)!.id;
    expect((await createPhone(p, waiting.key)).status).toBe(403);

    const approve = await call(p, 'POST', '/v1/admin/cloud-approval', 'admin', { tenantId });
    expect(approve.status).toBe(200);
    expect(await approve.json()).toEqual({ ok: true, approved: true, tenantId });
    expect((await createPhone(p, waiting.key)).status).toBe(202);
    expect((await summary(p)).waitlistedAccounts).toBe(0);

    await call(p, 'POST', '/v1/admin/cloud-approval', 'admin', { tenantId, approved: false });
    expect((await createPhone(p, waiting.key)).status).toBe(403);
    p.close();
  });

  test('by email with no account yet: recorded, so the account starts approved', async () => {
    const { store, p } = plane();
    const res = await call(p, 'POST', '/v1/admin/cloud-approval', 'admin', { email: 'Ada@Example.com' });
    expect(await res.json()).toEqual({
      ok: true,
      approved: true,
      email: 'ada@example.com',
      tenantId: null,
      accountExists: false,
    });
    expect(store.tenantForUser('user-ada', 'Ada', 'ada@example.com')?.cloudApproved).toBe(true);
    p.close();
  });

  test('unknown tenants and empty requests are errors', async () => {
    const { p } = plane();
    expect((await call(p, 'POST', '/v1/admin/cloud-approval', 'admin', { tenantId: 'ten_nope' })).status).toBe(404);
    expect((await call(p, 'POST', '/v1/admin/cloud-approval', 'admin', {})).status).toBe(400);
    p.close();
  });

  test('invalid approval values cannot accidentally approve an account', async () => {
    const { store, p } = plane();
    const waiting = store.createTenant('waiting', { cloudApproved: false });
    for (const approved of ['false', 0, null]) {
      const res = await call(p, 'POST', '/v1/admin/cloud-approval', 'admin', { tenantId: waiting.id, approved });
      expect(res.status).toBe(400);
      expect(store.cloudApproved(waiting.id)).toBe(false);
    }
    expect((await call(p, 'POST', '/v1/admin/cloud-approval', 'admin', null)).status).toBe(400);
    p.close();
  });

  test('a tenant minted by an operator is approved unless told otherwise', async () => {
    const { p } = plane();
    const minted = (await (await call(p, 'POST', '/v1/tenants', 'admin', { name: 'partner' })).json()) as {
      key: string;
    };
    expect((await createPhone(p, minted.key)).status).toBe(202);
    const held = (await (
      await call(p, 'POST', '/v1/tenants', 'admin', { name: 'held', cloudApproved: false })
    ).json()) as { key: string };
    expect((await createPhone(p, held.key)).status).toBe(403);
    p.close();
  });
});

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth, migrateAuth } from '../src/auth.ts';
import { type ControlPlaneOptions, createControlPlane } from '../src/control-plane.ts';
import { CloudStore } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'pu-waitlist-gate-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function plane(options: Partial<ControlPlaneOptions> = {}) {
  const store = new CloudStore(':memory:');
  // A live worker, so an approved create is accepted rather than "no capacity".
  store.registerHost({ id: 'mac-1', platform: 'ios', capacity: 4, publicUrl: 'http://worker' });
  const p = createControlPlane({ apiToken: 'admin', workerToken: 'worker', store, ...options });
  return { store, p };
}

type Plane = ReturnType<typeof createControlPlane>;

const create = (p: Plane, headers: Record<string, string>, body: unknown = { platform: 'ios' }) =>
  p.fetch(
    new Request('http://cp/v1/sandboxes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
const withKey = (key: string, client?: string) => ({
  authorization: `Bearer ${key}`,
  ...(client ? { 'x-phone-use-client': client } : {}),
});

const attempts = (store: CloudStore) =>
  store.db.query('SELECT account, platform, client FROM waitlist_attempts ORDER BY id').all() as Array<{
    account: string;
    platform: string | null;
    client: string;
  }>;
const sandboxCount = (store: CloudStore) =>
  (store.db.query('SELECT COUNT(*) AS c FROM sandboxes').get() as { c: number }).c;

describe('cloud waitlist gate on POST /v1/sandboxes', () => {
  test('an approved account still gets a phone', async () => {
    const { store, p } = plane();
    const approved = store.createTenant('approved');
    const res = await create(p, withKey(approved.key, 'cli'));
    expect(res.status).toBe(202);
    const sandbox = (await res.json()) as { id: string; status: string };
    expect(sandbox.id).toStartWith('sbx_');
    expect(sandbox.status).toBe('queued');
    expect(attempts(store)).toEqual([]);
    p.close();
  });

  test('an account that is not approved gets the stable cloud_waitlist answer and no phone', async () => {
    const { store, p } = plane();
    const waiting = store.createTenant('waiting', { cloudApproved: false });
    const tenantId = store.tenantForKey(waiting.key)!.id;

    const res = await create(p, withKey(waiting.key, 'cli'), { platform: 'android' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: expect.stringContaining('waitlist'),
      code: 'cloud_waitlist',
      waitlistUrl: 'https://phoneuse.dev/waitlist',
    });
    expect(sandboxCount(store)).toBe(0);
    expect(attempts(store)).toEqual([{ account: tenantId, platform: 'android', client: 'cli' }]);

    // Each refused attempt is one more row; the client kind comes from the header.
    await create(p, withKey(waiting.key, 'mcp'));
    await create(p, withKey(waiting.key, 'sdk'));
    await create(p, withKey(waiting.key));
    await create(p, withKey(waiting.key, 'not-a-client'));
    expect(attempts(store).map((a) => a.client)).toEqual(['cli', 'mcp', 'sdk', 'unknown', 'unknown']);
    expect(store.waitlistSummary().attempts.total).toBe(5);
    expect(sandboxCount(store)).toBe(0);
    p.close();
  });

  test('the answer does not depend on capacity, and a bad request is not counted', async () => {
    const store = new CloudStore(':memory:'); // no worker at all
    const p = createControlPlane({ apiToken: 'admin', workerToken: 'worker', store });
    const waiting = store.createTenant('waiting', { cloudApproved: false });
    const approved = store.createTenant('approved');

    const refused = await create(p, withKey(waiting.key));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe('cloud_waitlist');
    // The approved account sees the real state of the fleet.
    expect((await create(p, withKey(approved.key))).status).toBe(503);

    const invalid = await create(p, withKey(waiting.key), { platform: 'windows' });
    expect(invalid.status).toBe(400);
    expect((await create(p, withKey(waiting.key), null)).status).toBe(400);
    expect(store.waitlistSummary().attempts.total).toBe(1);
    p.close();
  });

  test('the admin token and admin tenants are never on the waitlist', async () => {
    const { store, p } = plane();
    expect((await create(p, withKey('admin'))).status).toBe(202);
    const ops = store.createTenant('ops', { admin: true, cloudApproved: false });
    expect((await create(p, withKey(ops.key))).status).toBe(202);
    const me = await p.fetch(new Request('http://cp/v1/me', { headers: withKey('admin') }));
    expect(((await me.json()) as { cloudApproved: boolean }).cloudApproved).toBe(true);
    expect(attempts(store)).toEqual([]);
    p.close();
  });

  test('approving an account lets it create; taking approval back refuses it again', async () => {
    const { store, p } = plane();
    const tenant = store.createTenant('waiting', { cloudApproved: false });
    const id = store.tenantForKey(tenant.key)!.id;
    expect((await create(p, withKey(tenant.key))).status).toBe(403);
    store.setCloudApproval(id, true);
    expect((await create(p, withKey(tenant.key))).status).toBe(202);
    store.setCloudApproval(id, false);
    expect((await create(p, withKey(tenant.key))).status).toBe(403);
    expect(sandboxCount(store)).toBe(1);
    p.close();
  });

  test('GET /v1/me says whether the account is approved', async () => {
    const { store, p } = plane({ waitlistUrl: 'https://example.test/join' });
    const waiting = store.createTenant('waiting', { cloudApproved: false });
    const approved = store.createTenant('approved');
    const me = async (key: string) =>
      (await (await p.fetch(new Request('http://cp/v1/me', { headers: withKey(key) }))).json()) as {
        cloudApproved: boolean;
        waitlistUrl?: string;
      };
    expect(await me(waiting.key)).toMatchObject({ cloudApproved: false, waitlistUrl: 'https://example.test/join' });
    const approvedMe = await me(approved.key);
    expect(approvedMe.cloudApproved).toBe(true);
    expect(approvedMe.waitlistUrl).toBeUndefined();
    // The configured link is the one in the refusal too.
    const refused = (await (await create(p, withKey(waiting.key))).json()) as { waitlistUrl: string; error: string };
    expect(refused.waitlistUrl).toBe('https://example.test/join');
    expect(refused.error).toContain('https://example.test/join');
    p.close();
  });

  test('a self-hosted control plane can turn the waitlist off', async () => {
    const { store, p } = plane({ cloudWaitlist: false });
    const tenant = store.createTenant('self-hosted', { cloudApproved: false });
    expect((await create(p, withKey(tenant.key))).status).toBe(202);
    const me = await p.fetch(new Request('http://cp/v1/me', { headers: withKey(tenant.key) }));
    expect(((await me.json()) as { cloudApproved: boolean }).cloudApproved).toBe(true);
    expect(attempts(store)).toEqual([]);
    p.close();
  });
});

describe('a brand-new console account', () => {
  let signups = 0;
  async function signedUp(name: string) {
    const databasePath = join(dir, `${name}.sqlite`);
    const auth = createAuth({
      databasePath,
      secret: 'test-secret-test-secret-test-secret!',
      baseURL: 'http://cp',
      trustedOrigins: ['http://cp'],
    });
    await migrateAuth(auth);
    const store = new CloudStore(databasePath);
    store.registerHost({ id: 'mac-1', platform: 'ios', capacity: 4, publicUrl: 'http://worker' });
    const p = createControlPlane({ apiToken: 'admin', workerToken: 'worker', store, auth });
    const signup = await p.fetch(
      new Request('http://cp/api/auth/sign-up/email', {
        method: 'POST',
        // Better Auth limits sign-ups per address, and every test file shares
        // one process: a distinct address keeps these out of other tests' way.
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${++signups}` },
        body: JSON.stringify({ email: `${name}@example.com`, password: 'a-long-password', name }),
      }),
    );
    expect(signup.status).toBe(200);
    return { store, p, cookie: signup.headers.get('set-cookie') ?? '' };
  }

  test('is refused with the waitlist answer from the console and from its key, and no phone starts', async () => {
    const { store, p, cookie } = await signedUp('newcomer');

    // From the console, before the email is even verified: the waitlist, not
    // "verify your email" — verifying would not get this account a phone.
    const fromConsole = await create(p, { cookie });
    expect(fromConsole.status).toBe(403);
    expect(((await fromConsole.json()) as { code: string }).code).toBe('cloud_waitlist');

    const me = (await (await p.fetch(new Request('http://cp/v1/me', { headers: { cookie } }))).json()) as {
      tenantId: string;
      cloudApproved: boolean;
    };
    expect(me.cloudApproved).toBe(false);

    // Verified, with an API key, from the CLI: still the waitlist.
    store.db.query('UPDATE user SET emailVerified = 1').run();
    const rotated = await p.fetch(
      new Request('http://cp/v1/keys/rotate', { method: 'POST', headers: { cookie } }),
    );
    const { key } = (await rotated.json()) as { key: string };
    const fromCli = await create(p, withKey(key, 'cli'));
    expect(fromCli.status).toBe(403);
    expect(((await fromCli.json()) as { code: string }).code).toBe('cloud_waitlist');

    expect(sandboxCount(store)).toBe(0);
    expect(attempts(store)).toEqual([
      { account: me.tenantId, platform: 'ios', client: 'web' },
      { account: me.tenantId, platform: 'ios', client: 'cli' },
    ]);

    // Once approved, the same account gets a phone.
    store.setCloudApproval(me.tenantId, true);
    expect((await create(p, withKey(key, 'cli'))).status).toBe(202);
    expect((await create(p, { cookie })).status).toBe(202);
    p.close();
  });

  test('once approved, an unverified email is still asked to verify before creating', async () => {
    const { store, p, cookie } = await signedUp('unverified');
    const me = (await (await p.fetch(new Request('http://cp/v1/me', { headers: { cookie } }))).json()) as {
      tenantId: string;
    };
    store.setCloudApproval(me.tenantId, true);
    const res = await create(p, { cookie });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('verify your email');
    expect(sandboxCount(store)).toBe(0);
    p.close();
  });

  test('an email approved before signing up starts approved', async () => {
    // The operator approves the email first; signedUp('early') uses the same file.
    const seed = new CloudStore(join(dir, 'early.sqlite'));
    seed.setCloudApprovalByEmail('early@example.com', true);
    seed.close();
    const { store, p, cookie } = await signedUp('early');
    store.db.query('UPDATE user SET emailVerified = 1').run();
    expect((await create(p, { cookie })).status).toBe(202);
    p.close();
  });

  test('an unverified account cannot get an API key by approving a device login, even with a pre-approved email', async () => {
    // Someone signs up with another person's pre-approved address and never verifies it.
    const seed = new CloudStore(join(dir, 'squatter.sqlite'));
    seed.setCloudApprovalByEmail('squatter@example.com', true);
    seed.close();
    const { store, p, cookie } = await signedUp('squatter');
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      p.fetch(
        new Request(`http://cp${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }),
      );
    const started = (await (await post('/v1/device/start', {})).json()) as { deviceCode: string; userCode: string };

    // The device login is how `phone-use login --device` gets its key.
    const approve = await post('/v1/device/approve', { code: started.userCode }, { cookie });
    expect(approve.status).toBe(403);
    expect(((await approve.json()) as { error: string }).error).toContain('verify your email');
    const polled = (await (await post('/v1/device/poll', { deviceCode: started.deviceCode })).json()) as {
      status: string;
      key?: string;
    };
    expect(polled.status).toBe('pending');
    expect(polled.key).toBeUndefined();
    // The other two ways to a phone or a key are closed to it as well.
    expect((await post('/v1/keys/rotate', {}, { cookie })).status).toBe(403);
    expect((await create(p, { cookie })).status).toBe(403);
    expect(sandboxCount(store)).toBe(0);

    // Once the address is verified, the same approval works and yields a key.
    store.db.query('UPDATE user SET emailVerified = 1').run();
    expect((await post('/v1/device/approve', { code: started.userCode }, { cookie })).status).toBe(200);
    const collected = (await (await post('/v1/device/poll', { deviceCode: started.deviceCode })).json()) as {
      status: string;
      key?: string;
    };
    expect(collected.status).toBe('approved');
    expect(collected.key).toStartWith('pk_');
    p.close();
  });
});

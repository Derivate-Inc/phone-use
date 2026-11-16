import { describe, expect, test } from 'bun:test';
import { createControlPlane } from '../src/control-plane.ts';
import { CloudStore } from '../src/store.ts';

function plane() {
  const store = new CloudStore(':memory:');
  return { store, p: createControlPlane({ apiToken: 'admin', workerToken: 'worker', store }) };
}

type Plane = ReturnType<typeof createControlPlane>;

/** An unauthenticated POST, as the CLI or the waitlist page sends it. */
const post = (p: Plane, path: string, body: unknown, from = '198.51.100.7') =>
  p.fetch(
    new Request(`http://cp${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': from },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

const attemptRows = (store: CloudStore) =>
  store.db.query('SELECT * FROM waitlist_attempts ORDER BY id').all() as Array<Record<string, unknown>>;

describe('POST /v1/waitlist/attempts (logged-out create)', () => {
  test('needs no credentials and records an anonymous attempt', async () => {
    const { store, p } = plane();
    const res = await post(p, '/v1/waitlist/attempts', { platform: 'ios', client: 'cli' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      recorded: true,
      code: 'cloud_waitlist',
      waitlistUrl: 'https://phoneuse.dev/waitlist',
    });
    await post(p, '/v1/waitlist/attempts', { platform: 'android', client: 'mcp' });
    expect(attemptRows(store).map((r) => [r.account, r.platform, r.client])).toEqual([
      ['anonymous', 'ios', 'cli'],
      ['anonymous', 'android', 'mcp'],
    ]);
    expect(store.waitlistSummary().attempts).toMatchObject({ total: 2, anonymous: 2, signedIn: 0 });
    p.close();
  });

  test('stores no IP address: the caller address appears nowhere in the database', async () => {
    const { store, p } = plane();
    await post(p, '/v1/waitlist/attempts', { platform: 'ios', client: 'cli' }, '198.51.100.77');
    await post(p, '/v1/waitlist', { email: 'a@example.com', useCase: 'x' }, '198.51.100.77');
    const [row] = attemptRows(store);
    expect(Object.keys(row ?? {}).sort()).toEqual(['account', 'client', 'id', 'platform', 'ts']);
    // Every value in every table: no column anywhere holds the address.
    const tables = (
      store.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((t) => t.name);
    for (const table of tables) {
      const dump = JSON.stringify(store.db.query(`SELECT * FROM "${table}"`).all());
      expect(dump).not.toContain('198.51.100.77');
    }
    p.close();
  });

  test('unknown platforms and clients are recorded as unstated, never as free text', async () => {
    const { store, p } = plane();
    await post(p, '/v1/waitlist/attempts', { platform: 'windows<script>', client: 'x'.repeat(5_000) });
    await post(p, '/v1/waitlist/attempts', {});
    expect(attemptRows(store).map((r) => [r.platform, r.client])).toEqual([
      [null, 'unknown'],
      [null, 'unknown'],
    ]);
    p.close();
  });

  test('is rate-limited per caller, and a limited request records nothing', async () => {
    const { store, p } = plane();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      statuses.push((await post(p, '/v1/waitlist/attempts', { platform: 'ios', client: 'cli' })).status);
    }
    expect(statuses.filter((s) => s === 202)).toHaveLength(20);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    expect(store.waitlistSummary().attempts.total).toBe(20);
    // Another caller is not affected.
    expect((await post(p, '/v1/waitlist/attempts', { platform: 'ios' }, '198.51.100.8')).status).toBe(202);
    p.close();
  });
});

describe('public waitlist request bounds', () => {
  test('rejects malformed JSON and non-object bodies without recording anything', async () => {
    const { store, p } = plane();
    for (const path of ['/v1/waitlist', '/v1/waitlist/attempts']) {
      for (const [i, body] of ['not json', 'null', '[]', '42', '"text"'].entries()) {
        expect((await post(p, path, body, `198.51.100.${i}`)).status).toBe(400);
      }
    }
    expect(attemptRows(store)).toEqual([]);
    expect(store.listWaitlistEntries()).toEqual([]);
    p.close();
  });

  test('bounds both declared and streamed bodies before parsing or recording', async () => {
    const { store, p } = plane();
    for (const path of ['/v1/waitlist', '/v1/waitlist/attempts']) {
      const body = JSON.stringify({ email: 'dev@example.com', useCase: 'x'.repeat(20_000) });
      // No content-length: exercises reading a streamed body up to the limit.
      expect((await post(p, path, body)).status).toBe(413);
      const res = await p.fetch(new Request(`http://cp${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
        body,
      }));
      expect(res.status).toBe(413);
    }
    expect(attemptRows(store)).toEqual([]);
    expect(store.listWaitlistEntries()).toEqual([]);
    p.close();
  });
});

describe('POST /v1/waitlist (the waitlist form)', () => {
  test('saves the email and the answer, and confirms', async () => {
    const { store, p } = plane();
    const res = await post(p, '/v1/waitlist', {
      email: '  Dev@Example.com ',
      useCase: 'Run my app’s UI tests on every pull request',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(store.listWaitlistEntries()).toEqual([
      {
        email: 'dev@example.com',
        useCase: 'Run my app’s UI tests on every pull request',
        createdAt: expect.any(String),
        approved: false,
      },
    ]);
    p.close();
  });

  test('the answer is optional, a second submission is not a second entry, and the reply does not say so', async () => {
    const { store, p } = plane();
    expect((await post(p, '/v1/waitlist', { email: 'dev@example.com' })).status).toBe(201);
    const again = await post(p, '/v1/waitlist', { email: 'DEV@example.com', useCase: 'load tests' });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ ok: true });
    expect(store.listWaitlistEntries()).toHaveLength(1);
    expect(store.listWaitlistEntries()[0]?.useCase).toBe('load tests');
    p.close();
  });

  test('rejects a missing or malformed email and caps the answer length', async () => {
    const { store, p } = plane();
    for (const email of [undefined, '', 'nope', 'a@b', 'a b@example.com', `${'a'.repeat(250)}@example.com`]) {
      const res = await post(p, '/v1/waitlist', { email, useCase: 'x' }, `198.51.100.${String(email).length % 200}`);
      expect(res.status).toBe(400);
    }
    expect(store.listWaitlistEntries()).toHaveLength(0);
    await post(p, '/v1/waitlist', { email: 'long@example.com', useCase: 'y'.repeat(10_000) }, '198.51.100.250');
    expect(store.listWaitlistEntries()[0]?.useCase).toHaveLength(2_000);
    p.close();
  });

  test('is rate-limited per caller', async () => {
    const { store, p } = plane();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await post(p, '/v1/waitlist', { email: `p${i}@example.com` })).status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429, 429]);
    expect(store.listWaitlistEntries()).toHaveLength(5);
    p.close();
  });

  test('the public routes are the only unauthenticated ones: the list itself needs credentials', async () => {
    const { p } = plane();
    const res = await p.fetch(new Request('http://cp/v1/waitlist'));
    expect(res.status).toBe(401);
    p.close();
  });
});

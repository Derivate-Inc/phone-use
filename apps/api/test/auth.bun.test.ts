import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth, migrateAuth } from '../src/auth.ts';
import { createControlPlane } from '../src/control-plane.ts';
import { CloudStore } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'pu-auth-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('console sessions (better-auth)', () => {
  test('signup → session cookie drives the API scoped to an auto-created tenant', async () => {
    const databasePath = join(dir, 'cloud.sqlite');
    const auth = createAuth({
      databasePath,
      secret: 'test-secret-test-secret-test-secret!',
      baseURL: 'http://cp',
      trustedOrigins: ['http://cp'],
    });
    await migrateAuth(auth);
    const plane = createControlPlane({
      apiToken: 'admin',
      workerToken: 'worker',
      store: new CloudStore(databasePath),
      auth,
    });

    // Email signup through the mounted handler.
    const signup = await plane.fetch(
      new Request('http://cp/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'dev@phoneuse.dev', password: 'a-long-password', name: 'Dev' }),
      }),
    );
    expect(signup.status).toBe(200);
    const cookie = signup.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('better-auth');

    // The session cookie is a first-class credential on /v1 routes.
    const me = await plane.fetch(new Request('http://cp/v1/me', { headers: { cookie } }));
    const whoami = (await me.json()) as { name: string; tenantId: string };
    expect(whoami.name).toBe('Dev');
    expect(whoami.tenantId.startsWith('ten_')).toBe(true);

    // Unverified emails cannot mint credentials (codex #4)…
    const denied = await plane.fetch(
      new Request('http://cp/v1/keys/rotate', { method: 'POST', headers: { cookie } }),
    );
    expect(denied.status).toBe(403);

    // …but a verified account can. (No email provider in tests: flip the flag.)
    plane.store.db.query('UPDATE user SET emailVerified = 1').run();

    // Key rotation returns a bearer key that resolves to the SAME tenant.
    const rotated = await plane.fetch(
      new Request('http://cp/v1/keys/rotate', { method: 'POST', headers: { cookie } }),
    );
    expect(rotated.status).toBe(201);
    const { key } = (await rotated.json()) as { key: string };
    const viaKey = await plane.fetch(
      new Request('http://cp/v1/me', { headers: { authorization: `Bearer ${key}` } }),
    );
    expect(((await viaKey.json()) as { tenantId: string }).tenantId).toBe(whoami.tenantId);

    // No cookie, no key → 401.
    const anon = await plane.fetch(new Request('http://cp/v1/sandboxes'));
    expect(anon.status).toBe(401);
    plane.close();
  });
});

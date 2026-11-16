import { describe, expect, test } from 'bun:test';
import { createControlPlane } from '../src/control-plane.ts';
import { CloudStore } from '../src/store.ts';

const plane = () => {
  const store = new CloudStore(':memory:');
  return {
    store,
    plane: createControlPlane({
      apiToken: 'admin',
      workerToken: 'worker',
      store,
      consoleOrigin: 'https://app.phoneuse.dev',
    }),
  };
};

const post = (p: ReturnType<typeof createControlPlane>, path: string, body: unknown, key?: string) =>
  p.fetch(
    new Request(`http://cp${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

describe('device authorization (RFC 8628)', () => {
  test('start is public: a headless CLI needs no credentials to begin', async () => {
    const { plane: p } = plane();
    const res = await post(p, '/v1/device/start', { clientName: 'phone-use CLI' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      intervalMs: number;
    };
    expect(body.deviceCode).toHaveLength(32);
    // Human-typed code: grouped, and drawn from an unambiguous alphabet.
    expect(body.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(body.verificationUri).toBe('https://app.phoneuse.dev/device');
    expect(body.intervalMs).toBe(5000);
    p.close();
  });

  test('poll stays pending until a signed-in human approves, then yields the key once', async () => {
    const { store, plane: p } = plane();
    const tenant = store.createTenant('device-user');
    const start = (await (await post(p, '/v1/device/start', {})).json()) as {
      deviceCode: string;
      userCode: string;
    };

    const pending = (await (await post(p, '/v1/device/poll', { deviceCode: start.deviceCode })).json()) as {
      status: string;
    };
    expect(pending.status).toBe('pending');

    const approved = await post(p, '/v1/device/approve', { code: start.userCode }, tenant.key);
    expect(approved.status).toBe(200);

    const collected = (await (
      await post(p, '/v1/device/poll', { deviceCode: start.deviceCode })
    ).json()) as { status: string; key?: string };
    expect(collected.status).toBe('approved');
    expect(collected.key).toStartWith('pk_');
    // The minted key really works, and the old one is rotated out.
    expect(store.tenantForKey(collected.key as string)?.id).toBe(tenant.id);
    expect(store.tenantForKey(tenant.key)).toBeUndefined();

    // Read-once: a replayed poll (or a stolen device code) gets nothing.
    const replay = (await (
      await post(p, '/v1/device/poll', { deviceCode: start.deviceCode })
    ).json()) as { status: string };
    expect(replay.status).toBe('not_found');
    p.close();
  });

  test('approval requires a signed-in caller — an anonymous approve cannot mint a key', async () => {
    const { plane: p } = plane();
    const start = (await (await post(p, '/v1/device/start', {})).json()) as { userCode: string };
    const anon = await post(p, '/v1/device/approve', { code: start.userCode });
    expect(anon.status).toBe(401);
    p.close();
  });

  test('denied and expired codes never hand out a key', async () => {
    const { store, plane: p } = plane();
    const denied = (await (await post(p, '/v1/device/start', {})).json()) as {
      deviceCode: string;
      userCode: string;
    };
    expect((await post(p, '/v1/device/deny', { code: denied.userCode }, 'admin')).status).toBe(200);
    const afterDeny = (await (
      await post(p, '/v1/device/poll', { deviceCode: denied.deviceCode })
    ).json()) as { status: string; key?: string };
    expect(afterDeny.status).toBe('denied');
    expect(afterDeny.key).toBeUndefined();

    const stale = (await (await post(p, '/v1/device/start', {})).json()) as {
      deviceCode: string;
      userCode: string;
    };
    store.db
      .query('UPDATE device_auth SET expires_at = ? WHERE device_code = ?')
      .run(Date.now() - 1, stale.deviceCode);
    const afterExpiry = (await (
      await post(p, '/v1/device/poll', { deviceCode: stale.deviceCode })
    ).json()) as { status: string };
    expect(afterExpiry.status).toBe('expired');
    // An expired code is also unapprovable, so a late click can't revive it.
    expect(store.approveDeviceAuth(stale.userCode, store.createTenant('late').id)).toBe(false);
    p.close();
  });

  test('user codes are case-insensitive and trimmed — people type them by hand', () => {
    const store = new CloudStore(':memory:');
    const tenant = store.createTenant('typist');
    const { userCode } = store.startDeviceAuth();
    expect(store.approveDeviceAuth(` ${userCode.toLowerCase()} `, tenant.id)).toBe(true);
    store.close();
  });
});

import { afterEach, describe, expect, it } from 'bun:test';
import { CloudWaitlistError } from '@phone-use/sdk';
import { CloudClient } from '../src/client.ts';
import { createControlPlane } from '../src/control-plane.ts';
import { CloudStore } from '../src/store.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A control plane on a real port, so the client is tested over HTTP. */
function served() {
  const store = new CloudStore(':memory:');
  store.registerHost({ id: 'mac-1', platform: 'ios', capacity: 4, publicUrl: 'http://worker' });
  const control = createControlPlane({
    apiToken: 'admin',
    workerToken: 'worker',
    store,
    waitlistUrl: 'https://example.test/join',
  });
  cleanups.push(() => control.close());
  const server = Bun.serve({ port: 0, fetch: control.fetch });
  cleanups.push(() => server.stop());
  return { store, baseUrl: server.url.toString() };
}

const attempts = (store: CloudStore) =>
  store.db.query('SELECT account, platform, client FROM waitlist_attempts ORDER BY id').all() as Array<{
    account: string;
    platform: string | null;
    client: string;
  }>;

async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('CloudClient (the SDK surface) and the waitlist', () => {
  it('create from an account that is not approved throws CloudWaitlistError, and no phone starts', async () => {
    const { store, baseUrl } = served();
    const waiting = store.createTenant('waiting', { cloudApproved: false });
    const client = new CloudClient({ baseUrl, token: waiting.key });

    const error = await thrownBy(() => client.create({ platform: 'ios' }));
    expect(error).toBeInstanceOf(CloudWaitlistError);
    const waitlist = error as CloudWaitlistError;
    expect(waitlist.code).toBe('CLOUD_WAITLIST');
    expect(waitlist.waitlistUrl).toBe('https://example.test/join');
    expect(waitlist.message).toContain('Cloud phones are on a waitlist');
    expect(waitlist.message).toContain('https://example.test/join');
    // An SDK caller is pointed at the SDK's own local device, not at a shell command.
    expect(waitlist.localCommand).toContain("from '@phone-use/sdk'");

    // launch() is create + connect, so it is refused the same way.
    expect(await thrownBy(() => client.launch({ platform: 'ios' }))).toBeInstanceOf(CloudWaitlistError);

    expect(await client.list()).toEqual([]);
    const tenantId = store.tenantForKey(waiting.key)!.id;
    expect(attempts(store)).toEqual([
      { account: tenantId, platform: 'ios', client: 'sdk' },
      { account: tenantId, platform: 'ios', client: 'sdk' },
    ]);
  });

  it('create with no token throws CloudWaitlistError and is counted as an anonymous sdk attempt', async () => {
    const { store, baseUrl } = served();
    const saved = process.env.PHONE_USE_CLOUD_TOKEN;
    Reflect.deleteProperty(process.env, 'PHONE_USE_CLOUD_TOKEN');
    try {
      const client = new CloudClient({ baseUrl });
      const error = await thrownBy(() => client.create({ platform: 'android' }));
      expect(error).toBeInstanceOf(CloudWaitlistError);
      expect((error as Error).message).toContain('PHONE_USE_CLOUD_TOKEN');
      expect(attempts(store)).toEqual([{ account: 'anonymous', platform: 'android', client: 'sdk' }]);
      // Everything else still needs the token, and says so.
      expect(((await thrownBy(() => client.list())) as Error).message).toBe(
        'PHONE_USE_CLOUD_TOKEN or token is required',
      );
    } finally {
      if (saved !== undefined) process.env.PHONE_USE_CLOUD_TOKEN = saved;
    }
  });

  it('with no token, an unreachable control plane still gives the waitlist answer', async () => {
    const client = new CloudClient({ baseUrl: 'http://127.0.0.1:9', token: '' });
    const saved = process.env.PHONE_USE_CLOUD_TOKEN;
    Reflect.deleteProperty(process.env, 'PHONE_USE_CLOUD_TOKEN');
    try {
      const offline = new CloudClient({ baseUrl: 'http://127.0.0.1:9' });
      expect(await thrownBy(() => offline.create({ platform: 'ios' }))).toBeInstanceOf(CloudWaitlistError);
      expect(await thrownBy(() => client.create({ platform: 'ios' }))).toBeInstanceOf(CloudWaitlistError);
    } finally {
      if (saved !== undefined) process.env.PHONE_USE_CLOUD_TOKEN = saved;
    }
  });

  it('an approved account creates as before', async () => {
    const { store, baseUrl } = served();
    const approved = store.createTenant('approved');
    const client = new CloudClient({ baseUrl, token: approved.key });
    const sandbox = await client.create({ platform: 'ios', wait: false });
    expect(sandbox.id).toStartWith('sbx_');
    expect(sandbox.status).toBe('queued');
    expect(attempts(store)).toEqual([]);
  });
});

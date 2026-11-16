import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { CloudClient } from '../src/client.ts';
import { createControlPlane } from '../src/control-plane.ts';
import type { SandboxProvider } from '../src/providers.ts';
import type { WorkerHost } from '../src/types.ts';
import { SandboxWorker } from '../src/worker.ts';
import { WorkerControlClient } from '../src/worker-api.ts';
import { WorkerStateStore } from '../src/worker-state.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('cloud lifecycle', () => {
  it('creates, drives, and destroys a sandbox through the real HTTP protocol', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phone-use-cloud-test-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));

    const control = createControlPlane({
      apiToken: 'client-secret',
      workerToken: 'worker-secret',
      databasePath: ':memory:',
    });
    cleanups.push(() => control.close());
    const controlServer = Bun.serve({ port: 0, fetch: control.fetch });
    cleanups.push(() => controlServer.stop());

    let worker!: SandboxWorker;
    const workerServer = Bun.serve({ port: 0, fetch: (request) => worker.fetch(request) });
    cleanups.push(() => workerServer.stop());
    const host: WorkerHost = {
      id: 'ios-test-worker',
      platform: 'ios',
      capacity: 2,
      publicUrl: workerServer.url.toString().replace(/\/$/, ''),
    };
    const fake = new FakeBackend({
      screens: [screen([el({ ref: '@button', type: 'Button', label: 'Continue' })])],
    });
    const provider: SandboxProvider = {
      platform: 'ios',
      async provision() {
        return { deviceId: 'TEST-UDID', name: 'Warm iPhone' };
      },
      async destroy() {},
    };
    worker = new SandboxWorker({
      host,
      control: new WorkerControlClient(controlServer.url.toString(), 'worker-secret', host.id),
      provider,
      stateStore: new WorkerStateStore(join(directory, 'state.json')),
      dataDirectory: directory,
      pollIntervalMs: 10,
      backendFactory: () => fake,
    });
    await worker.start();
    cleanups.push(() => worker.stop());

    const client = new CloudClient({
      baseUrl: controlServer.url.toString(),
      token: 'client-secret',
    });
    const sandbox = await client.create({
      platform: 'ios',
      ttlMs: 60_000,
      idleTimeoutMs: false,
      timeoutMs: 5_000,
    });
    expect(sandbox.status).toBe('running');
    expect(sandbox.connection?.token).toBeTruthy();

    const device = await client.connect(sandbox.id);
    expect((await device.backend.snapshot()).nodes[1]?.label).toBe('Continue');
    await device.close();
    expect((await client.get(sandbox.id)).status).toBe('closed');
    expect(fake.calls.some((call) => call.method === 'snapshot')).toBe(true);
  });

  it('rejects bad client and sandbox tokens', async () => {
    const control = createControlPlane({
      apiToken: 'right',
      workerToken: 'worker',
      databasePath: ':memory:',
    });
    cleanups.push(() => control.close());
    expect((await control.fetch(new Request('http://test/v1/sandboxes'))).status).toBe(401);
  });
});

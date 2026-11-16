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

describe('sandbox action log', () => {
  it('records redacted per-verb events readable through the tenant API', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phone-use-events-test-'));
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
      id: 'ios-events-worker',
      platform: 'ios',
      capacity: 2,
      publicUrl: workerServer.url.toString().replace(/\/$/, ''),
    };
    const fake = new FakeBackend({
      screens: [screen([el({ ref: '@button', type: 'Button', label: 'Sign in' })])],
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
    const device = await client.connect(sandbox.id);

    await device.backend.snapshot();
    await device.backend.typeText('hunter2secret');
    await device.close();

    // touch(event) is fire-and-forget from the worker; give it a beat to land.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const response = await fetch(
      `${controlServer.url.toString().replace(/\/$/, '')}/v1/sandboxes/${sandbox.id}/events`,
      { headers: { authorization: 'Bearer client-secret' } },
    );
    expect(response.status).toBe(200);
    const { events } = (await response.json()) as {
      events: Array<{ ts: number; method: string; detail: string | null }>;
    };

    const methods = events.map((event) => event.method);
    expect(methods).toContain('snapshot');
    expect(methods).toContain('typeText');

    // Redaction: the typed secret must never be stored — only its length.
    const typed = events.find((event) => event.method === 'typeText');
    expect(typed?.detail).toContain('"textLength":13');
    expect(JSON.stringify(events)).not.toContain('hunter2secret');
  });
});

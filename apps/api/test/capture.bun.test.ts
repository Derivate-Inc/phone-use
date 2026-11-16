import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { CaptureManager } from '../src/capture.ts';
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

const tmp = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phone-use-capture-test-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

const flow = (sandboxId: string | null, host: string) =>
  `${JSON.stringify({
    ts: '2026-09-19T00:00:00Z',
    sandboxId,
    udid: 'U1',
    method: 'GET',
    host,
    path: '/',
    status: 200,
    reqBytes: 0,
    resBytes: 10,
    contentType: 'text/html',
    durMs: 12,
    error: null,
  })}\n`;

describe('CaptureManager', () => {
  it('maintains the udid→sandbox map across provision, restore, and delete', async () => {
    const directory = await tmp();
    const capture = new CaptureManager({ dataDirectory: directory });
    const mapPath = join(directory, 'capture', 'devices.json');
    // start() needs mitmdump; the map machinery must work without it (tests,
    // and the worker calls setDevice before flows ever exist).
    await Bun.write(mapPath, '{}');

    await capture.setDevice('sbx-1', 'UDID-A');
    expect(JSON.parse(await readFile(mapPath, 'utf8'))).toEqual({ 'UDID-A': 'sbx-1' });

    // Checkpoint restore: same sandbox, new udid — the OLD udid must go, or a
    // recycled udid would attribute a stranger's traffic to this sandbox.
    await capture.setDevice('sbx-1', 'UDID-B');
    expect(JSON.parse(await readFile(mapPath, 'utf8'))).toEqual({ 'UDID-B': 'sbx-1' });

    await capture.setDevice('sbx-2', 'UDID-C');
    await capture.removeDevice('sbx-1');
    expect(JSON.parse(await readFile(mapPath, 'utf8'))).toEqual({ 'UDID-C': 'sbx-2' });
  });

  it('filters flows per sandbox and survives a torn tail line', async () => {
    const directory = await tmp();
    const capture = new CaptureManager({ dataDirectory: directory });
    const flowsPath = join(directory, 'capture', 'flows.jsonl');
    await Bun.write(
      flowsPath,
      flow('sbx-1', 'api.example.com') +
        flow('sbx-2', 'other.example.com') +
        flow(null, 'unattributed.example.com') +
        flow('sbx-1', 'cdn.example.com') +
        '{"ts":"2026-09-19T00:00:01Z","sandboxId":"sbx-1","met', // torn mid-write
    );
    const flows = await capture.flowsFor('sbx-1');
    expect(flows.map((f) => f.host)).toEqual(['api.example.com', 'cdn.example.com']);
    expect(await capture.flowsFor('sbx-404')).toEqual([]);
  });
});

describe('worker /traffic endpoint', () => {
  it('serves a sandbox its own flows over the wire, and 501s without capture', async () => {
    const directory = await tmp();
    const capture = new CaptureManager({ dataDirectory: directory });

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
      id: 'capture-worker',
      platform: 'ios',
      capacity: 2,
      publicUrl: workerServer.url.toString().replace(/\/$/, ''),
    };
    const provider: SandboxProvider = {
      platform: 'ios',
      async provision() {
        return { deviceId: 'UDID-A' };
      },
      async destroy() {},
    };
    const fake = new FakeBackend({
      screens: [screen([el({ ref: '@b', type: 'Button', label: 'Go' })])],
    });
    worker = new SandboxWorker({
      host,
      control: new WorkerControlClient(controlServer.url.toString(), 'worker-secret', host.id),
      provider,
      stateStore: new WorkerStateStore(join(directory, 'state.json')),
      dataDirectory: directory,
      pollIntervalMs: 10,
      backendFactory: () => fake,
      capture,
    });
    await worker.start();
    cleanups.push(() => worker.stop());

    const client = new CloudClient({ baseUrl: controlServer.url.toString(), token: 'client-secret' });
    const sandbox = await client.create({ platform: 'ios', ttlMs: 60_000, idleTimeoutMs: false, timeoutMs: 5_000 });
    const connection = sandbox.connection!;

    // Provisioning must have registered the device for attribution.
    const map = JSON.parse(await readFile(join(directory, 'capture', 'devices.json'), 'utf8'));
    expect(map['UDID-A']).toBe(sandbox.id);

    // Two sandboxes' flows in one host file; each sees only its own.
    await writeFile(
      join(directory, 'capture', 'flows.jsonl'),
      flow(sandbox.id, 'mine.example.com') + flow('sbx-other', 'theirs.example.com'),
    );
    const response = await fetch(`${connection.endpoint}/traffic`, {
      headers: { authorization: `Bearer ${connection.token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { flows: Array<{ host: string }> };
    expect(body.flows.map((f) => f.host)).toEqual(['mine.example.com']);

    // Wrong token → 401, never data.
    const denied = await fetch(`${connection.endpoint}/traffic`, {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(denied.status).toBe(401);
  });
});

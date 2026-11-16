import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeBackend, screen } from '@phone-use/sdk/testing';
import { CloudClient } from '../src/client.ts';
import { createControlPlane } from '../src/control-plane.ts';
import type { SandboxProvider } from '../src/providers.ts';
import type { WorkerHost } from '../src/types.ts';
import { MAX_APP_BYTES, SandboxWorker } from '../src/worker.ts';
import { WorkerControlClient } from '../src/worker-api.ts';
import { WorkerStateStore } from '../src/worker-state.ts';

// A real iOS app is hundreds of megabytes. The original upload path carried the
// zip as base64 inside a JSON body, which inflates it by a third and capped the
// real ceiling near 144MB — Wikipedia's 159MB build simply closed the socket.
// These tests pin the raw-stream route that replaced it.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A live control plane + worker with one running sandbox, wired over real HTTP. */
async function fleet() {
  const directory = await mkdtemp(join(tmpdir(), 'phone-use-upload-test-'));
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
  // Mirror worker-main.ts: Bun's default body cap is 128MB, well under a real app.
  const workerServer = Bun.serve({
    port: 0,
    maxRequestBodySize: MAX_APP_BYTES + 16_000_000,
    fetch: (request) => worker.fetch(request),
  });
  cleanups.push(() => workerServer.stop());
  const host: WorkerHost = {
    id: 'ios-upload-worker',
    platform: 'ios',
    capacity: 1,
    publicUrl: workerServer.url.toString().replace(/\/$/, ''),
  };
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
    backendFactory: () => new FakeBackend({ screens: [screen([])] }),
  });
  await worker.start();
  cleanups.push(() => worker.stop());

  const client = new CloudClient({ baseUrl: controlServer.url.toString(), token: 'client-secret' });
  const sandbox = await client.create({
    platform: 'ios',
    ttlMs: 60_000,
    idleTimeoutMs: false,
    timeoutMs: 5_000,
  });
  const connection = sandbox.connection;
  if (!connection) throw new Error('sandbox came back without a connection');
  return { directory, endpoint: connection.endpoint, token: connection.token };
}

// ditto(1) is macOS-only and CI runs the API suite on ubuntu. The two tests
// that need a real zip skip there rather than fail; the auth and empty-body
// cases are platform-independent and always run.
const hasDitto = Bun.spawnSync(['which', 'ditto']).exitCode === 0;

/** Zip a directory the way the CLI does, so the test exercises the real format. */
async function zipOf(directory: string, entry: string): Promise<Blob> {
  const zipPath = join(directory, 'upload.zip');
  const zip = Bun.spawn(['ditto', '-c', '-k', '--keepParent', entry, zipPath], { stderr: 'pipe' });
  if ((await zip.exited) !== 0) throw new Error(await new Response(zip.stderr).text());
  return Bun.file(zipPath);
}

const upload = (endpoint: string, token: string, body: Blob) =>
  fetch(`${endpoint}/app`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' },
    body,
  });

describe('streamed app upload', () => {
  it.skipIf(!hasDitto)('accepts a zip far larger than the old base64 ceiling', async () => {
    const { directory, endpoint, token } = await fleet();

    // 180MB of incompressible payload — impossible on the JSON path, where
    // base64 would have inflated it to ~240MB against a 192MB cap.
    const payload = join(directory, 'Big.app');
    await mkdir(payload, { recursive: true });
    const chunk = new Uint8Array(1_000_000);
    const handle = Bun.file(join(payload, 'binary')).writer();
    for (let i = 0; i < 180; i++) {
      crypto.getRandomValues(chunk);
      handle.write(chunk);
    }
    await handle.end();

    const response = await upload(endpoint, token, await zipOf(directory, payload));
    const body = (await response.json()) as { ok: boolean; error?: { message: string } };

    // TEST-UDID is not a real simulator, so the install itself cannot succeed —
    // reaching simctl at all proves the bytes streamed, unzipped, and the .app
    // was found.
    expect(body.error?.message ?? '').toMatch(/simctl install failed/);
  }, 120_000);

  it.skipIf(!hasDitto)('reports a zip that contains no .app rather than failing opaquely', async () => {
    const { directory, endpoint, token } = await fleet();
    const loose = join(directory, 'notanapp');
    await mkdir(loose, { recursive: true });
    await writeFile(join(loose, 'readme.txt'), 'no bundle here');

    const response = await upload(endpoint, token, await zipOf(directory, loose));
    const body = (await response.json()) as { ok: boolean; error?: { message: string } };
    expect(body.error?.message).toContain('no .app bundle found');
  }, 30_000);

  it('refuses an upload carrying the wrong sandbox token', async () => {
    const { endpoint } = await fleet();
    const response = await upload(endpoint, 'not-the-token', new Blob([new Uint8Array([1, 2, 3])]));
    expect(response.status).toBe(401);
  });

  it('rejects an empty body instead of unzipping nothing', async () => {
    const { endpoint, token } = await fleet();
    const response = await upload(endpoint, token, new Blob([]));
    expect(response.status).toBe(400);
  });
});

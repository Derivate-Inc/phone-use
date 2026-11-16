import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { CloudClient } from '../src/client.ts';
import { createControlPlane } from '../src/control-plane.ts';
import type { SandboxProvider } from '../src/providers.ts';
import type { ProvisionedResource, RpcResponse, WorkerHost } from '../src/types.ts';
import { SandboxWorker } from '../src/worker.ts';
import { WorkerControlClient } from '../src/worker-api.ts';
import { WorkerStateStore } from '../src/worker-state.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Provider whose checkpoint verbs record calls and mint predictable ids. */
function checkpointingProvider() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  let clones = 0;
  const provider: SandboxProvider = {
    platform: 'ios',
    async provision() {
      return { deviceId: 'DEVICE-0', name: 'Warm iPhone' };
    },
    async destroy(resource) {
      calls.push({ op: 'destroy', args: [resource.deviceId] });
    },
    async checkpoint(resource, name) {
      calls.push({ op: 'checkpoint', args: [resource.deviceId, name] });
      return { checkpointUdid: `CKPT-UDID-${++clones}` };
    },
    async restoreCheckpoint(resource, checkpointUdid, name): Promise<ProvisionedResource> {
      calls.push({ op: 'restoreCheckpoint', args: [resource.deviceId, checkpointUdid, name] });
      return { deviceId: `RESTORED-${clones}`, name };
    },
    async deleteCheckpoint(checkpointUdid) {
      calls.push({ op: 'deleteCheckpoint', args: [checkpointUdid] });
    },
  };
  return { provider, calls };
}

async function startCloud(provider: SandboxProvider, backendsSeen: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'phone-use-checkpoint-test-'));
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
    id: 'ios-checkpoint-worker',
    platform: 'ios',
    capacity: 2,
    publicUrl: workerServer.url.toString().replace(/\/$/, ''),
  };
  const fake = new FakeBackend({
    screens: [screen([el({ ref: '@button', type: 'Button', label: 'Continue' })])],
  });
  worker = new SandboxWorker({
    host,
    control: new WorkerControlClient(controlServer.url.toString(), 'worker-secret', host.id),
    provider,
    stateStore: new WorkerStateStore(join(directory, 'state.json')),
    dataDirectory: directory,
    pollIntervalMs: 10,
    backendFactory: (_platform, deviceId) => {
      backendsSeen.push(deviceId);
      return fake;
    },
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
  expect(sandbox.status).toBe('running');
  const connection = sandbox.connection!;
  const rpc = async (method: string, ...args: unknown[]): Promise<RpcResponse> => {
    const response = await fetch(`${connection.endpoint}/rpc`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ method, args }),
    });
    return (await response.json()) as RpcResponse;
  };
  return { client, sandbox, rpc };
}

describe('device checkpoints', () => {
  it('saves, lists, restores, and deletes a checkpoint over the RPC wire', async () => {
    const { provider, calls } = checkpointingProvider();
    const backendsSeen: string[] = [];
    const { rpc } = await startCloud(provider, backendsSeen);

    const saved = await rpc('checkpoint', { label: 'clean' });
    expect(saved.ok).toBe(true);
    const checkpoint = (saved as { result: { id: string; label?: string } }).result;
    expect(checkpoint.id).toStartWith('ckpt_');
    expect(checkpoint.label).toBe('clean');
    // The provider was handed the live device and a name that ties the clone
    // back to its sandbox (that name is how a human finds it in simctl list).
    const saveCall = calls.find((c) => c.op === 'checkpoint');
    expect(saveCall?.args[0]).toBe('DEVICE-0');
    expect(String(saveCall?.args[1])).toContain('phone-use-ckpt-');

    const listed = await rpc('listCheckpoints');
    expect(listed.ok).toBe(true);
    expect((listed as { result: unknown[] }).result).toHaveLength(1);

    // Restore by label. The device identity changes; the worker must rebind
    // its backend to the new udid or every later verb hits a dead device.
    const restored = await rpc('restoreCheckpoint', 'clean');
    expect(restored.ok).toBe(true);
    expect((restored as { result: { deviceId: string } }).result.deviceId).toBe('RESTORED-1');
    expect(calls.find((c) => c.op === 'restoreCheckpoint')?.args[1]).toBe('CKPT-UDID-1');
    expect(backendsSeen.at(-1)).toBe('RESTORED-1');

    // The checkpoint SURVIVES a restore — that is the whole point.
    const listedAfter = await rpc('listCheckpoints');
    expect((listedAfter as { result: unknown[] }).result).toHaveLength(1);
    // …and the device still answers verbs after the swap.
    const snapshot = await rpc('snapshot');
    expect(snapshot.ok).toBe(true);

    const deleted = await rpc('deleteCheckpoint', checkpoint.id);
    expect((deleted as { result: { deleted: boolean } }).result.deleted).toBe(true);
    expect(calls.find((c) => c.op === 'deleteCheckpoint')?.args[0]).toBe('CKPT-UDID-1');
    expect(((await rpc('listCheckpoints')) as { result: unknown[] }).result).toHaveLength(0);
  });

  it('destroys checkpoint artifacts when the sandbox is deleted', async () => {
    const { provider, calls } = checkpointingProvider();
    const { client, sandbox, rpc } = await startCloud(provider, []);

    expect((await rpc('checkpoint', { label: 'keep' })).ok).toBe(true);
    await client.close(sandbox.id);

    const deletes = calls.filter((c) => c.op === 'deleteCheckpoint').map((c) => c.args[0]);
    expect(deletes).toContain('CKPT-UDID-1');
    // Checkpoint cleanup must happen alongside device destruction, not instead of it.
    expect(calls.some((c) => c.op === 'destroy')).toBe(true);
  });

  it('fails cleanly when the provider has no checkpoint support', async () => {
    const bare: SandboxProvider = {
      platform: 'ios',
      async provision() {
        return { deviceId: 'DEVICE-0' };
      },
      async destroy() {},
    };
    const { rpc } = await startCloud(bare, []);
    const response = await rpc('checkpoint', {});
    expect(response.ok).toBe(false);
    expect((response as { error: { message: string } }).error.message).toContain('not supported');
  });
});

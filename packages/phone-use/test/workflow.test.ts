import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeviceHandle } from '@phone-use/sdk';
import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { expect, it } from 'vitest';
import { runWorkflow, type Workflow } from '../src/workflow.ts';

const fixture = () => {
  const backend = new FakeBackend({
    screens: [screen([el({ ref: '@e1', label: 'Welcome' })], { appName: 'Test', appBundleId: 'app.test' })],
  });
  backend.screenshot = async ({ path }) => {
    await writeFile(path, 'test screenshot');
    return { path };
  };
  const device = createDeviceHandle({
    id: 'workflow-device',
    platform: 'ios',
    backend,
    createdByUs: false,
    idleTimeoutMs: false,
    doClose: async () => {},
  });
  return { backend, device };
};
const flow: Workflow = {
  version: 1,
  name: 'welcome',
  steps: [{ tool: 'observe', args: {} }],
  expectations: [{ kind: 'screen', contains: 'Welcome', app: 'app.test' }],
};

it('executes, independently verifies, and writes one evidence bundle without closing the device', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-flow-'));
  try {
    const { device } = fixture();
    const result = await runWorkflow(flow, { device, outputDir: dir });
    expect(result.status).toBe('verified');
    expect(result.steps).toHaveLength(1);
    expect(result.device.id).toBe('workflow-device');
    expect(result.evidenceErrors).toEqual([]);
    expect(JSON.parse(await readFile(result.artifacts.result!, 'utf8')).runId).toBe(result.runId);
    expect(JSON.parse(await readFile(result.artifacts.workflow!, 'utf8')).name).toBe('welcome');
    expect(device.isClosed).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('validates every step before performing any action', async () => {
  const { backend, device } = fixture();
  await expect(
    runWorkflow(
      {
        ...flow,
        steps: [
          { tool: 'tap', args: { label: 'Go' } },
          { tool: 'missing', args: {} },
        ],
      },
      { device },
    ),
  ).rejects.toThrow('Unknown workflow tool');
  expect(backend.calls).toHaveLength(0);
});

it('stops at a failed assertion and never performs the next mutation', async () => {
  const { backend, device } = fixture();
  const result = await runWorkflow(
    {
      ...flow,
      steps: [
        { tool: 'observe', args: { expect: 'Missing' } },
        { tool: 'tap', args: { label: 'Welcome' } },
      ],
    },
    { device },
  );
  expect(result.status).toBe('failed');
  expect(result.failure).toMatchObject({ phase: 'step', step: 1 });
  expect(backend.calls.some((c) => c.method === 'press')).toBe(false);
});

it('does not call a workflow without expectations verified', async () => {
  const { device } = fixture();
  expect((await runWorkflow({ ...flow, expectations: [] }, { device })).status).toBe('unverified');
});

it('rejects concurrent workflows on the same device and releases the claim afterward', async () => {
  const { device } = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const first = runWorkflow(
    { ...flow, install: 'app.app' },
    {
      device,
      installApp: async () => {
        ready();
        await gate;
      },
    },
  );
  await entered;
  await expect(runWorkflow(flow, { device })).rejects.toThrow('already has an active workflow');
  release();
  await first;
  expect((await runWorkflow(flow, { device })).status).toBe('verified');
});

it('cancellation stops before installation or mutation', async () => {
  const { backend, device } = fixture();
  const controller = new AbortController();
  controller.abort();
  const result = await runWorkflow(flow, { device, signal: controller.signal });
  expect(result.status).toBe('stopped');
  expect(backend.calls).toHaveLength(0);
});

it('opens an explicit app when a fresh device has no active session', async () => {
  const { backend, device } = fixture();
  const snapshot = backend.snapshot.bind(backend);
  let opened = false;
  backend.snapshot = async () => {
    if (!opened) throw Object.assign(new Error('open first'), { code: 'SESSION_NOT_FOUND' });
    return snapshot();
  };
  backend.openApp = async () => {
    opened = true;
    return {} as never;
  };
  const result = await runWorkflow({ ...flow, app: 'app.test' }, { device });
  expect(result.status).toBe('verified');
});

it('shares the device claim with embedded prompts', async () => {
  const { createSession } = await import('../src/sdk.ts');
  const { device } = fixture();
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const session = createSession({
    device,
    runner: {
      id: 'test',
      reset() {},
      capabilities: new Set(),
      async runTurn() {
        ready();
        await gate;
        return { status: 'completed', summary: 'done' };
      },
    },
  });
  const prompt = session.prompt('wait');
  await entered;
  await expect(runWorkflow(flow, { device })).rejects.toThrow('already has an active workflow');
  release();
  await prompt;
  expect((await runWorkflow(flow, { device })).status).toBe('verified');
});

import { createDeviceHandle } from '@phone-use/sdk';
import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { expect, it } from 'vitest';
import { createSession } from '../src/sdk.ts';
import { checkSnapshot, outcomeStatus, runExitCode, verifyOutcome } from '../src/verification.ts';

it('checks values and app identity rather than treating a label as the desired value', () => {
  const snapshot = { appBundleId: 'app.test', nodes: [{ label: 'Enabled', value: '0' }] };
  expect(checkSnapshot(snapshot, { kind: 'field', label: 'Enabled', equals: '1' }).status).toBe('failed');
  expect(checkSnapshot(snapshot, { kind: 'app', bundleId: 'wrong.app' }).status).toBe('failed');
  expect(checkSnapshot({ nodes: [] }, { kind: 'screen', contains: 'Success' }).status).toBe('unavailable');
  expect(checkSnapshot(snapshot, { kind: 'screen', contains: 'Enabled', app: 'app.test' }).status).toBe(
    'passed',
  );
});

it('cannot pass with no checks, unavailable evidence, or a failed execution', () => {
  expect(outcomeStatus('completed', [])).toBe('unverified');
  expect(outcomeStatus('completed', [{ id: 'x', at: '', status: 'unavailable', detail: '' }])).toBe(
    'unverified',
  );
  expect(outcomeStatus('failed', [{ id: 'x', at: '', status: 'passed', detail: '' }])).toBe('failed');
  expect(runExitCode('unverified')).toBe(4);
});

it('captures external oracle errors without turning them into success', async () => {
  const checks = await verifyOutcome(
    new FakeBackend({ screens: [screen([])] }),
    [],
    [
      {
        id: 'database',
        check: async () => {
          throw new Error('DB offline');
        },
      },
    ],
  );
  expect(checks[0]).toMatchObject({ id: 'database', status: 'unavailable', detail: 'Error: DB offline' });
});

it('a convincing model summary cannot override failed checks; results are snapshots per prompt', async () => {
  const device = createDeviceHandle({
    id: 'verification',
    platform: 'ios',
    createdByUs: false,
    idleTimeoutMs: false,
    doClose: async () => {},
    backend: new FakeBackend({ screens: [screen([el({ ref: '@e1', label: 'Login failed' })])] }),
  });
  const session = createSession({
    device,
    runner: {
      id: 'liar',
      capabilities: new Set(),
      reset() {},
      async runTurn(req) {
        await req.tools.find((t) => t.name === 'note')!.run({ op: 'save', key: 'x', content: 'data' });
        return { status: 'completed', summary: 'Successfully logged in!' };
      },
    },
  });
  const first = await session.prompt('login', { expectations: [{ kind: 'screen', contains: 'Welcome' }] });
  expect(first.status).toBe('failed');
  expect(first.checks[0]?.status).toBe('failed');
  const second = await session.prompt('look', {
    expectations: [{ kind: 'screen', contains: 'Login failed' }],
  });
  expect(second.status).toBe('verified');
  expect(first.steps).toHaveLength(1);
  expect(second.steps).toHaveLength(1);
  expect(second.runId).not.toBe(first.runId);
});

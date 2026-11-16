import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionFailedError, DeviceNotFoundError, ios, TimeoutError } from '../src/index.ts';
import { createDeviceHandle } from '../src/lifecycle.ts';
import { FakeBackend, type ScriptedExecStep, screen, scriptedExecRunner } from '../src/testing.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const UDID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const createStep = (stdout = `${UDID}\n`): ScriptedExecStep => ({ stdout });
const bootStep: ScriptedExecStep = { stdout: '' };
const bootstatusStep: ScriptedExecStep = { stdout: 'Device already booted, nothing to do.\n' };

describe('ios.launch', () => {
  it('happy path: create → boot → bootstatus, returns the pinned handle', async () => {
    const exec = scriptedExecRunner([createStep(), bootStep, bootstatusStep]);
    const device = await ios.launch({ exec, idleTimeoutMs: false });

    expect(exec.calls.map((c) => c.file)).toEqual(['xcrun', 'xcrun', 'xcrun']);
    const [create, boot, bootstatus] = exec.calls.map((c) => c.args);
    expect(create!.slice(0, 2)).toEqual(['simctl', 'create']);
    expect(create![2]).toMatch(/^phone-use-[0-9a-f]{8}$/); // orphan-discovery prefix
    expect(create![3]).toBe('iPhone 16'); // default device type
    expect(create!.length).toBe(4); // no runtime → simctl picks newest
    expect(boot).toEqual(['simctl', 'boot', UDID]);
    expect(bootstatus).toEqual(['simctl', 'bootstatus', UDID, '-b']);

    expect(device.id).toBe(UDID);
    expect(device.platform).toBe('ios');
    expect(device.createdByUs).toBe(true);
    expect(device.status).toBe('running');
    expect(device.backendName).toBe('xctest');
    expect(device.capabilities.has('snapshot')).toBe(true);
    expect(exec.remaining()).toBe(0);
  });

  it('explicit deviceType/runtime/name/simulatorDeviceSet reach simctl, with --set prefix everywhere', async () => {
    const exec = scriptedExecRunner([createStep(), bootStep, bootstatusStep]);
    await ios.launch({
      exec,
      idleTimeoutMs: false,
      deviceType: 'iPhone 15',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
      name: 'bench-sim',
      simulatorDeviceSet: '/tmp/devset',
    });
    const [create, boot, bootstatus] = exec.calls.map((c) => c.args);
    expect(create).toEqual([
      'simctl',
      '--set',
      '/tmp/devset',
      'create',
      'bench-sim',
      'iPhone 15',
      'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
    ]);
    expect(boot!.slice(0, 3)).toEqual(['simctl', '--set', '/tmp/devset']);
    expect(bootstatus!.slice(0, 3)).toEqual(['simctl', '--set', '/tmp/devset']);
  });

  it('unparseable create output → ActionFailedError carrying the stdout', async () => {
    const exec = scriptedExecRunner([{ stdout: 'Something went sideways\n' }]);
    await expect(ios.launch({ exec, idleTimeoutMs: false })).rejects.toThrowError(ActionFailedError);
    const exec2 = scriptedExecRunner([{ stdout: 'warning: blah\nnot-a-udid\n' }]);
    await expect(ios.launch({ exec: exec2, idleTimeoutMs: false })).rejects.toThrow(/not-a-udid/);
  });

  it('tolerates boot exit 149 (already booted)', async () => {
    const exec = scriptedExecRunner([
      createStep(),
      { code: 149, stderr: 'Unable to boot device in current state: Booted' },
      bootstatusStep,
    ]);
    const device = await ios.launch({ exec, idleTimeoutMs: false });
    expect(device.status).toBe('running');
  });

  it('boot failure after create deletes the leaked sim, then rethrows the ORIGINAL error', async () => {
    const exec = scriptedExecRunner([
      createStep(),
      { code: 1, stderr: 'Invalid device state' }, // boot fails hard
      { stdout: '' }, // best-effort delete
    ]);
    await expect(ios.launch({ exec, idleTimeoutMs: false })).rejects.toThrow(/Invalid device state/);
    expect(exec.calls[2]!.args).toEqual(['simctl', 'delete', UDID]);
  });

  it('bootstatus runner kill → TimeoutError', async () => {
    const exec = scriptedExecRunner([
      createStep(),
      bootStep,
      { killed: true },
      { stdout: '' }, // cleanup delete
    ]);
    await expect(ios.launch({ exec, idleTimeoutMs: false })).rejects.toThrowError(TimeoutError);
  });
});

describe('ios.connect', () => {
  it('connect(udid) to an already-booted sim only lists — no create/boot', async () => {
    const exec = scriptedExecRunner([{ stdout: fixture('simctl-list-all.json') }]);
    const device = await ios.connect('11111111-2222-3333-4444-555555555555', { exec, idleTimeoutMs: false });
    expect(exec.calls.length).toBe(1);
    expect(exec.calls[0]!.args).toEqual(['simctl', 'list', 'devices', '-j']);
    expect(device.createdByUs).toBe(false);
    expect(device.name).toBe('iPhone 16');
  });

  it('connect(udid) to a Shutdown sim boots it first', async () => {
    const exec = scriptedExecRunner([{ stdout: fixture('simctl-list-all.json') }, bootStep, bootstatusStep]);
    const device = await ios.connect('66666666-7777-8888-9999-000000000000', { exec, idleTimeoutMs: false });
    expect(exec.calls[1]!.args).toEqual(['simctl', 'boot', '66666666-7777-8888-9999-000000000000']);
    expect(device.createdByUs).toBe(false);
  });

  it('connect(unknown udid) → DeviceNotFoundError', async () => {
    const exec = scriptedExecRunner([{ stdout: fixture('simctl-list-all.json') }]);
    await expect(
      ios.connect('99999999-0000-1111-2222-333333333333', { exec, idleTimeoutMs: false }),
    ).rejects.toThrowError(DeviceNotFoundError);
  });

  it('connect() no-arg picks the booted available sim (the surviving auto-detect)', async () => {
    const exec = scriptedExecRunner([{ stdout: fixture('simctl-list-booted.json') }]);
    const device = await ios.connect(undefined, { exec, idleTimeoutMs: false });
    expect(exec.calls[0]!.args).toEqual(['simctl', 'list', 'devices', 'booted', '-j']);
    expect(device.id).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('connect() no-arg with nothing booted → DeviceNotFoundError', async () => {
    const exec = scriptedExecRunner([{ stdout: fixture('simctl-list-none-booted.json') }]);
    await expect(ios.connect(undefined, { exec, idleTimeoutMs: false })).rejects.toThrow(
      /no booted simulator/,
    );
  });
});

describe('close semantics', () => {
  it('close() on a launched device shuts down AND deletes; connect() only shuts down', async () => {
    const execA = scriptedExecRunner([
      createStep(),
      bootStep,
      bootstatusStep,
      { stdout: '' },
      { stdout: '' },
    ]);
    const launched = await ios.launch({ exec: execA, idleTimeoutMs: false });
    await launched.close();
    expect(execA.calls.slice(3).map((c) => c.args)).toEqual([
      ['simctl', 'shutdown', UDID],
      ['simctl', 'delete', UDID],
    ]);
    expect(launched.isClosed).toBe(true);

    const execB = scriptedExecRunner([{ stdout: fixture('simctl-list-booted.json') }, { stdout: '' }]);
    const connected = await ios.connect(undefined, { exec: execB, idleTimeoutMs: false });
    await connected.close();
    expect(execB.calls.slice(1).map((c) => c.args)).toEqual([
      ['simctl', 'shutdown', '11111111-2222-3333-4444-555555555555'],
    ]);
  });

  it('double-close is idempotent (no new simctl calls), shutdown-149 tolerated', async () => {
    const exec = scriptedExecRunner([
      createStep(),
      bootStep,
      bootstatusStep,
      { code: 149, stderr: 'Unable to shutdown device in current state: Shutdown' },
      { stdout: '' },
    ]);
    const device = await ios.launch({ exec, idleTimeoutMs: false });
    await device.close();
    const callsAfterFirst = exec.calls.length;
    await device.close();
    expect(exec.calls.length).toBe(callsAfterFirst);
    expect(device.isClosed).toBe(true);
  });

  it('Symbol.asyncDispose delegates to close()', async () => {
    const exec = scriptedExecRunner([createStep(), bootStep, bootstatusStep, { stdout: '' }, { stdout: '' }]);
    const device = await ios.launch({ exec, idleTimeoutMs: false });
    await device[Symbol.asyncDispose]();
    expect(device.isClosed).toBe(true);
    expect(exec.calls[3]!.args[1]).toBe('shutdown');
  });
});

describe('idle lease + reaper (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('default 3-minute lease reaps: shutdown+delete fire, onIdleClose observes', async () => {
    const exec = scriptedExecRunner([createStep(), bootStep, bootstatusStep, { stdout: '' }, { stdout: '' }]);
    let reaped: string | null = null;
    const device = await ios.launch({ exec, onIdleClose: (d) => (reaped = d.id) });
    await vi.advanceTimersByTimeAsync(180_000); // fires the reaper
    expect(device.isClosed).toBe(true); // status flips synchronously
    // The close chain includes best-effort real I/O (closeSession against a
    // daemon that isn't there) — settle it under REAL time, not fake.
    vi.useRealTimers();
    await vi.waitFor(() => expect(reaped).toBe(UDID), { timeout: 3000 });
    expect(exec.calls.slice(3).map((c) => c.args[1])).toEqual(['shutdown', 'delete']);
  });

  it('extendLease defers expiry; one-shot override window works', async () => {
    const exec = scriptedExecRunner([createStep(), bootStep, bootstatusStep, { stdout: '' }, { stdout: '' }]);
    const device = await ios.launch({ exec });
    await vi.advanceTimersByTimeAsync(170_000);
    device.extendLease();
    await vi.advanceTimersByTimeAsync(170_000);
    expect(device.status).toBe('running'); // 340s wall, but lease re-armed at 170s
    device.extendLease(30_000); // one-shot shorter window
    await vi.advanceTimersByTimeAsync(30_000);
    expect(device.isClosed).toBe(true);
  });

  it('idleTimeoutMs: false never arms', async () => {
    const exec = scriptedExecRunner([createStep(), bootStep, bootstatusStep]);
    const device = await ios.launch({ exec, idleTimeoutMs: false });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(device.status).toBe('running');
  });

  it('backend activity through the handle touches the lease', async () => {
    // Drive the handle over a FakeBackend via the internal factory — the unit
    // under test is the touch-wrapping proxy, not simctl.
    let closed = false;
    const device = createDeviceHandle({
      id: 'fake-1',
      platform: 'ios',
      backend: new FakeBackend({ screens: [screen([])] }),
      createdByUs: false,
      idleTimeoutMs: 180_000,
      doClose: async () => {
        closed = true;
      },
    });
    await vi.advanceTimersByTimeAsync(170_000);
    await device.backend.snapshot(); // activity → lease re-arms
    await vi.advanceTimersByTimeAsync(170_000);
    expect(device.status).toBe('running');
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(device.isClosed).toBe(true);
    expect(closed).toBe(true);
  });

  it('two devices are independent: closing A leaves B; leases do not cross', async () => {
    const execA = scriptedExecRunner([
      createStep(),
      bootStep,
      bootstatusStep,
      { stdout: '' },
      { stdout: '' },
    ]);
    const execB = scriptedExecRunner([
      createStep('BBBBBBBB-BBBB-CCCC-DDDD-EEEEEEEEEEEE\n'),
      bootStep,
      bootstatusStep,
      { stdout: '' },
      { stdout: '' },
    ]);
    const a = await ios.launch({ exec: execA, idleTimeoutMs: false });
    const b = await ios.launch({ exec: execB });
    await a.close();
    expect(a.isClosed).toBe(true);
    expect(b.status).toBe('running');
    expect(execB.calls.length).toBe(3); // B saw no shutdown/delete from A's close
    await vi.advanceTimersByTimeAsync(180_000);
    expect(b.isClosed).toBe(true);
  });
});

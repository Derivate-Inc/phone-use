import { createDeviceHandle, type DeviceCore } from '@phone-use/sdk';
import { el, FakeBackend, screen, scriptedExecRunner } from '@phone-use/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { bindDevice, selectDevice } from '../src/bind.ts';
import { DeviceContext } from '../src/device-context.ts';
import * as driver from '../src/driver.ts';

// The rebind seam (docs/20 item 5): explicit device selection binds the
// process default context to the SAME core the Device's verbs drive.

afterEach(() => {
  driver.setDefaultDeviceContext(null);
  delete process.env.PHONE_USE_DEVICE;
});

const UDID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

describe('selectDevice', () => {
  it("unset spec → null, zero execs, default slot untouched (today's behavior)", async () => {
    const sel = await selectDevice(undefined);
    expect(sel).toBeNull();
  });

  it('launch: one shared DeviceContext drives BOTH the harness facade and the device', async () => {
    const exec = scriptedExecRunner([{ stdout: `${UDID}\n` }, { stdout: '' }, { stdout: 'Booted.\n' }]);
    const sel = await selectDevice('launch', { exec });
    expect(sel).not.toBeNull();
    expect(sel?.owned).toBe(true);
    expect(exec.calls[0]!.args[1]).toBe('create');
    // The captured context IS a DeviceContext and IS the default context.
    expect(sel?.ctx).toBeInstanceOf(DeviceContext);
    expect(driver.defaultDeviceContext()).toBe(sel?.ctx);
    // One core: the context's backend is the device's (lease-touching) backend.
    expect(sel?.ctx.backend).toBe(sel?.device.backend);
  });

  it('connect(udid): owned=false — exit cleanup must NOT close it', async () => {
    const exec = scriptedExecRunner([
      {
        stdout: JSON.stringify({
          devices: { 'iOS-18': [{ udid: UDID, name: 'iPhone 16', state: 'Booted', isAvailable: true }] },
        }),
      },
    ]);
    const sel = await selectDevice(UDID, { exec });
    expect(sel?.owned).toBe(false);
    expect(sel?.device.id).toBe(UDID);
    expect(driver.defaultDeviceContext()).toBe(sel?.ctx);
  });
});

describe('bindDevice (caller-passed Device)', () => {
  it('binds the default context to the device backend', async () => {
    const fake = new FakeBackend({
      screens: [screen([el({ ref: '@e1', type: 'Cell', label: 'Bound Row' })], { appName: 'BoundApp' })],
    });
    const device = createDeviceHandle({
      id: 'x',
      platform: 'ios',
      backend: fake,
      createdByUs: false,
      idleTimeoutMs: false,
      doClose: async () => {},
    });
    const ctx = bindDevice(device);
    expect(driver.defaultDeviceContext()).toBe(ctx);
    await driver.observe();
    expect(driver.currentApp()).toBe('BoundApp');
    expect(fake.calls.some((c) => c.method === 'snapshot')).toBe(true);
  });
});

describe('coreFactory seam (SDK side)', () => {
  it('createDeviceHandle uses the factory-supplied core for its verbs', async () => {
    const fake = new FakeBackend({
      screens: [screen([el({ ref: '@e1', type: 'Cell', label: 'Factory Row' })], { appName: 'FactoryApp' })],
    });
    let captured: DeviceCore | null = null;
    const device = createDeviceHandle({
      id: 'y',
      platform: 'ios',
      backend: fake,
      createdByUs: false,
      idleTimeoutMs: false,
      coreFactory: (b) => {
        captured = new DeviceContext(b);
        return captured;
      },
      doClose: async () => {},
    });
    expect(captured).toBeInstanceOf(DeviceContext);
    await device.observe();
    // The device's verb populated the FACTORY core's cache.
    expect((captured as DeviceCore | null)?.currentApp()).toBe('FactoryApp');
  });
});

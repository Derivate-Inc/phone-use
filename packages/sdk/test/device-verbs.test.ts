import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionNotFoundError } from '../src/errors.ts';
import { createDeviceHandle, type Device } from '../src/lifecycle.ts';
import { el, FakeBackend, screen } from '../src/testing.ts';

const homeScreen = () =>
  screen(
    [
      el({ ref: '@e1', type: 'Cell', label: 'General', rect: { x: 0, y: 100, width: 390, height: 44 } }),
      el({ ref: '@e2', type: 'TextField', label: 'Search', rect: { x: 0, y: 200, width: 390, height: 36 } }),
    ],
    { appName: 'Settings', appBundleId: 'com.apple.Preferences' },
  );

function makeDevice(fake: FakeBackend, idleTimeoutMs: number | false = false): Device {
  return createDeviceHandle({
    id: 'test-device',
    platform: 'ios',
    backend: fake,
    createdByUs: false,
    idleTimeoutMs,
    doClose: async () => {},
  });
}

describe('Device verb surface', () => {
  it('flat hot path + namespaces exist and drive the internal core', async () => {
    const fake = new FakeBackend({ screens: [homeScreen()] });
    const device = makeDevice(fake);

    const obs = await device.observe();
    expect(obs.success).toBe(true);
    expect(obs.app).toBe('Settings');
    expect(obs.actions.some((a) => a.verb === 'tap')).toBe(true);

    const tap = await device.tap('General');
    expect(tap.success).toBe(true);

    const typed = await device.type('hello', { field: 'Search' });
    expect(typed.success).toBe(true);
    expect(fake.calls.some((c) => c.method === 'fill' && c.args[1] === 'hello')).toBe(true);

    const act = await device.act({ formatVersion: 0, verb: 'scroll', params: { direction: 'down' } });
    expect(act.success).toBe(true);

    expect(await device.apps.list()).toEqual([]);
    expect(device.apps.current()).toBe('Settings');
    expect((await device.apps.open('Settings')).success).toBe(true);
    expect((await device.screen.back()).success).toBe(true);
    expect((await device.screen.home()).success).toBe(true);
    const shot = await device.screen.screenshot({ path: '/tmp/x.png' });
    expect(shot.success).toBe(true);
    const alert = await device.screen.alert('get');
    expect(alert.success).toBe(false); // no alert showing
  });

  it('verbs on a closed device throw SessionNotFoundError (infrastructure)', async () => {
    const fake = new FakeBackend({ screens: [homeScreen()] });
    const device = makeDevice(fake);
    await device.close();
    expect(() => device.observe()).toThrowError(SessionNotFoundError);
    expect(() => device.tap('General')).toThrowError(SessionNotFoundError);
  });

  it('secrets store rides the device: type(%name%) substitutes, results redact', async () => {
    const fake = new FakeBackend({ screens: [homeScreen()] });
    const device = createDeviceHandle({
      id: 'd2',
      platform: 'ios',
      backend: fake,
      createdByUs: false,
      idleTimeoutMs: false,
      secrets: { token: 'sekrit99' },
      doClose: async () => {},
    });
    await device.observe();
    const r = await device.type('%token%', { field: 'Search' });
    expect(r.success).toBe(true);
    expect(fake.calls.find((c) => c.method === 'fill')?.args[1]).toBe('sekrit99');
    expect(r.message).not.toContain('sekrit99');
  });
});

describe('verbs touch the idle lease', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a verb call re-arms the lease like raw backend activity does', async () => {
    let closed = false;
    const fake = new FakeBackend({ screens: [homeScreen()] });
    const device = createDeviceHandle({
      id: 'd3',
      platform: 'ios',
      backend: fake,
      createdByUs: false,
      idleTimeoutMs: 180_000,
      doClose: async () => {
        closed = true;
      },
    });
    await vi.advanceTimersByTimeAsync(170_000);
    await device.observe(); // verb → backend.snapshot through the touching proxy
    await vi.advanceTimersByTimeAsync(170_000);
    expect(device.status).toBe('running');
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(device.isClosed).toBe(true);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { installedApps, resolveApp } from '../src/apps.ts';
import { setDefaultDeviceContext } from '../src/driver.ts';
import { createExecution, withExecution } from '../src/execution-context.ts';

// Regression: with a remote backend attached (cloud sandbox / runner), app
// resolution must target the REMOTE device — a locally booted simulator's app
// list leaking in is how "Clock" once resolved to a benchmark clone that only
// existed locally.
describe('app resolution against a remote backend', () => {
  afterEach(() => {
    delete process.env.PHONE_USE_SANDBOX_URL;
    delete process.env.PHONE_USE_SANDBOX_TOKEN;
    setDefaultDeviceContext(null);
  });

  function attachFakeRemote(listed: string[]): void {
    process.env.PHONE_USE_SANDBOX_URL = 'http://127.0.0.1:1';
    process.env.PHONE_USE_SANDBOX_TOKEN = 'test-token';
    setDefaultDeviceContext({
      backend: { listApps: async () => listed },
    } as never);
  }

  it('resolves from the remote list plus stock apps, never local simctl', async () => {
    attachFakeRemote(['My Test App (com.example.myapp)']);
    const apps = await installedApps(true);
    expect(apps.some((a) => a.bundleId === 'com.example.myapp')).toBe(true);
    expect(apps.some((a) => a.bundleId === 'com.apple.Preferences')).toBe(true);

    expect((await resolveApp('my test app'))?.bundleId).toBe('com.example.myapp');
    expect((await resolveApp('Settings'))?.bundleId).toBe('com.apple.Preferences');
    // Simulators ship no Clock: must NOT resolve to anything learned elsewhere.
    expect(await resolveApp('Clock')).toBeNull();
  });

  it('falls back to the stock table when the backend is unreachable', async () => {
    process.env.PHONE_USE_SANDBOX_URL = 'http://127.0.0.1:1';
    process.env.PHONE_USE_SANDBOX_TOKEN = 'test-token';
    setDefaultDeviceContext({
      backend: {
        listApps: async () => {
          throw new Error('unreachable');
        },
      },
    } as never);
    const apps = await installedApps(true);
    expect(apps.some((a) => a.bundleId === 'com.apple.reminders')).toBe(true);
    expect(await resolveApp('Clock')).toBeNull();
  });

  // Regression (2026-11-07, live cloud Android): "Settings" became the iOS
  // com.apple.Preferences from the CLI, and com.android.providers.settings
  // through a multi-phone MCP server. The Android backend resolves names
  // itself (Settings -> com.android.settings), so names pass through.
  const ANDROID_PACKAGES = [
    'android',
    'com.android.providers.settings',
    'com.android.settings',
    'com.android.chrome',
    'com.google.android.gm',
  ];

  it('passes names through to a remote Android phone', async () => {
    attachFakeRemote(ANDROID_PACKAGES);
    expect(await installedApps(true)).toEqual([]);
    expect(await resolveApp('Settings')).toBeNull();
    expect(await resolveApp('Chrome')).toBeNull();
    expect((await resolveApp('com.android.settings'))?.bundleId).toBe('com.android.settings');
  });

  it('an iOS app named Android... does not make the phone look like Android', async () => {
    attachFakeRemote(['Android File Transfer (com.example.aft)']);
    await installedApps(true);
    expect((await resolveApp('Settings'))?.bundleId).toBe('com.apple.Preferences');
  });

  it('passes names through for an Android phone in its own execution (multi-phone)', async () => {
    let listed = 0;
    const device = {
      backend: {
        listApps: async () => {
          listed++;
          return ANDROID_PACKAGES;
        },
      },
    } as never;
    const result = await withExecution(createExecution(device, 'default' as never, 'android'), () =>
      resolveApp('Settings'),
    );
    expect(result).toBeNull();
    expect(listed).toBe(0);
  });

  it('keeps the stock table for an iPhone in its own execution', async () => {
    const device = { backend: { listApps: async () => ['My App (com.example.app)'] } } as never;
    const result = await withExecution(createExecution(device, 'default' as never, 'ios'), () =>
      resolveApp('Settings'),
    );
    expect(result?.bundleId).toBe('com.apple.Preferences');
  });
});

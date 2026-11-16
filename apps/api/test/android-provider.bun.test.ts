import { describe, expect, it } from 'bun:test';
import type { Device } from '@phone-use/sdk';
import { AndroidEmulatorProvider } from '../src/providers.ts';
import { withTimeout } from '../src/worker.ts';

type LaunchArgs = Parameters<AndroidEmulatorProvider['provision']>[0] & Record<string, unknown>;

function fakeLaunch(opts: { failPorts?: number[] } = {}) {
  const launches: Record<string, unknown>[] = [];
  const closed: string[] = [];
  const launch = (async (options: Record<string, unknown>) => {
    launches.push(options);
    if (opts.failPorts?.includes(options.port as number)) throw new Error('boot failed');
    const id = `emulator-${options.port}`;
    return {
      id,
      close: async () => {
        closed.push(id);
      },
    } as unknown as Device;
  }) as unknown as AndroidEmulatorProvider extends { launch: infer L } ? L : never;
  return { launch, launches, closed };
}

describe('AndroidEmulatorProvider', () => {
  it('boots read-only headless instances on successive even ports and kills them on destroy', async () => {
    const fake = fakeLaunch();
    const killed: string[][] = [];
    const provider = new AndroidEmulatorProvider({
      avd: 'golden',
      maxInstances: 2,
      launch: fake.launch as never,
      exec: async (_cmd, args) => {
        killed.push(args);
        return { stdout: '', stderr: '' };
      },
    });
    const a = await provider.provision({ id: 'sbx_a' } as LaunchArgs);
    const b = await provider.provision({ id: 'sbx_b' } as LaunchArgs);
    expect([a.deviceId, b.deviceId]).toEqual(['emulator-5554', 'emulator-5556']);
    expect(fake.launches[0]).toMatchObject({ avd: 'golden', port: 5554, readOnly: true, headless: true });
    await expect(provider.provision({ id: 'sbx_c' } as LaunchArgs)).rejects.toThrow(/capacity exhausted/);

    await provider.destroy(a);
    expect(fake.closed).toEqual(['emulator-5554']);
    expect(killed).toEqual([]); // had a live handle → no adb fallback
    // the port is free again
    const c = await provider.provision({ id: 'sbx_c' } as LaunchArgs);
    expect(c.deviceId).toBe('emulator-5554');
  });

  it('a failed boot releases its port', async () => {
    const fake = fakeLaunch({ failPorts: [5554] });
    const provider = new AndroidEmulatorProvider({ avd: 'golden', maxInstances: 1, launch: fake.launch as never });
    await expect(provider.provision({ id: 'x' } as LaunchArgs)).rejects.toThrow('boot failed');
    // second attempt reuses 5554 instead of reporting exhaustion
    await expect(provider.provision({ id: 'y' } as LaunchArgs)).rejects.toThrow('boot failed');
    expect(fake.launches.map((l) => l.port)).toEqual([5554, 5554]);
  });

  it('an adopted instance (no process handle) is killed through the emulator console', async () => {
    const killed: string[][] = [];
    const provider = new AndroidEmulatorProvider({
      avd: 'golden',
      adbBin: '/sdk/adb',
      launch: fakeLaunch().launch as never,
      exec: async (cmd, args) => {
        killed.push([cmd, ...args]);
        return { stdout: '', stderr: '' };
      },
    });
    const resource = { deviceId: 'emulator-5558', name: 'golden @5558', metadata: { port: 5558 } };
    provider.restore(resource);
    await provider.destroy(resource);
    expect(killed).toEqual([['/sdk/adb', '-s', 'emulator-5558', 'emu', 'kill']]);
  });
});

describe('withTimeout (worker provision guard)', () => {
  it('rejects a hung provision and hands a late result to onLate', async () => {
    let resolveLate: (v: string) => void = () => undefined;
    const late = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });
    const seen: string[] = [];
    await expect(withTimeout(late, 20, 'provision', (v) => seen.push(v))).rejects.toThrow(/timed out after 20ms/);
    resolveLate('device-1');
    await late;
    await Bun.sleep(1);
    expect(seen).toEqual(['device-1']);
  });

  it('passes a prompt result through untouched', async () => {
    expect(await withTimeout(Promise.resolve(42), 1000, 'x')).toBe(42);
  });
});

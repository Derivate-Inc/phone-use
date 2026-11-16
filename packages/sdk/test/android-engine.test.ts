import { describe, expect, it } from 'vitest';
import { android, type EmulatorProcess } from '../src/backends/android.ts';
import { ActionFailedError, DeviceNotFoundError, TimeoutError } from '../src/errors.ts';
import type { ExecRunner } from '../src/exec.ts';

const DEVICES_ONE =
  'List of devices attached\nemulator-5554\tdevice product:sdk_gphone64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1\n';
const DEVICES_TWO = `${DEVICES_ONE}R58M12ABCDE\tdevice product:a52 model:SM_A525F device:a52q transport_id:2\n`;
const DEVICES_UNAUTH = 'List of devices attached\nR58M12ABCDE\tunauthorized transport_id:2\n';
const DEVICES_NONE = 'List of devices attached\n\n';

type Call = { file: string; args: string[] };

function fake(respond: (args: string[]) => string) {
  const calls: Call[] = [];
  const exec: ExecRunner = async (file, args) => {
    calls.push({ file, args: [...args] });
    return { stdout: respond(args), stderr: '' };
  };
  return { exec, calls };
}

describe('android.list', () => {
  it('parses adb devices -l', async () => {
    const { exec } = fake(() => DEVICES_TWO);
    expect(await android.list({ exec })).toEqual([
      { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64_x86_64' },
      { serial: 'R58M12ABCDE', state: 'device', model: 'SM_A525F' },
    ]);
  });
});

describe('android.connect', () => {
  it('attaches to the single ready device and never shuts it down on close', async () => {
    const { exec, calls } = fake(() => DEVICES_ONE);
    const device = await android.connect(undefined, { exec, idleTimeoutMs: false });
    expect(device.id).toBe('emulator-5554');
    expect(device.platform).toBe('android');
    expect(device.name).toBe('sdk_gphone64_x86_64');
    expect(device.backendName).toBe('android-adb');
    expect(device.createdByUs).toBe(false);
    expect(device.capabilities.has('snapshot')).toBe(true);
    const before = calls.length;
    await device.close();
    expect(device.isClosed).toBe(true);
    expect(calls.slice(before).some((c) => c.args.includes('kill'))).toBe(false);
  });

  it('pins by serial', async () => {
    const { exec } = fake(() => DEVICES_TWO);
    const device = await android.connect('R58M12ABCDE', { exec, idleTimeoutMs: false });
    expect(device.id).toBe('R58M12ABCDE');
    await device.close();
  });

  it('refuses to guess between several ready devices', async () => {
    const { exec } = fake(() => DEVICES_TWO);
    await expect(android.connect(undefined, { exec })).rejects.toThrow(/several Android devices/);
  });

  it('names the fix when nothing is attached or the device is unauthorized', async () => {
    await expect(android.connect(undefined, { exec: fake(() => DEVICES_NONE).exec })).rejects.toThrow(
      /USB debugging/,
    );
    await expect(android.connect(undefined, { exec: fake(() => DEVICES_UNAUTH).exec })).rejects.toThrow(
      /unauthorized/,
    );
    await expect(android.connect('nope', { exec: fake(() => DEVICES_ONE).exec })).rejects.toBeInstanceOf(
      DeviceNotFoundError,
    );
  });
});

function fakeEmulator() {
  const spawned: Call[] = [];
  let exitListener: (() => void) | null = null;
  const proc: EmulatorProcess & { killed: NodeJS.Signals[]; exit(): void } = {
    killed: [],
    exited: false,
    kill(signal) {
      this.killed.push(signal ?? 'SIGTERM');
    },
    once(_event, listener) {
      exitListener = listener;
    },
    exit() {
      (this as { exited: boolean }).exited = true;
      exitListener?.();
    },
  };
  const spawn = (file: string, args: string[]) => {
    spawned.push({ file, args });
    return proc;
  };
  return { spawn, spawned, proc };
}

describe('android.launch', () => {
  it('boots a headless read-only instance, waits for sys.boot_completed, kills it on close', async () => {
    let polls = 0;
    const { exec, calls } = fake((args) => {
      if (args.includes('getprop')) return ++polls < 3 ? '' : '1\n';
      if (args.includes('kill')) return 'OK: killing emulator, bye bye\n';
      return '';
    });
    const emu = fakeEmulator();
    const device = await android.launch({
      avd: 'phone-use-golden',
      port: 5558,
      readOnly: true,
      emulatorBin: '/sdk/emulator/emulator',
      exec,
      spawn: emu.spawn,
      sleep: async () => undefined,
      idleTimeoutMs: false,
    });
    expect(emu.spawned).toEqual([
      {
        file: '/sdk/emulator/emulator',
        args: [
          '-avd',
          'phone-use-golden',
          '-port',
          '5558',
          '-no-boot-anim',
          '-no-audio',
          '-no-window',
          '-read-only',
        ],
      },
    ]);
    expect(calls[0]?.args).toEqual(['-s', 'emulator-5558', 'wait-for-device']);
    expect(polls).toBe(3);
    expect(device.id).toBe('emulator-5558');
    expect(device.createdByUs).toBe(true);
    expect(device.name).toBe('phone-use-golden');

    const closing = device.close();
    emu.proc.exit();
    await closing;
    expect(calls.at(-1)?.args).toEqual(['-s', 'emulator-5558', 'emu', 'kill']);
    expect(emu.proc.killed).toEqual([]); // exited politely, no SIGKILL needed
  });

  it('a boot that never completes is killed and reported as a timeout', async () => {
    const { exec, calls } = fake(() => '');
    const emu = fakeEmulator();
    let now = 0;
    const sleep = async (ms: number) => {
      now += ms;
    };
    const realNow = Date.now;
    Date.now = () => realNow() + now;
    try {
      const pending = android.launch({
        avd: 'x',
        exec,
        spawn: emu.spawn,
        sleep,
        bootTimeoutMs: 2_500,
        pollIntervalMs: 1_000,
      });
      // The stop() path waits for exit: simulate the emulator dying after the kill.
      const exitSoon = setInterval(() => {
        if (calls.some((c) => c.args.includes('kill'))) {
          emu.proc.exit();
          clearInterval(exitSoon);
        }
      }, 5);
      await expect(pending).rejects.toBeInstanceOf(TimeoutError);
      expect(calls.some((c) => c.args.includes('kill'))).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it('rejects an odd console port up front', async () => {
    await expect(android.launch({ avd: 'x', port: 5555, exec: fake(() => '').exec })).rejects.toBeInstanceOf(
      ActionFailedError,
    );
  });
});

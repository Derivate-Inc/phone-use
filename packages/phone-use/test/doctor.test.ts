import { describe, expect, it } from 'vitest';
import { doctorExitCode, renderDoctor, runDoctor } from '../src/doctor.ts';

type Call = [file: string, args: string[]];

// Scripted exec: match on the simctl subcommand, return canned JSON.
function healthyExec(calls: Call[] = []) {
  return async (file: string, args: string[]) => {
    calls.push([file, args]);
    const joined = `${file} ${args.join(' ')}`;
    if (joined === 'xcode-select -p')
      return { stdout: '/Applications/Xcode.app/Contents/Developer', stderr: '' };
    if (joined === 'xcodebuild -version') return { stdout: 'Xcode 26.5', stderr: '' };
    if (joined === 'xcrun --find simctl') return { stdout: '/usr/bin/simctl\n', stderr: '' };
    if (joined.includes('list runtimes')) {
      return {
        stdout: JSON.stringify({ runtimes: [{ platform: 'iOS', isAvailable: true, name: 'iOS 26.1' }] }),
        stderr: '',
      };
    }
    if (joined.includes('list devices booted')) {
      return {
        stdout: JSON.stringify({ devices: { 'iOS-26-1': [{ state: 'Booted', name: 'iPhone 16' }] } }),
        stderr: '',
      };
    }
    throw new Error(`unexpected exec: ${joined}`);
  };
}

// A machine without adb: every exec fails the way a missing binary does. Tests
// must never reach the real adb, which may be installed (and slow) on the host.
const noAdb = async (): Promise<never> => {
  throw Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' });
};

const base = {
  platform: 'darwin' as const,
  bunVersion: '1.3.14',
  env: { ANTHROPIC_API_KEY: 'k' },
  findXcode: () => undefined,
  runnerCheck: () => ({ name: 'ios runner', status: 'ok' as const, detail: 'built' }),
};

describe('runDoctor', () => {
  it('rejects Command Line Tools even when simctl happens to be available', async () => {
    const checks = await runDoctor({
      ...base,
      exec: async (file, args) =>
        file === 'xcode-select'
          ? { stdout: '/Library/Developer/CommandLineTools', stderr: '' }
          : healthyExec()(file, args),
    });
    expect(checks.find((c) => c.name === 'xcode')?.status).toBe('fail');
    expect(checks.find((c) => c.name === 'xcode')?.detail).toContain('Full Xcode');
  });

  it('uses an installed Xcode when xcode-select points at the Command Line Tools', async () => {
    const envs: Array<[string, Record<string, string> | undefined]> = [];
    const checks = await runDoctor({
      ...base,
      findXcode: () => '/Applications/Xcode.app/Contents/Developer',
      exec: async (file, args, opts) => {
        envs.push([file, opts?.env]);
        return file === 'xcode-select'
          ? { stdout: '/Library/Developer/CommandLineTools', stderr: '' }
          : healthyExec()(file, args);
      },
    });
    const xcode = checks.find((c) => c.name === 'xcode');
    expect(xcode?.status).toBe('ok');
    expect(xcode?.detail).toContain('xcode-select points to /Library/Developer/CommandLineTools');
    const apple = envs.filter(([file]) => file === 'xcrun' || file === 'xcodebuild');
    expect(apple.length).toBeGreaterThan(0);
    expect(apple.every(([, e]) => e?.DEVELOPER_DIR === '/Applications/Xcode.app/Contents/Developer')).toBe(
      true,
    );
    expect(doctorExitCode(checks)).toBe(0);
  });

  it('remote runs do not require local Xcode or adb and report the selected provider key', async () => {
    const calls: Call[] = [];
    const checks = await runDoctor({
      ...base,
      platform: 'linux',
      exec: healthyExec(calls),
      env: {
        PHONE_USE_SANDBOX_URL: 'https://example.test',
        PHONE_USE_PROVIDER: 'openai',
        OPENAI_API_KEY: 'secret',
      },
    });
    expect(calls).toHaveLength(0);
    expect(doctorExitCode(checks)).toBe(0);
    expect(checks.find((c) => c.name === 'api key')?.detail).toBe('OPENAI_API_KEY set');
    expect(JSON.stringify(checks)).not.toContain('secret');
  });

  it('explicit Android selection fails when no device is authorized and never probes Xcode', async () => {
    const calls: Call[] = [];
    const checks = await runDoctor({
      ...base,
      env: { PHONE_USE_DEVICE: 'android' },
      exec: async (file, args) => {
        calls.push([file, args]);
        return { stdout: 'List of devices attached\nphone\tunauthorized\n', stderr: '' };
      },
    });
    expect(doctorExitCode(checks)).toBe(1);
    expect(calls.every(([file]) => file === 'adb')).toBe(true);
  });
  it('all green on a healthy mac', async () => {
    const checks = await runDoctor({ ...base, exec: healthyExec() });
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ['bun', 'ok'],
      ['android', 'ok'],
      ['platform', 'ok'],
      ['xcode', 'ok'],
      ['ios runtime', 'ok'],
      ['booted simulator', 'ok'],
      ['ios runner', 'ok'],
      ['api key', 'ok'],
      ['atlas', 'ok'],
    ]);
    expect(doctorExitCode(checks)).toBe(0);
  });

  it('missing xcrun fails and short-circuits the simctl checks', async () => {
    const checks = await runDoctor({
      ...base,
      exec: async () => {
        throw new Error('xcrun: not found');
      },
    });
    const xcode = checks.find((c) => c.name === 'xcode');
    expect(xcode?.status).toBe('fail');
    expect(xcode?.detail).toContain('xcode-select --switch');
    expect(checks.some((c) => c.name === 'ios runtime')).toBe(false);
    expect(doctorExitCode(checks)).toBe(1);
  });

  it('non-macOS without adb is ready for cloud phones', async () => {
    const checks = await runDoctor({ ...base, platform: 'linux', exec: noAdb });
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ['bun', 'ok'],
      ['android', 'ok'],
      ['platform', 'ok'],
      ['api key', 'ok'],
      ['atlas', 'ok'],
    ]);
    expect(checks.find((c) => c.name === 'platform')?.detail).toContain('cloud phones work here');
    expect(renderDoctor(checks)).toContain('ready to drive');
    expect(doctorExitCode(checks)).toBe(0);
  });

  it('non-macOS with adb and a device is ready for Android', async () => {
    const exec = async (file: string, args: string[]) => {
      if (file === 'adb' && args[0] === 'devices') {
        return { stdout: 'List of devices attached\nemulator-5554\tdevice model:sdk_gphone64\n', stderr: '' };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };
    const checks = await runDoctor({ ...base, platform: 'linux', exec });
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ['bun', 'ok'],
      ['android', 'ok'],
      ['platform', 'ok'],
      ['api key', 'ok'],
      ['atlas', 'ok'],
    ]);
    expect(checks.find((c) => c.name === 'android')?.detail).toContain('emulator-5554');
    expect(doctorExitCode(checks)).toBe(0);
  });

  it('adb without a device is informational on a mac but a warning on linux', async () => {
    const exec = async (file: string, args: string[]) => {
      if (file === 'adb') return { stdout: 'List of devices attached\n\n', stderr: '' };
      return healthyExec()(file, args);
    };
    const mac = await runDoctor({ ...base, exec });
    expect(mac.find((c) => c.name === 'android')).toMatchObject({ status: 'ok' });
    expect(renderDoctor(mac)).toContain('ready to drive');
    const linux = await runDoctor({ ...base, platform: 'linux', exec });
    expect(linux.find((c) => c.name === 'android')).toMatchObject({ status: 'warn' });
    expect(linux.find((c) => c.name === 'platform')).toMatchObject({ status: 'ok' });
    expect(doctorExitCode(linux)).toBe(0);
  });

  it('no booted simulator and no API key are warnings, not failures', async () => {
    const exec = async (file: string, args: string[]) => {
      const joined = `${file} ${args.join(' ')}`;
      if (joined === 'xcode-select -p')
        return { stdout: '/Applications/Xcode.app/Contents/Developer', stderr: '' };
      if (joined === 'xcodebuild -version') return { stdout: 'Xcode 26.5', stderr: '' };
      if (joined === 'xcrun --find simctl') return { stdout: '/usr/bin/simctl', stderr: '' };
      if (joined.includes('list runtimes'))
        return { stdout: JSON.stringify({ runtimes: [{ platform: 'iOS', name: 'iOS 26.1' }] }), stderr: '' };
      return { stdout: JSON.stringify({ devices: {} }), stderr: '' };
    };
    const checks = await runDoctor({ platform: 'darwin', bunVersion: '1.3.14', env: {}, exec });
    expect(checks.find((c) => c.name === 'booted simulator')?.status).toBe('warn');
    expect(checks.find((c) => c.name === 'api key')?.status).toBe('warn');
    expect(doctorExitCode(checks)).toBe(0);
  });

  it('not running under Bun is a failure with an install pointer', async () => {
    const checks = await runDoctor({ ...base, bunVersion: undefined, exec: healthyExec() });
    const bun = checks.find((c) => c.name === 'bun');
    expect(bun?.status).toBe('fail');
    expect(bun?.detail).toContain('bun.sh');
  });
});

describe('renderDoctor', () => {
  it('renders one row per check plus a verdict', async () => {
    const checks = await runDoctor({ ...base, exec: healthyExec() });
    const out = renderDoctor(checks);
    expect(out.split('\n')).toHaveLength(checks.length + 2);
    expect(out).toContain('ready to drive');
  });

  it('names the failure count when something is broken', async () => {
    // Android selected, but adb isn't installed: one failure, on any host.
    const env = { ...base.env, PHONE_USE_DEVICE: 'android' };
    const checks = await runDoctor({ ...base, env, exec: noAdb });
    expect(renderDoctor(checks)).toContain('1 problem found');
  });
});

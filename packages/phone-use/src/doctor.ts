import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { android, currentBuildKey, resolveDeveloperDir, runnerState } from '@phone-use/sdk';
import { accent, bold, muted } from './style.ts';

// ---------------------------------------------------------------------------
// `phone-use doctor` — environment diagnostics. The stack has several silent
// failure modes (no Xcode CLT, no simulator runtime installed, nothing
// booted, adb without an authorized device); doctor names each one and says
// exactly what to do about it, so a broken setup fails here in two seconds
// instead of hanging on first use.
// Read-only by design: doctor never boots, installs, or mutates anything.
// Deps are injectable so tests run without macOS or Xcode.
// ---------------------------------------------------------------------------

export type DoctorStatus = 'ok' | 'warn' | 'fail';
export type DoctorCheck = { name: string; status: DoctorStatus; detail: string };

type ExecFn = (
  file: string,
  args: string[],
  opts?: { env?: Record<string, string> | undefined },
) => Promise<{ stdout: string; stderr: string }>;

export type DoctorDeps = {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  bunVersion?: string | undefined;
  home?: string;
  /** A full Xcode found on disk when xcode-select points elsewhere (default: auto-detect). */
  findXcode?: () => string | undefined;
  /** Report the phone-use iOS runner's build/launch state (default: read ~/.phone-use/runner). */
  runnerCheck?: (udid: string | undefined) => DoctorCheck | undefined;
};

const pExecFile = promisify(execFile);
const defaultExec: ExecFn = async (file, args, opts) => {
  const { stdout, stderr } = await pExecFile(file, args, {
    timeout: 15_000,
    ...(opts?.env ? { env: opts.env } : {}),
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

type SimctlRuntime = { platform?: string; isAvailable?: boolean; name?: string };
type SimctlDevice = { state?: string; name?: string; udid?: string; isAvailable?: boolean };

/** Run every check. Never throws — a broken environment is the expected input. */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const exec = deps.exec ?? defaultExec;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const bunVersion = deps.bunVersion ?? (typeof Bun === 'undefined' ? undefined : Bun.version);
  const home = deps.home ?? homedir();
  const checks: DoctorCheck[] = [];

  if (bunVersion === undefined) {
    checks.push({
      name: 'bun',
      status: 'fail',
      detail: 'not running under Bun — the CLI requires Bun >= 1.3 (https://bun.sh)',
    });
  } else {
    const [major = 0, minor = 0] = bunVersion.split('.').map(Number);
    const recent = major > 1 || (major === 1 && minor >= 3);
    checks.push({
      name: 'bun',
      status: recent ? 'ok' : 'warn',
      detail: recent ? `v${bunVersion}` : `v${bunVersion} — engines want >= 1.3, run \`bun upgrade\``,
    });
  }

  // Remote devices do not require local Xcode/adb. Never print credentials.
  const explicitLocal = env.PHONE_USE_DEVICE === 'android' || env.PHONE_USE_DEVICE === 'mirror';
  if (!explicitLocal && (env.PHONE_USE_SANDBOX_URL || env.PHONE_USE_RUNNER_URL)) {
    checks.push({
      name: 'device backend',
      status: 'ok',
      detail: 'remote endpoint configured; connectivity is checked by run preflight',
    });
    pushCommon(checks, env, home);
    return checks;
  }

  // Android over adb runs on every OS, so probe it BEFORE the macOS gate: a
  // Linux box with a phone attached is "ready", not "wrong platform".
  let adbPresent = false;
  try {
    const devices = await android.list({ adbBin: env.PHONE_USE_ADB_BIN, exec });
    adbPresent = true;
    const ready = devices.filter((d) => d.state === 'device');
    const unauthorized = devices.filter((d) => d.state === 'unauthorized');
    // No device is only a problem where Android is the only option (non-macOS);
    // a Mac driving simulators should still read "ready to drive".
    checks.push(
      ready.length > 0
        ? { name: 'android', status: 'ok', detail: `adb ok — ${ready.map((d) => d.serial).join(', ')}` }
        : unauthorized.length > 0
          ? {
              name: 'android',
              status: 'warn',
              detail: `adb ok, ${unauthorized[0]?.serial} is unauthorized — accept the USB-debugging prompt on the phone`,
            }
          : {
              name: 'android',
              status: platform === 'darwin' ? 'ok' : 'warn',
              detail:
                'adb ok, no device attached — `phone-use connect android` needs one (USB debugging on, or an emulator)',
            },
    );
  } catch {
    checks.push({
      name: 'android',
      status: 'ok',
      detail:
        'adb not installed (optional — `brew install android-platform-tools` / `apt install adb` to drive Android)',
    });
  }

  if (env.PHONE_USE_DEVICE === 'android') {
    const androidCheck = checks.find((check) => check.name === 'android');
    if (!adbPresent || androidCheck?.status !== 'ok' || androidCheck.detail.includes('no device')) {
      checks.push({
        name: 'selected device',
        status: 'fail',
        detail:
          'Android selected but no authorized device is ready. Run adb devices and authorize or boot the intended device.',
      });
    }
    pushCommon(checks, env, home);
    return checks;
  }

  if (platform !== 'darwin') {
    // Cloud phones (`phone-use create ios|android`) work from any OS, so a
    // machine without local device tooling is still ready; it only can't drive
    // a local simulator or emulator.
    checks.push({
      name: 'platform',
      status: 'ok',
      detail: adbPresent
        ? `${platform} — Android over adb (iOS simulators need macOS)`
        : `${platform} — cloud phones work here; a local device needs macOS with Xcode (iOS) or adb (Android)`,
    });
    pushCommon(checks, env, home);
    return checks;
  }
  checks.push({ name: 'platform', status: 'ok', detail: 'macOS' });

  // When xcode-select points at the Command Line Tools but a full Xcode is
  // installed, phone-use uses that Xcode for its own processes (DEVELOPER_DIR),
  // so that setup works and is reported as such rather than failing.
  let appleEnv: { env: Record<string, string> } | undefined;
  try {
    let selected = env.DEVELOPER_DIR ?? (await exec('xcode-select', ['-p'])).stdout.trim();
    let note = '';
    if (!selected || selected.includes('CommandLineTools')) {
      const found = (deps.findXcode ?? defaultFindXcode)();
      if (!found) throw new Error('Full Xcode is not selected');
      note = ` (xcode-select points to ${selected || 'nothing'}; phone-use uses this Xcode for its own processes)`;
      selected = found;
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) merged[k] = v;
      appleEnv = { env: { ...merged, DEVELOPER_DIR: found } };
    }
    await exec('xcodebuild', ['-version'], appleEnv);
    const { stdout } = await exec('xcrun', ['--find', 'simctl'], appleEnv);
    checks.push({ name: 'xcode', status: 'ok', detail: `${selected}; simctl at ${stdout.trim()}${note}` });
  } catch {
    checks.push({
      name: 'xcode',
      status: 'fail',
      detail:
        'Full Xcode is required (Command Line Tools alone are insufficient). Select it with `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`, or set DEVELOPER_DIR to your Xcode installation; finish Xcode first-launch setup.',
    });
    return checks; // runtime/device checks all ride on simctl
  }

  try {
    const { stdout } = await exec('xcrun', ['simctl', 'list', 'runtimes', '-j'], appleEnv);
    const runtimes = (JSON.parse(stdout) as { runtimes?: SimctlRuntime[] }).runtimes ?? [];
    const ios = runtimes.filter((r) => r.platform === 'iOS' && r.isAvailable !== false);
    checks.push(
      ios.length > 0
        ? { name: 'ios runtime', status: 'ok', detail: ios.map((r) => r.name).join(', ') }
        : {
            name: 'ios runtime',
            status: 'fail',
            detail: 'no iOS Simulator runtime — install one in Xcode ▸ Settings ▸ Components',
          },
    );
  } catch (error) {
    checks.push({
      name: 'ios runtime',
      status: 'fail',
      detail: `simctl list runtimes failed: ${(error as Error).message}`,
    });
  }

  try {
    const { stdout } = await exec('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], appleEnv);
    const rows = Object.values(
      (JSON.parse(stdout) as { devices?: Record<string, SimctlDevice[]> }).devices ?? {},
    )
      .flat()
      .filter((d) => d.state === 'Booted');
    const selected = env.PHONE_USE_DEVICE;
    if (
      selected &&
      !['launch', 'connect', 'mirror', 'android'].includes(selected) &&
      !rows.some((device) => device.udid === selected)
    ) {
      checks.push({
        name: 'selected device',
        status: 'fail',
        detail: `Selected simulator ${selected} is not booted. Boot that device explicitly or choose another device.`,
      });
    } else if (rows.length > 1 && !selected) {
      checks.push({
        name: 'selected device',
        status: 'fail',
        detail:
          'Multiple simulators are booted. Set PHONE_USE_DEVICE to the intended UDID to avoid driving the wrong phone.',
      });
    }
    checks.push(
      rows.length > 0
        ? { name: 'booted simulator', status: 'ok', detail: rows.map((d) => d.name).join(', ') }
        : {
            name: 'booted simulator',
            status: 'warn',
            detail: 'none booted — use `--device launch`, or boot one in Simulator.app',
          },
    );
  } catch (error) {
    checks.push({
      name: 'booted simulator',
      status: 'warn',
      detail: `simctl list failed: ${(error as Error).message}`,
    });
  }

  const selectedUdid =
    env.PHONE_USE_DEVICE && /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(env.PHONE_USE_DEVICE)
      ? env.PHONE_USE_DEVICE
      : undefined;
  const runner = (deps.runnerCheck ?? defaultRunnerCheck)(selectedUdid);
  if (runner) checks.push(runner);

  pushCommon(checks, env, home);
  return checks;
}

function defaultFindXcode(): string | undefined {
  const { dir } = resolveDeveloperDir();
  return dir && !dir.includes('CommandLineTools') ? dir : undefined;
}

/** Read-only: is the runner built for this Xcode, and is one recorded for the selected simulator? */
function defaultRunnerCheck(udid: string | undefined): DoctorCheck | undefined {
  try {
    const key = currentBuildKey();
    const built = existsSync(join(homedir(), '.phone-use', 'runner', 'build', key));
    const state = udid ? runnerState(udid) : undefined;
    const parts = [
      built
        ? `built for this Xcode (${key})`
        : 'not built yet — the first iOS command builds it (about 10 s)',
    ];
    if (state) parts.push(`last started on ${udid} at ${state.startedAt}, port ${state.port}`);
    return { name: 'ios runner', status: 'ok', detail: parts.join('; ') };
  } catch (error) {
    return { name: 'ios runner', status: 'warn', detail: (error as Error).message };
  }
}

/** The platform-independent tail: API key and the atlas directory. */
function pushCommon(checks: DoctorCheck[], env: Record<string, string | undefined>, home: string): void {
  const openai =
    env.PHONE_USE_PROVIDER === 'openai' ||
    (env.PHONE_USE_PROVIDER !== 'anthropic' &&
      Boolean(env.PHONE_USE_BASE_URL || (env.PHONE_USE_MODEL && !env.PHONE_USE_MODEL.startsWith('claude'))));
  const key = openai ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  checks.push(
    env[key]
      ? { name: 'api key', status: 'ok', detail: `${key} set` }
      : {
          name: 'api key',
          status: 'warn',
          detail: `${key} unset — model tasks may need credentials; MCP, run, and device verbs do not`,
        },
  );

  const atlasDir = join(home, '.phone-use');
  checks.push(
    existsSync(atlasDir)
      ? { name: 'atlas', status: 'ok', detail: atlasDir }
      : { name: 'atlas', status: 'ok', detail: `${atlasDir} (created on first use)` },
  );
}

const SYMBOL: Record<DoctorStatus, string> = { ok: '✓', warn: '⚠', fail: '✗' };

/** Human rendering: one row per check, then a verdict line. */
export function renderDoctor(checks: DoctorCheck[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  const rows = checks.map((c) => {
    const symbol = c.status === 'ok' ? accent(SYMBOL.ok) : bold(SYMBOL[c.status]);
    return `  ${symbol} ${bold(c.name.padEnd(width + 2))}${muted(c.detail)}`;
  });
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  const verdict =
    fails > 0
      ? `${fails} problem${fails === 1 ? '' : 's'} found — fix the ✗ items above`
      : warns > 0
        ? 'checks completed with warnings — review ⚠ items before running'
        : 'ready to drive';
  return `${rows.join('\n')}\n\n  ${bold(verdict)}`;
}

/** Exit code for doctor: any fail → 1, else 0 (warns don't fail CI). */
export function doctorExitCode(checks: DoctorCheck[]): 0 | 1 {
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}

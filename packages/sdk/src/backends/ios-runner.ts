import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { appleEnv, resolveDeveloperDir } from '../apple.ts';
import { ActionFailedError, DeviceInUseError, DeviceNotFoundError, TimeoutError } from '../errors.ts';

// ---------------------------------------------------------------------------
// The phone-use XCTest runner on an iOS simulator: build it once per runner
// version and Xcode, launch it per simulator, and remember where it listens so
// the next CLI process reuses it instead of paying the launch again.
//
// The runner is the session. There is no separate daemon: the XCTest process
// lives on the simulator, holds the element refs, and answers on a loopback
// port protected by a per-launch token stored 0600 in ~/.phone-use/runner.
// ---------------------------------------------------------------------------

const pExecFile = promisify(execFile);
const RUNNER_BUNDLE = 'dev.phoneuse.runner.uitests.xctrunner';
const TEST_ID = 'PhoneUseRunnerUITests/PhoneUseRunner/testServe';

/** Where a running runner can be reached. */
export type RunnerEndpoint = {
  udid: string;
  port: number;
  token: string;
  url: string;
  pid: number;
  buildKey: string;
  startedAt: string;
  logPath: string;
};

/** Options for {@link ensureRunner}. */
export type EnsureRunnerOptions = {
  /** State root; default `~/.phone-use/runner` (or PHONE_USE_RUNNER_HOME). */
  home?: string | undefined;
  /** Take over a simulator that another XCTest runner is driving (stops it). Default false. */
  takeover?: boolean | undefined;
  /** How long to wait for a fresh runner to answer. Default 90 s (includes a first build). */
  readyTimeoutMs?: number | undefined;
  /** Progress notes for long steps (build, launch). */
  onProgress?: ((message: string) => void) | undefined;
};

function runnerHome(opts?: EnsureRunnerOptions): string {
  return opts?.home ?? process.env.PHONE_USE_RUNNER_HOME ?? join(homedir(), '.phone-use', 'runner');
}

/** The runner's Xcode project, shipped inside this package (or PHONE_USE_RUNNER_PROJECT). */
export function runnerProjectDir(): string {
  const override = process.env.PHONE_USE_RUNNER_PROJECT;
  if (override) return override;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'ios-runner');
    if (existsSync(join(candidate, 'PhoneUseRunner.xcodeproj'))) return candidate;
    dir = dirname(dir);
  }
  throw new ActionFailedError('the phone-use iOS runner project is missing from this install', {
    details: {
      hint: 'reinstall @phone-use/sdk, or set PHONE_USE_RUNNER_PROJECT to a checkout of packages/sdk/ios-runner',
    },
  });
}

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'build' || entry.name === 'xcuserdata') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSources(path));
    else if (/\.(swift|m|h|plist|pbxproj|yml)$/.test(entry.name)) out.push(path);
  }
  return out.sort();
}

/** Xcode's version, read from its version.plist (no process spawn). */
function xcodeVersion(): string {
  const { dir } = resolveDeveloperDir();
  if (!dir) return 'none';
  try {
    return readFileSync(join(dir, '..', 'version.plist'), 'utf8').replace(/\s+/g, '');
  } catch {
    return dir;
  }
}

/** Cache key: runner sources + Xcode version. A change to either rebuilds. Cheap: file reads only. */
export function currentBuildKey(): string {
  const projectDir = runnerProjectDir();
  const hash = createHash('sha256');
  hash.update(xcodeVersion());
  for (const file of listSources(projectDir)) {
    hash.update(file.slice(projectDir.length));
    hash.update(readFileSync(file));
  }
  return hash.digest('hex').slice(0, 16);
}

function findXctestrun(productsDir: string): string | undefined {
  if (!existsSync(productsDir)) return undefined;
  const file = readdirSync(productsDir).find(
    (f) => f.endsWith('.xctestrun') && f.includes('iphonesimulator'),
  );
  return file ? join(productsDir, file) : undefined;
}

/** A crude cross-process lock: exclusive create, stale after `staleMs`. */
async function withLock<T>(path: string, staleMs: number, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + staleMs + 5000;
  for (;;) {
    try {
      closeSync(openSync(path, 'wx'));
      break;
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) rmSync(path, { force: true });
      } catch {
        /* lock vanished between checks */
      }
      if (Date.now() > deadline) throw new TimeoutError(`timed out waiting for ${path}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}

/**
 * Build the runner for the iOS Simulator unless this exact build is cached.
 * Returns the .xctestrun file to launch and the cache key.
 */
export async function buildRunner(opts?: EnsureRunnerOptions): Promise<{ xctestrun: string; key: string }> {
  if (!resolveDeveloperDir().dir) {
    throw new DeviceNotFoundError('the iOS runner needs a full Xcode install', {
      details: {
        hint: 'install Xcode from the App Store; the Command Line Tools alone cannot run simulators',
      },
    });
  }
  const projectDir = runnerProjectDir();
  const key = currentBuildKey();
  const derived = join(runnerHome(opts), 'build', key);
  const existing = findXctestrun(join(derived, 'Build', 'Products'));
  if (existing) return { xctestrun: existing, key };

  return withLock(join(runnerHome(opts), 'build', `${key}.lock`), 10 * 60_000, async () => {
    const again = findXctestrun(join(derived, 'Build', 'Products'));
    if (again) return { xctestrun: again, key };
    opts?.onProgress?.('building the phone-use iOS runner (once per Xcode version, about 10-60 s)');
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    try {
      await pExecFile(
        'xcodebuild',
        [
          'build-for-testing',
          '-project',
          join(projectDir, 'PhoneUseRunner.xcodeproj'),
          '-scheme',
          'PhoneUseRunnerUITests',
          '-destination',
          'generic/platform=iOS Simulator',
          '-derivedDataPath',
          derived,
          `ARCHS=${arch}`,
          'ONLY_ACTIVE_ARCH=YES',
          '-quiet',
        ],
        { env: appleEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 },
      );
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message: string };
      const lines = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.split('\n').filter((l) => /error:/.test(l));
      throw new ActionFailedError(
        `building the iOS runner failed: ${lines.slice(0, 5).join(' | ') || err.message}`,
        {
          details: { hint: 'open packages/sdk/ios-runner in Xcode to see the full build log' },
          cause: error,
        },
      );
    }
    const built = findXctestrun(join(derived, 'Build', 'Products'));
    if (!built) throw new ActionFailedError('the runner build produced no .xctestrun file');
    return { xctestrun: built, key };
  });
}

function statePath(udid: string, opts?: EnsureRunnerOptions): string {
  return join(runnerHome(opts), 'sessions', `${udid}.json`);
}

function readState(udid: string, opts?: EnsureRunnerOptions): RunnerEndpoint | undefined {
  try {
    return JSON.parse(readFileSync(statePath(udid, opts), 'utf8')) as RunnerEndpoint;
  } catch {
    return undefined;
  }
}

function writeState(state: RunnerEndpoint, opts?: EnsureRunnerOptions): void {
  const path = statePath(state.udid, opts);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when the runner at `url` answers its health check. */
export async function runnerHealthy(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; protocol?: number };
    return body.ok === true && body.protocol === 2;
  } catch {
    return false;
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function pickPort(udid: string): Promise<number> {
  // Simulators share the Mac's loopback, so each needs its own port. Start
  // from a udid-derived port so a relaunch tends to land on the same one.
  const seed = Number.parseInt(createHash('sha1').update(udid).digest('hex').slice(0, 6), 16);
  for (let i = 0; i < 200; i++) {
    const port = 47000 + ((seed + i) % 2000);
    if (await portFree(port)) return port;
  }
  throw new ActionFailedError('no free loopback port in 47000-48999 for the iOS runner');
}

/** Bundle ids of UIKit apps running on a simulator, from its launchd. */
export async function runningApps(udid: string): Promise<string[]> {
  const { dir } = resolveDeveloperDir();
  const simctl = dir ? join(dir, 'usr', 'bin', 'simctl') : 'xcrun';
  const args = dir ? ['spawn', udid, 'launchctl', 'list'] : ['simctl', 'spawn', udid, 'launchctl', 'list'];
  const { stdout } = await pExecFile(simctl, args, { env: appleEnv(), encoding: 'utf8', timeout: 10_000 });
  const ids = new Set<string>();
  for (const match of stdout.matchAll(/UIKitApplication:([^[\s]+)\[/g)) if (match[1]) ids.add(match[1]);
  return [...ids];
}

/** XCTest runner apps on the simulator that are not ours (other automation tools). */
async function foreignRunners(udid: string): Promise<string[]> {
  return (await runningApps(udid)).filter((id) => id.endsWith('.xctrunner') && id !== RUNNER_BUNDLE);
}

function tail(path: string, lines = 15): string {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Return a healthy runner on simulator `udid`, reusing one a previous process
 * started when it is still alive and built from the same sources.
 */
export async function ensureRunner(udid: string, opts?: EnsureRunnerOptions): Promise<RunnerEndpoint> {
  const existing = readState(udid, opts);
  if (
    existing &&
    alive(existing.pid) &&
    existing.buildKey === currentBuildKey() &&
    (await runnerHealthy(existing.url))
  ) {
    return existing;
  }

  return withLock(join(runnerHome(opts), 'sessions', `${udid}.lock`), 120_000, async () => {
    const current = readState(udid, opts);
    const { xctestrun, key } = await buildRunner(opts);
    if (current && alive(current.pid)) {
      if (current.buildKey === key && (await runnerHealthy(current.url))) return current;
      stopProcess(current.pid);
    }

    const others = await foreignRunners(udid);
    if (others.length) {
      if (!opts?.takeover) {
        throw new DeviceInUseError(
          `another XCTest runner is driving this simulator (${others.join(', ')}); only one can run at a time`,
          {
            details: {
              hint: 'stop that tool, use a different simulator, or pass takeover: true (PHONE_USE_RUNNER_TAKEOVER=1) to stop it',
            },
          },
        );
      }
      for (const bundle of others) {
        await pExecFile('xcrun', ['simctl', 'terminate', udid, bundle], { env: appleEnv() }).catch(
          () => undefined,
        );
      }
    }

    const port = await pickPort(udid);
    const token = randomBytes(24).toString('base64url');
    const logDir = join(runnerHome(opts), 'logs');
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, `${udid}.log`);
    // Keep the previous run's log: when a runner dies and is relaunched, that
    // log is the only record of why.
    if (existsSync(logPath)) renameSync(logPath, join(logDir, `${udid}.previous.log`));
    const log = openSync(logPath, 'w', 0o600);
    opts?.onProgress?.(`starting the phone-use runner on ${udid}`);
    const child = spawn(
      'xcodebuild',
      [
        'test-without-building',
        '-xctestrun',
        xctestrun,
        '-destination',
        `platform=iOS Simulator,id=${udid}`,
        `-only-testing:${TEST_ID}`,
      ],
      {
        detached: true,
        stdio: ['ignore', log, log],
        env: appleEnv({
          TEST_RUNNER_PHONE_USE_RUNNER_PORT: String(port),
          TEST_RUNNER_PHONE_USE_RUNNER_TOKEN: token,
        }),
      },
    );
    closeSync(log);
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new ActionFailedError('could not start xcodebuild for the iOS runner');

    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + (opts?.readyTimeoutMs ?? 90_000);
    while (Date.now() < deadline) {
      if (await runnerHealthy(url, 1000)) {
        const state: RunnerEndpoint = {
          udid,
          port,
          token,
          url,
          pid,
          buildKey: key,
          startedAt: new Date().toISOString(),
          logPath,
        };
        writeState(state, opts);
        return state;
      }
      if (!alive(pid)) {
        throw new ActionFailedError(`the iOS runner exited during launch:\n${tail(logPath)}`, {
          details: { hint: `full log: ${logPath}` },
        });
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    stopProcess(pid);
    throw new TimeoutError(`the iOS runner did not answer within ${opts?.readyTimeoutMs ?? 90_000}ms`, {
      details: { hint: `log: ${logPath}` },
    });
  });
}

function stopProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

/** Stop the runner on `udid` if one is recorded, and forget it. */
export function stopRunner(udid: string, opts?: EnsureRunnerOptions): boolean {
  const state = readState(udid, opts);
  if (!state) return false;
  if (alive(state.pid)) stopProcess(state.pid);
  rmSync(statePath(udid, opts), { force: true });
  return true;
}

/** The recorded runner for `udid`, without starting one. */
export function runnerState(udid: string, opts?: EnsureRunnerOptions): RunnerEndpoint | undefined {
  return readState(udid, opts);
}

import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { appleEnv } from '../apple.ts';
import { ActionFailedError, PhoneUseError } from '../errors.ts';

// ---------------------------------------------------------------------------
// Simulator controls that need no XCTest runner: everything simctl can do from
// the Mac. These are the evidence and setup tools a coding agent reaches for
// when checking its own change — app logs, a screen recording, a permission
// pre-granted so no prompt interrupts the run, a push notification, dark mode.
//
// Long-running captures (logs, recordings) outlive the CLI process that
// started them; their pid and output path are recorded under
// ~/.phone-use/runner/sim/<udid>/ so a later process can stop them.
// ---------------------------------------------------------------------------

const pExecFile = promisify(execFile);

/** Privacy services simctl can grant, revoke or reset. */
export type PrivacyService =
  | 'all'
  | 'calendar'
  | 'contacts-limited'
  | 'contacts'
  | 'location'
  | 'location-always'
  | 'photos-add'
  | 'photos'
  | 'media-library'
  | 'microphone'
  | 'motion'
  | 'reminders'
  | 'siri';

/** A log stream or screen recording running in the background: its process, file and start time. */
export type SimulatorCapture = {
  pid: number;
  path: string;
  startedAt: string;
  bundleId?: string | undefined;
};

/** Options for {@link simulator}. */
export type SimulatorToolsOptions = {
  /** State root; default `~/.phone-use/runner` (or PHONE_USE_RUNNER_HOME). */
  home?: string | undefined;
};

async function simctl(args: string[], input?: string): Promise<string> {
  try {
    if (input === undefined) {
      const { stdout } = await pExecFile('xcrun', ['simctl', ...args], {
        env: appleEnv(),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
      });
      return stdout;
    }
    return await new Promise<string>((resolvePromise, reject) => {
      const child = execFile(
        'xcrun',
        ['simctl', ...args],
        { env: appleEnv(), encoding: 'utf8', timeout: 60_000 },
        (err, stdout) => (err ? reject(err) : resolvePromise(stdout)),
      );
      child.stdin?.end(input);
    });
  } catch (cause) {
    const err = cause as { stderr?: string; message: string };
    throw new ActionFailedError(`simctl ${args[0]} failed: ${(err.stderr || err.message).trim()}`, { cause });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

/**
 * simctl-backed controls for one simulator. Every call is independent and
 * safe to make from a fresh process.
 */
export function simulator(udid: string, opts: SimulatorToolsOptions = {}) {
  const home = opts.home ?? process.env.PHONE_USE_RUNNER_HOME ?? join(homedir(), '.phone-use', 'runner');
  const stateDir = join(home, 'sim', udid);
  const statePath = (kind: 'logs' | 'record') => join(stateDir, `${kind}.json`);

  const readCapture = (kind: 'logs' | 'record'): SimulatorCapture | undefined => {
    try {
      return JSON.parse(readFileSync(statePath(kind), 'utf8')) as SimulatorCapture;
    } catch {
      return undefined;
    }
  };
  const writeCapture = (kind: 'logs' | 'record', capture: SimulatorCapture) => {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(statePath(kind), JSON.stringify(capture, null, 2), { mode: 0o600 });
  };

  /** The executable name of an installed app, for log predicates. */
  const executableOf = async (bundleId: string): Promise<string | undefined> => {
    const plist = await simctl(['listapps', udid]);
    const json = await new Promise<string>((resolvePromise, reject) => {
      const child = execFile(
        'plutil',
        ['-convert', 'json', '-o', '-', '-'],
        { maxBuffer: 64 * 1024 * 1024 },
        (err, out) => (err ? reject(err) : resolvePromise(out)),
      );
      child.stdin?.end(plist);
    });
    const apps = JSON.parse(json) as Record<string, { CFBundleExecutable?: string }>;
    return apps[bundleId]?.CFBundleExecutable;
  };

  return {
    udid,

    /** App and system logs streamed to a file until `logs.stop()`. */
    logs: {
      /** Start streaming logs (one app's, or all) to a file; a stream already running is returned as is. */
      async start(
        options: {
          bundleId?: string | undefined;
          predicate?: string | undefined;
          path?: string | undefined;
        } = {},
      ) {
        const running = readCapture('logs');
        if (running && alive(running.pid)) return running;
        let predicate = options.predicate;
        if (!predicate && options.bundleId) {
          const executable = await executableOf(options.bundleId);
          const clauses = [`subsystem BEGINSWITH "${options.bundleId}"`];
          if (executable) clauses.push(`process == "${executable}"`);
          predicate = clauses.join(' OR ');
        }
        const path = resolve(options.path ?? join(stateDir, `logs-${Date.now()}.log`));
        mkdirSync(dirname(path), { recursive: true });
        const fd = openSync(path, 'a', 0o600);
        const args = ['simctl', 'spawn', udid, 'log', 'stream', '--style', 'compact', '--level', 'debug'];
        if (predicate) args.push('--predicate', predicate);
        const child = spawn('xcrun', args, { detached: true, stdio: ['ignore', fd, fd], env: appleEnv() });
        closeSync(fd);
        child.unref();
        if (child.pid === undefined) throw new ActionFailedError('could not start log streaming');
        const capture: SimulatorCapture = {
          pid: child.pid,
          path,
          startedAt: new Date().toISOString(),
          bundleId: options.bundleId,
        };
        writeCapture('logs', capture);
        return capture;
      },
      /** Stop streaming; returns where the log is. */
      async stop(): Promise<SimulatorCapture | undefined> {
        const capture = readCapture('logs');
        if (!capture) return undefined;
        if (alive(capture.pid)) {
          process.kill(capture.pid, 'SIGTERM');
          await waitForExit(capture.pid, 3000);
        }
        rmSync(statePath('logs'), { force: true });
        return capture;
      },
      /** The running (or last) capture, if any. */
      current: (): SimulatorCapture | undefined => readCapture('logs'),
    },

    /** Screen recording (H.264 .mp4) until `record.stop()`. */
    record: {
      /** Start recording the screen to `path` (default: a temp .mp4). */
      async start(path?: string | undefined): Promise<SimulatorCapture> {
        const running = readCapture('record');
        if (running && alive(running.pid)) {
          throw new PhoneUseError(`already recording to ${running.path}`, {
            code: 'DEVICE_IN_USE',
            retryable: false,
            details: { hint: 'stop the current recording first' },
          });
        }
        const out = resolve(path ?? join(tmpdir(), `phone-use-${udid.slice(0, 8)}-${Date.now()}.mp4`));
        mkdirSync(dirname(out), { recursive: true });
        const child = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', out], {
          detached: true,
          stdio: 'ignore',
          env: appleEnv(),
        });
        child.unref();
        if (child.pid === undefined) throw new ActionFailedError('could not start recording');
        const capture: SimulatorCapture = { pid: child.pid, path: out, startedAt: new Date().toISOString() };
        writeCapture('record', capture);
        return capture;
      },
      /** Stop and finalize the file (SIGINT lets simctl write the moov atom). */
      async stop(): Promise<SimulatorCapture | undefined> {
        const capture = readCapture('record');
        if (!capture) return undefined;
        if (alive(capture.pid)) {
          process.kill(capture.pid, 'SIGINT');
          if (!(await waitForExit(capture.pid, 15_000))) process.kill(capture.pid, 'SIGKILL');
        }
        rmSync(statePath('record'), { force: true });
        return capture;
      },
      /** The running (or last) recording, if any. */
      current: (): SimulatorCapture | undefined => readCapture('record'),
    },

    /** Pre-grant, revoke or reset a privacy permission so no prompt interrupts a run. */
    async permission(
      action: 'grant' | 'revoke' | 'reset',
      service: PrivacyService,
      bundleId?: string,
    ): Promise<void> {
      await simctl(['privacy', udid, action, service, ...(bundleId ? [bundleId] : [])]);
    },

    /** Switch the simulator to light or dark mode. */
    async appearance(mode: 'light' | 'dark'): Promise<void> {
      await simctl(['ui', udid, 'appearance', mode]);
    },

    /** Deliver a push notification payload (APNs JSON) to an installed app. */
    async push(bundleId: string, payload: Record<string, unknown>): Promise<void> {
      const file = join(tmpdir(), `phone-use-push-${process.pid}-${Date.now()}.json`);
      writeFileSync(file, JSON.stringify(payload));
      try {
        await simctl(['push', udid, bundleId, file]);
      } finally {
        rmSync(file, { force: true });
      }
    },

    /** The simulator's pasteboard. */
    clipboard: {
      /** Read the pasteboard's text. */
      read: async (): Promise<string> => simctl(['pbpaste', udid]),
      /** Put text on the pasteboard. */
      write: async (text: string): Promise<void> => {
        await simctl(['pbcopy', udid], text);
      },
    },

    /** The simulated GPS position. */
    location: {
      /** Report this position to apps. */
      set: async (latitude: number, longitude: number): Promise<void> => {
        await simctl(['location', udid, 'set', `${latitude},${longitude}`]);
      },
      /** Stop simulating a position. */
      clear: async (): Promise<void> => {
        await simctl(['location', udid, 'clear']);
      },
    },

    /** A screenshot-ready status bar (9:41, full battery and signal), or the real one back. */
    statusBar: {
      /** Override the status bar: 9:41, full battery, full signal. */
      clean: async (): Promise<void> => {
        await simctl([
          'status_bar',
          udid,
          'override',
          '--time',
          '9:41',
          '--dataNetwork',
          'wifi',
          '--wifiBars',
          '3',
          '--cellularMode',
          'active',
          '--cellularBars',
          '4',
          '--batteryState',
          'charged',
          '--batteryLevel',
          '100',
        ]);
      },
      /** Remove the override. */
      reset: async (): Promise<void> => {
        await simctl(['status_bar', udid, 'clear']);
      },
    },

    /** Install an .app bundle. */
    async install(appPath: string): Promise<void> {
      await simctl(['install', udid, resolve(appPath)]);
    },
    /** Remove an installed app. */
    async uninstall(bundleId: string): Promise<void> {
      await simctl(['uninstall', udid, bundleId]);
    },
    /** Quit a running app. */
    async terminate(bundleId: string): Promise<void> {
      await simctl(['terminate', udid, bundleId]);
    },
    /** Open a URL or deep link with the app that owns it. */
    async openUrl(url: string): Promise<void> {
      await simctl(['openurl', udid, url]);
    },
  };
}

/** What {@link simulator} returns. */
export type SimulatorTools = ReturnType<typeof simulator>;

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// ---------------------------------------------------------------------------
// Host side of phone-use's Android helper (packages/sdk/android-helper): a
// small dex jar run on the device with app_process, holding a warm
// UiAutomation connection and answering over an adb-forwarded abstract
// socket. One tree read costs a few milliseconds instead of `uiautomator
// dump`'s ~2 s idle wait plus a file copy plus a dumpsys for the package.
//
// The helper outlives the CLI process that started it; its forwarded port is
// recorded in ~/.phone-use/android/<serial>.json for the next process. If it
// cannot start (an Android release that changed the hidden API it uses),
// callers fall back to `uiautomator dump`.
// ---------------------------------------------------------------------------

const pExecFile = promisify(execFile);
const DEVICE_JAR = '/data/local/tmp/phone-use-helper.jar';
const SOCKET = 'phone-use-helper';
const MAIN_CLASS = 'dev.phoneuse.android.Helper';

/** Options for {@link AndroidHelper}. */
export type AndroidHelperOptions = {
  adbBin: string;
  serial?: string | undefined;
  /** State root; default `~/.phone-use/android` (or PHONE_USE_ANDROID_HOME). */
  home?: string | undefined;
};

/** The helper jar shipped in this package (or PHONE_USE_ANDROID_HELPER_JAR). */
export function androidHelperJar(): string | undefined {
  const override = process.env.PHONE_USE_ANDROID_HELPER_JAR;
  if (override) return override;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'android-helper', 'phone-use-helper.jar');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return undefined;
}

/** A client for the on-device helper; starts it on first use. */
export class AndroidHelper {
  private readonly opts: AndroidHelperOptions;
  private port: number | undefined;
  private starting: Promise<number> | undefined;
  /** Set once starting failed, so a session does not retry on every read. */
  unavailable: string | undefined;

  constructor(opts: AndroidHelperOptions) {
    this.opts = opts;
  }

  private statePath(): string {
    const home =
      this.opts.home ?? process.env.PHONE_USE_ANDROID_HOME ?? join(homedir(), '.phone-use', 'android');
    return join(home, `${(this.opts.serial ?? 'default').replace(/[^\w.-]/g, '_')}.json`);
  }

  private adbArgs(args: string[]): string[] {
    return this.opts.serial ? ['-s', this.opts.serial, ...args] : args;
  }

  private async adb(args: string[], timeoutMs = 20_000): Promise<string> {
    const { stdout } = await pExecFile(this.opts.adbBin, this.adbArgs(args), {
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    return stdout;
  }

  /** One request over a fresh connection to the forwarded port. */
  private ask(port: number, command: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`android helper did not answer ${command} within ${timeoutMs}ms`));
      }, timeoutMs);
      socket.on('connect', () => socket.write(`${command}\n`));
      socket.on('data', (c: Buffer) => chunks.push(c));
      socket.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      socket.on('close', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
  }

  private async alive(port: number): Promise<boolean> {
    try {
      return (await this.ask(port, 'ping', 1500)).startsWith('ok');
    } catch {
      return false;
    }
  }

  private async ensure(): Promise<number> {
    if (this.port !== undefined && (await this.alive(this.port))) return this.port;
    this.port = undefined;
    try {
      const saved = JSON.parse(readFileSync(this.statePath(), 'utf8')) as { port?: number };
      if (saved.port && (await this.alive(saved.port))) {
        this.port = saved.port;
        return saved.port;
      }
    } catch {
      /* no saved helper */
    }
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    this.port = await this.starting;
    return this.port;
  }

  private async start(): Promise<number> {
    const jar = androidHelperJar();
    if (!jar) throw new Error('the Android helper jar is missing from this install');
    const local = createHash('sha256').update(readFileSync(jar)).digest('hex');
    const remote = (await this.adb(['shell', `sha256sum ${DEVICE_JAR} 2>/dev/null`]).catch(() => '')).split(
      /\s/,
    )[0];
    if (remote !== local) await this.adb(['push', jar, DEVICE_JAR], 60_000);
    // Stop a helper left from an older jar, then start ours. The `adb shell`
    // that hosts it runs detached so it outlives this process.
    await this.adb(['shell', `pkill -f ${MAIN_CLASS} 2>/dev/null; true`]).catch(() => '');
    const child = spawn(
      this.opts.adbBin,
      this.adbArgs(['shell', `CLASSPATH=${DEVICE_JAR} app_process /system/bin ${MAIN_CLASS} ${SOCKET}`]),
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    const port = Number((await this.adb(['forward', 'tcp:0', `localabstract:${SOCKET}`])).trim());
    if (!Number.isInteger(port) || port <= 0) throw new Error('adb forward did not return a port');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await this.alive(port)) {
        mkdirSync(dirname(this.statePath()), { recursive: true });
        writeFileSync(
          this.statePath(),
          JSON.stringify({ port, jar: local, startedAt: new Date().toISOString() }),
        );
        return port;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('the Android helper did not start (app_process exited or the hidden API changed)');
  }

  /** The active window as uiautomator-compatible XML, or undefined if the helper is unavailable. */
  async dump(): Promise<string | undefined> {
    return this.request('dump');
  }

  /** The active window's package, or undefined if the helper is unavailable. */
  async foreground(): Promise<string | undefined> {
    const pkg = await this.request('foreground');
    return pkg?.trim() || undefined;
  }

  private async request(command: string): Promise<string | undefined> {
    if (this.unavailable) return undefined;
    try {
      return await this.ask(await this.ensure(), command, 10_000);
    } catch (error) {
      this.unavailable = (error as Error).message;
      return undefined;
    }
  }
}

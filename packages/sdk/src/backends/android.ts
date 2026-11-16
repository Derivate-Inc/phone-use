import { execFile, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { BaseDeviceBackend } from '../backend.ts';
import type { DeviceConfig } from '../config.ts';
import type { OpenAppResult, PressTarget, Rect, ScrollDirection, Snapshot } from '../device.ts';
import { ActionFailedError, DeviceNotFoundError, PhoneUseError, TimeoutError } from '../errors.ts';
import { defaultExecRunner, type ExecRunner, isExecError } from '../exec.ts';
import { createDeviceHandle, type Device } from '../lifecycle.ts';
import { AndroidHelper } from './android-helper.ts';
import { parseHierarchy } from './android-hierarchy.ts';

// ---------------------------------------------------------------------------
// The Android backend + engine: a real device or emulator over adb. adb already
// exposes everything the DeviceBackend contract wants, with no daemon:
//
//   eyes    `uiautomator dump`  → the accessibility tree (labels, ids, bounds)
//           `screencap -p`      → a PNG of the screen
//   hands   `input tap/text/swipe/keyevent`
//
// Every device-side command is built from an argv and shell-quoted here,
// because `adb shell` joins its arguments with spaces and hands the string to
// the device's /bin/sh unescaped ("just like the real shell does", per adb's
// own source). Model-controlled strings — app names, URLs, typed text — reach
// this file, so nothing may be interpolated into a shell string raw.
//
// Verified on real hardware (OnePlus Nord AC2001, Android 12) and API 33/36
// emulators, including the full AndroidWorld suite (docs/41).
// ---------------------------------------------------------------------------

/** Android keycodes used below (KeyEvent constants). */
const KEYCODE = { home: 3, back: 4, enter: 66, del: 67, moveEnd: 123 } as const;

/** Where uiautomator writes its dump: /data/local/tmp round-trips on scoped-storage builds, /sdcard does not. */
const DUMP_PATH = '/data/local/tmp/phone-use-dump.xml';

/** A package id as Android accepts it: dotted Java-style segments. */
const PACKAGE_RE = /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/;
/** `com.pkg/.Activity` as `cmd package resolve-activity --brief` prints it. */
const ACTIVITY_RE = /^[\w.]+\/[\w.$]+$/;

/** Characters that need no quoting for the device's /bin/sh. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote one argument for the device shell. `adb shell` does not escape its
 * arguments, so this is the injection boundary for every device command.
 */
export function shellQuote(arg: string): string {
  if (arg.length > 0 && SHELL_SAFE.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** True when every char is printable ASCII — the range `input text` can deliver. */
export function isPrintableAscii(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/** Binary-stdout runner for `adb exec-out` (screencap). Resolves with the raw bytes. */
export type BinaryExecRunner = (
  file: string,
  args: string[],
  opts?: { timeoutMs?: number | undefined },
) => Promise<Uint8Array>;

const pExecFile = promisify(execFile);

const defaultBinaryExecRunner: BinaryExecRunner = async (file, args, opts) => {
  const { stdout } = await pExecFile(file, args, {
    encoding: 'buffer',
    // A screencap PNG on a 1440×3200 panel can run past 10 MB.
    maxBuffer: 64 * 1024 * 1024,
    ...(opts?.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
  });
  return new Uint8Array(stdout);
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Options for {@link AndroidBackend} / {@link createAndroidBackend}. */
export type AndroidBackendOptions = {
  /** adb serial to target (`adb -s`); omit when exactly one device is attached. */
  serial?: string | undefined;
  /** Path to the adb binary (default: `adb` on PATH). */
  adbBin?: string | undefined;
  /** Per-command ceiling in ms before a hung adb call rejects with TimeoutError (default 30_000). */
  commandTimeoutMs?: number | undefined;
  /** @internal test seam — DI'd process runner. */
  exec?: ExecRunner | undefined;
  /** @internal test seam — DI'd binary-stdout runner (screencap). */
  execBinary?: BinaryExecRunner | undefined;
  /** @internal test seam — DI'd delay. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Read the screen through phone-use's on-device helper (a few ms per read)
   * instead of `uiautomator dump` (~2 s). Default: on, unless PHONE_USE_ANDROID_HELPER=0
   * or an exec runner is injected (tests). Falls back to `uiautomator dump` by itself.
   */
  helper?: boolean | undefined;
};

/**
 * Drive an Android device or emulator over adb. Implements the
 * {@link DeviceBackend} contract with uiautomator for the tree, screencap for
 * pixels, and `input` for gestures. Stateless across calls except the ref → rect
 * map from the last snapshot (what makes press-by-ref work).
 */
export class AndroidBackend extends BaseDeviceBackend {
  private readonly serial: string | undefined;
  private readonly adbBin: string;
  private readonly timeoutMs: number;
  private readonly exec: ExecRunner;
  private readonly execBinary: BinaryExecRunner;
  private readonly sleep: (ms: number) => Promise<void>;
  private rects = new Map<string, Rect>();
  private sizeCache: { width: number; height: number } | null = null;
  private launchablesCache: string[] | null = null;
  private readonly helper: AndroidHelper | undefined;

  constructor(opts: AndroidBackendOptions = {}) {
    super('android-adb', [
      'snapshot',
      'screenshot',
      'press',
      'longPress',
      'fill',
      'type',
      'key',
      'scroll',
      'pan',
      'waitForText',
      'home',
      'back',
      'openApp',
      'openUrl',
      'listApps',
      'closeSession',
    ]);
    this.serial = opts.serial;
    this.adbBin = opts.adbBin ?? 'adb';
    this.timeoutMs = opts.commandTimeoutMs ?? 30_000;
    this.exec = opts.exec ?? defaultExecRunner;
    this.execBinary = opts.execBinary ?? defaultBinaryExecRunner;
    this.sleep = opts.sleep ?? defaultSleep;
    const helperOn = opts.helper ?? (opts.exec === undefined && process.env.PHONE_USE_ANDROID_HELPER !== '0');
    this.helper = helperOn ? new AndroidHelper({ adbBin: this.adbBin, serial: this.serial }) : undefined;
  }

  // ---- transport ----------------------------------------------------------

  private withSerial(args: string[]): string[] {
    return this.serial ? ['-s', this.serial, ...args] : args;
  }

  /** Normalize an exec failure into the PhoneUseError the contract promises. */
  private fail(what: string, err: unknown): PhoneUseError {
    if (err instanceof PhoneUseError) return err;
    if (isExecError(err)) {
      const stderr = String(err.stderr ?? '').trim();
      if (err.killed || err.signal) {
        return new TimeoutError(`adb ${what} timed out after ${this.timeoutMs}ms`, { cause: err });
      }
      if (err.code === 'ENOENT') {
        return new ActionFailedError(
          `adb not found at "${this.adbBin}" — install the Android platform-tools or pass adbBin`,
          { cause: err },
        );
      }
      if (/not found|no devices\/emulators|device offline|more than one device|unauthorized/i.test(stderr)) {
        return new DeviceNotFoundError(`adb ${what}: ${stderr}`, { cause: err });
      }
      return new ActionFailedError(
        `adb ${what} failed (exit ${String(err.code ?? '?')}): ${stderr || err.message}`,
        {
          details: { backendCode: String(err.code ?? 'EXEC') },
          cause: err,
        },
      );
    }
    return new ActionFailedError(`adb ${what} failed: ${String(err)}`, { cause: err });
  }

  /** Run an adb command, returning stdout text. */
  private async adb(args: string[]): Promise<string> {
    try {
      const r = await this.exec(this.adbBin, this.withSerial(args), { timeoutMs: this.timeoutMs });
      return r.stdout;
    } catch (err) {
      throw this.fail(args.slice(0, 2).join(' '), err);
    }
  }

  /** `adb shell <argv>` — each argument quoted for the device shell. */
  private shell(...argv: string[]): Promise<string> {
    return this.adb(['shell', argv.map(shellQuote).join(' ')]);
  }

  /** `adb shell <literal>` for the few CONSTANT commands that need a pipe. Never pass input. */
  private shellRaw(literal: string): Promise<string> {
    return this.adb(['shell', literal]);
  }

  private center(ref: string): { x: number; y: number } {
    const rect = this.rects.get(ref);
    if (!rect) throw new ActionFailedError(`unknown element ${ref} — take a fresh snapshot first`);
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  }

  /** The screen size input coordinates map to (an `Override size` wins over `Physical size`). */
  private async screenSize(): Promise<{ width: number; height: number }> {
    if (this.sizeCache) return this.sizeCache;
    const out = await this.shell('wm', 'size');
    const m = out.match(/Override size:\s*(\d+)x(\d+)/) ?? out.match(/Physical size:\s*(\d+)x(\d+)/);
    if (!m) throw new ActionFailedError(`could not read screen size from: ${out.trim()}`);
    this.sizeCache = { width: Number(m[1]), height: Number(m[2]) };
    return this.sizeCache;
  }

  // ---- eyes ---------------------------------------------------------------

  override async snapshot(opts?: { interactiveOnly?: boolean | undefined }): Promise<Snapshot> {
    const size = await this.screenSize();
    // A dump can fail while the UI is mid-animation; retry briefly. An EMPTY
    // dump is a failure, not an empty screen: reporting zero nodes as success
    // sent agents scroll-hunting for controls that were on screen the whole time.
    // The on-device helper answers from a warm accessibility connection; the
    // dump below is the fallback when it is off or could not start.
    let xml = (await this.helper?.dump()) ?? '';
    let lastError: unknown;
    for (let attempt = 0; attempt < 3 && !xml.includes('<node'); attempt += 1) {
      try {
        await this.shell('uiautomator', 'dump', DUMP_PATH);
        xml = await this.adb(['exec-out', 'cat', DUMP_PATH]);
      } catch (err) {
        lastError = err;
      }
      if (xml.includes('<node')) break;
      await this.sleep(400);
    }
    if (!xml.includes('<node')) {
      throw new ActionFailedError(
        'uiautomator dump produced no UI nodes after 3 attempts — the UI may be mid-transition or uiautomator ' +
          'may be wedged (try `adb shell uiautomator dump` by hand)',
        { cause: lastError },
      );
    }
    const parsed = parseHierarchy(xml, { interactiveOnly: opts?.interactiveOnly ?? false });
    this.rects = parsed.rects;
    // Prefer the resumed activity's package: the dump's first node is usually
    // the status bar (com.android.systemui), so the tree's own package would
    // mislabel every screen as systemui.
    const appName = (await this.foregroundPackage().catch(() => undefined)) ?? parsed.packageName;
    return {
      // Synthetic root: the SDK derives the viewport from an Application/Window
      // node and FALLS BACK TO 1000px when none exists. uiautomator dumps have
      // no such node, so on a 2400px screen everything below y≈1000 was
      // classified off-viewport. Give the tree a true-sized root.
      nodes: [
        {
          ref: '@a0',
          type: 'Application',
          role: 'Application',
          label: appName ?? 'android',
          rect: { x: 0, y: 0, width: size.width, height: size.height },
        },
        ...parsed.nodes,
      ],
      ...(appName ? { appName, appBundleId: appName } : {}),
    };
  }

  /** The package of the resumed (frontmost) activity, for the snapshot header. */
  private async foregroundPackage(): Promise<string | undefined> {
    // The key varies by Android version (ResumedActivity / mResumedActivity /
    // topResumedActivity); the record shape does not: …{hash u0 com.pkg/.Act t123}
    const fromHelper = await this.helper?.foreground();
    if (fromHelper) return fromHelper;
    const out = await this.shellRaw('dumpsys activity activities | grep -m1 ResumedActivity');
    return out.match(/\su0\s+([\w.]+)\//)?.[1];
  }

  override async screenshot(opts: { path: string }): Promise<{ path: string }> {
    let png: Uint8Array;
    try {
      png = await this.execBinary(this.adbBin, this.withSerial(['exec-out', 'screencap', '-p']), {
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      throw this.fail('screencap', err);
    }
    await writeFile(opts.path, png);
    return { path: opts.path };
  }

  // ---- hands --------------------------------------------------------------

  override async press(target: PressTarget): Promise<void> {
    const { x, y } = 'ref' in target ? this.center(target.ref) : target;
    await this.shell('input', 'tap', String(Math.round(x)), String(Math.round(y)));
  }

  override async longPress(ref: string, durationMs = 700): Promise<void> {
    const { x, y } = this.center(ref);
    // A zero-distance swipe with a duration is Android's long-press.
    await this.shell(
      'input',
      'swipe',
      String(x),
      String(y),
      String(x),
      String(y),
      String(Math.max(400, durationMs)),
    );
  }

  override async fill(ref: string, text: string): Promise<void> {
    const { x, y } = this.center(ref);
    await this.shell('input', 'tap', String(x), String(y));
    await this.sleep(120);
    await this.clearFocusedField();
    await this.typeText(text);
  }

  /**
   * Empty the currently-focused text field. Ctrl+A then DEL (`input
   * keycombination`, Android 12+); a short MOVE_END + backspace sweep stays as
   * the fallback for the rare field that ignores the select combo. Replaces a
   * 60-backspace sweep that left residue on long fields and made repeated
   * `type`s ACCUMULATE, sending the agent into retry loops.
   */
  private async clearFocusedField(): Promise<void> {
    await this.shell('input', 'keycombination', '113', '29').catch(() => undefined); // Ctrl(113)+A(29)
    await this.shell('input', 'keyevent', String(KEYCODE.del));
    await this.shell('input', 'keyevent', String(KEYCODE.moveEnd));
    for (let i = 0; i < 8; i += 1) await this.shell('input', 'keyevent', String(KEYCODE.del));
  }

  override async typeText(text: string): Promise<void> {
    if (!text) return;
    // ASCII goes through `input text` as ONE quoted argument (spaces included —
    // the `%s` convention only existed because unquoted spaces split the
    // argument). Non-ASCII makes Android's own `input text` throw, so it rides
    // the ADB Keyboard IME when present. Newlines become ENTER and \b becomes
    // DEL so multi-line and corrective input work through the same call.
    for (const [i, line] of text.split('\n').entries()) {
      if (i > 0) await this.shell('input', 'keyevent', String(KEYCODE.enter));
      for (const [j, chunk] of line.split('\b').entries()) {
        if (j > 0) await this.shell('input', 'keyevent', String(KEYCODE.del));
        if (!chunk) continue;
        if (isPrintableAscii(chunk)) {
          // Bounded per call: adb's command line has a ~4 KiB ceiling.
          for (let at = 0; at < chunk.length; at += 400) {
            await this.shell('input', 'text', chunk.slice(at, at + 400));
          }
        } else {
          await this.typeUnicode(chunk);
        }
      }
    }
  }

  /** The IME id of senzhk/ADBKeyBoard, the de-facto Unicode input path for adb. */
  private static readonly ADB_IME = 'com.android.adbkeyboard/.AdbIME';

  /**
   * Type non-ASCII via the ADB Keyboard broadcast. The IME must be the ACTIVE
   * keyboard; some OEM builds deny the shell WRITE_SECURE_SETTINGS so `ime set`
   * cannot switch it. We try (works on stock builds) and restore the previous
   * keyboard afterwards when we did the switching. Never a silent drop.
   */
  private async typeUnicode(text: string): Promise<void> {
    const ime = AndroidBackend.ADB_IME;
    const installed = (
      await this.shell('pm', 'list', 'packages', 'com.android.adbkeyboard').catch(() => '')
    ).includes('com.android.adbkeyboard');
    if (!installed) {
      throw new ActionFailedError(
        `Android cannot type non-ASCII text ("${text.slice(0, 20)}…") over adb: the platform's own \`input text\` ` +
          'rejects it and no built-in alternative exists. ASCII works. For accented or non-Latin text, tap the ' +
          'field and use the on-screen keyboard (tap the keys), or paste text the user already has on the clipboard. ' +
          '(Dev/test devices only: the ADB Keyboard IME — github.com/senzhk/ADBKeyBoard — enables Unicode over adb.)',
      );
    }
    const previous = (
      await this.shell('settings', 'get', 'secure', 'default_input_method').catch(() => '')
    ).trim();
    let switched = false;
    if (previous !== ime) {
      await this.shell('ime', 'enable', ime).catch(() => undefined);
      await this.shell('ime', 'set', ime).catch(() => undefined);
      const now = (
        await this.shell('settings', 'get', 'secure', 'default_input_method').catch(() => '')
      ).trim();
      switched = now === ime;
      if (!switched) {
        throw new ActionFailedError(
          'Android cannot type non-ASCII text over adb on this device: the ADB Keyboard IME is installed but ' +
            'the OS blocks adb from activating it (WRITE_SECURE_SETTINGS denied). ASCII works. For accented or ' +
            'non-Latin text, tap the field and use the on-screen keyboard, or paste from the clipboard. ' +
            '(Dev/test: enable ADB Keyboard once in Settings → Languages & input → Manage keyboards.)',
        );
      }
      await this.sleep(300);
    }
    try {
      const b64 = Buffer.from(text, 'utf8').toString('base64');
      await this.shell('am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', b64);
      await this.sleep(150);
    } finally {
      if (switched && previous) await this.shell('ime', 'set', previous).catch(() => undefined);
    }
  }

  override async pressKey(_key: 'return'): Promise<void> {
    await this.shell('input', 'keyevent', String(KEYCODE.enter));
  }

  override async scroll(direction: ScrollDirection): Promise<void> {
    const { width, height } = await this.screenSize();
    // NEVER swipe through the soft keyboard: Gboard reads a drag across it as
    // glide typing and types a word into the focused field (measured live —
    // every scroll typed "by"). With the IME shown, anchor the gesture in the
    // keyboard-free upper band instead.
    const imeShown = (await this.shell('dumpsys', 'input_method').catch(() => '')).includes(
      'mInputShown=true',
    );
    const cx = Math.round(width / 2);
    const cy = imeShown ? Math.round(height * 0.3) : Math.round(height / 2);
    const dx = Math.round(width * 0.35);
    const dy = imeShown ? Math.round(height * 0.15) : Math.round(height * 0.35);
    // Swipe the finger OPPOSITE to the content you want revealed.
    const from = { up: [cx, cy - dy], down: [cx, cy + dy], left: [cx - dx, cy], right: [cx + dx, cy] };
    const to = { up: [cx, cy + dy], down: [cx, cy - dy], left: [cx + dx, cy], right: [cx - dx, cy] };
    const [fx, fy] = from[direction] as [number, number];
    const [tx, ty] = to[direction] as [number, number];
    // A quick swipe ends with velocity, so the list keeps flinging after the
    // command returns — the next uiautomator dump reads mid-animation geometry
    // and a follow-up tap gets absorbed as "stop the fling" instead of a
    // click. Swipe slowly enough to avoid momentum, then let the UI settle.
    await this.shell('input', 'swipe', String(fx), String(fy), String(tx), String(ty), '450');
    await this.sleep(350);
  }

  override async pan(x: number, y: number, dx: number, dy: number, durationMs = 300): Promise<void> {
    await this.shell(
      'input',
      'swipe',
      String(Math.round(x)),
      String(Math.round(y)),
      String(Math.round(x + dx)),
      String(Math.round(y + dy)),
      String(Math.max(50, durationMs)),
    );
  }

  override async waitForText(text: string, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const needle = text.toLowerCase();
    for (;;) {
      const snap = await this.snapshot();
      if (snap.nodes.some((n) => (n.label ?? '').toLowerCase().includes(needle))) return;
      if (Date.now() >= deadline) throw new TimeoutError(`"${text}" did not appear within ${timeoutMs}ms`);
      await this.sleep(500);
    }
  }

  override async home(): Promise<void> {
    await this.shell('input', 'keyevent', String(KEYCODE.home));
  }

  override async back(): Promise<void> {
    await this.shell('input', 'keyevent', String(KEYCODE.back));
  }

  // ---- apps ---------------------------------------------------------------

  /** Packages that expose a launcher icon — the set `open <name>` can resolve to. */
  private async launchables(): Promise<string[]> {
    if (this.launchablesCache) return this.launchablesCache;
    const out = await this.shell(
      'cmd',
      'package',
      'query-activities',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
    ).catch(() => '');
    const pkgs = [...new Set([...out.matchAll(/packageName=([\w.]+)/g)].map((m) => m[1]!))];
    if (pkgs.length) this.launchablesCache = pkgs; // never cache an empty (transient) result
    return pkgs;
  }

  /**
   * Resolve a human app name to an installed package: agents say "Markor" or
   * "Simple Calendar", `am` needs `net.gsantner.markor`. Score each launchable
   * package by how many of the query's words appear in its id; best (shortest
   * on a tie) wins. An exact package id passes straight through. Returns
   * undefined when nothing matches and the query is not a package id at all.
   */
  private async resolvePackage(query: string): Promise<string | undefined> {
    const launch = await this.launchables();
    if (launch.includes(query)) return query;
    // A package-shaped query is an id, not a name: never fuzzy-match it (the
    // `com` in `com.example.hidden` would otherwise "match" com.android.settings).
    if (PACKAGE_RE.test(query)) return query;
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    let best: { pkg: string; score: number } | null = null;
    for (const pkg of launch) {
      const np = norm(pkg);
      const score = words.filter((w) => np.includes(w)).length;
      if (score === 0) continue;
      if (!best || score > best.score || (score === best.score && pkg.length < best.pkg.length)) {
        best = { pkg, score };
      }
    }
    return best?.pkg;
  }

  override async openApp(opts: {
    app?: string | undefined;
    url?: string | undefined;
    relaunch?: boolean | undefined;
  }): Promise<OpenAppResult> {
    if (opts.url) {
      await this.shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', opts.url);
      return {};
    }
    if (!opts.app) throw new ActionFailedError('openApp needs an app name/package id or a url');
    const pkg = await this.resolvePackage(opts.app);
    if (!pkg) {
      throw new DeviceNotFoundError(
        `no installed app matches "${opts.app}" — pass a launcher name or a package id (see listApps)`,
      );
    }
    if (opts.relaunch) await this.shell('am', 'force-stop', pkg).catch(() => undefined);
    // Launch via the resolved launcher activity + `am start`. `monkey` returns a
    // spurious non-zero exit on keyless AVDs and sometimes fails to launch at
    // all, so it is only the fallback when the activity can't be resolved.
    const activity = (
      await this.shell(
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        '-c',
        'android.intent.category.LAUNCHER',
        pkg,
      ).catch(() => '')
    )
      .trim()
      .split('\n')
      .pop()
      ?.trim();
    if (activity && ACTIVITY_RE.test(activity)) {
      await this.shell('am', 'start', '-n', activity);
    } else {
      await this.shell('monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1').catch(
        () => undefined,
      );
    }
    return { appBundleId: pkg };
  }

  override async listApps(): Promise<string[]> {
    const out = await this.shell('pm', 'list', 'packages');
    return out
      .split('\n')
      .map((l) => l.replace(/^package:/, '').trim())
      .filter(Boolean)
      .sort();
  }

  override closeSession(): Promise<void> {
    // adb is stateless — nothing to tear down.
    return Promise.resolve();
  }
}

/**
 * Backend factory for the `android-adb` registry entry: an
 * {@link AndroidDeviceConfig} pins the serial; anything else targets the single
 * attached device.
 */
export function createAndroidBackend(config?: DeviceConfig | AndroidBackendOptions): AndroidBackend {
  if (config && 'platform' in config) {
    return new AndroidBackend(config.platform === 'android' ? { serial: config.serial } : {});
  }
  return new AndroidBackend(config);
}

// ---------------------------------------------------------------------------
// The Android engine (engine-as-object, the ios.ts twin): android.connect()
// attaches to a device adb already sees; android.launch() boots a dedicated
// emulator instance from an AVD and returns a Device that kills it on close.
// ---------------------------------------------------------------------------

/** One row of `adb devices -l`. */
export type AndroidDeviceInfo = {
  /** adb serial, e.g. `emulator-5554` or `R58M12ABCDE`. */
  serial: string;
  /** adb state: `device` (ready), `unauthorized`, `offline`, … */
  state: string;
  /** Model name when adb reports one. */
  model?: string | undefined;
};

type CommonAndroidOptions = {
  /** Path to the adb binary (default: `adb` on PATH). */
  adbBin?: string | undefined;
  /** Idle lease window in ms (false disables). Default 180_000 (3 min). */
  idleTimeoutMs?: number | false | undefined;
  /** Observer for reaper-initiated closes. */
  onIdleClose?: ((device: Device) => void) | undefined;
  /** Initial %name% secret values (see Device.secrets). */
  secrets?: Record<string, string> | undefined;
  /** @internal harness seam — supplies the verb core (see createDeviceHandle). */
  coreFactory?:
    | ((backend: import('../backend.ts').DeviceBackend) => import('../observe.ts').DeviceCore)
    | undefined;
  /** @internal test seam — DI'd process runner. */
  exec?: ExecRunner | undefined;
  /** @internal test seam — DI'd binary-stdout runner. */
  execBinary?: BinaryExecRunner | undefined;
  /** @internal test seam — DI'd delay. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Read the screen through phone-use's on-device helper (a few ms per read)
   * instead of `uiautomator dump` (~2 s). Default: on, unless PHONE_USE_ANDROID_HELPER=0
   * or an exec runner is injected (tests). Falls back to `uiautomator dump` by itself.
   */
  helper?: boolean | undefined;
};

/** Options for `android.connect()`. */
export type AndroidConnectOptions = CommonAndroidOptions;

/** Options for `android.list()`. */
export type AndroidListOptions = {
  /** Path to the adb binary (default: `adb` on PATH). */
  adbBin?: string | undefined;
  /** @internal test seam — DI'd process runner. */
  exec?: ExecRunner | undefined;
};

/** The child-process handle the emulator spawner returns (what `android.launch()` kills on close). */
export type EmulatorProcess = {
  /** Send a signal to the emulator process. */
  kill(signal?: NodeJS.Signals): void;
  /** Subscribe once to process exit. */
  once(event: 'exit', listener: () => void): unknown;
  /** True once the process has exited. */
  readonly exited: boolean;
};

/** Options for `android.launch()` — which AVD, which port, headless or not. */
export type AndroidLaunchOptions = CommonAndroidOptions & {
  /** The AVD name (`emulator -list-avds`). Required. */
  avd: string;
  /** Console port; the serial becomes `emulator-<port>`. Default 5554. Must be even. */
  port?: number | undefined;
  /** Path to the `emulator` binary (default: `$ANDROID_HOME/emulator/emulator`, else `emulator` on PATH). */
  emulatorBin?: string | undefined;
  /** Run without a window (default true — cloud hosts have no display). */
  headless?: boolean | undefined;
  /** `-read-only`: lets several instances of ONE AVD run at once (what a cloud worker wants). */
  readOnly?: boolean | undefined;
  /** Extra emulator arguments appended verbatim (e.g. `-gpu swiftshader_indirect`). */
  extraArgs?: string[] | undefined;
  /** Boot ceiling in ms for `sys.boot_completed` (default 180_000). */
  bootTimeoutMs?: number | undefined;
  /** @internal test seam — boot-poll interval (default 1000). */
  pollIntervalMs?: number | undefined;
  /** @internal test seam — DI'd emulator spawner. */
  spawn?: ((file: string, args: string[]) => EmulatorProcess) | undefined;
};

/** Parse `adb devices -l` (header dropped). */
function parseDevices(stdout: string): AndroidDeviceInfo[] {
  return stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('*'))
    .map((line) => {
      const [serial = '', state = 'unknown', ...rest] = line.split(/\s+/);
      const model = rest.find((f) => f.startsWith('model:'))?.slice('model:'.length);
      return { serial, state, ...(model ? { model } : {}) };
    })
    .filter((d) => d.serial.length > 0);
}

async function runAdb(exec: ExecRunner, adbBin: string, args: string[], timeoutMs: number): Promise<string> {
  try {
    return (await exec(adbBin, args, { timeoutMs })).stdout;
  } catch (err) {
    if (isExecError(err)) {
      if (err.killed || err.signal)
        throw new TimeoutError(`adb ${args[0]} timed out after ${timeoutMs}ms`, { cause: err });
      if (err.code === 'ENOENT') {
        throw new ActionFailedError(`adb not found at "${adbBin}" — install the Android platform-tools`, {
          cause: err,
        });
      }
      // exec-out runs surface stderr as a Buffer, not a string — coerce.
      throw new ActionFailedError(`adb ${args[0]} failed: ${String(err.stderr ?? err.message).trim()}`, {
        cause: err,
      });
    }
    throw new ActionFailedError(`adb ${args[0]} failed: ${String(err)}`, { cause: err });
  }
}

/** Devices adb currently sees, with their state. */
async function list(options: AndroidListOptions = {}): Promise<AndroidDeviceInfo[]> {
  const exec = options.exec ?? defaultExecRunner;
  return parseDevices(await runAdb(exec, options.adbBin ?? 'adb', ['devices', '-l'], 15_000));
}

function finishHandle(
  row: AndroidDeviceInfo,
  createdByUs: boolean,
  opts: CommonAndroidOptions,
  doClose: () => Promise<void>,
): Device {
  const backend = new AndroidBackend({
    serial: row.serial,
    adbBin: opts.adbBin,
    exec: opts.exec,
    execBinary: opts.execBinary,
    sleep: opts.sleep,
  });
  return createDeviceHandle({
    id: row.serial,
    platform: 'android',
    name: row.model,
    backend,
    createdByUs,
    idleTimeoutMs: opts.idleTimeoutMs,
    onIdleClose: opts.onIdleClose,
    secrets: opts.secrets,
    coreFactory: opts.coreFactory,
    doClose,
  });
}

const FIX_USB_DEBUGGING =
  'enable Developer options → USB debugging on the phone, connect over USB (or `adb connect <ip:port>`), ' +
  'and confirm with `adb devices`';

/**
 * Attach to a device adb already sees. With a serial, that device; without,
 * the single ready device (several attached → an error naming them, so verbs
 * never land on the wrong phone). `close()` releases the handle and never
 * shuts the device down — it was yours before we connected.
 */
async function connect(serial?: string, options: AndroidConnectOptions = {}): Promise<Device> {
  const exec = options.exec ?? defaultExecRunner;
  const devices = await list({ adbBin: options.adbBin, exec });
  let row: AndroidDeviceInfo | undefined;
  if (serial !== undefined) {
    row = devices.find((d) => d.serial === serial);
    if (!row) {
      const seen = devices.map((d) => `${d.serial} (${d.state})`).join(', ') || 'none';
      throw new DeviceNotFoundError(`no adb device with serial ${serial} — attached: ${seen}`);
    }
  } else {
    const ready = devices.filter((d) => d.state === 'device');
    if (ready.length === 0) {
      const unauthorized = devices.find((d) => d.state === 'unauthorized');
      throw new DeviceNotFoundError(
        unauthorized
          ? `device ${unauthorized.serial} is attached but unauthorized — unlock it and accept the "Allow USB debugging" prompt`
          : `no Android device attached — ${FIX_USB_DEBUGGING}`,
      );
    }
    if (ready.length > 1) {
      throw new DeviceNotFoundError(
        `several Android devices attached (${ready.map((d) => d.serial).join(', ')}) — pass a serial`,
      );
    }
    row = ready[0]!;
  }
  if (row.state !== 'device') {
    throw new DeviceNotFoundError(
      row.state === 'unauthorized'
        ? `device ${row.serial} is unauthorized — unlock it and accept the "Allow USB debugging" prompt`
        : `device ${row.serial} is ${row.state} — ${FIX_USB_DEBUGGING}`,
    );
  }
  return finishHandle(row, false, options, () => Promise.resolve());
}

function defaultEmulatorBin(): string {
  const root = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  return root ? `${root}/emulator/emulator` : 'emulator';
}

function defaultSpawn(file: string, args: string[]): EmulatorProcess {
  const child = spawn(file, args, { stdio: 'ignore' });
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  // A spawn failure (ENOENT) surfaces as 'error'; treat it as an exit so the
  // boot wait below fails fast instead of polling a serial that never appears.
  child.once('error', () => {
    exited = true;
    child.emit('exit');
  });
  return {
    kill: (signal) => {
      child.kill(signal);
    },
    once: (event, listener) => child.once(event, listener),
    get exited() {
      return exited;
    },
  };
}

/**
 * Boot a DEDICATED emulator instance from an AVD and return a {@link Device}
 * pinned to its serial (`emulator-<port>`). `close()` kills the instance.
 * `readOnly: true` lets several instances of one AVD run side by side, which
 * is how a cloud worker turns one golden image into N phones.
 */
async function launch(options: AndroidLaunchOptions): Promise<Device> {
  const exec = options.exec ?? defaultExecRunner;
  const sleep = options.sleep ?? defaultSleep;
  const adbBin = options.adbBin ?? 'adb';
  const port = options.port ?? 5554;
  if (port % 2 !== 0 || port < 5554 || port > 5682) {
    throw new ActionFailedError(`emulator port must be an even number in 5554..5682, got ${port}`);
  }
  const serial = `emulator-${port}`;
  const bootTimeoutMs = options.bootTimeoutMs ?? 180_000;
  const pollMs = options.pollIntervalMs ?? 1000;
  const spawnEmulator = options.spawn ?? defaultSpawn;

  const args = [
    '-avd',
    options.avd,
    '-port',
    String(port),
    '-no-boot-anim',
    '-no-audio',
    ...(options.headless === false ? [] : ['-no-window']),
    ...(options.readOnly ? ['-read-only'] : []),
    ...(options.extraArgs ?? []),
  ];
  const child = spawnEmulator(options.emulatorBin ?? defaultEmulatorBin(), args);

  const stop = async (): Promise<void> => {
    await runAdb(exec, adbBin, ['-s', serial, 'emu', 'kill'], 10_000).catch(() => undefined);
    if (child.exited) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  try {
    const deadline = Date.now() + bootTimeoutMs;
    await runAdb(exec, adbBin, ['-s', serial, 'wait-for-device'], bootTimeoutMs);
    for (;;) {
      if (child.exited) throw new ActionFailedError(`emulator ${serial} exited during boot`);
      const out = await runAdb(
        exec,
        adbBin,
        ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
        15_000,
      ).catch(() => '');
      if (out.trim() === '1') break;
      if (Date.now() >= deadline) {
        throw new TimeoutError(`emulator ${serial} did not finish booting within ${bootTimeoutMs}ms`);
      }
      await sleep(pollMs);
    }
  } catch (err) {
    // We started it and it never came up — never leak a headless emulator.
    await stop().catch(() => undefined);
    throw err;
  }

  // Automation prep, best effort. Animations left running stall the a11y
  // idle detector (uiautomator dumps then serve stale pre-transition trees),
  // and the SIM Toolkit's carrier dialog plants itself over whatever the
  // agent opens on a fresh boot.
  for (const key of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
    await runAdb(exec, adbBin, ['-s', serial, 'shell', 'settings', 'put', 'global', key, '0'], 10_000).catch(
      () => undefined,
    );
  }
  await runAdb(
    exec,
    adbBin,
    ['-s', serial, 'shell', 'pm', 'disable-user', '--user', '0', 'com.android.stk'],
    10_000,
  ).catch(() => undefined);

  return finishHandle({ serial, state: 'device', model: options.avd }, true, options, stop);
}

/**
 * The Android engine object (the `ios` twin): `android.connect()` for a device
 * adb already sees, `android.launch()` for a dedicated emulator instance,
 * `android.list()` to see what is attached. All return/describe the same
 * Device type the iOS engine does.
 */
export const android = {
  /** Attach to an attached device or running emulator by serial (no-arg: the single ready device). */
  connect,
  /** Boot a dedicated emulator instance from an AVD and return a Device pinned to it. */
  launch,
  /** Devices adb currently sees, with their state. */
  list,
} as const;

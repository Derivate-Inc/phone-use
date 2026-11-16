import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AndroidBackend, createAndroidBackend, shellQuote } from '../src/backends/android.ts';
import { ActionFailedError, DeviceNotFoundError, TimeoutError } from '../src/errors.ts';
import type { ExecRunner } from '../src/exec.ts';

// A trimmed but real-shaped uiautomator dump.
const DUMP = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][1080,2340]">
    <node index="0" text="Sign in" resource-id="com.example.app:id/login" class="android.widget.Button" package="com.example.app" clickable="true" enabled="true" bounds="[40,300][1040,420]" />
    <node index="1" text="" content-desc="Email" class="android.widget.EditText" package="com.example.app" clickable="true" focusable="true" enabled="true" bounds="[40,140][1040,260]" />
  </node>
</hierarchy>`;

type Call = { file: string; args: string[] };

/** Strip the `-s <serial>` prefix so assertions read the same with or without a serial. */
const strip = (args: string[]): string[] => (args[0] === '-s' ? args.slice(2) : args);

/** Canned responses for a healthy device; tests override per case. */
function healthy(args: string[]): string {
  const a = strip(args);
  if (a[0] === 'shell') {
    const s = a[1] ?? '';
    if (s.startsWith('wm size')) return 'Physical size: 1080x2340\n';
    if (s.startsWith('uiautomator dump'))
      return `UI hierchary dumped to: /data/local/tmp/phone-use-dump.xml\n`;
    if (s.startsWith('dumpsys activity'))
      return '    mResumedActivity: ActivityRecord{1a2b u0 com.example.app/.Main t12}\n';
    if (s.startsWith('dumpsys input_method')) return '  mInputShown=false\n';
    if (s.startsWith('cmd package query-activities')) {
      return '      packageName=net.gsantner.markor\n      packageName=com.android.settings\n';
    }
    if (s.startsWith('cmd package resolve-activity')) return 'net.gsantner.markor/.activity.MainActivity\n';
    if (s.startsWith('pm list packages com.android.adbkeyboard')) return '';
    if (s.startsWith('pm list packages')) return 'package:com.b\npackage:com.a\n';
    return '';
  }
  if (a[0] === 'exec-out' && a[1] === 'cat') return DUMP;
  return '';
}

function fakeAdb(respond: (args: string[]) => string | Error = healthy) {
  const calls: Call[] = [];
  const exec: ExecRunner = async (file, args) => {
    calls.push({ file, args: [...args] });
    const r = respond(args);
    if (r instanceof Error) throw r;
    return { stdout: r, stderr: '' };
  };
  const shells = () => calls.filter((c) => strip(c.args)[0] === 'shell').map((c) => strip(c.args)[1] ?? '');
  const backend = new AndroidBackend({
    exec,
    execBinary: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    sleep: async () => undefined,
  });
  return { exec, calls, shells, backend };
}

const execError = (props: { code?: number | string; stderr?: string; killed?: boolean; signal?: string }) =>
  Object.assign(new Error('Command failed'), { stdout: '', stderr: '', ...props });

describe('shellQuote', () => {
  it('leaves safe tokens alone and single-quotes everything else', () => {
    expect(shellQuote('input')).toBe('input');
    expect(shellQuote('com.example.app/.Main')).toBe('com.example.app/.Main');
    expect(shellQuote('hello world')).toBe("'hello world'");
    expect(shellQuote(';reboot;')).toBe("';reboot;'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('')).toBe("''");
  });
});

describe('AndroidBackend snapshot', () => {
  it('prefixes a true-size Application root and reads the foreground package', async () => {
    const { backend } = fakeAdb();
    const snap = await backend.snapshot();
    expect(snap.nodes[0]).toMatchObject({
      ref: '@a0',
      type: 'Application',
      label: 'com.example.app',
      rect: { x: 0, y: 0, width: 1080, height: 2340 },
    });
    expect(snap.appName).toBe('com.example.app');
    expect(snap.nodes.some((n) => n.label === 'Sign in' && n.type === 'Button')).toBe(true);
  });

  it('an empty dump is an error, never an empty screen', async () => {
    const { backend, shells } = fakeAdb((args) => (strip(args)[1] === 'cat' ? '' : healthy(args)));
    await expect(backend.snapshot()).rejects.toBeInstanceOf(ActionFailedError);
    await expect(backend.snapshot()).rejects.toThrow(/no UI nodes after 3 attempts/);
    expect(shells().filter((s) => s.startsWith('uiautomator dump'))).toHaveLength(6);
  });

  it('a dump that throws is retried, then surfaced', async () => {
    const { backend } = fakeAdb((args) =>
      strip(args)[1]?.startsWith('uiautomator') ? execError({ code: 1, stderr: 'killed' }) : healthy(args),
    );
    await expect(backend.snapshot()).rejects.toBeInstanceOf(ActionFailedError);
  });
});

describe('AndroidBackend gestures', () => {
  it('press by ref taps the element centre; unknown refs fail without touching the device', async () => {
    const { backend, shells } = fakeAdb();
    await backend.snapshot();
    const login = (await backend.snapshot()).nodes.find((n) => n.label === 'Sign in')!;
    await backend.press({ ref: login.ref! });
    expect(shells().at(-1)).toBe('input tap 540 360');
    const before = shells().length;
    await expect(backend.press({ ref: '@a99' })).rejects.toBeInstanceOf(ActionFailedError);
    expect(shells().length).toBe(before);
  });

  it('press at coordinates rounds', async () => {
    const { backend, shells } = fakeAdb();
    await backend.press({ x: 10.4, y: 20.6 });
    expect(shells().at(-1)).toBe('input tap 10 21');
  });

  it('scroll anchors in the keyboard-free band when the IME is shown', async () => {
    const { backend: closed, shells: closedShells } = fakeAdb();
    await closed.scroll('down');
    expect(closedShells().at(-1)).toBe('input swipe 540 1989 540 351 450');
    const { backend: open, shells: openShells } = fakeAdb((args) =>
      strip(args)[1]?.startsWith('dumpsys input_method') ? 'mInputShown=true' : healthy(args),
    );
    await open.scroll('down');
    expect(openShells().at(-1)).toBe('input swipe 540 1053 540 351 450');
  });

  it('screenshot writes the screencap bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pu-android-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const { backend, calls } = fakeAdb();
    const out = join(dir, 'shot.png');
    expect(await backend.screenshot({ path: out })).toEqual({ path: out });
    expect([...readFileSync(out)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(calls).toHaveLength(0); // binary runner, not the text runner
  });
});

describe('AndroidBackend typing', () => {
  it('sends ASCII as ONE quoted argument — spaces and quotes survive, no %s dance', async () => {
    const { backend, shells } = fakeAdb();
    await backend.typeText("hello world it's 50% off");
    expect(shells()).toEqual([`input text 'hello world it'\\''s 50% off'`]);
  });

  it('newline → ENTER, backspace → DEL', async () => {
    const { backend, shells } = fakeAdb();
    await backend.typeText('ab\ncd\be');
    expect(shells()).toEqual([
      'input text ab',
      'input keyevent 66',
      'input text cd',
      'input keyevent 67',
      'input text e',
    ]);
  });

  it('non-ASCII without the ADB Keyboard IME fails clearly instead of dropping characters', async () => {
    const { backend, shells } = fakeAdb();
    await expect(backend.typeText('café')).rejects.toThrow(/cannot type non-ASCII/);
    expect(shells().some((s) => s.startsWith('input text'))).toBe(false);
  });

  it('fill taps, clears with Ctrl+A/DEL, then types', async () => {
    const { backend, shells } = fakeAdb();
    await backend.snapshot();
    const email = (await backend.snapshot()).nodes.find((n) => n.label === 'Email')!;
    await backend.fill(email.ref!, 'ada@example.com');
    const s = shells();
    expect(s).toContain('input tap 540 200');
    expect(s).toContain('input keycombination 113 29');
    expect(s.at(-1)).toBe('input text ada@example.com');
  });
});

describe('AndroidBackend openApp (the injection boundary)', () => {
  it('quotes URLs verbatim — no shell metacharacters reach the device unquoted, no %-mangling', async () => {
    const { backend, shells } = fakeAdb();
    await backend.openApp({ url: 'https://x.test/a%20b?q=1;reboot;' });
    expect(shells()).toEqual([
      `am start -a android.intent.action.VIEW -d 'https://x.test/a%20b?q=1;reboot;'`,
    ]);
  });

  it('a newline in a URL cannot start a second command', async () => {
    const { backend, shells } = fakeAdb();
    await backend.openApp({ url: 'https://x.test/\nrm -rf /sdcard' });
    expect(shells()).toHaveLength(1);
    expect(shells()[0]).toBe(`am start -a android.intent.action.VIEW -d 'https://x.test/\nrm -rf /sdcard'`);
  });

  it('resolves a launcher name to its package and starts the resolved activity', async () => {
    const { backend, shells } = fakeAdb();
    expect(await backend.openApp({ app: 'Markor' })).toEqual({ appBundleId: 'net.gsantner.markor' });
    expect(shells().at(-1)).toBe('am start -n net.gsantner.markor/.activity.MainActivity');
  });

  it('an unmatched, non-package query is refused before any am/monkey call', async () => {
    const { backend, shells } = fakeAdb();
    await expect(backend.openApp({ app: ';reboot;' })).rejects.toBeInstanceOf(DeviceNotFoundError);
    expect(shells().some((s) => s.startsWith('am ') || s.startsWith('monkey'))).toBe(false);
  });

  it('a well-formed package id that is not launchable still passes through (quoted)', async () => {
    const { backend, shells } = fakeAdb((args) =>
      strip(args)[1]?.startsWith('cmd package resolve-activity') ? '' : healthy(args),
    );
    await backend.openApp({ app: 'com.example.hidden', relaunch: true });
    expect(shells()).toContain('am force-stop com.example.hidden');
    expect(shells().at(-1)).toBe('monkey -p com.example.hidden -c android.intent.category.LAUNCHER 1');
  });

  it('listApps strips the package: prefix and sorts', async () => {
    const { backend } = fakeAdb();
    expect(await backend.listApps()).toEqual(['com.a', 'com.b']);
  });
});

describe('AndroidBackend error mapping', () => {
  it('device-gone stderr → DeviceNotFoundError', async () => {
    const { backend } = fakeAdb(() => execError({ code: 1, stderr: "error: device 'R58M' not found" }));
    await expect(backend.home()).rejects.toBeInstanceOf(DeviceNotFoundError);
  });
  it('a killed process → TimeoutError', async () => {
    const { backend } = fakeAdb(() => execError({ killed: true, signal: 'SIGTERM' }));
    await expect(backend.home()).rejects.toBeInstanceOf(TimeoutError);
  });
  it('missing adb binary → ActionFailedError naming the install fix', async () => {
    const { backend } = fakeAdb(() => execError({ code: 'ENOENT' }));
    await expect(backend.home()).rejects.toThrow(/adb not found/);
  });
  it('serial is threaded into every call', async () => {
    const calls: Call[] = [];
    const backend = new AndroidBackend({
      serial: 'emulator-5556',
      exec: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      },
    });
    await backend.back();
    expect(calls[0]).toEqual({ file: 'adb', args: ['-s', 'emulator-5556', 'shell', 'input keyevent 4'] });
  });

  it('pressKey sends the key event for each key, not Return for all of them', async () => {
    const calls: Call[] = [];
    const backend = new AndroidBackend({
      serial: 'emulator-5556',
      exec: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      },
    });
    for (const key of ['return', 'tab', 'backspace', 'space', 'escape'] as const) await backend.pressKey(key);
    expect(calls.map((c) => c.args.at(-1))).toEqual([
      'input keyevent 66',
      'input keyevent 61',
      'input keyevent 67',
      'input keyevent 62',
      'input keyevent 111',
    ]);
  });
});

describe('createAndroidBackend', () => {
  it('accepts a DeviceConfig (registry factory) or plain options', () => {
    expect(createAndroidBackend({ platform: 'android', serial: 'x' }).backendName).toBe('android-adb');
    expect(createAndroidBackend({ adbBin: '/opt/adb' }).backendName).toBe('android-adb');
    expect(createAndroidBackend().capabilities.has('alert')).toBe(false);
  });
});

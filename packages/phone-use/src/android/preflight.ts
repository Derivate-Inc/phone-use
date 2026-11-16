/**
 * Preflight for the Android backend.
 *
 * Same contract as the iPhone preflight: nothing throws, every failure carries
 * the exact fix, and the whole report renders at once so a user learns all the
 * missing steps together instead of one round-trip at a time.
 *
 * Unlike iPhone Mirroring, adb runs on macOS, Linux, and Windows — so there is
 * no platform gate here, only "is adb installed and is a device reachable".
 */
import { type AndroidDeviceInfo, android } from '@phone-use/sdk';

export type Check = { name: string; ok: boolean; fix?: string };
export type Preflight = { ok: boolean; supported: boolean; checks: Check[] };

const INSTALL_ADB =
  'Install the Android platform-tools (they ship `adb`): ' +
  'macOS `brew install android-platform-tools`, ' +
  'Linux `apt install adb`, or download from ' +
  'https://developer.android.com/tools/releases/platform-tools. ' +
  'Set PHONE_USE_ADB_BIN if adb is not on PATH.';

export async function preflightAndroid(
  deps: { list?: (opts: { adbBin?: string | undefined }) => Promise<AndroidDeviceInfo[]> } = {},
): Promise<Preflight> {
  const checks: Check[] = [];
  const list = deps.list ?? android.list;

  // 1. adb present and answering. The SDK names a missing binary explicitly;
  // any other failure is adb itself misbehaving (server refusing to start, …).
  let devices: AndroidDeviceInfo[] = [];
  try {
    devices = await list({ adbBin: process.env.PHONE_USE_ADB_BIN });
    checks.push({ name: 'adb installed', ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      name: 'adb installed',
      ok: false,
      fix: /adb not found/.test(message) ? INSTALL_ADB : `adb is installed but failed: ${message}`,
    });
    return { ok: false, supported: true, checks };
  }

  // 2. A device is attached and authorized.
  const ready = devices.filter((d) => d.state === 'device');
  const unauthorized = devices.filter((d) => d.state === 'unauthorized');

  if (ready.length > 0) {
    checks.push({ name: `device connected (${ready.map((d) => d.serial).join(', ')})`, ok: true });
  } else if (unauthorized.length > 0) {
    checks.push({
      name: 'device authorized',
      ok: false,
      fix:
        'A device is attached but not authorized. Unlock the phone and tap ' +
        '"Allow USB debugging" on the prompt (check "Always allow" to skip it next time).',
    });
  } else {
    checks.push({
      name: 'device connected',
      ok: false,
      fix:
        'No device is attached. Enable Developer Options and USB debugging on the phone ' +
        '(Settings → About phone → tap "Build number" 7×, then Settings → System → ' +
        'Developer options → USB debugging), connect over USB (or `adb connect <ip:port>` ' +
        'for wireless), and run `adb devices` to confirm it appears as "device". ' +
        'For an emulator: `emulator -avd <name>` (or `android.launch()` from the SDK).',
    });
  }

  // 3. If several are ready, a serial is required so verbs target the right one.
  if (ready.length > 1 && !process.env.PHONE_USE_ANDROID_SERIAL) {
    checks.push({
      name: 'single target device',
      ok: false,
      fix:
        `Multiple devices are attached (${ready.map((d) => d.serial).join(', ')}). ` +
        'Set PHONE_USE_ANDROID_SERIAL=<serial> to choose one.',
    });
  }

  return { ok: checks.every((c) => c.ok), supported: true, checks };
}

export function formatPreflight(result: Preflight): string {
  const lines = result.checks.map((c) =>
    c.ok ? `  ok   ${c.name}` : ` FAIL  ${c.name}\n         → ${c.fix}`,
  );
  if (!result.ok) {
    lines.push('');
    lines.push('note: run `adb devices` yourself to confirm the phone is seen and authorized.');
  }
  return lines.join('\n');
}

#!/usr/bin/env bun
// Android smoke: boot a dedicated read-only emulator instance from an AVD,
// observe, go home, open Settings, screenshot, then kill it. Prints timings so
// a host's cold-boot and per-verb latency are known before it joins the fleet.
//
//   bun packages/phone-use/scripts/smoke-android.ts [avd] [--serial emulator-5554]
//
// With --serial the boot step is skipped and the smoke drives an already
// running device (a real phone over USB works too).
import { android, type Device } from '@phone-use/sdk';

const args = process.argv.slice(2);
const serialFlag = args.indexOf('--serial');
const serial = serialFlag === -1 ? undefined : args[serialFlag + 1];
const avd =
  args.find((a) => !a.startsWith('--') && a !== serial) ??
  process.env.PHONE_USE_ANDROID_AVD ??
  'phone-use-golden';
const adbBin = process.env.PHONE_USE_ADB_BIN;

const t0 = performance.now();
const lap = (label: string) => console.log(`  ${label.padEnd(28)} ${Math.round(performance.now() - t0)}ms`);

let device: Device;
if (serial) {
  device = await android.connect(serial, { adbBin, idleTimeoutMs: false });
  lap(`connected ${serial}`);
} else {
  device = await android.launch({
    avd,
    port: Number(process.env.PHONE_USE_ANDROID_BASE_PORT ?? 5574),
    readOnly: true,
    adbBin,
    extraArgs: (process.env.PHONE_USE_ANDROID_EMULATOR_ARGS ?? '-gpu swiftshader_indirect')
      .split(/\s+/)
      .filter(Boolean),
    idleTimeoutMs: false,
  });
  lap(`booted ${device.id} (${avd})`);
}

try {
  const first = await device.observe();
  lap(`observe: ${first.elements.length} elements`);
  await device.screen.home();
  lap('home');
  const opened = await device.apps.open('com.android.settings');
  lap(`open Settings → ${opened.success ? 'ok' : opened.message}`);
  const settings = await device.observe();
  const sawSettings = settings.elements.some((e) => /settings|search/i.test(e.label ?? ''));
  lap(
    `observe Settings: ${settings.elements.length} elements${sawSettings ? '' : ' (no Settings labels seen!)'}`,
  );
  const shot = await device.screen.screenshot({ path: `/tmp/phone-use-android-smoke-${device.id}.png` });
  lap(`screenshot → ${shot.success ? shot.path : shot.message}`);
  if (!opened.success || !sawSettings || !shot.success) {
    console.error('SMOKE FAILED');
    process.exitCode = 1;
  }
} finally {
  await device.close();
  lap(serial ? 'released' : 'killed');
}

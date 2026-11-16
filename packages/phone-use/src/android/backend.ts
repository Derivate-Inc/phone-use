// Android over adb: the backend itself lives in @phone-use/sdk (AndroidBackend,
// alongside the `android` engine) so the SDK, this harness, and the cloud worker
// drive Android with ONE implementation. This module only reads the harness's
// environment knobs and hands them over.
import { AndroidBackend } from '@phone-use/sdk';

/** The process-default Android backend: PHONE_USE_ANDROID_SERIAL picks the device, PHONE_USE_ADB_BIN the binary. */
export function createAndroidBackend(): AndroidBackend {
  return new AndroidBackend({
    serial: process.env.PHONE_USE_ANDROID_SERIAL,
    adbBin: process.env.PHONE_USE_ADB_BIN,
  });
}

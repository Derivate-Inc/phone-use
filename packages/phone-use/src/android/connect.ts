/**
 * `phone-use connect android` / `disconnect` — point every verb at a real
 * Android device over adb. Mirrors the iPhone connect flow: it refuses (with
 * the full fix list) rather than saving a selection that cannot work.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { USER_CONFIG_PATH } from '../settings.ts';
import { formatPreflight, preflightAndroid } from './preflight.ts';

const DEVICE_KEY = 'PHONE_USE_DEVICE';

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(USER_CONFIG_PATH, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeConfig(values: Record<string, unknown>): void {
  mkdirSync(dirname(USER_CONFIG_PATH), { recursive: true });
  writeFileSync(USER_CONFIG_PATH, `${JSON.stringify(values, null, 2)}\n`);
}

export async function connectAndroidPhone(): Promise<number> {
  const pre = await preflightAndroid();
  if (!pre.ok) {
    console.error(`\ncannot connect to an Android device yet:\n\n${formatPreflight(pre)}\n`);
    return 1;
  }
  writeConfig({ ...readConfig(), [DEVICE_KEY]: 'android' });
  console.log(
    [
      '',
      '  Connected to your Android device.',
      '',
      '  Every verb now runs on the phone over adb:',
      '    phone-use observe',
      '    phone-use open com.android.chrome',
      '',
      '  Back to simulators and cloud phones:  phone-use disconnect',
      '',
    ].join('\n'),
  );
  return 0;
}

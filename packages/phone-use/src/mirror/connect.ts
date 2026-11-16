/**
 * `phone-use connect` / `disconnect` — choose the phone every verb runs on.
 *
 * Cloud phones you `create`; the phone in your pocket you `connect` to. The
 * selection is remembered in ~/.phone-use/config.json rather than asked for on
 * every command, because "which phone" is a mode you stay in, not an argument
 * you repeat. The environment still wins over the file, so PHONE_USE_DEVICE
 * remains a one-off override and CI is unaffected by whatever a laptop
 * remembered.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { USER_CONFIG_PATH } from '../settings.ts';
import { formatPreflight, preflightMirror } from './preflight.ts';

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

/** Which phone verbs currently target, for status lines. */
export function currentDevice(): 'real iPhone' | 'cloud phone' | 'simulator' {
  if (process.env.PHONE_USE_DEVICE === 'mirror') return 'real iPhone';
  if (process.env.PHONE_USE_SANDBOX_URL) return 'cloud phone';
  return 'simulator';
}

/**
 * Point every verb at the real iPhone. Refuses — with the full list of fixes —
 * rather than saving a selection that cannot work, so the failure arrives here
 * and not three commands later inside a task.
 */
export async function connectRealPhone(): Promise<number> {
  const pre = await preflightMirror();
  if (!pre.ok) {
    console.error(`\ncannot connect to your iPhone yet:\n\n${formatPreflight(pre)}\n`);
    return 1;
  }
  writeConfig({ ...readConfig(), [DEVICE_KEY]: 'mirror' });
  console.log(
    [
      '',
      '  Connected to your iPhone.',
      '',
      '  Every verb now runs on the real phone:',
      '    phone-use observe',
      '    phone-use open "Weather"',
      '',
      '  Back to simulators and cloud phones:  phone-use disconnect',
      '',
    ].join('\n'),
  );
  return 0;
}

/** Stop targeting the real phone. Leaves every other setting alone. */
export function disconnectRealPhone(): number {
  const config = readConfig();
  // Clears any real-device selection — the iPhone (mirror) or an Android.
  const wasConnected = config[DEVICE_KEY] === 'mirror' || config[DEVICE_KEY] === 'android';
  if (wasConnected) delete config[DEVICE_KEY];
  writeConfig(config);
  console.log(
    wasConnected
      ? '\n  Disconnected. Verbs target simulators and cloud phones again.\n'
      : '\n  Not connected to a real phone — nothing to do.\n',
  );
  // A stale env var would silently keep the old target for this process.
  if (process.env.PHONE_USE_DEVICE === 'mirror') {
    console.log('  note: PHONE_USE_DEVICE=mirror is set in your environment and still wins.\n');
  }
  return 0;
}

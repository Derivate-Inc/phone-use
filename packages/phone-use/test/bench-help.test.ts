import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each(['--help', '-h'])('bench %s exits without accessing a device', (flag) => {
  const result = spawnSync(
    'bun',
    [fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'bench', flag],
    {
      env: {
        ...process.env,
        PHONE_USE_DEVICE: 'android',
        PHONE_USE_ADB_BIN: '/nonexistent-release-test-adb',
      },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('usage: phone-use bench');
  expect(result.stderr).toBe('');
});

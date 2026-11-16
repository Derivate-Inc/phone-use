import { expect, it } from 'vitest';
import { readWithRecovery } from '../src/recovery.ts';

it('retries a declared transient read once and preserves permanent failures', async () => {
  let count = 0;
  const value = await readWithRecovery(async () => {
    if (++count === 1) throw Object.assign(new Error('session disconnected'), { retryable: true });
    return 'screen';
  });
  expect(value).toBe('screen');
  expect(count).toBe(2);
  count = 0;
  await expect(
    readWithRecovery(async () => {
      count++;
      throw new Error('wrong device');
    }),
  ).rejects.toThrow('wrong device');
  expect(count).toBe(1);
});

it('bounds hanging reads and does not start a read after cancellation', async () => {
  await expect(readWithRecovery(() => new Promise(() => {}), { timeoutMs: 10 })).rejects.toThrow();
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await expect(
    readWithRecovery(
      async () => {
        called = true;
      },
      { signal: controller.signal },
    ),
  ).rejects.toThrow();
  expect(called).toBe(false);
});

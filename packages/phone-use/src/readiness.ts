import { setTimeout as delay } from 'node:timers/promises';
import type { DeviceBackend } from '@phone-use/sdk';
import { readWithRecovery } from './recovery.ts';

/** Cold accessibility runners can take longer than ordinary observations.
 * Open exactly once; poll only reads, with one shared startup deadline.
 */
export async function waitForAppReady(
  backend: DeviceBackend,
  app: string,
  options: { signal?: AbortSignal | undefined; timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  let last = 'No accessibility observation completed';
  try {
    await readWithRecovery(
      async (signal) => {
        for (;;) {
          signal.throwIfAborted();
          try {
            const snapshot = await backend.snapshot();
            signal.throwIfAborted();
            if (snapshot.appBundleId === app && snapshot.nodes.length > 0) return;
            last =
              snapshot.appBundleId === app
                ? 'The foreground app has an empty accessibility tree'
                : `Expected ${app}; observed ${snapshot.appBundleId ?? 'unknown foreground app'}`;
          } catch (error) {
            signal.throwIfAborted();
            if (
              !(
                error &&
                typeof error === 'object' &&
                (('retryable' in error && error.retryable === true) ||
                  ('code' in error && error.code === 'SESSION_NOT_FOUND'))
              )
            )
              throw error;
            last = String(error);
          }
          await delay(options.pollMs ?? 250, undefined, { signal });
        }
      },
      { timeoutMs: options.timeoutMs ?? 60_000, signal: options.signal },
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(`App readiness failed for ${app}: ${last}. ${String(error)}`, { cause: error });
  }
}

/** Bound read-only probes. Never use this helper around mutations. */
export async function readWithRecovery<T>(
  read: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs?: number; signal?: AbortSignal | undefined; onRetry?: (reason: string) => void } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Read timeout must be positive');
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve()
          .then(() => {
            signal.throwIfAborted();
            return read(signal);
          })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
    } catch (error) {
      if (
        signal.aborted ||
        attempt >= 1 ||
        !(error && typeof error === 'object' && 'retryable' in error && error.retryable === true)
      )
        throw error;
      options.onRetry?.(String(error));
    }
  }
}

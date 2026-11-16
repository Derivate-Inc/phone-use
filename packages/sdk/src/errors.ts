/**
 * Stable machine-readable error codes carried by every {@link PhoneUseError}.
 *
 * Harness checks branch on these strings (for example
 * `(e as {code?: string}).code === 'SESSION_NOT_FOUND'`), so they are stable.
 * A backend's own code survives in `details.backendCode`.
 */
export type PhoneUseErrorCode =
  | 'DEVICE_NOT_FOUND'
  | 'DEVICE_IN_USE'
  | 'SESSION_NOT_FOUND'
  | 'TIMEOUT'
  | 'ACTION_FAILED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'BACKEND_NOT_FOUND'
  | 'ABORTED'
  | 'CLOUD_WAITLIST'
  | 'UNKNOWN';

/** Structured, code-specific context attached to a {@link PhoneUseError}. */
export type PhoneUseErrorDetails = Record<string, unknown> & {
  /** What the caller can do next — describeError renders it. */
  hint?: string | undefined;
  /** The raw backend code when we collapse to ACTION_FAILED. */
  backendCode?: string | undefined;
};

/**
 * Root of the typed error tree.
 * Every backend method rejects only with PhoneUseError subclasses; transport
 * errors are normalized at the boundary by
 * {@link toPhoneUseError} so no backend type ever reaches the public API. Each
 * error carries a stable `code` and an explicit `retryable` flag — the field
 * agent loops need to decide retry-vs-replan.
 */
export class PhoneUseError extends Error {
  /** Stable machine-readable code — the field to branch on. */
  readonly code: PhoneUseErrorCode;
  /** Whether retrying the same call can plausibly succeed. */
  readonly retryable: boolean;
  /** Optional structured context (hint, raw backend code, ...). */
  readonly details?: PhoneUseErrorDetails | undefined;

  constructor(
    message: string,
    opts: {
      code: PhoneUseErrorCode;
      retryable: boolean;
      details?: PhoneUseErrorDetails | undefined;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.code = opts.code;
    this.retryable = opts.retryable;
    this.details = opts.details;
  }
}

/** No device matched the selection (`DEVICE_NOT_FOUND`, not retryable). */
export class DeviceNotFoundError extends PhoneUseError {
  constructor(message: string, opts: { details?: PhoneUseErrorDetails | undefined; cause?: unknown } = {}) {
    super(message, { code: 'DEVICE_NOT_FOUND', retryable: false, ...opts });
  }
}

/** The device is held by another session (`DEVICE_IN_USE`, retryable). */
export class DeviceInUseError extends PhoneUseError {
  constructor(message: string, opts: { details?: PhoneUseErrorDetails | undefined; cause?: unknown } = {}) {
    super(message, { code: 'DEVICE_IN_USE', retryable: true, ...opts });
  }
}

/** No live session — the device/session was closed (`SESSION_NOT_FOUND`, not retryable). */
export class SessionNotFoundError extends PhoneUseError {
  constructor(message: string, opts: { details?: PhoneUseErrorDetails | undefined; cause?: unknown } = {}) {
    super(message, { code: 'SESSION_NOT_FOUND', retryable: false, ...opts });
  }
}

/** A deadline elapsed before the operation completed (`TIMEOUT`, retryable). */
export class TimeoutError extends PhoneUseError {
  constructor(message: string, opts: { details?: PhoneUseErrorDetails | undefined; cause?: unknown } = {}) {
    super(message, { code: 'TIMEOUT', retryable: true, ...opts });
  }
}

/** A device action failed to execute (`ACTION_FAILED`, retryable). */
export class ActionFailedError extends PhoneUseError {
  constructor(message: string, opts: { details?: PhoneUseErrorDetails | undefined; cause?: unknown } = {}) {
    super(message, { code: 'ACTION_FAILED', retryable: true, ...opts });
  }
}

/** The backend does not implement the capability (`UNSUPPORTED_CAPABILITY`, not retryable). */
export class UnsupportedCapabilityError extends PhoneUseError {
  /** The backend that rejected the call. */
  readonly backend: string;
  /** The missing capability. */
  readonly capability: string;

  constructor(opts: { backend: string; capability: string; cause?: unknown }) {
    super(`backend "${opts.backend}" does not support "${opts.capability}"`, {
      code: 'UNSUPPORTED_CAPABILITY',
      retryable: false,
      details: { backend: opts.backend, capability: opts.capability },
      ...(opts.cause === undefined ? {} : { cause: opts.cause }),
    });
    this.backend = opts.backend;
    this.capability = opts.capability;
  }
}

/**
 * The caller's AbortSignal fired (`ABORTED`, not retryable). Abort is caller
 * control flow, not a device outcome — never retried.
 */
export class AbortedError extends PhoneUseError {
  constructor(message = 'aborted by caller', opts: { cause?: unknown } = {}) {
    super(message, { code: 'ABORTED', retryable: false, ...opts });
  }
}

const TIMEOUT_RE = /\btime[d ]?\s?out\b|\btimeout\b/i;

/**
 * Boundary normalizer: ANY thrown value → PhoneUseError. An existing
 * PhoneUseError passes through untouched; a thrown value that carries one of
 * our codes keeps it; anything else wraps as UNKNOWN (not retryable), or
 * TIMEOUT when the message says so. The original error always rides on `cause`.
 */
export function toPhoneUseError(
  err: unknown,
  ctx: { backend?: string; capability?: string } = {},
): PhoneUseError {
  if (err instanceof PhoneUseError) return err;

  if (err instanceof Error) {
    const coded = err as Error & { code?: unknown; details?: Record<string, unknown> };
    const details: PhoneUseErrorDetails = { ...(coded.details ?? {}) };
    const opts = { details, cause: err };
    switch (coded.code) {
      case 'DEVICE_NOT_FOUND':
        return new DeviceNotFoundError(err.message, opts);
      case 'DEVICE_IN_USE':
        return new DeviceInUseError(err.message, opts);
      case 'SESSION_NOT_FOUND':
        return new SessionNotFoundError(err.message, opts);
      case 'UNSUPPORTED_CAPABILITY':
        return new UnsupportedCapabilityError({
          backend: ctx.backend ?? 'unknown',
          capability: ctx.capability ?? 'unknown',
          cause: err,
        });
      default:
        break;
    }
    if (TIMEOUT_RE.test(err.message)) return new TimeoutError(err.message, { cause: err });
    return new PhoneUseError(err.message, { code: 'UNKNOWN', retryable: false, cause: err });
  }
  return new PhoneUseError(String(err), { code: 'UNKNOWN', retryable: false, cause: err });
}

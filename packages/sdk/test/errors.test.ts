import { describe, expect, it } from 'vitest';
import {
  ActionFailedError,
  DeviceInUseError,
  DeviceNotFoundError,
  PhoneUseError,
  SessionNotFoundError,
  TimeoutError,
  toPhoneUseError,
  UnsupportedCapabilityError,
} from '../src/errors.ts';

describe('error taxonomy', () => {
  const table = [
    { make: () => new DeviceNotFoundError('x'), code: 'DEVICE_NOT_FOUND', retryable: false },
    { make: () => new DeviceInUseError('x'), code: 'DEVICE_IN_USE', retryable: true },
    { make: () => new SessionNotFoundError('x'), code: 'SESSION_NOT_FOUND', retryable: false },
    { make: () => new TimeoutError('x'), code: 'TIMEOUT', retryable: true },
    { make: () => new ActionFailedError('x'), code: 'ACTION_FAILED', retryable: true },
    {
      make: () => new UnsupportedCapabilityError({ backend: 'b', capability: 'c' }),
      code: 'UNSUPPORTED_CAPABILITY',
      retryable: false,
    },
  ] as const;

  it.each(table)('$code carries stable code + retryable flag', ({ make, code, retryable }) => {
    const e = make();
    expect(e).toBeInstanceOf(PhoneUseError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe(code);
    expect(e.retryable).toBe(retryable);
    expect(e.name).toBe(e.constructor.name);
  });
});

describe('toPhoneUseError boundary normalization', () => {
  /** An error thrown by some transport that carries one of our codes. */
  const coded = (code: string, message: string, details?: Record<string, unknown>) =>
    Object.assign(new Error(message), { code, ...(details ? { details } : {}) });

  const mapping = [
    { code: 'DEVICE_NOT_FOUND', cls: DeviceNotFoundError },
    { code: 'DEVICE_IN_USE', cls: DeviceInUseError },
    { code: 'SESSION_NOT_FOUND', cls: SessionNotFoundError },
    { code: 'UNSUPPORTED_CAPABILITY', cls: UnsupportedCapabilityError },
  ] as const;

  it.each(mapping)('a thrown $code keeps its class ($cls.name)', ({ code, cls }) => {
    const original = coded(code, `boom ${code}`, { hint: 'try again' });
    const mapped = toPhoneUseError(original, { backend: 'xctest', capability: 'press' });
    expect(mapped).toBeInstanceOf(cls);
    expect(mapped).toBeInstanceOf(PhoneUseError);
    expect(mapped.cause).toBe(original);
    if (!(mapped instanceof UnsupportedCapabilityError)) {
      expect(mapped.message).toContain(`boom ${code}`);
      expect(mapped.details?.hint).toBe('try again');
    }
  });

  it('timeout message heuristic applies to plain errors', () => {
    const mapped = toPhoneUseError(new Error('operation timed out after 5000ms'));
    expect(mapped).toBeInstanceOf(TimeoutError);
    expect(mapped.retryable).toBe(true);
  });

  it('is idempotent for PhoneUseError inputs', () => {
    const e = new ActionFailedError('once');
    expect(toPhoneUseError(e)).toBe(e);
  });

  it('wraps plain Errors and garbage as UNKNOWN, not retryable', () => {
    const e1 = toPhoneUseError(new Error('generic'));
    expect(e1.code).toBe('UNKNOWN');
    expect(e1.retryable).toBe(false);
    const e2 = toPhoneUseError('boom');
    expect(e2.code).toBe('UNKNOWN');
    expect(e2.message).toBe('boom');
  });

  it('UNSUPPORTED_CAPABILITY carries backend + capability context', () => {
    const mapped = toPhoneUseError(coded('UNSUPPORTED_CAPABILITY', 'no such op'), {
      backend: 'xctest',
      capability: 'longPress',
    });
    expect(mapped).toBeInstanceOf(UnsupportedCapabilityError);
    const u = mapped as UnsupportedCapabilityError;
    expect(u.backend).toBe('xctest');
    expect(u.capability).toBe('longPress');
  });
});

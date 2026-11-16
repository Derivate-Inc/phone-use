import { describe, expect, it } from 'vitest';
import { getBackendFactory, listBackends, PhoneUseError, registerBackend } from '../src/index.ts';
import { FakeBackend, screen } from '../src/testing.ts';

describe('backend registry', () => {
  it('the built-in xctest backend is registered by the barrel', () => {
    expect(listBackends()).toContain('xctest');
    expect(typeof getBackendFactory('xctest')).toBe('function');
  });

  it('registerBackend/getBackendFactory round-trip', () => {
    const factory = () => new FakeBackend({ screens: [screen([])] });
    registerBackend('test-roundtrip', factory);
    expect(getBackendFactory('test-roundtrip')).toBe(factory);
    expect(listBackends()).toContain('test-roundtrip');
  });

  it('unknown name throws BACKEND_NOT_FOUND listing registered names', () => {
    try {
      getBackendFactory('nope-not-here');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PhoneUseError);
      const pe = e as PhoneUseError;
      expect(pe.code).toBe('BACKEND_NOT_FOUND');
      expect(pe.retryable).toBe(false);
      expect(pe.message).toContain('xctest'); // lists what IS registered
    }
  });

  it('duplicate registration throws', () => {
    registerBackend('test-dup', () => new FakeBackend({ screens: [screen([])] }));
    expect(() => registerBackend('test-dup', () => new FakeBackend({ screens: [screen([])] }))).toThrowError(
      /already registered/,
    );
  });
});

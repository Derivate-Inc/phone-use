import { describe, expect, spyOn, test } from 'bun:test';
import { windowLimiter } from '../src/rate-limit.ts';

describe('windowLimiter', () => {
  test('limits repeated callers without exhausting another caller’s quota', () => {
    const allow = windowLimiter(2, 60_000);
    expect([allow('a'), allow('a'), allow('a'), allow('b')]).toEqual([true, true, false, true]);
  });

  test('caps new caller identities, reclaims expired entries and renews windows', () => {
    const now = spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const allow = windowLimiter(2, 60_000, 2);
      expect(allow('a')).toBe(true);
      expect(allow('b')).toBe(true);
      expect(allow('c')).toBe(false);
      // Filling the map does not deny remaining quota for known callers.
      expect(allow('a')).toBe(true);
      expect(allow('a')).toBe(false);
      now.mockReturnValue(61_000);
      expect(allow('c')).toBe(true);
      expect(allow('d')).toBe(true);
      expect(allow('e')).toBe(false);
      expect(allow('c')).toBe(true);
      expect(allow('c')).toBe(false);
    } finally {
      now.mockRestore();
    }
  });
});

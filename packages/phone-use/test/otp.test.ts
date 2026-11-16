import { describe, expect, it } from 'vitest';
import { extractOtp, extractOtpCandidates } from '../src/otp.ts';

describe('extractOtp', () => {
  it('pulls a 6-digit code from a typical SMS', () => {
    expect(extractOtp(['Your verification code is 481920'])?.code).toBe('481920');
  });

  it('handles code-first phrasing', () => {
    expect(extractOtp(['284617 is your one-time login code'])?.code).toBe('284617');
  });

  it('normalises a grouped code (123-456 / 123 456)', () => {
    expect(extractOtp(['Your code: 348-921'])?.code).toBe('348921');
    expect(extractOtp(['G-552 149 is your Google verification code'])?.code).toBe('552149');
  });

  it('ignores a year with no code context', () => {
    expect(extractOtp(['Copyright 2026 Acme Inc'])).toBeNull();
  });

  it('ignores a time and a price', () => {
    const c = extractOtpCandidates(['Meeting at 12:30', 'Total $49.99']);
    expect(c.every((x) => x.confidence < 0.5)).toBe(true);
  });

  it('does not grab a phone/account number (9+ digits)', () => {
    expect(extractOtp(['Call us at 18005551234'])).toBeNull();
  });

  it('prefers the code near a code-word over a bare number on screen', () => {
    const best = extractOtp(['Order 100200', 'Your security code is 736251', 'Delivered 2026']);
    expect(best?.code).toBe('736251');
  });

  it('ranks candidates by confidence, most likely first', () => {
    const ranked = extractOtpCandidates(['random 4821', 'Enter the verification code 905513 to continue']);
    expect(ranked[0]?.code).toBe('905513');
    expect(ranked[0]?.confidence).toBeGreaterThan(ranked[1]?.confidence ?? 0);
  });

  it('keeps the context for the audit log', () => {
    expect(extractOtp(['Apple ID Code: 190834'])?.context).toContain('190834');
  });

  it('returns null below the confidence bar', () => {
    // a bare 4-digit run with zero context should not clear 0.5
    expect(extractOtp(['4821'])).toBeNull();
  });

  it('finds a code split from its word across separate elements (iOS AX tree)', () => {
    // "code" in one StaticText, the digits in the next — the common a11y shape
    expect(extractOtp(['Enter the verification code below', '739104'])?.code).toBe('739104');
  });

  it('does not over-fire the global boost on a screen with no code-word anywhere', () => {
    // a lone 6-digit number with zero verification context stays below the bar
    expect(extractOtp(['Balance', '482913', 'Recent activity'])).toBeNull();
  });
});

// OTP extraction — pull a one-time verification code out of on-screen text.
//
// This is the core of the consent-gated OTP relay: reading a code on the
// user's actual device instead of renting an SMS number. The extraction is a
// pure function so it is unit-testable without a live SMS; the tool that reads
// the screen and gates on consent lives in registry.ts.
//
// The permission floor (permissions.ts / docs/05-trust-security.md) REDACTS
// OTP codes from ordinary observations. This module is the deliberate,
// audited exception: it only runs behind an explicit consent grant, and it
// returns exactly one code for exactly one flow.
//
// Verified against a REAL SMS inbox (OnePlus Nord, Google Messages): pulled two
// genuine verification codes at 0.9 confidence from real messages, correctly
// ignoring the inbox's other numbers (unread counts, timestamps).

/** A ranked OTP candidate. */
export type OtpCandidate = {
  code: string;
  /** 0–1 confidence that this is a verification code, not a year/price/phone. */
  confidence: number;
  /** the surrounding text the code was found in, for the audit log */
  context: string;
};

// Words that, appearing near a number, mark it as a verification code.
const CODE_WORDS =
  /\b(code|verification|verify|otp|one[-\s]?time|passcode|pin|security|login|log[-\s]?in|sign[-\s]?in|authenticate|confirm|2fa|two[-\s]?factor)\b/i;

// A bare 4–8 digit run, optionally split once by a space or hyphen (e.g.
// "123 456"). Anchored on word boundaries so it won't grab part of a longer id.
const DIGIT_RUN = /\b(\d{3,4}[-\s]?\d{3,4}|\d{4,8})\b/g;

/** Normalise "123 456" / "123-456" → "123456". */
function normalise(raw: string): string {
  return raw.replace(/[-\s]/g, '');
}

function looksLikeYear(code: string): boolean {
  return /^(19|20)\d{2}$/.test(code);
}

function looksLikeTimeOrPrice(context: string, raw: string): boolean {
  // A colon before/after (12:34) or a currency/decimal nearby.
  const i = context.indexOf(raw);
  const around = context.slice(Math.max(0, i - 2), i + raw.length + 2);
  return /[:$£€.]/.test(around);
}

/**
 * Extract the most likely verification code from on-screen text lines.
 *
 * Scores each 4–8 digit candidate: boosted when a code-word sits nearby,
 * penalised when it reads as a year, time, price, or a phone-number-length run.
 * Returns candidates ranked by confidence (highest first); empty if none.
 */
export function extractOtpCandidates(lines: string[]): OtpCandidate[] {
  const out: OtpCandidate[] = [];
  const seen = new Set<string>();
  // The iOS accessibility tree often splits a message across elements — "code"
  // in one StaticText, "123456" in the next — so a code-word anywhere on the
  // screen lends weaker support to a code that has none on its own line.
  const globalHasWord = lines.some((l) => typeof l === 'string' && CODE_WORDS.test(l));

  for (const line of lines) {
    if (typeof line !== 'string' || !line) continue;
    const hasWord = CODE_WORDS.test(line);
    for (const m of line.matchAll(DIGIT_RUN)) {
      const raw = m[0];
      const code = normalise(raw);
      // Codes are 4–8 digits. 9+ is an account/phone number; 3 is too short.
      if (code.length < 4 || code.length > 8) continue;
      if (seen.has(code)) continue;

      let confidence = 0.35; // a bare code with no context
      if (hasWord)
        confidence += 0.45; // "your code is 123456" — code-word on the same line
      else if (globalHasWord) confidence += 0.22; // code-word elsewhere on a code-bearing screen
      if (raw.includes(' ') || raw.includes('-')) confidence += 0.1; // grouped: 123-456
      if (code.length === 6)
        confidence += 0.1; // 6 is the overwhelming default
      else if (code.length === 4 || code.length === 8) confidence += 0.03;
      if (looksLikeYear(code)) confidence -= 0.55;
      if (looksLikeTimeOrPrice(line, raw)) confidence -= 0.4;
      if (code.length === 7) confidence -= 0.05; // uncommon length

      confidence = Math.max(0, Math.min(1, confidence));
      if (confidence <= 0) continue;
      seen.add(code);
      out.push({ code, confidence: Math.round(confidence * 100) / 100, context: line.trim() });
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/** The single best code, or null if nothing clears the confidence bar. */
export function extractOtp(lines: string[], minConfidence = 0.5): OtpCandidate | null {
  const best = extractOtpCandidates(lines)[0];
  return best && best.confidence >= minConfidence ? best : null;
}

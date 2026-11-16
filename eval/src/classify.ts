import type { Claim, Effect, Expect, ProbeOutcome, Verdict } from './types.ts';

/** Calls slower than this are hangs, whatever they eventually returned (doc 43: "hang (>30 s)"). */
export const HANG_MS = 30_000;

/**
 * Cross what the tool claimed with what the oracle saw. Pure: the whole scoring rule is here.
 *
 *                     effect: intended   wrong / partial    none
 *   claim ok                  pass       FALSE SUCCESS      FALSE SUCCESS
 *   claim uncertain           pass       flagged failure    flagged failure
 *   claim error/refused   false failure  unsafe error       pass if refusing is right, else refused wrongly
 */
export function classify(expect: Expect, claim: Claim | undefined, effect: Effect | undefined): Verdict {
  if (!claim || !effect) return 'setup_failed';
  if (claim.status === 'hang' || claim.ms > HANG_MS) return 'hang';
  if (claim.status === 'crash') return 'crash';
  if (claim.status === 'unsupported') return 'unsupported';
  const said = claim.status; // ok | uncertain | error | refused
  const positive = said === 'ok' || said === 'uncertain';
  if (effect === 'intended') return positive ? 'pass' : 'false_failure';
  if (effect === 'wrong' || effect === 'partial') {
    if (said === 'ok') return 'false_success';
    if (said === 'uncertain') return 'flagged_failure';
    return 'unsafe_error';
  }
  // effect === 'none'
  if (said === 'ok') return 'false_success';
  if (said === 'uncertain') return 'flagged_failure';
  return expect === 'act' ? 'refused_wrongly' : 'pass';
}

/** The verdict for a whole probe outcome, honouring invalid / setup-failed / hang on any call. */
export function verdictOf(expect: Expect, o: ProbeOutcome): Verdict {
  // A hang or crash is the tool's failure even when the scenario's precondition
  // then also failed: it must not disappear as unscored.
  if (o.hung || o.calls?.some((c) => c.status === 'hang' || c.ms > HANG_MS)) return 'hang';
  if (o.calls?.some((c) => c.status === 'crash')) return 'crash';
  if (o.invalid) return 'invalid';
  if (o.setupFailed) return 'setup_failed';
  const v = classify(expect, o.claim, o.effect);
  return v === 'pass' && o.extra?.leaked === true ? 'leak' : v;
}

export type Tally = {
  scored: number;
  pass: number;
  falseSuccess: number;
  claimedOk: number;
  /** false successes / calls the tool reported as plain success. */
  falseSuccessRate: number | null;
  byVerdict: Partial<Record<Verdict, number>>;
};

export function tally(rs: Array<{ verdict: Verdict; claim?: Claim | undefined }>): Tally {
  const byVerdict: Partial<Record<Verdict, number>> = {};
  for (const r of rs) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  const scoredRs = rs.filter((r) => r.verdict !== 'invalid');
  const claimedOk = scoredRs.filter((r) => r.claim?.status === 'ok').length;
  const falseSuccess = byVerdict.false_success ?? 0;
  return {
    scored: scoredRs.length,
    pass: byVerdict.pass ?? 0,
    falseSuccess,
    claimedOk,
    falseSuccessRate: claimedOk ? falseSuccess / claimedOk : null,
    byVerdict,
  };
}

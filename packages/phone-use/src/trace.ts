import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { currentTraceSession } from './trace-session.ts';

// Append-only JSONL trace of every tool call — the harness-v2 state spine
// (decision doc research/10 §5). One line per action, capturing what was
// requested, the permission verdict, how the target resolved, whether the
// screen changed, and timing. This is:
//   • the audit trail the permission system needs (every gated/denied call),
//   • post-hoc debugging for device runs (replay to see what happened),
//   • the trajectory-release format the benchmark plan already committed to
//     publishing (research/5 §3).
//
// It is NOT a durable-execution / resume mechanism — taps aren't idempotent,
// so replaying a trace re-runs side effects. Kept deliberately as a record,
// not a rollback engine (see the honest divergence note in research/9).
//
// Off by default; enable with PHONE_USE_TRACE=1 (writes to
// ~/.phone-use/traces/<session>.jsonl) or PHONE_USE_TRACE=/path/to/file.jsonl.

export type TraceLine = {
  ts: string;
  tool: string;
  args: Record<string, unknown>;
  risk: string;
  decision: 'allow' | 'deny' | 'ask';
  /** how the target resolved, when known (e.g. "fuzzy 0.82 → Wi-Fi") */
  via?: string | undefined;
  /** did the screen change (verified-tap evidence), when known */
  changed?: boolean | undefined;
  app?: string | undefined;
  ms: number;
  ok: boolean;
  detail?: string | undefined;
};

let traceFile: string | null = null;
let resolved = false;

function target(): string | null {
  if (resolved) return traceFile;
  resolved = true;
  const env = process.env.PHONE_USE_TRACE;
  if (!env || env === '0') {
    traceFile = null;
    return null;
  }
  if (env.endsWith('.jsonl') || env.includes('/')) {
    traceFile = env;
  } else {
    const dir = join(homedir(), '.phone-use', 'traces');
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* exists */
    }
    // Session id can't use Date.now() safely across environments; the process
    // start time is stable enough and set once here.
    traceFile = join(dir, `${SESSION_ID}.jsonl`);
  }
  return traceFile;
}

// A per-process session id. Derived from pid + a monotonic counter so it needs
// no wall-clock (which some runtimes restrict); collisions across processes are
// avoided by pid.
const SESSION_ID = `s${process.pid.toString(36)}`;

export function trace(line: Omit<TraceLine, 'ts'>): void {
  const ts = new Date().toISOString();
  const file = target();
  if (file) {
    try {
      appendFileSync(file, `${JSON.stringify({ ts, ...line })}\n`);
    } catch {
      /* tracing must never break a run */
    }
  }
  // The trace-artifact session rides the same spine —
  // independent of the legacy file target, so it records even when
  // PHONE_USE_TRACE is unset.
  try {
    currentTraceSession()?.add({ ts, ...line });
  } catch {
    /* tracing must never break a run */
  }
}

export function tracePath(): string | null {
  return target();
}

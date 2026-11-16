import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { currentExecution } from './execution-context.ts';
import { type ZipEntry, zipWriteSync } from './zip.ts';

// ---------------------------------------------------------------------------
// TraceSession: the context-scoped recorder behind the trace
// artifact — one portable zip per run holding the JSONL action/verdict lines
// (permission decisions included), per-action tree snapshots, and a screenshot
// filmstrip when frames are capturable. Declarative policy:
//   PHONE_USE_TRACE_MODE = on | on-failure   (anything else = off)
// 'on-failure' + a passed run discards everything with zero disk I/O, so
// recording costs ~nothing on the happy path. PHONE_USE_TRACE_OUT overrides
// the default ~/.phone-use/traces/<sessionId>.zip destination.
// ---------------------------------------------------------------------------

export type TracePolicy = 'on' | 'on-failure';
export type TraceOutcome = 'passed' | 'failed' | 'unknown';

export type VerdictLine = {
  kind: 'verdict';
  ts: string;
  source: 'observe-expect' | 'skill-verify' | 'bench' | 'otp-relay';
  expect?: string | undefined;
  ok: boolean;
  detail: string;
};

type TreeSnap = {
  app?: string | undefined;
  bundleId?: string | undefined;
  viewport: { width: number; height: number };
  nodes: unknown[];
};

const LINE_CAP = 10_000;
const TREE_CAP = 200;
const FRAME_CAP = 60;
const FRAME_BYTE_CAP = 30 * 1024 * 1024;

const pad6 = (n: number) => String(n).padStart(6, '0');

function generatorVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export class TraceSession {
  readonly policy: TracePolicy;
  readonly sessionId: string;
  private readonly startedAt = new Date().toISOString();

  // JSONL lines, stringified at add() time (that IS the defensive copy).
  private readonly lines: string[] = [];
  // Tree snapshots keep their ORIGINAL capture indices across ring drops.
  private readonly trees: { n: number; json: string }[] = [];
  private readonly frames: { n: number; data: Buffer }[] = [];
  private frameBytes = 0;
  private treeSeq = 0;
  private frameSeq = 0;
  private framePending: Promise<void> | null = null;
  private readonly dropped = { lines: 0, trees: 0, frames: 0, frameSkips: 0 };
  private finishResult: Promise<string | null> | null = null;

  constructor(
    policy: TracePolicy,
    private readonly options: {
      output?: string;
      device?: { id: string; platform: string; backend?: string };
    } = {},
  ) {
    this.policy = policy;
    this.sessionId = `t${randomUUID()}`;
  }

  add(line: { ts: string; [key: string]: unknown }): void {
    if (this.finishResult) return;
    this.pushLine(line);
  }

  private pushLine(line: { ts: string; [key: string]: unknown }): void {
    this.lines.push(JSON.stringify(line));
    while (this.lines.length > LINE_CAP) {
      this.lines.shift();
      this.dropped.lines++;
    }
  }

  addVerdict(v: Omit<VerdictLine, 'ts'>): void {
    this.add({ ...v, ts: new Date().toISOString() });
  }

  captureTree(snap: TreeSnap): void {
    if (this.finishResult) return;
    const n = this.treeSeq++;
    // Stringify immediately — the live tree keeps mutating under us.
    this.trees.push({ n, json: JSON.stringify(snap) });
    while (this.trees.length > TREE_CAP) {
      this.trees.shift();
      this.dropped.trees++;
    }
    this.add({ kind: 'tree', ts: new Date().toISOString(), n });
  }

  captureFrame(get: () => Promise<Buffer | null>): void {
    if (this.finishResult) return;
    if (this.framePending) {
      // A capture is already in flight — skip rather than queue (the filmstrip
      // tolerates gaps; a capture pile-up would not).
      this.dropped.frameSkips++;
      return;
    }
    const ts = new Date().toISOString();
    // No finished-guard inside the then: finish() awaits this promise so an
    // in-flight capture still lands in the artifact.
    this.framePending = get()
      .then((buf) => {
        if (buf && buf.length > 0) this.pushFrame(buf, ts);
      })
      .catch(() => undefined)
      .finally(() => {
        this.framePending = null;
      });
  }

  private pushFrame(data: Buffer, ts: string): void {
    const n = this.frameSeq++;
    this.frames.push({ n, data });
    this.frameBytes += data.length;
    while (this.frames.length > 1 && (this.frames.length > FRAME_CAP || this.frameBytes > FRAME_BYTE_CAP)) {
      const evicted = this.frames.shift()!;
      this.frameBytes -= evicted.data.length;
      this.dropped.frames++;
    }
    // Direct pushLine: a frame landing while finish() awaits it must keep its
    // index line paired with the stored bytes.
    this.pushLine({ kind: 'frame', ts, n });
  }

  /**
   * Flush (or discard) the session. Idempotent — a second call returns the
   * first result. Returns the zip path, or null when the on-failure policy
   * discarded a passed run (no disk I/O at all in that case).
   */
  finish(outcome: TraceOutcome): Promise<string | null> {
    this.finishResult ??= this.flush(outcome);
    return this.finishResult;
  }

  private async flush(outcome: TraceOutcome): Promise<string | null> {
    if (this.policy === 'on-failure' && outcome === 'passed') return null;
    if (this.framePending) await this.framePending;

    const manifest = {
      formatVersion: 0,
      generator: { name: 'phone-use', version: generatorVersion() },
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      policy: this.policy,
      outcome,
      device: this.options.device ?? { platform: 'unknown', id: 'unknown' },
      counts: { lines: this.lines.length, trees: this.trees.length, frames: this.frames.length },
      dropped: { ...this.dropped },
    };

    const entries: ZipEntry[] = [
      { name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` },
      { name: 'trace.jsonl', data: this.lines.length ? `${this.lines.join('\n')}\n` : '' },
      ...this.trees.map((t) => ({ name: `trees/${pad6(t.n)}.json`, data: t.json })),
      ...this.frames.map((f) => ({ name: `frames/${pad6(f.n)}.jpeg`, data: f.data })),
    ];

    const out =
      this.options.output ??
      process.env.PHONE_USE_TRACE_OUT ??
      join(homedir(), '.phone-use', 'traces', `${this.sessionId}.zip`);
    mkdirSync(dirname(out), { recursive: true });
    zipWriteSync(out, entries);
    return out;
  }
}

// --- Module slot: the process-current session ------------------------------
// One session per process, matching the process-global driver facade. Owners
// (CLI task, SDK prompt, MCP server) start it from the environment and finish
// it; the trace spine and DeviceContext feed whichever session is current.

let slot: TraceSession | null = null;

export function startTraceSessionFromEnv(): TraceSession | null {
  const mode = process.env.PHONE_USE_TRACE_MODE;
  if (mode !== 'on' && mode !== 'on-failure') return null;
  const session = new TraceSession(mode);
  setTraceSession(session);
  return session;
}

export function currentTraceSession(): TraceSession | null {
  const scoped = currentExecution();
  return scoped ? scoped.trace : slot;
}

export function traceActive(): boolean {
  return currentTraceSession() !== null;
}

/** Test-only: install (or clear) the current session directly. */
export function setTraceSession(s: TraceSession | null): void {
  const scoped = currentExecution();
  if (scoped) scoped.trace = s;
  else slot = s;
}

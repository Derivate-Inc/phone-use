import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { soleBootedSimulator } from '@phone-use/sdk';

// ---------------------------------------------------------------------------
// Cross-process device leases: one agent session drives a simulator at a time.
//
// device-claim.ts only sees its own process. Two agents (two CLI loops, two
// MCP servers, or one of each) on one simulator used to interleave silently:
// each call was truthful, yet each agent's app state changed under it
// (eval Tier 2, case I2). Another session could also uninstall the app from
// under an agent (case I5).
//
// A lease is a file per device naming the session that last used it. Another
// session is refused (DEVICE_IN_USE) while the holder is alive and was active
// within the TTL. A session is PHONE_USE_SESSION when set; otherwise the agent
// process the CLI runs under (the first ancestor that is not a shell or a
// launcher), or the MCP server process. Calls from one agent therefore share a
// session whatever shell each command runs in.
// ---------------------------------------------------------------------------

export type Lease = {
  session: string;
  /** The session was named with PHONE_USE_SESSION (compare names only). */
  explicit: boolean;
  /** The agent process that holds the lease (liveness). */
  pid: number;
  /** Its ancestors, so a CLI call and an MCP server of one agent count as one session. */
  chain: number[];
  cwd: string;
  lastUsed: number;
};

export type Identity = Omit<Lease, 'cwd' | 'lastUsed'>;

export class DeviceLeaseError extends Error {
  readonly code = 'DEVICE_IN_USE';
}

const SKIP = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  'env',
  'sudo',
  'timeout',
  'nohup',
  'xargs',
  'script',
  'time',
  'npx',
  'npm',
  'bunx',
  'pnpm',
  'yarn',
]);

export function leaseDir(): string {
  return process.env.PHONE_USE_LEASE_DIR ?? join(homedir(), '.phone-use', 'leases');
}

function ttlMs(): number {
  const v = Number(process.env.PHONE_USE_LEASE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 5 * 60_000;
}

/** pid → [ppid, command line] for every process (one `ps`). */
function processTable(): Map<number, [number, string]> {
  const out = new Map<number, [number, string]>();
  try {
    const text = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], {
      encoding: 'utf8',
      maxBuffer: 16 << 20,
    });
    for (const line of text.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) out.set(Number(m[1]), [Number(m[2]), m[3] ?? '']);
    }
  } catch {
    /* no ps: identity falls back to the parent pid */
  }
  return out;
}

/** Is this command a shell or launcher between the agent and us (or phone-use's own wrapper)? */
export function isIntermediary(args: string): boolean {
  const [first = '', script = ''] = args.trim().split(/\s+/);
  const exe = basename(first).replace(/^-/, '');
  // phone-use itself: its binary, or a runtime running its entry point. Not any
  // process that merely mentions phone-use (an agent working in a directory of
  // that name is still the agent).
  const phoneUse =
    exe === 'phone-use' ||
    (/^(node|bun)$/.test(exe) &&
      (basename(script) === 'phone-use' || /\/packages\/phone-use\/src\/index\.ts$/.test(script)));
  return SKIP.has(exe) || phoneUse;
}

/** Who is calling: the agent process above this CLI call, or this MCP server. */
export function callerIdentity(kind: 'cli' | 'mcp'): Identity {
  const table = processTable();
  const chain: number[] = [];
  for (let pid = process.ppid, hops = 0; pid > 1 && hops < 40; hops++) {
    chain.push(pid);
    const row = table.get(pid);
    if (!row) break;
    pid = row[0];
  }
  const root =
    kind === 'mcp'
      ? process.pid
      : (chain.find((pid) => {
          const row = table.get(pid);
          return row ? !isIntermediary(row[1]) : true;
        }) ?? process.ppid);
  const explicit = process.env.PHONE_USE_SESSION;
  return {
    session: explicit || `${kind}:${root}`,
    explicit: !!explicit,
    pid: root,
    chain: kind === 'mcp' ? [process.pid, ...chain] : chain,
  };
}

/** Same agent session? Named sessions compare by name; otherwise by process ancestry. */
export function sameSession(holder: Identity, caller: Identity): boolean {
  if (holder.explicit || caller.explicit) return holder.session === caller.session;
  return holder.pid === caller.pid || caller.chain.includes(holder.pid) || holder.chain.includes(caller.pid);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pid written in a lock file, or undefined when it holds none (being written, or a legacy lock). */
function lockOwner(lock: string): number | undefined {
  try {
    const pid = Number(readFileSync(lock, 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A short exclusive section around read-modify-write. The lock is a file
 * created exclusively and holding the owner's pid. A caller never enters
 * without owning it, and removes only its own. A lock whose owner has died is
 * taken over; so is an unreadable one older than 5 s (a crashed writer, or the
 * directory lock of earlier versions). Otherwise, after 2 s, the call fails
 * rather than proceed unlocked: the section takes milliseconds, so a lock held
 * that long means something is wrong.
 */
function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = lockOwner(lock);
      try {
        const stale = owner !== undefined ? !alive(owner) : Date.now() - statSync(lock).mtimeMs > 5000;
        // Re-check just before removing: another caller may have replaced it.
        if (stale && lockOwner(lock) === owner) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* gone already */
      }
      if (Date.now() > deadline)
        throw new Error(`the device lease lock ${lock} is held by process ${owner ?? '?'}; try again`);
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    if (lockOwner(lock) === process.pid) rmSync(lock, { force: true });
  }
}

function fileFor(device: string): string {
  return join(leaseDir(), `${device.replace(/[^\w.-]/g, '_')}.json`);
}

function read(path: string): Lease | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Lease;
  } catch {
    return undefined;
  }
}

/** Whether `holder` still holds the device against `caller` right now. */
export function holds(holder: Lease | undefined, caller: Identity, now = Date.now()): boolean {
  if (!holder) return false;
  if (sameSession(holder, caller)) return false;
  if (now - holder.lastUsed > ttlMs()) return false;
  return alive(holder.pid);
}

/**
 * Take or renew the lease on `device` for `caller`, or throw DeviceLeaseError
 * naming the session that holds it. PHONE_USE_TAKEOVER=1 takes it regardless.
 */
export function acquireDevice(device: string, caller: Identity, label = device): void {
  mkdirSync(leaseDir(), { recursive: true, mode: 0o700 });
  const path = fileFor(device);
  withLock(path, () => {
    const holder = read(path);
    if (process.env.PHONE_USE_TAKEOVER !== '1' && holds(holder, caller)) {
      const h = holder as Lease;
      const ago = Math.round((Date.now() - h.lastUsed) / 1000);
      throw new DeviceLeaseError(
        `${label} is in use by another agent session (${h.session}, in ${h.cwd}, last active ${ago}s ago). ` +
          'Two agents on one device would silently interleave. Use your own simulator ' +
          '(PHONE_USE_DEVICE=<udid>, or PHONE_USE_DEVICE=launch for a fresh one), wait until it is free ' +
          `(${Math.round(ttlMs() / 1000)}s after its last use, or when that agent exits), ` +
          'or take it over with PHONE_USE_TAKEOVER=1.',
      );
    }
    const lease: Lease = { ...caller, cwd: process.cwd(), lastUsed: Date.now() };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(lease), { mode: 0o600 });
    renameSync(tmp, path);
  });
}

/** Give the device back (an MCP server shutting down). Only the holder's own lease is removed. */
export function releaseDevice(device: string, caller: Identity): void {
  const path = fileFor(device);
  // Best effort: a lease left behind expires after the TTL anyway.
  try {
    withLock(path, () => {
      const holder = read(path);
      if (holder && sameSession(holder, caller)) rmSync(path, { force: true });
    });
  } catch {
    /* lock busy; the lease expires on its own */
  }
}

const UDID_RE = /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;

/**
 * The shared local simulator this process will drive, when it is one: a udid in
 * PHONE_USE_DEVICE, or (unpinned, or `connect`) the one booted simulator. Null for
 * devices that are not shared simulators (`launch` makes a private one; real
 * devices and cloud phones have their own access control) and when selection
 * fails (the verb reports that itself).
 */
export async function sharedSimulator(env = process.env): Promise<string | null> {
  const spec = env.PHONE_USE_DEVICE;
  if (spec && UDID_RE.test(spec)) return spec;
  if (spec && spec !== 'connect') return null;
  if (env.PHONE_USE_SANDBOX_URL || env.PHONE_USE_RUNNER_URL) return null;
  try {
    return await soleBootedSimulator();
  } catch {
    return null;
  }
}

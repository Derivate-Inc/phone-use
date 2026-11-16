import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireDevice,
  DeviceLeaseError,
  holds,
  type Identity,
  isIntermediary,
  type Lease,
  releaseDevice,
  sameSession,
} from '../src/device-lease.ts';

const me = (over: Partial<Identity> = {}): Identity => ({
  session: `cli:${process.pid}`,
  explicit: false,
  pid: process.pid,
  chain: [process.pid],
  ...over,
});
// A live process that is not us or our ancestor: our parent's pid is alive but
// "foreign" once removed from the chain.
const other = (over: Partial<Identity> = {}): Identity => ({
  session: `cli:${process.ppid}`,
  explicit: false,
  pid: process.ppid,
  chain: [process.ppid],
  ...over,
});

describe('device lease', () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pu-lease-'));
    process.env.PHONE_USE_LEASE_DIR = dir;
    delete process.env.PHONE_USE_TAKEOVER;
    delete process.env.PHONE_USE_LEASE_TTL_MS;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
  });

  it('treats shells and the phone-use wrapper as intermediaries, not the agent', () => {
    expect(isIntermediary('/bin/zsh -c phone-use observe')).toBe(true);
    expect(isIntermediary('-zsh')).toBe(true);
    expect(isIntermediary('node /usr/local/bin/phone-use observe')).toBe(true);
    expect(isIntermediary('bun /repo/packages/phone-use/src/index.ts observe')).toBe(true);
    expect(isIntermediary('node /Users/x/.nvm/bin/claude')).toBe(false);
    // An agent that merely mentions phone-use (working in a directory of that name) is still the agent.
    expect(isIntermediary('node /Users/x/.nvm/bin/claude --cwd /Users/x/phone-use')).toBe(false);
  });

  it('never enters the lease section while a live process holds the lock: it fails instead', () => {
    const lock = join(dir, 'SIM-1.json.lock');
    writeFileSync(lock, String(process.ppid)); // alive, and not us
    expect(() => acquireDevice('SIM-1', me())).toThrow(/lease lock/);
    expect(existsSync(join(dir, 'SIM-1.json'))).toBe(false); // nothing written unlocked
    releaseDevice('SIM-1', me()); // best effort: does not throw, and leaves the other's lock
    expect(readFileSync(lock, 'utf8')).toBe(String(process.ppid));
  });

  it('takes over a lock whose owner died, and a directory lock left by an earlier version', () => {
    writeFileSync(join(dir, 'SIM-1.json.lock'), String(2 ** 22 + 12_345));
    expect(() => acquireDevice('SIM-1', me())).not.toThrow();
    expect(existsSync(join(dir, 'SIM-1.json.lock'))).toBe(false);

    const legacy = join(dir, 'SIM-2.json.lock');
    mkdirSync(legacy);
    const old = new Date(Date.now() - 60_000);
    utimesSync(legacy, old, old);
    expect(() => acquireDevice('SIM-2', me())).not.toThrow();
    expect(existsSync(legacy)).toBe(false);
  });

  it('one agent is one session: same root, or a root in the other one ancestry (CLI + MCP)', () => {
    expect(sameSession(me(), me())).toBe(true);
    const mcp = me({ session: 'mcp:1', pid: 999_999, chain: [999_999, process.pid] });
    expect(sameSession(mcp, me())).toBe(true);
    expect(sameSession(me(), other())).toBe(false);
    // Named sessions compare by name only.
    expect(sameSession(me({ explicit: true, session: 'a' }), me({ explicit: true, session: 'b' }))).toBe(
      false,
    );
    expect(sameSession(other({ explicit: true, session: 'a' }), me({ explicit: true, session: 'a' }))).toBe(
      true,
    );
  });

  it('a live holder within the TTL holds; an idle or dead one does not', () => {
    const lease: Lease = { ...other(), cwd: '/x', lastUsed: Date.now() };
    expect(holds(lease, me())).toBe(true);
    expect(holds({ ...lease, lastUsed: Date.now() - 10 * 60_000 }, me())).toBe(false);
    expect(holds({ ...lease, pid: 2 ** 22 + 12_345 }, me())).toBe(false);
    expect(holds(lease, other())).toBe(false);
  });

  it('refuses a second session with a message naming the holder, then lets the holder renew', () => {
    acquireDevice('SIM-1', other({ explicit: true, session: 'agent-a' }));
    expect(() => acquireDevice('SIM-1', me({ explicit: true, session: 'agent-b' }))).toThrow(
      DeviceLeaseError,
    );
    expect(() => acquireDevice('SIM-1', me({ explicit: true, session: 'agent-b' }))).toThrow(/agent-a/);
    expect(() => acquireDevice('SIM-1', other({ explicit: true, session: 'agent-a' }))).not.toThrow();
    // A different device is unaffected.
    expect(() => acquireDevice('SIM-2', me({ explicit: true, session: 'agent-b' }))).not.toThrow();
  });

  it('PHONE_USE_TAKEOVER takes the device; release frees it only for its holder', () => {
    acquireDevice('SIM-1', other({ explicit: true, session: 'agent-a' }));
    process.env.PHONE_USE_TAKEOVER = '1';
    acquireDevice('SIM-1', me({ explicit: true, session: 'agent-b' }));
    delete process.env.PHONE_USE_TAKEOVER;
    expect(() => acquireDevice('SIM-1', other({ explicit: true, session: 'agent-a' }))).toThrow(/agent-b/);
    releaseDevice('SIM-1', other({ explicit: true, session: 'agent-a' })); // not the holder: no effect
    expect(() => acquireDevice('SIM-1', other({ explicit: true, session: 'agent-a' }))).toThrow();
    releaseDevice('SIM-1', me({ explicit: true, session: 'agent-b' }));
    expect(() => acquireDevice('SIM-1', other({ explicit: true, session: 'agent-a' }))).not.toThrow();
  });
});

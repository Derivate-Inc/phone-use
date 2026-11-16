import { spawn } from 'node:child_process';
import { appleEnv, stopRunner } from '@phone-use/sdk';

const UDID_RE = /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;

/**
 * Shut down and delete simulators this server launched, from a detached
 * process that outlives it.
 *
 * MCP clients give a server a few seconds after they hang up, then kill it:
 * the TypeScript SDK's client ends stdin, waits 2 s, sends SIGTERM, waits 2 s,
 * then SIGKILL. Shutting a simulator down and deleting it takes longer, so
 * closing in-process left launched simulators behind (seen live: two launched
 * simulators, both left, one still booted). The detached shell finishes the
 * job whatever happens to this process.
 */
export function reapSimulators(udids: readonly string[]): void {
  const targets = udids.filter((udid) => UDID_RE.test(udid));
  if (targets.length === 0) return;
  for (const udid of targets) {
    try {
      stopRunner(udid);
    } catch {
      /* no runner state, or it is already gone */
    }
  }
  const script =
    'for u in "$@"; do xcrun simctl shutdown "$u" >/dev/null 2>&1; done; xcrun simctl delete "$@" >/dev/null 2>&1';
  const child = spawn('/bin/sh', ['-c', script, 'phone-use-reap', ...targets], {
    detached: true,
    stdio: 'ignore',
    env: appleEnv(),
  });
  child.unref();
}

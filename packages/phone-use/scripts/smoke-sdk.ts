// Device-free, key-free smoke test of the SDK surface (src/sdk.ts) and its
// permission wiring (src/tools.ts + src/permissions.ts). Proves the SDK's core
// safety guarantee — deny-by-default gating and single-use token redemption —
// WITHOUT an ANTHROPIC_API_KEY, a simulator, or the phone-use iOS runner.
//   bun scripts/smoke-sdk.ts
//
// Ordering is load-bearing: the permission grant cache is process-global with
// no reset (deliberately — no config may disable the deny floor), so every
// assertion uses a DISTINCT target label to avoid fingerprint collisions, and
// the "must block" checks run before any approval caches a grant.

import { evaluate, setMode } from '../src/permissions.ts';
import { createSession } from '../src/sdk.ts';
import { buildTools } from '../src/tools.ts';

setMode('default'); // pin against a stray PHONE_USE_MODE in the environment

let ok = false;
try {
  // 1. Shape — createSession works with no API key (lazy client construction).
  const session = createSession({});
  const shape =
    typeof session.prompt === 'function' &&
    typeof session.stop === 'function' &&
    Array.isArray(session.steps) &&
    session.steps.length === 0;

  // 2. Deny-by-default gate blocks a destructive tap WITHOUT reaching the driver.
  //    No daemon is running, so an ERROR result would mean the gate leaked
  //    through to the handler — BLOCKED-not-ERROR is itself the proof.
  const events: { decision: string; result: string }[] = [];
  const stepsDeny: import('../src/tools.ts').StepLog[] = [];
  const denyTools = buildTools(stepsDeny, {
    onConfirm: () => false,
    onEvent: (e) => events.push({ decision: e.decision, result: e.result }),
  });
  const tap = denyTools.find((t) => t.name === 'tap')!;
  const denied = await tap.run({ label: 'Delete Account' });
  const gateBlocks = typeof denied === 'string' && denied.startsWith('⛔ BLOCKED');
  const eventFired = events.length === 1 && events[0]!.decision === 'deny' && events[0]!.result === denied;

  // 3. Token redemption at the evaluate layer (a DIFFERENT target).
  const ask = evaluate({ tool: 'tap', risk: 'mutate', target: 'Erase All Content' });
  const isAsk = ask.decision === 'ask' && typeof (ask as { token?: string }).token === 'string';
  const token = (ask as { token: string }).token;
  const redeemed =
    evaluate({ tool: 'tap', risk: 'mutate', target: 'Erase All Content', confirm: token }).decision ===
    'allow';
  const singleUse =
    evaluate({ tool: 'tap', risk: 'mutate', target: 'Erase All Content', confirm: token }).decision ===
    'deny'; // token consumed
  const grantCached =
    evaluate({ tool: 'tap', risk: 'mutate', target: 'Erase All Content' }).decision === 'allow'; // session grant persists

  // 4. Approve path opens the gate (a THIRD distinct target). With no daemon the
  //    handler errors — that ERROR (not a ⛔) proves control reached the driver.
  let confirmCalls = 0;
  const stepsAllow: import('../src/tools.ts').StepLog[] = [];
  const allowTools = buildTools(stepsAllow, {
    onConfirm: () => {
      confirmCalls++;
      return true;
    },
  });
  const tap2 = allowTools.find((t) => t.name === 'tap')!;
  // 30s: on a Mac with a live daemon the first driver call includes XCTest
  // runner attach (>5s cold); on the VPS the no-daemon error returns instantly.
  const approved = await Promise.race([
    tap2.run({ label: 'Remove Card' }),
    new Promise<string>((resolve) => setTimeout(() => resolve('TIMEOUT'), 30_000)),
  ]);
  const gateOpened =
    confirmCalls === 1 &&
    approved !== 'TIMEOUT' &&
    !(typeof approved === 'string' && approved.startsWith('⛔'));

  ok = shape && gateBlocks && eventFired && isAsk && redeemed && singleUse && grantCached && gateOpened;
  console.log(
    `shape=${shape} gateBlocks=${gateBlocks} eventFired=${eventFired} isAsk=${isAsk} redeemed=${redeemed} singleUse=${singleUse} grantCached=${grantCached} gateOpened=${gateOpened}`,
  );
  console.log(ok ? 'PASS — deny-by-default gate, token redemption, approve-opens-gate' : 'FAIL');
} catch (error) {
  console.log(`FAIL — ${String(error).slice(0, 200)}`);
}

process.exit(ok ? 0 : 1);

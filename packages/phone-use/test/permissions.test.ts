import { describe, expect, it } from 'vitest';
import { effectiveRisk, evaluate, renderAsk, setMode } from '../src/permissions.ts';

// The permission floor under unit test (plan item 1; item 5 extends this to
// every config path). permissions.ts pulls no Bun APIs — its one import is
// `import type` — so this tier runs under plain Node vitest.
//
// grants/pendingTokens are module-global with NO reset (deliberate: no config
// may disable the floor), so every case uses a UNIQUE tool/app/target tuple —
// tests would otherwise pass/fail order-dependently.

describe('permission floor', () => {
  it('read always allows, in every mode', () => {
    for (const mode of ['observe', 'default', 'auto'] as const) {
      setMode(mode);
      expect(evaluate({ tool: 'observe', risk: 'read', target: `probe-${mode}` }).decision).toBe('allow');
    }
  });

  it('observe mode blocks anything non-read', () => {
    setMode('observe');
    expect(evaluate({ tool: 'tap', risk: 'mutate', target: 'Observe Blocked Row' }).decision).toBe('deny');
    expect(evaluate({ tool: 'scroll', risk: 'navigate' }).decision).toBe('deny');
  });

  it('destructive target asks EVEN IN auto — the un-overridable floor', () => {
    setMode('auto');
    const v = evaluate({ tool: 'tap', risk: 'mutate', target: 'Delete Backup Auto', app: 'Settings' });
    expect(v.decision).toBe('ask');
  });

  it('token redemption is single-use and fingerprint-specific', () => {
    setMode('default');
    const target = 'Erase Watch Data';
    const ask = evaluate({ tool: 'tap', risk: 'mutate', target });
    expect(ask.decision).toBe('ask');
    if (ask.decision !== 'ask') return;

    // Wrong fingerprint: same token, different action — deny.
    expect(
      evaluate({ tool: 'tap', risk: 'mutate', target: 'Erase Other Data', confirm: ask.token }).decision,
    ).toBe('deny');

    // The wrong-fingerprint attempt consumed nothing for THIS action; a fresh
    // ask token for the real target redeems exactly once...
    const ask2 = evaluate({ tool: 'tap', risk: 'mutate', target });
    expect(ask2.decision).toBe('ask');
    if (ask2.decision !== 'ask') return;
    expect(evaluate({ tool: 'tap', risk: 'mutate', target, confirm: ask2.token }).decision).toBe('allow');

    // ...then the grant cache answers without a token,
    expect(evaluate({ tool: 'tap', risk: 'mutate', target }).decision).toBe('allow');

    // and the spent token cannot be replayed (single-use).
    expect(
      evaluate({ tool: 'tap', risk: 'mutate', target: 'Erase Third Data', confirm: ask2.token }).decision,
    ).toBe('deny');
  });

  it('type/toggle ask in default mode; plain taps ride free', () => {
    setMode('default');
    expect(evaluate({ tool: 'type', risk: 'mutate', target: 'Notes Body Field' }).decision).toBe('ask');
    expect(evaluate({ tool: 'toggle', risk: 'mutate', target: 'Wi-Fi Assist Row' }).decision).toBe('ask');
    expect(evaluate({ tool: 'tap', risk: 'mutate', target: 'General Row' }).decision).toBe('allow');
  });

  it('auto mode frees mutations but never destructive targets', () => {
    setMode('auto');
    expect(evaluate({ tool: 'type', risk: 'mutate', target: 'Search Field Auto' }).decision).toBe('allow');
    expect(evaluate({ tool: 'toggle', risk: 'mutate', target: 'Bluetooth Row Auto' }).decision).toBe('allow');
    expect(evaluate({ tool: 'tap', risk: 'mutate', target: 'Pay Now Button' }).decision).toBe('ask');
  });

  it('effectiveRisk: verb is the floor, element target is the ceiling', () => {
    expect(effectiveRisk({ tool: 'toggle', risk: 'mutate', target: 'Delete Account Switch' })).toBe(
      'destructive',
    );
    expect(effectiveRisk({ tool: 'type', risk: 'mutate', target: 'Verification Code Entry' })).toBe(
      'destructive',
    );
    expect(effectiveRisk({ tool: 'toggle', risk: 'mutate', target: 'Full-Screen Previews' })).toBe('mutate');
    expect(effectiveRisk({ tool: 'observe', risk: 'read', target: 'delete everything' })).toBe('read');
  });

  it('renderAsk carries the token and the re-call contract', () => {
    setMode('default');
    const v = evaluate({ tool: 'tap', risk: 'mutate', target: 'Remove Payment Card X' });
    expect(v.decision).toBe('ask');
    if (v.decision !== 'ask') return;
    const text = renderAsk(v);
    expect(text).toContain('CONFIRMATION REQUIRED');
    expect(text).toContain(v.token);
  });
});

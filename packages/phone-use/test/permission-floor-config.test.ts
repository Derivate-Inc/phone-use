import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The floor through EVERY config path (docs/20 item 5): mode env at import,
// setMode with every (and junk) values, token forgery, lexicon coverage,
// backend independence. Isolated file: the vi.resetModules cases create a
// fresh permissions module instance that no other suite must observe.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const freshPermissions = async () => await import('../src/permissions.ts');

describe('PHONE_USE_MODE at import time', () => {
  it.each(['auto', 'observe', 'default'])('mode env %s: destructive target still asks', async (mode) => {
    vi.stubEnv('PHONE_USE_MODE', mode);
    vi.resetModules();
    const p = await freshPermissions();
    const v = p.evaluate({ tool: 'tap', risk: 'mutate', target: `Delete Env ${mode} Row` });
    expect(v.decision).not.toBe('allow');
  });

  it('junk mode env (e.g. "bypass") does not create an allow-everything mode', async () => {
    vi.stubEnv('PHONE_USE_MODE', 'bypass');
    vi.resetModules();
    const p = await freshPermissions();
    const v = p.evaluate({ tool: 'tap', risk: 'mutate', target: 'Delete Bypass Row' });
    expect(v.decision).not.toBe('allow');
  });
});

describe('setMode through every value', () => {
  it('no mode value makes a destructive target silent', async () => {
    const p = await freshPermissions();
    for (const mode of ['observe', 'default', 'auto', 'yolo', 'bypass', ''] as const) {
      p.setMode(mode as Parameters<typeof p.setMode>[0]);
      const v = p.evaluate({ tool: 'tap', risk: 'mutate', target: `Erase Mode ${mode || 'empty'} Data` });
      expect(v.decision, `mode=${mode}`).not.toBe('allow');
    }
  });
});

describe('confirm-token forgery matrix', () => {
  it('never-issued, cross-tool, cross-app, and empty tokens all fail', async () => {
    const p = await freshPermissions();
    p.setMode('default');

    // Never-issued token.
    expect(
      p.evaluate({ tool: 'tap', risk: 'mutate', target: 'Delete Forge A', confirm: 'deadbeef' }).decision,
    ).toBe('deny');

    // Cross-tool: token issued for `type`, redeemed on `toggle` (same target).
    const asked = p.evaluate({ tool: 'type', risk: 'mutate', target: 'Verification Code Forge' });
    expect(asked.decision).toBe('ask');
    if (asked.decision !== 'ask') return;
    expect(
      p.evaluate({ tool: 'toggle', risk: 'mutate', target: 'Verification Code Forge', confirm: asked.token })
        .decision,
    ).toBe('deny');

    // Cross-app: same tool+target, different app.
    const asked2 = p.evaluate({ tool: 'tap', risk: 'mutate', target: 'Delete Forge B', app: 'Photos' });
    expect(asked2.decision).toBe('ask');
    if (asked2.decision !== 'ask') return;
    expect(
      p.evaluate({
        tool: 'tap',
        risk: 'mutate',
        target: 'Delete Forge B',
        app: 'Messages',
        confirm: asked2.token,
      }).decision,
    ).toBe('deny');

    // Empty confirm falls through to normal evaluation — never redeems.
    expect(p.evaluate({ tool: 'tap', risk: 'mutate', target: 'Delete Forge C', confirm: '' }).decision).toBe(
      'ask',
    );
  });
});

describe('sensitive-field lexicon in auto mode', () => {
  it.each(['Verification Code Entry X', 'CVV Field X', 'One-Time Code X', 'Passcode Entry X'])(
    '"%s" escalates to ask even in auto',
    async (target) => {
      const p = await freshPermissions();
      p.setMode('auto');
      expect(p.evaluate({ tool: 'type', risk: 'mutate', target }).decision).toBe('ask');
    },
  );
});

describe('backend independence of the floor', () => {
  it('permissions depend only on types and passive async scope, never a backend implementation', () => {
    const src = readFileSync(new URL('../src/permissions.ts', import.meta.url), 'utf8');
    const importLines = src.split('\n').filter((l) => /^import /.test(l.trim()));
    for (const line of importLines) {
      expect(line, `unexpected runtime dependency in permissions.ts: ${line}`).toMatch(
        /^import type |^import \{ currentExecution \} from '\.\/execution-context\.ts';$/,
      );
    }
    const context = readFileSync(new URL('../src/execution-context.ts', import.meta.url), 'utf8');
    for (const line of context.split('\n').filter((line) => /^import /.test(line))) {
      expect(line).toMatch(/^import type |^import \{ AsyncLocalStorage \} from 'node:async_hooks';$/);
    }
  });

  it('evaluate runs with no device context bound and no backend constructed', async () => {
    const p = await freshPermissions();
    p.setMode('auto');
    // No setDefaultDeviceContext, no backend anywhere in this test file.
    expect(p.evaluate({ tool: 'tap', risk: 'mutate', target: 'Pay Independence Check' }).decision).toBe(
      'ask',
    );
  });
});

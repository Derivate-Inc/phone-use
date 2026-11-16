import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceContext } from '../src/device-context.ts';
import * as driver from '../src/driver.ts';

// The singleton backward-compat surface (docs/20 item 2): every pre-seam
// driver export keeps working, delegating to the default DeviceContext — and
// contexts never bleed state into each other (the refactor's #1 risk).

afterEach(() => driver.setDefaultDeviceContext(null));

describe('driver facade (singleton compat)', () => {
  it('module exports drive the injected context, not a real client', async () => {
    const fake = new FakeBackend({
      screens: [screen([el({ ref: '@e1', type: 'Cell', label: 'General' })], { appName: 'Settings' })],
    });
    driver.setDefaultDeviceContext(new DeviceContext(fake));

    const obs = await driver.observe();
    expect(obs.app).toBe('Settings');
    expect(obs.elements).toContain('General');
    expect(driver.currentApp()).toBe('Settings');
    expect(driver.interactiveElements().map((e) => e.label)).toContain('General');
    expect(driver.renderObservation(true)).toContain('General');

    await driver.press('@e1');
    expect(fake.calls.map((c) => c.method)).toContain('snapshot');
    expect(fake.calls.map((c) => c.method)).toContain('press');
  });

  it('two contexts never bleed state: caches, delta baselines', async () => {
    const ctxA = new DeviceContext(
      new FakeBackend({
        screens: [screen([el({ ref: '@e1', type: 'Cell', label: 'Screen A Row' })], { appName: 'A' })],
      }),
    );
    const ctxB = new DeviceContext(
      new FakeBackend({
        screens: [screen([el({ ref: '@e1', type: 'Cell', label: 'Screen B Row' })], { appName: 'B' })],
      }),
    );

    // A observes and establishes its delta baseline.
    await ctxA.observe();
    ctxA.renderObservation();
    // B's FIRST render must be full (its own baseline is empty) — if A's
    // baseline leaked, B would render "unchanged".
    await ctxB.observe();
    const bFirst = ctxB.renderObservation();
    expect(bFirst).toContain('Screen B Row');
    expect(bFirst).not.toContain('unchanged');

    // A's second render is unchanged — B's render must not have reset it.
    const aSecond = ctxA.renderObservation();
    expect(aSecond).toContain('unchanged');

    // Caches are per-context.
    expect(ctxA.currentApp()).toBe('A');
    expect(ctxB.currentApp()).toBe('B');
    expect(ctxA.interactiveElements().map((e) => e.label)).toEqual(['Screen A Row']);
    expect(ctxB.interactiveElements().map((e) => e.label)).toEqual(['Screen B Row']);

    // Cursor state is per-context (same defaults, distinct objects).
    const curA = ctxA.getCursor();
    const curB = ctxB.getCursor();
    expect(curA).toEqual(curB);
    expect(curA).not.toBe(curB);

    // Live-state listeners are per-context: registering on A must not appear
    // in B's live state emissions machinery (unsubscribe works, no cross-fire).
    let aFired = 0;
    const off = ctxA.onState(() => {
      aFired++;
    });
    off();
    expect(aFired).toBe(0);
  });

  it('the export surface is frozen — any rename/removal breaks loudly', async () => {
    const mod = await import('../src/driver.ts');
    expect(Object.keys(mod).sort()).toEqual([
      'allElements',
      'captureFastJpeg',
      'clearBlockingAlerts',
      'clickCursor',
      'closeSession',
      'contentBounds',
      'currentApp',
      'currentElements',
      'defaultDeviceContext',
      'describeError',
      'fill',
      'findElement',
      'getCursor',
      'getLiveState',
      'goBack',
      'goHome',
      'goToRoot',
      'handleAlert',
      'inputFields',
      'interactiveElements',
      'labelMatches',
      'lastPressEvidence',
      'listApps',
      'longPress',
      'moveCursorToPoint',
      'moveCursorToRef',
      'observe',
      'onState',
      'openApp',
      'openUrl',
      'pan',
      'press',
      'pressAt',
      'pressInZoom',
      'pressReturn',
      'readField',
      'renderActionResult',
      'renderCurrentFrame',
      'renderObservation',
      'resolveElement',
      'screenSignature',
      'screenTitle',
      'screenshot',
      'screenshotWithRefs',
      'scroll',
      'scrollToTop',
      'selectBackendKind',
      'setDefaultDeviceContext',
      'tapLabel',
      'typeText',
      'viewportHeight',
      'waitForText',
      'zoomRegion',
    ]);
  });

  it('setDefaultDeviceContext(null) resets the singleton seam', async () => {
    const fake = new FakeBackend({ screens: [screen([], { appName: 'X' })] });
    driver.setDefaultDeviceContext(new DeviceContext(fake));
    await driver.observe();
    expect(driver.currentApp()).toBe('X');
    driver.setDefaultDeviceContext(null);
    // A fresh injected context starts clean (no cache from the previous one).
    const fake2 = new FakeBackend({ screens: [screen([], { appName: 'Y' })] });
    driver.setDefaultDeviceContext(new DeviceContext(fake2));
    expect(driver.currentApp()).toBeUndefined();
    await driver.observe();
    expect(driver.currentApp()).toBe('Y');
  });
});

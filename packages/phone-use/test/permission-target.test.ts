import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceContext } from '../src/device-context.ts';
import { observe, setDefaultDeviceContext } from '../src/driver.ts';
import { effectiveRisk } from '../src/permissions.ts';
import { targetOf } from '../src/registry.ts';

// The floor vets the element an action will HIT, not only the label the
// model typed: tapping "Delete Account" by @ref, by its coordinates, via a
// batch, or accepting the [Cancel, Delete] sheet that follows must all
// classify as destructive exactly like `tap label="Delete Account"`.

const DELETE = el({
  ref: '@e7',
  type: 'Button',
  label: 'Delete Account',
  rect: { x: 20, y: 600, width: 350, height: 44 },
});
const GENERAL = el({
  ref: '@e2',
  type: 'Cell',
  label: 'General',
  rect: { x: 0, y: 100, width: 390, height: 44 },
});

async function bind(nodes: ReturnType<typeof el>[]) {
  setDefaultDeviceContext(
    new DeviceContext(new FakeBackend({ screens: [screen(nodes, { appName: 'Settings' })] })),
  );
  await observe();
}

afterEach(() => setDefaultDeviceContext(null));

describe('targetOf resolves what the action will hit', () => {
  it('tap by ref → the element label', async () => {
    await bind([GENERAL, DELETE]);
    expect(targetOf('tap', { ref: '@e7' })).toBe('Delete Account');
    expect(targetOf('tap', { ref: 'e7' })).toBe('Delete Account');
    expect(targetOf('tap', { ref: '@e2' })).toBe('General');
    expect(effectiveRisk({ tool: 'tap', risk: 'mutate', target: targetOf('tap', { ref: '@e7' }) })).toBe(
      'destructive',
    );
  });

  it('tap at coordinates → the smallest labelled element under the point; zoom-space stays unresolved', async () => {
    await bind([GENERAL, DELETE]);
    expect(targetOf('tap', { at: { x: 100, y: 620 } })).toBe('Delete Account');
    expect(targetOf('tap', { at: { x: 100, y: 120 } })).toBe('General');
    expect(targetOf('tap', { at: { x: 100, y: 900 } })).toBeUndefined();
    expect(targetOf('tap', { at: { x: 100, y: 620 }, inZoom: true })).toBeUndefined();
  });

  it('drag → the element under the touch-down point', async () => {
    await bind([GENERAL, DELETE]);
    expect(targetOf('drag', { x: 50, y: 610, dx: -300, dy: 0 })).toBe('Delete Account');
  });

  it('batch actions by ref are vetted like batch actions by label', async () => {
    await bind([GENERAL, DELETE]);
    expect(
      targetOf('batch', {
        actions: [
          { do: 'tap', ref: '@e2' },
          { do: 'tap', ref: '@e7' },
        ],
      }),
    ).toBe('General → Delete Account');
  });

  it('handle_alert accept carries every alert button, so a [Cancel, Delete] sheet is destructive', async () => {
    await bind([
      GENERAL,
      el({
        ref: '@a1',
        type: 'Alert',
        label: 'Delete 3 photos?',
        rect: { x: 40, y: 300, width: 310, height: 200 },
      }),
      el({ ref: '@b1', type: 'Button', label: 'Cancel', rect: { x: 50, y: 440, width: 140, height: 44 } }),
      el({ ref: '@b2', type: 'Button', label: 'Delete', rect: { x: 200, y: 440, width: 140, height: 44 } }),
      el({ ref: '@b9', type: 'Button', label: 'Remove all', rect: { x: 0, y: 700, width: 390, height: 44 } }),
    ]);
    const target = targetOf('handle_alert', { action: 'accept' });
    expect(target).toBe('Cancel → Delete'); // the button outside the alert box is not part of it
    expect(effectiveRisk({ tool: 'handle_alert', risk: 'mutate', target })).toBe('destructive');
    expect(targetOf('handle_alert', { action: 'dismiss' })).toBeUndefined();
  });

  it('a benign alert stays benign', async () => {
    await bind([
      el({
        ref: '@a1',
        type: 'Alert',
        label: 'Allow notifications?',
        rect: { x: 40, y: 300, width: 310, height: 200 },
      }),
      el({
        ref: '@b1',
        type: 'Button',
        label: "Don't Allow",
        rect: { x: 50, y: 440, width: 140, height: 44 },
      }),
      el({ ref: '@b2', type: 'Button', label: 'Allow', rect: { x: 200, y: 440, width: 140, height: 44 } }),
    ]);
    const target = targetOf('handle_alert', { action: 'accept' });
    expect(effectiveRisk({ tool: 'handle_alert', risk: 'mutate', target })).toBe('mutate');
  });

  it('with nothing observed yet, refs and coordinates resolve to nothing (no throw)', () => {
    setDefaultDeviceContext(new DeviceContext(new FakeBackend({ screens: [screen([])] })));
    expect(targetOf('tap', { ref: '@e7' })).toBeUndefined();
    expect(targetOf('tap', { at: { x: 1, y: 1 } })).toBeUndefined();
    expect(targetOf('handle_alert', { action: 'accept' })).toBe('accept alert');
  });
});

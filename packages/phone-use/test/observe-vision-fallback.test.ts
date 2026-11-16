import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceContext } from '../src/device-context.ts';
import * as driver from '../src/driver.ts';
import { REGISTRY, VISION_MARKER } from '../src/registry.ts';

// Integration coverage for the auto-vision fallback: the observe verb must
// attach a set-of-marks screenshot when the tree is blind, and must NOT when
// the screen is readable. Runs the real registry handler over a FakeBackend.

const observe = REGISTRY.find((d) => d.name === 'observe');

afterEach(() => driver.setDefaultDeviceContext(null));

function ctxWith(nodes: Parameters<typeof screen>[0]) {
  const fake = new FakeBackend({ screens: [screen(nodes)] });
  const ctx = new DeviceContext(fake);
  driver.setDefaultDeviceContext(ctx);
  return { fake, ctx };
}

describe('observe → auto-vision fallback', () => {
  it('attaches a marks screenshot when an opaque container has no readable content inside it', async () => {
    const { ctx } = ctxWith([
      // A full-screen WebView with nothing readable inside — the canvas case.
      el({
        ref: 'w1',
        type: 'WebView',
        role: 'WebView',
        label: '',
        rect: { x: 0, y: 100, width: 402, height: 700 },
      }),
      el({ ref: 'b1', role: 'Button', label: 'New tab', rect: { x: 300, y: 20, width: 60, height: 40 } }),
      el({
        ref: 'b2',
        role: 'Button',
        label: 'Switch or close tabs',
        rect: { x: 340, y: 20, width: 60, height: 40 },
      }),
    ]);
    // Stand in for the real capture: the fake has no pixels, so stub the marks
    // screenshot and assert the handler routes through it.
    let captured = '';
    ctx.screenshotWithRefs = async (path: string) => {
      captured = path;
      return path;
    };
    const out = await observe?.handler({ full: true });
    expect(out).toContain('accessibility tree is blind');
    expect(out).toContain(`${VISION_MARKER}${captured}`);
    expect(captured).toMatch(/phone-use-vision-\d+\.png$/);
  });

  it('stays quiet on a readable screen (no marker, no capture)', async () => {
    const { ctx } = ctxWith([
      el({ ref: 'e1', role: 'Cell', label: 'Wi-Fi', rect: { x: 0, y: 100, width: 402, height: 44 } }),
      el({ ref: 'e2', role: 'Cell', label: 'Bluetooth', rect: { x: 0, y: 150, width: 402, height: 44 } }),
      el({
        ref: 'e3',
        role: 'Switch',
        label: 'Airplane mode',
        rect: { x: 0, y: 200, width: 402, height: 44 },
      }),
    ]);
    let called = false;
    ctx.screenshotWithRefs = async (path: string) => {
      called = true;
      return path;
    };
    const out = await observe?.handler({ full: true });
    expect(out).not.toContain(VISION_MARKER);
    expect(called).toBe(false);
  });

  it('stays quiet when a WebView has readable content inside it (a rendered DOM page)', async () => {
    const { ctx } = ctxWith([
      el({
        ref: 'w1',
        type: 'WebView',
        role: 'WebView',
        label: 'Kyoto',
        rect: { x: 0, y: 100, width: 402, height: 700 },
      }),
      el({
        ref: 't1',
        type: 'StaticText',
        role: 'StaticText',
        label: 'Kyoto is a city in the Kansai region of Japan.',
        rect: { x: 20, y: 200, width: 360, height: 40 },
      }),
      el({
        ref: 'l1',
        role: 'Link',
        label: 'Read more about Kyoto',
        rect: { x: 20, y: 260, width: 200, height: 30 },
      }),
    ]);
    let called = false;
    ctx.screenshotWithRefs = async (path: string) => {
      called = true;
      return path;
    };
    const out = await observe?.handler({ full: true });
    expect(out).not.toContain(VISION_MARKER);
    expect(called).toBe(false);
  });
});

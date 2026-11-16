import { describe, expect, it } from 'vitest';
import { DeviceCore } from '../src/observe.ts';
import { el, FakeBackend, screen } from '../src/testing.ts';

// Renderer honesty (iOSWorld failure diagnosis): the compressed observation
// must not present a partially visible element as normally tappable, nor a
// cut-down value as the field's full content — and press() must tap the
// visible region of an edge-straddling element instead of refusing.

const offScreenPressError = () => new Error('element is off-screen and not safe to press');

describe('renderer honesty markers', () => {
  it('marks partially visible elements whose center is horizontally off-screen', async () => {
    const fake = new FakeBackend({
      screens: [
        screen([
          el({ ref: 'e1', label: 'On Screen' }),
          // Straddles the right edge: center x = 430 > vw 390, but 60pt visible.
          el({ ref: 'e2', label: 'Straddle Right', rect: { x: 330, y: 300, width: 200, height: 44 } }),
          // Straddles the left edge: center x = -60 < 0.
          el({ ref: 'e3', label: 'Straddle Left', rect: { x: -160, y: 360, width: 200, height: 44 } }),
        ]),
      ],
    });
    const core = new DeviceCore(fake);
    const lines = (await core.observe()).elements.split('\n');
    expect(lines.find((l) => l.includes('Straddle Right'))).toContain('(center off-screen)');
    expect(lines.find((l) => l.includes('Straddle Left'))).toContain('(center off-screen)');
    expect(lines.find((l) => l.includes('On Screen'))).not.toContain('(center off-screen)');
  });

  it('appends [truncated] when a long value or label is cut by the renderer', async () => {
    const longValue = 'lorem '.repeat(100); // 600 chars
    const fake = new FakeBackend({
      screens: [
        screen([
          el({ ref: 'e1', type: 'TextView', label: 'Body', value: longValue }),
          el({ ref: 'e2', label: 'Short', value: 'ok', rect: { x: 0, y: 200, width: 390, height: 44 } }),
        ]),
      ],
    });
    const core = new DeviceCore(fake);
    const lines = (await core.observe()).elements.split('\n');
    const body = lines.find((l) => l.includes('Body'))!;
    expect(body).toContain('[truncated]');
    expect(body.length).toBeLessThan(300); // actually cut, not just marked
    expect(lines.find((l) => l.includes('Short'))).not.toContain('[truncated]');
  });
});

describe('press off-screen fallback', () => {
  it('falls back to the visible-region midpoint when the runner refuses a straddling element', async () => {
    const fake = new FakeBackend({
      screens: [
        screen([el({ ref: 'e2', label: 'Straddle', rect: { x: 330, y: 300, width: 200, height: 44 } })]),
      ],
      // The runner refuses ref-presses whose center is off-screen; raw
      // coordinate presses are fine.
      failWith: (call) =>
        call.method === 'press' && (call.args[0] as { ref?: string }).ref !== undefined
          ? offScreenPressError()
          : undefined,
    });
    const core = new DeviceCore(fake);
    await core.observe();
    const ev = await core.press('@e2');
    const coord = fake.calls.find(
      (c) => c.method === 'press' && (c.args[0] as { x?: number }).x !== undefined,
    );
    expect(coord).toBeTruthy();
    // Midpoint of the visible region: x 330..390 → 360, y 300..344 → 322.
    expect(coord!.args[0]).toEqual({ x: 360, y: 322 });
    expect(ev.changed).toBe(false); // same screen either way — evidence still reported
  });

  it('still refuses a fully off-screen element', async () => {
    const fake = new FakeBackend({
      screens: [screen([el({ ref: 'e9', label: 'Gone', rect: { x: 400, y: 300, width: 100, height: 44 } })])],
      failWith: (call) =>
        call.method === 'press' && (call.args[0] as { ref?: string }).ref !== undefined
          ? offScreenPressError()
          : undefined,
    });
    const core = new DeviceCore(fake);
    await core.observe();
    await expect(core.press('@e9')).rejects.toThrow(/off-screen/);
    // No coordinate fallback was attempted.
    expect(
      fake.calls.some((c) => c.method === 'press' && (c.args[0] as { x?: number }).x !== undefined),
    ).toBe(false);
  });
});

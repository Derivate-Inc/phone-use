import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceContext } from '../src/device-context.ts';
import { setDefaultDeviceContext } from '../src/driver.ts';
import { REGISTRY } from '../src/registry.ts';

// Harness fixes from the iOSWorld failure diagnosis: bare `type` with nothing
// focused must self-recover (or fail structurally) instead of throwing the
// session-restarting XCTest error the model retries forever, and `batch` must
// reject malformed action objects with a corrective message instead of
// crashing mid-run on `step.ok`.

const typeTool = REGISTRY.find((d) => d.name === 'type')!;
const batchTool = REGISTRY.find((d) => d.name === 'batch')!;

const typeFailure = () => new Error('Element recorded a failure while executing type: no focused element');

afterEach(() => setDefaultDeviceContext(null));

describe('type auto-focus fallback', () => {
  const titleField = () =>
    el({ ref: 'f1', type: 'TextField', label: 'Title', rect: { x: 0, y: 200, width: 390, height: 40 } });

  it('taps the best visible field and retries ONCE when nothing is focused', async () => {
    let failures = 1; // first typeText throws (no focus), the retry lands
    const fake = new FakeBackend({
      screens: [screen([titleField()])],
      failWith: (call) => (call.method === 'typeText' && failures-- > 0 ? typeFailure() : undefined),
    });
    setDefaultDeviceContext(new DeviceContext(fake));

    const out = await typeTool.handler({ text: 'hello' });
    expect(out).toContain('Typed "hello"');
    expect(out).toContain('auto-focused "Title"');
    expect(fake.calls.filter((c) => c.method === 'typeText').length).toBe(2);
    // The focus recipe is a coordinate tap at the field's center.
    const coord = fake.calls.find((c) => c.method === 'press' && (c.args[0] as { x?: number }).x === 195);
    expect(coord).toBeTruthy();
  });

  it('returns a structured failure (not a throw) when no editable field exists', async () => {
    const fake = new FakeBackend({
      screens: [screen([el({ ref: 'e1', label: 'General' })])],
      failWith: (call) => (call.method === 'typeText' ? typeFailure() : undefined),
    });
    setDefaultDeviceContext(new DeviceContext(fake));

    const out = await typeTool.handler({ text: 'hello' });
    expect(out).toContain('type failed: no focused input');
    expect(fake.calls.filter((c) => c.method === 'typeText').length).toBe(1);
  });

  it('gives up with the structured failure when the single retry also fails', async () => {
    const fake = new FakeBackend({
      screens: [screen([titleField()])],
      failWith: (call) => (call.method === 'typeText' ? typeFailure() : undefined),
    });
    setDefaultDeviceContext(new DeviceContext(fake));

    const out = await typeTool.handler({ text: 'hello' });
    expect(out).toContain('type failed: no focused input');
    // Exactly one retry — never an XCTest retry loop.
    expect(fake.calls.filter((c) => c.method === 'typeText').length).toBe(2);
  });
});

describe('batch action validation', () => {
  it('rejects a malformed action with a corrective message naming the index', async () => {
    const out = await batchTool.handler({
      actions: [
        { do: 'tap', label: 'OK' },
        { do: 'type', text: 'x' }, // not a batch shape
      ],
    });
    expect(out).toContain('batch action 2 is invalid');
    expect(out).toContain("{do:'tap', label}");
    expect(out).toContain('Nothing was run');
  });

  it('names the missing key for a right-do wrong-shape action', async () => {
    const out = await batchTool.handler({ actions: [{ do: 'fill' }] });
    expect(out).toContain('batch action 1 is invalid');
    expect(out).toContain('fill needs a string value');

    const scroll = await batchTool.handler({ actions: [{ do: 'scroll', direction: 'sideways' }] });
    expect(scroll).toContain('scroll needs direction');
  });

  it('rejects a missing or empty actions array', async () => {
    expect(await batchTool.handler({})).toContain('batch needs a non-empty actions array');
    expect(await batchTool.handler({ actions: [] })).toContain('batch needs a non-empty actions array');
  });

  it('still runs a well-formed batch against the live screen', async () => {
    const fake = new FakeBackend({ screens: [screen([el({ ref: 'e1', label: 'General' })])] });
    setDefaultDeviceContext(new DeviceContext(fake));
    const out = await batchTool.handler({
      actions: [
        { do: 'tap', label: 'General' },
        { do: 'verify', contains: 'General' },
      ],
    });
    expect(out).toContain('1. tap: ✓');
    expect(out).toContain('2. verify: ✓');
    expect(out).toContain('All actions completed.');
  });
});

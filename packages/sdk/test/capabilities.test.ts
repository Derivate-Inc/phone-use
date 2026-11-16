import { describe, expect, it } from 'vitest';
import type { Capability, Snapshot } from '../src/index.ts';
import { BaseDeviceBackend, UnsupportedCapabilityError } from '../src/index.ts';
import { FakeBackend, screen } from '../src/testing.ts';

class SnapshotOnlyBackend extends BaseDeviceBackend {
  constructor() {
    super('snapshot-only', ['snapshot']);
  }
  override snapshot(): Promise<Snapshot> {
    return Promise.resolve({ nodes: [] });
  }
}

describe('capability gating', () => {
  it('undeclared methods reject with typed UnsupportedCapabilityError', async () => {
    const b = new SnapshotOnlyBackend();
    await expect(b.screenshot({ path: '/tmp/x.png' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      retryable: false,
      backend: 'snapshot-only',
      capability: 'screenshot',
    });
    await expect(b.screenshot({ path: '/tmp/x.png' })).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(b.snapshot()).resolves.toEqual({ nodes: [] });
  });

  it('requireCapability throws for missing, passes for declared', () => {
    const b = new SnapshotOnlyBackend();
    expect(() => b.requireCapability('snapshot')).not.toThrow();
    expect(() => b.requireCapability('fill')).toThrowError(UnsupportedCapabilityError);
  });

  it('capabilities is queryable and backendName matches', () => {
    const b = new SnapshotOnlyBackend();
    expect(b.backendName).toBe('snapshot-only');
    expect(b.capabilities.has('snapshot')).toBe(true);
    expect(b.capabilities.has('press')).toBe(false);
  });

  it('FakeBackend records calls and honors restricted capability sets', async () => {
    const restricted: Capability[] = ['snapshot', 'press'];
    const fake = new FakeBackend({ screens: [screen([])], capabilities: restricted });
    await fake.snapshot();
    await fake.press({ ref: '@e1' });
    expect(fake.calls.map((c) => c.method)).toEqual(['snapshot', 'press']);
    expect(fake.capabilities.has('fill')).toBe(false);
  });
});

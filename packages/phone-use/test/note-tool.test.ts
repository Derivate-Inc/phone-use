import { describe, expect, it } from 'vitest';
import { REGISTRY } from '../src/registry.ts';

// The task scratchpad: a keyed KV store carried in-process so
// the model can move data across apps without trusting its own recall. Risk
// 'read' — it never touches the device, so no confirmation ceremony.

const note = REGISTRY.find((d) => d.name === 'note');

describe('note tool', () => {
  it('exists in the registry as a read-risk tool', () => {
    expect(note).toBeDefined();
    expect(note?.risk).toBe('read');
  });

  it('save → read → list round-trip; read returns content inline', async () => {
    expect(await note?.handler({ op: 'save', key: 'wifi', content: 'Network: Cortex-5G' })).toContain(
      'Saved note "wifi"',
    );
    expect(await note?.handler({ op: 'read', key: 'wifi' })).toBe('Note "wifi": Network: Cortex-5G');
    expect(await note?.handler({ op: 'list' })).toContain('wifi');
  });

  it('save overwrites; missing read names the saved keys', async () => {
    await note?.handler({ op: 'save', key: 'wifi', content: 'changed' });
    expect(await note?.handler({ op: 'read', key: 'wifi' })).toContain('changed');
    const miss = await note?.handler({ op: 'read', key: 'nope' });
    expect(miss).toContain('No note named "nope"');
    expect(miss).toContain('wifi');
  });

  it('validates arguments instead of throwing', async () => {
    expect(await note?.handler({ op: 'read' })).toContain('needs key');
    expect(await note?.handler({ op: 'save', key: 'x' })).toContain('needs content');
  });
});

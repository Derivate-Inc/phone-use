import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SYSTEM } from '../src/agent.ts';
import { toolContent } from '../src/tool-content.ts';

it('embeds screenshot bytes and blind-tree fallbacks while leaving ordinary paths alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-content-'));
  try {
    const path = join(dir, 'screen.png');
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(path, bytes);
    expect(await toolContent(path)).toEqual([{ type: 'text', text: path }]);
    expect((await toolContent(path, true))[1]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: bytes.toString('base64'),
    });
    expect(await toolContent(`blind tree\n[vision] ${path}`)).toEqual([
      { type: 'text', text: 'blind tree' },
      { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') },
    ]);
    expect(JSON.stringify(await toolContent(`${path}.missing`, true))).toContain('Image unavailable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('the built-in prompt references current verification and open tools', () => {
  expect(SYSTEM).not.toMatch(/verify_state|open_app|open_url/);
  expect(SYSTEM).toContain('observe({expect:');
  expect(SYSTEM).not.toContain('costs you nothing');
});

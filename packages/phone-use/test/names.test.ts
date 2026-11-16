import { describe, expect, it } from 'vitest';
import { assertSafeName } from '../src/names.ts';

describe('assertSafeName (skill/map filenames under ~/.phone-use)', () => {
  it('accepts bundle ids and ordinary skill names', () => {
    for (const ok of ['com.apple.Preferences', 'read-ios-version', 'my_skill.v2', 'A1']) {
      expect(assertSafeName(ok, 'skill')).toBe(ok);
    }
  });
  it('rejects traversal, separators, empties and junk', () => {
    for (const bad of [
      '../config',
      '..',
      'a/b',
      'a\\b',
      '',
      ' ',
      '.hidden',
      'a..b',
      'x'.repeat(81),
      42,
      null,
    ]) {
      expect(() => assertSafeName(bad, 'map')).toThrow(/invalid map name/);
    }
  });
});

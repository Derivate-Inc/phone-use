import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// index.ts runs the CLI at module top level, so read the source instead of
// importing it. tools/sync-versions.ts rewrites this line on `bun run version`.
it('VERSION constant matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  const source = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8');
  const match = source.match(/^export const VERSION = '([^']*)';$/m);
  expect(match?.[1]).toBe(pkg.version);
});

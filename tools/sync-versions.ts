// Keeps runtime VERSION constants honest: after `changeset version` bumps the
// package.json files, rewrite each `VERSION = '...'` line to match. Wired into
// the root "version" script so they can never drift (packages/sdk/test/
// version.test.ts and packages/phone-use/test/version.test.ts assert it).
//
//   bun tools/sync-versions.ts

import { readFileSync, writeFileSync } from 'node:fs';

const TARGETS = [
  {
    pkg: 'packages/sdk/package.json',
    file: 'packages/sdk/src/index.ts',
    re: /^export const VERSION = '[^']*';$/m,
    line: (v: string) => `export const VERSION = '${v}';`,
  },
  {
    pkg: 'packages/phone-use/package.json',
    file: 'packages/phone-use/src/version.ts',
    re: /^export const VERSION = '[^']*';$/m,
    line: (v: string) => `export const VERSION = '${v}';`,
  },
];

let failed = false;
for (const { pkg, file, re, line } of TARGETS) {
  const { version } = JSON.parse(readFileSync(pkg, 'utf8')) as { version: string };
  const source = readFileSync(file, 'utf8');
  if (!re.test(source)) {
    console.error(`✗ ${file}: could not find the VERSION line`);
    failed = true;
    continue;
  }
  const next = source.replace(re, line(version));
  if (next === source) {
    console.log(`${file}: VERSION already ${version} — nothing to do`);
  } else {
    writeFileSync(file, next);
    console.log(`${file}: VERSION → ${version}`);
  }
}
if (failed) process.exit(1);

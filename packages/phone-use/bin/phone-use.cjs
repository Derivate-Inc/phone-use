#!/usr/bin/env node
// Node-runnable launcher: the CLI itself runs on Bun (Bun.serve, Bun.spawn).
// This shim makes `npm install -g phone-use` work everywhere — it execs bun
// when present and explains the one prerequisite when it isn't.
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const entry = join(__dirname, '..', 'src', 'index.ts');
const result = spawnSync('bun', [entry, ...process.argv.slice(2)], { stdio: 'inherit' });

if (result.error && result.error.code === 'ENOENT') {
  console.error(
    [
      'phone-use runs on Bun, which is not installed (or not on PATH).',
      '',
      'Install it in one line:',
      '  curl -fsSL https://bun.sh/install | bash',
      '',
      'then re-run your command. https://bun.sh',
    ].join('\n'),
  );
  process.exit(1);
}
process.exit(result.status ?? 0);

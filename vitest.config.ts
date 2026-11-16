import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run from source; consumers resolve dist via the exports map.
    // Order matters: the /testing subpath must be registered before the bare
    // alias (vitest aliases are prefix-matched in order).
    alias: [
      {
        find: '@phone-use/sdk/testing',
        replacement: fileURLToPath(new URL('./packages/sdk/src/testing.ts', import.meta.url)),
      },
      {
        find: '@phone-use/sdk',
        replacement: fileURLToPath(new URL('./packages/sdk/src/index.ts', import.meta.url)),
      },
      {
        find: '@phone-use/cloud',
        replacement: fileURLToPath(new URL('./apps/api/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: [
      'test/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'eval/test/**/*.test.ts',
    ],
    // *.bun.test.ts files use the bun:test runner (cd apps/api && bun test).
    exclude: ['**/node_modules/**', '**/*.bun.test.ts'],
    maxWorkers: 2, // 3 vCPU / 4 GB box
    testTimeout: 20_000,
  },
});

import { defineConfig } from 'tsdown';

export default defineConfig({
  // sdk.ts is the library entry (exports map); index.ts is the CLI (bin).
  entry: ['src/sdk.ts', 'src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
});

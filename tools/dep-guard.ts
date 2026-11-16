// Dependency-tree guard (docs/20 item 1): @phone-use/sdk has ZERO runtime
// dependencies. It drives iOS with its own XCTest runner (packages/sdk/ios-runner)
// and Android over adb, so nothing third-party sits between an agent and the
// device. Fails the build if any runtime dependency appears — most importantly
// `sharp` (native binary), any harness-layer dep (@anthropic-ai/sdk,
// @modelcontextprotocol/sdk, zod), or another automation tool.
//
//   bun tools/dep-guard.ts        exit 0 = clean, 1 = violation

import { readFileSync } from 'node:fs';

const ALLOWLIST = new Set<string>([]);

// 1. Manifest-level: the SDK declares no runtime dependencies.
const sdkPkg = JSON.parse(readFileSync('packages/sdk/package.json', 'utf8')) as {
  dependencies?: Record<string, string>;
};
const declared = Object.keys(sdkPkg.dependencies ?? {}).sort();
if (declared.length !== 0) {
  console.error(`✗ @phone-use/sdk must have no runtime dependencies, got: ${JSON.stringify(declared)}`);
  process.exit(1);
}

// 2. Lockfile-level: BFS the transitive closure from the SDK's declared deps.
// bun.lock is JSON with trailing commas — strip them before parsing.
const lockText = readFileSync('bun.lock', 'utf8').replace(/,(\s*[}\]])/g, '$1');
const lock = JSON.parse(lockText) as {
  packages: Record<string, [string, ...unknown[]]>;
};

// lock.packages maps name -> tuple whose 4th element (index 2 of the metadata
// object position) carries { dependencies: {...} }; shape: [id, registry, meta, sha]
function depsOf(name: string): string[] {
  const entry = lock.packages[name];
  if (!entry) return [];
  const meta = entry.find((e) => typeof e === 'object' && e !== null && !Array.isArray(e)) as
    | { dependencies?: Record<string, string> }
    | undefined;
  return Object.keys(meta?.dependencies ?? {});
}

const queue = [...declared];
const seen = new Set<string>();
const violations: string[] = [];
while (queue.length) {
  const name = queue.shift();
  if (name === undefined || seen.has(name)) continue;
  seen.add(name);
  if (!ALLOWLIST.has(name)) {
    violations.push(name);
    continue;
  }
  queue.push(...depsOf(name));
}

if (violations.length) {
  console.error(`✗ @phone-use/sdk transitive closure escaped the allowlist: ${violations.join(', ')}`);
  console.error(`  allowlist: ${[...ALLOWLIST].join(', ')} — grow it consciously or cut the dep.`);
  process.exit(1);
}

console.log(`✓ @phone-use/sdk has no runtime dependencies${seen.size ? `: ${[...seen].join(', ')}` : ''}`);

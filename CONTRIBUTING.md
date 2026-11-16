# Contributing

Thanks for helping build phone-use.

## Setup

Requires [Bun](https://bun.sh) >= 1.3. Device execution requires macOS with
Xcode and an iOS Simulator runtime (`phone-use doctor` checks all of it).

```bash
bun install
bun run typecheck   # tsc across both packages
bun run lint        # biome
bun run test        # vitest — device-free, runs anywhere
bun run build       # tsdown → dist for both packages
```

`bun run smoke` runs the device-touching smoke suite (needs a booted
simulator). `bun run bench` runs the self-verifying benchmark.

## Repo layout

- `packages/sdk` — `@phone-use/sdk`: typed device runtime (Device, backends,
  errors, actions). No Bun APIs; runs under Node too.
- `packages/phone-use` — `phone-use`: the harness (CLI, MCP server, agent
  loop). Bun-only at runtime; the CLI executes from `src/`.
- `apps/landing` — phoneuse.dev and the public docs (Next.js).
- `apps/api` — the cloud control plane and workers. `apps/web` — the console.

## Making changes

1. Branch from `main`; keep changes minimal and focused.
2. Every user-visible change needs a changeset: `bunx changeset` (patch until
   1.0 unless discussed).
3. `bun run lint && bun run typecheck && bun run test` must pass; the same
   gates run in CI.
4. Match the surrounding code's comment density and style. Comments explain
   constraints, not narration.

## Hard rules

- The destructive-action permission floor is non-negotiable: no flag, mode,
  env var, or config key may bypass the deny tier or skip confirmation for
  destructive targets. PRs that weaken it will be declined.
- `@phone-use/sdk` must stay importable under plain Node (no Bun APIs).
- No new runtime dependencies without discussion (`bun run check:deps`).

## Releases

Changesets + trusted publishing — see [RELEASING.md](RELEASING.md).

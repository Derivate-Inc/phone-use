# Security Policy

## Supported versions

Pre-1.0: only the latest published minor of each package (`@phone-use/sdk`, `phone-use`) receives security fixes.

The hosted service (api.phoneuse.dev, app.phoneuse.dev and the cloud phones)
is in scope too; report issues with it the same way.

## Reporting a vulnerability

Report privately — do not open a public issue:

- GitHub private vulnerability reporting on this repository (Security → Report a vulnerability).
- Or email: support@phoneuse.dev

You'll get an acknowledgment within 72 hours. We follow a 90-day coordinated
disclosure window: we'll work with you on a fix and credit you in the release
notes unless you prefer otherwise.

## Scope notes

- **The permission floor is a security boundary.** The destructive-target
  confirmation tier (`src/permissions.ts`) is designed to be un-overridable by
  any mode, flag, env var, or configuration. Any bypass of that floor — a way
  to make a destructive-target action execute without a live confirmation — is
  in scope and treated as a vulnerability, not a feature request.
- Prompt-injection paths that cause the harness to *request* a destructive
  action are model behavior, not a boundary break — but anything that lets such
  a request *execute without the gate* is in scope.
- Supply-chain: dependencies are exact-pinned; `tools/dep-guard.ts` enforces the
  SDK's dependency allowlist in CI. Reports of malicious or compromised
  dependencies in the tree are in scope.

## Supply-chain posture

- **Exact pins in what we publish.** The two published packages
  (`@phone-use/sdk`, `phone-use`) pin every dependency to an exact version.
  The apps in `apps/` use ranges, resolved by the committed lockfile.
- **Frozen installs in CI.** All CI and release jobs install with
  `bun install --frozen-lockfile`; a lockfile drift fails the build instead of
  silently resolving something new.
- **No lifecycle scripts.** Honestly, in two parts: Bun already blocks
  untrusted dependency lifecycle scripts by default (only packages on its
  allowlist/`trustedDependencies` may run them), and the root `.npmrc` sets
  `ignore-scripts=true` so npm/npx-based paths (e.g. `npm pack`, editor
  tooling) get the same protection.
- **No long-lived publish token.** Releases use npm OIDC trusted publishing
  from `.github/workflows/release.yml` — there is no `NPM_TOKEN` secret to
  steal, and the workflow is written to never accept one.
- **Provenance.** Publishing via OIDC from a public repo attaches npm
  provenance automatically, linking each published tarball to the exact
  commit and workflow run that built it.

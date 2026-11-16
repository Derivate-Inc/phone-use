# Releasing

The release flow is Changesets + npm OIDC trusted publishing
(`.github/workflows/release.yml`): merge to main with pending changesets →
the action opens a "Version Packages" PR → merging that PR publishes both
packages. `bun run version` also syncs the `VERSION` constant in
`packages/sdk/src/index.ts` (see `tools/sync-versions.ts`).

There is deliberately **no NPM_TOKEN secret** — publishing works only via
trusted publishing, or not at all.

## One-time founder actions (in order)

1. **npm scope.** Confirm/register the `@phone-use` org on npmjs.com. If the
   name is taken, pick the fallback consciously (and update both package
   names, the dep in `packages/phone-use/package.json`, `tools/dep-guard.ts`,
   and the READMEs) — do not let CI decide by failing.
2. **Repo public.** Trusted publishing and provenance require the GitHub repo
   to be public (provenance links the package to a public commit/workflow).
3. **First publish, manually.** npm's trusted-publisher config can only be
   attached to an *existing* package, so the very first publish of each
   package is manual: create a granular automation token scoped to the two
   packages, `npm publish` from a clean checkout (`bun install && bun run
   build && bun run check:publish` first), then **revoke the token
   immediately**.
4. **Register the trusted publisher for BOTH packages** on npmjs.com
   (`@phone-use/sdk` and `phone-use` → Settings → Trusted publisher):
   - Provider: GitHub Actions
   - Organization/user: `rajmeet`
   - Repository: `phone-use`
   - Workflow filename: `release.yml`
   - Environment: (leave empty)
5. **Repo setting.** Enable "Allow GitHub Actions to create and approve pull
   requests" (Settings → Actions → General) so `changesets/action` can open
   the Version Packages PR.

## Per-release checklist

1. Every user-visible change lands with a changeset (`bunx changeset`).
2. Merge the "Version Packages" PR when ready to ship. That run publishes,
   with provenance, via OIDC.
3. Sanity-check: `npm view @phone-use/sdk version` and the provenance badge
   on the npm page.

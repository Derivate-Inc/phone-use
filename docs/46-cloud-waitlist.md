# Cloud waitlist: what shipped and how to run it

Status: **built 2026-11-13. Not deployed yet.**

In one line: phone-use stays free on the user's own machine, and cloud phones go behind a
waitlist that people meet when they run `create`.

This supersedes the "anyone who signs up can create a phone" statements in
35-cloud-product-state.md once it is deployed. No cloud code
was removed; an approved account works exactly as before.

## What changes for a user

| Who | `phone-use create ios` |
| --- | --- |
| Logged out | Prints the waitlist message, exits 1. Counted as an `anonymous` attempt. |
| New account (signed up after this ships) | Same message, exits 1. Counted against the account. No phone starts. |
| Account that existed when this shipped | Works as before. |
| Account an operator approved | Works as before. |

The message is written for a coding agent, because an agent usually runs the command. It
says three things: cloud phones are on a waitlist and nothing was created; the exact
command that continues on this machine; and the waitlist link to tell the user. The same
text comes back from the MCP tool `create_cloud_phone` (as a structured error) and from the
SDK (`CloudWaitlistError`). The wording lives in one place:
`packages/sdk/src/cloud-waitlist.ts`.

Local commands are untouched and send nothing to our servers.
The fallback command explicitly selects a local backend, even if cloud exports or
a saved real-device choice are present. MCP clients are told to run it in a shell
or restart with a local device: a running MCP server does not reread shell settings.

## How it works on the server (`apps/api`)

- `tenants.cloud_approved_at`: NULL means on the waitlist. The column is added by
  `CloudStore.ensureCloudApproval()` in one transaction with a one-time backfill that
  approves every tenant that exists at that moment, including allocating approved
  tenants for existing auth users who have not visited the console yet. It is in code, not in a migration
  file, because migration files re-run on every start and the backfill must not.
- A console signup creates a waitlisted tenant. A tenant an operator mints
  (`POST /v1/tenants`) is approved unless `cloudApproved: false` is sent. Admin tenants and
  the admin token are never on the waitlist.
- `POST /v1/sandboxes` from an account that is not approved answers **HTTP 403** with
  `{ "code": "cloud_waitlist", "waitlistUrl": "…", "error": "…" }` and creates nothing.
  The answer is the same whatever the fleet's capacity.
- Every refusal is one row in `waitlist_attempts`: time, account id or `anonymous`,
  platform, client kind (`cli`, `mcp`, `sdk`, `web`, `unknown`). **No IP address.** The
  client kind comes from the `x-phone-use-client` header; a console session counts as `web`.
- `POST /v1/waitlist/attempts` (no key) records a logged-out attempt. `POST /v1/waitlist`
  (no key) saves the waitlist form: email and "What would you use cloud phones for?".
  Both are rate-limited per caller (20 and 5 a minute) with an hourly ceiling overall. The
  limiter's key is a digest of the caller's address under a secret that exists only in the
  running process, so no address is kept, in memory or on disk.
  The limiter bounds its caller map and reclaims expired entries. Public requests must
  be JSON objects of at most 16 KiB; malformed requests do not add demand records.
- `GET /v1/me` returns `cloudApproved`; the console shows a waitlist note when it is false.

Note on IP addresses: the waitlist tables and the access log hold none. Better Auth's own
`session` table has an `ipAddress` column for console sign-ins. That is existing behaviour
and was not changed here.

## Settings (control plane environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PHONE_USE_CLOUD_WAITLIST` | on | `0`, `off` or `false` turns the gate off: every account can create. For a self-hosted control plane, or a public demo. |
| `PHONE_USE_WAITLIST_URL` | `https://phoneuse.dev/waitlist` | The link in the refusal. |

Nothing needs setting for the hosted product: deploy, and on first start the existing
accounts are approved and new ones are waitlisted.

## Operator commands

`scripts/cloud-waitlist.ts` talks to the admin routes. It needs the control plane's admin
token in `PHONE_USE_CLOUD_API_TOKEN`, and `PHONE_USE_CLOUD_URL` for anything other than
production.

```bash
bun scripts/cloud-waitlist.ts count                    # the demand count
bun scripts/cloud-waitlist.ts list                     # accounts waiting, and the form entries
bun scripts/cloud-waitlist.ts approve dev@example.com  # or a tenant id: ten_…
bun scripts/cloud-waitlist.ts unapprove dev@example.com
bun scripts/cloud-waitlist.ts count --json
```

Approving an email that has no account yet is recorded: the account starts approved when
that person signs up. The count splits refused creates into logged out and signed in, by
platform and by client, and shows the last 24 hours and 7 days.

The routes behind it: `GET /v1/admin/waitlist` and `POST /v1/admin/cloud-approval`
(`{ tenantId | email, approved? }`).

## The waitlist page

`apps/landing/app/waitlist` serves `/waitlist`. It posts to `/v1/waitlist` on its own
origin; `next.config.ts` already forwards `/v1/*` to the control plane.

## What was checked, and what was not

Checked on 2026-11-13 on a local stack on one Mac (control plane, landing site
and an iOS worker, all local):

- Logged out, `create ios` prints the message and exits 1; the local simulator answers
  `observe` and `open Settings`.
- A brand-new account gets the waitlist answer from the console session and from the CLI
  with its own key; the `sandboxes` table stays empty.
- After `approve`, the same key creates a phone on the local worker, and `observe`,
  `open Settings` and `close` work on it.
- Each refused attempt raised the count by exactly one; the waitlist tables have no
  address column and a dump of the database contained no address.
- The waitlist page, in headless Chromium: a malformed email shows an error; a real entry
  shows the confirmation and appears in `list`.

Not checked: anything on the live servers. Nothing was deployed, so the production
control plane, the production database's one-time backfill and the live Mac worker have
not run this code.

Found while checking: `open -a Simulator && phone-use observe` fails on a cold start,
because `open` returns before the simulator has booted; `observe` works a few seconds
later. The message says so under the command.

## Known follow-ups

- The landing home page still headlines "Cloud phones for AI agents" and its "Get started"
  button goes to console sign-up. A new signup now lands on a console that shows the
  waitlist note. Changing the home page is a messaging decision and was left alone.
- `scripts/stranger-test.ts` signs up a new account and expects a phone. Against a server
  with the waitlist on, it stops at create unless the throwaway account is approved first.

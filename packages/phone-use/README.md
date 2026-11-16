# phone-use

The phone-use **harness**: an agent that operates an iPhone end to end — MCP
server, CLI, and an embeddable agent loop — built on
[`@phone-use/sdk`](https://www.npmjs.com/package/@phone-use/sdk). It adds what
raw device control doesn't have: an un-overridable destructive-action
permission floor, the App Cartographer (autonomous app mapping + deterministic
`goto`/`ask`/`toggle` navigation with zero model calls), replayable skills,
a live browser viewer, and portable trace artifacts.

**Requires Bun** (>= 1.3). The CLI and MCP server run from TypeScript source
via Bun — this package is not a Node CLI. (The `.` export, `createSession`, is
buildable for Node, but the supported path is Bun.) iOS execution requires macOS
with Xcode and an iOS Simulator runtime; Android runs over adb on macOS, Linux, or
Windows (`phone-use connect android`).

## Teach your agent the CLI

One command makes Claude Code, Cursor, or any skills-compatible agent fluent
with phone-use — the local simulator, the verbs, and honest verification:

```bash
npx skills add Derivate-Inc/phone-use-skills
```

## MCP server

```bash
claude mcp add --scope project phone-use -- bunx phone-use mcp
```

or from a checkout:

```bash
claude mcp add --scope project phone-use -- bun /path/to/phone-use/packages/phone-use/src/index.ts mcp
```

The server also hosts the live viewer at `localhost:4936` — watch the agent
drive the phone in real time.

## Device selection

By default the harness attaches to whatever simulator is booted. Make it
explicit with `--device` (or `PHONE_USE_DEVICE`):

```bash
phone-use mcp --device launch        # dedicated simulator, deleted on exit
phone-use mcp --device connect       # first booted simulator
phone-use mcp --device <udid>        # a specific simulator
```

### Several phones in one session

One agent can drive several phones through one server: send a message on
one and read it on the other, or run the same flow on an iPhone and an
Android phone. Name the phones with `--devices` (or `PHONE_USE_DEVICES`):

```bash
phone-use mcp --devices a=<udid>,b=<udid>                 # two booted simulators
phone-use mcp --devices ios=launch,pixel=android:emulator-5554
phone-use mcp --devices a=cloud:<sandbox-id>,b=cloud:<sandbox-id>
```

A device is a simulator UDID, `launch` (a new simulator, deleted on exit),
`connect`, `android` or `android:<serial>`, or `cloud:<sandbox-id>` (a
running cloud phone on your account). Every tool except `note` then takes
an optional `phone` argument, the first phone is the default, and each
result starts with `[phone <name>]`. Calls to different phones can run at
the same time. Each phone keeps its own screen state, app list and
confirmation tokens; the `note` scratchpad is shared, so a value read on one
phone can be typed on another. The live viewer shows the first phone.

Booted simulators start in about a second. `launch` boots a simulator per
phone when the server starts (about a minute for two), which can exceed an
MCP client's startup timeout, so prefer UDIDs of simulators you boot first.
`bun run smoke:multi-phone` checks the whole path on two simulators.

## Embedded agent sessions

```ts
import { createSession } from 'phone-use';
import { ios } from '@phone-use/sdk';

const device = await ios.launch();
const session = createSession({
  device, // caller-owned: the session never closes it
  onConfirm: (req) => {
    console.log(`confirm? ${req.summary}`);
    return false; // deny-by-default: omit onConfirm and every ask is refused
  },
});
const result = await session.prompt('open Settings and read the iOS version');
console.log(result.status, result.summary);
await device.close();
```

Needs `ANTHROPIC_API_KEY`. The permission floor holds here too: destructive
targets always require a live confirmation, and no mode, flag, or env var can
disable that tier.

## CLI

```bash
phone-use task "open Settings and go to Accessibility"   # one-off goal (needs API key)
phone-use bench                                          # self-verifying benchmark suite
phone-use atlas                                          # what the phone has learned
```

### Device verbs — drive the phone from any shell

Every registry tool is also a one-shot CLI command (the agent-first-CLI
pattern: point any coding agent at `phone-use --help` and it can operate the
phone with its shell — no MCP wiring, no API key). The Phone Use runtime keeps
the device session warm, so a verb costs ~300ms, not a cold attach:

```bash
phone-use observe                        # frontmost app + visible elements
phone-use open Settings
phone-use goto Settings About            # map-powered navigation, zero model calls
phone-use ask "iOS Version"              # → iOS Version = 26.1
phone-use tap "General"
phone-use toggle Settings "Full-Screen Previews" --on
phone-use search Maps coffee --open
phone-use skill run add-contact --args '{"name":"Alan"}'
```

Target elements by **label** — `@ref`s do not survive across invocations. Exit
codes: `0` ok · `1` failed · `2` blocked · `3` confirmation required. The
permission floor holds: destructive targets (delete/pay/send/2FA) refuse on
first run and require re-running the same command with `--yes`; deny-tier
blocks cannot be overridden by any flag. Output is styled for humans at a TTY
and automatically plain when piped (or under `NO_COLOR`).

## Cloud phones (waitlist)

Everything above runs on your own machine, is free, and needs no account.
Cloud phones run on our hardware and are on a waitlist:
https://phoneuse.dev/waitlist

`phone-use create` from an account that is not approved (or with no key at
all) creates nothing. It prints a short message written for a coding agent —
cloud phones are on a waitlist, the exact command that continues on the local
simulator, and the waitlist link to tell the user — and exits `1`. With
`--json` the same facts are on stdout as `{ "code": "cloud_waitlist", … }`.
The MCP server's `create_cloud_phone` tool returns the same text as a
structured error.

For an approved account, cloud phones work as before:

```bash
phone-use login          # browser sign-in; key saved to ~/.phone-use/config.json
phone-use create ios     # running phone in ~2s (warm pool)
eval "$(phone-use env sbx_…)"
phone-use task "open Settings and report the iOS version"
phone-use install ./build/MyApp.app   # put your own build on it
phone-use close sbx_…
```

Attach any MCP client by setting `PHONE_USE_SANDBOX_URL` / `PHONE_USE_SANDBOX_TOKEN`
in its `phone-use mcp` server env (the console's Connect panel prints the block).
Console: https://app.phoneuse.dev · Docs: https://www.phoneuse.dev/docs/cloud/overview

## Stability

Pre-1.0: minor versions may break APIs. Pin exact versions.

## License

Apache-2.0

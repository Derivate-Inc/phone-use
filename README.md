# Phone Use

**Computer use, for phones.** A runtime that lets AI agents operate an iPhone — fast, verifiable, and reliable — plus a novel capability no phone-use tool has had before: an agent that **autonomously maps an app into a reusable graph** and then navigates it deterministically!

The runtime drives the iOS Simulator and real iPhones on macOS, and Android devices or emulators over adb on any OS. The SDK keeps the device transport behind a private backend boundary, and the transport is ours end to end: an XCTest runner for iOS simulators and a small on-device helper for Android, with zero third-party runtime dependencies ([how and why](docs/42-own-device-layer.md)).

## Packages

| Package | What it is |
| --- | --- |
| [`@phone-use/sdk`](packages/sdk/) | Typed device runtime SDK: `ios.launch()/connect()` → `Device`, observe/act with portable re-resolvable `Action`s, typed error tree, backend registry, `/testing` doubles, `simulator()` controls (logs, recording, permissions, push). Zero runtime dependencies; runs on Node >= 22 or Bun. |
| [`phone-use`](packages/phone-use/) | The harness on top of the SDK: MCP server + CLI + embeddable agent loop, permission floor, App Cartographer maps, skills, live viewer, trace artifacts. Requires Bun. |

## Why this exists

Desktop "computer use" got good. Phones stayed unexplored — partly because you can't "view source" on a native app; you have to physically drive the UI. Phone Use closes that gap with a driver tuned for phones (accessibility + vision + coordinate taps), an interactive cursor you can watch live, and an **App Cartographer** that turns exploration into a durable, shareable map.

## What's inside

### Driver & interaction (`packages/phone-use/src/driver.ts`)
- **Fast capture** — direct `simctl` JPEG (~110ms, 4× faster than the toolkit default)
- **Compressed observation** — filters accessibility noise, adds geometry; a Hacker News page goes from 485 noisy nodes to ~134 clean ones
- **Action ladder** — deep links → verified taps → scroll → type → system-alert handling → **zoom-on-region** for tiny targets
- **Vision fallback** — Set-of-Marks screenshots + raw coordinate taps for canvas/map screens accessibility can't see
- **Change evidence on every tap** — the runner compares the accessibility tree just before and after the tap and reports whether it changed (or that it could not tell), so most no-op taps show up at once. It is evidence of a change, not proof the intended thing happened. A stale or ambiguous ref, or a control something covers, is refused instead of tapped

### Interactive cursor & live viewer (`packages/phone-use/src/annotate.ts`, `packages/phone-use/src/live.ts`)
- A real visible pointer with **move-then-click**, element boxes, and click pulses composited into every frame
- A browser **live viewer** (`localhost:4936`): MJPEG screen video + a 60fps client-side cursor overlay — watch the agent drive in real time

Cloud iOS sessions also expose an authenticated **Open phone** page with native
H.264 video (30fps target), browser decoding, and automatic reconnection. See
[cloud live video](docs/cloud-live-video.md) for worker setup, implementation,
and local verification results.

### App Cartographer — the novel core (`packages/phone-use/src/explore.ts`, `packages/phone-use/src/appmap.ts`)
- **Autonomous crawl** → a graph of screens (nodes) and transitions (edges), keyed by a structural signature stable across dynamic content
- **Directed search** — for a specific destination, a depth-first crawl that stops the moment it's reached (a depth-2 setting is ~3 taps, not a full app map); full breadth-first crawl available for complete maps
- **Deterministic navigation** — `goto("Fonts")` computes the shortest tap-path and executes it with **zero model calls**; cached routes replay in a few seconds
- **Persistent & self-enriching** — maps save to `~/.phone-use/maps/<bundle>.json`, reload across sessions, and grow richer every time they're used; crawled edges carry **semantic docs** (what tapping each element does — `opens "General"`, `reveals …`), so the map is functional knowledge, not just topology
- **Shareable — exploration compounds across agents** — `export_atlas` bundles the learned maps + skills into one portable file; another phone `import_atlas`es it and navigates instantly with **zero crawl** (a fresh phone did `goto About` in 5s from an inherited map vs ~23s to build one). Imported maps *merge*, so knowledge accretes. `inspect_atlas` previews what a bundle would add (new / enriches / redundant per app, new vs existing skills) before you trust it — and flags a map's age (`⚠ may be stale` past 30 days), since maps are stamped with a save time
- **Self-extending** — auto-builds a map when none exists; crawls deeper on demand for unmapped screens
- **Self-healing** — when a saved path breaks (the app updated), it detects the failure, re-maps, diffs what changed, and routes the new way

### Intent-based control — ask & act by name (`packages/phone-use/src/task.ts`, `packages/phone-use/src/apps.ts`)
- **`ask("iOS Version")`** — read any value without knowing which screen (or even which app) it's on: searches every mapped app, resolves the one that has it, navigates, and reads
- **`toggle_setting("Full-Screen Previews", on=true)`** — flip a switch by name, auto-finding its screen; idempotent desired-state
- **`tap("Send")`** — press a control by name (exact or substring): the action verb for buttons like "Done", "Add", "New". Taps in place, scrolling to find it if needed. Complements `toggle_setting` (switches) so skills can do create/compose errands, not just read/navigate
- **`set_field("Ada", field="First name")`** — type into a form field by its label/placeholder (the input verb for forms; `search` is for search bars). With `tap` this completes compose/create errands — *open Contacts → tap Add → set First/Last name → tap Done* is one deterministic skill that actually creates the contact
- **`search("Maps", "coffee")`** — the input primitive: focus an app's search field and type, revealing it whether it's a large-title bar hidden above the list (Settings) or a collapsed bottom card (Maps). Completes the intent vocabulary: navigate (`goto`), read (`ask`), act (`toggle_setting`), input (`search`)
- **Whole-phone** — any app by natural name (`"Settings"` → `com.apple.Preferences`), since `openApp` is the cross-app transition and a registry maps names to bundle ids
- The atlas becomes a **queryable, controllable knowledge base of the phone** that gets faster and richer as it's explored — `atlas_overview` (or `phone-use atlas`) shows what's been learned: every mapped app (screens, transitions, freshness) and every saved skill, so an agent can check what it already knows before exploring

### Phone Skills — replayable cross-app composites (`packages/phone-use/src/skills.ts`)
- A **skill** is a named, ordered chain of the intent primitives with **variable capture**: any step names its result with `as`, later steps interpolate it as `{{name}}`. So a cross-app errand — *read a value in app A, use it in app B* — is one saved artifact
- **Recorded once, replayed forever with zero model calls** — the deterministic composite layer on top of the primitives (the "agent runs your phone errands" payoff)
- **Resilient replay** — each step retries on transient failure (cold-launch timing, mid-animation taps, focus races); safe because an op reports failure only when it didn't act, so a retry never double-acts
- **Checked, not fire-and-hope** — a `verify` step asserts a postcondition ("Delivered" showed, the contact saved), so a skill confirms its own success; with retries it also polls, doubling as wait-for-condition
- **Learn by doing** — `record_skill` → perform the task once → `stop_recording`: every primitive that succeeds is captured as a step, so the phone learns an errand by *watching* it, no hand-authoring
- **Generalize** — `parameterize_skill` promotes a recorded literal to a `{{param}}` slot, so one recording of "open coffee in Maps" replays for any place (`run_skill args={place:"sushi"}`)
- Skills persist to `~/.phone-use/skills/<name>.json`; run saved-by-name or ad-hoc. MCP: `run_skill`, `save_skill`, `list_skills`, `record_skill`, `stop_recording`, `parameterize_skill`
- Verified: a skill that asks Settings for the model name, captures it, then searches Maps for it runs end-to-end — cross-app, with substitution

### Live atlas (`packages/phone-use/src/live.ts`, `packages/phone-use/src/vizbus.ts`)
- The viewer shows the phone streaming on one side and the **app map drawing itself in real time** on the other, as the agent crawls

### Surfaces (`packages/phone-use/src/mcp.ts`, `packages/phone-use/src/agent.ts`)
- **MCP server** — `observe` (delta-rendered), `batch`, `verify`, `press`/`press_at`, `zoom_region`, `apps`, `map_app`, `goto`, `ask`, `toggle_setting`, skills & atlas tools, … usable by Claude Code, Codex, or any MCP client
- **Built-in agent loop** — Claude drives the phone directly (needs an API key); same harness rules as the MCP path (milestones, two-strike, reflection-on-demand)

## Benchmark

**The device layer has a regression eval** ([`eval/`](eval/README.md), results in [docs/45](docs/45-device-layer-eval-results.md)): 30 probes on a test app that records what it actually received, so the tool never grades itself, plus a multi-agent tier. Its headline is the false-success rate (the tool said OK, the app says otherwise). phone-use was tuned against these probes, so its 0% there is a regression bar, not evidence of reliability in general; comparisons with other tools are not yet independent. It measures single device actions, not whether an agent completes real tasks. `bun run bench` below is a smoke test of the high-level verbs.

`bun run bench` runs a suite of phone tasks, each a skill that ends in a `verify` text check on the final screen, from a clean state, timed, across the capability classes. Latest simulator run:

```
Phone Use benchmark — 6/6 passed, avg ~6.3s/task
  ✓ read-ios-version         read          3658ms   goto Settings→About, verify "26.1"
  ✓ deep-nav-accessibility   navigate      2860ms   goto Accessibility, verify "Vision"
  ✓ search-open-maps         search+act    8269ms   search Maps "coffee" → open, verify
  ✓ toggle-setting           toggle        3581ms   set a switch by name (idempotent)
  ✓ phone-wide-ask           ask-anywhere  5832ms   resolve which app holds a fact, read it
  ✓ create-contact           create       13506ms   Add → fill name → Done → verify
```

`bench --json` emits machine-readable results for CI (exit code nonzero on any failure). It is a repeatable smoke test on stock apps the tool was tuned on; its checks are text on the final screen (and the toggle task trusts its own result), so passing it does not show generalization. Building it surfaced (and fixed) real races the piecemeal tests missed.

`bun run smoke` runs the headline-feature regression guards in one command — the recorder over the real MCP wire, the shared-atlas inherit-and-navigate round-trip, and the full skill lifecycle (record → parameterize → replay → forget) — each asserting live on the simulator.

## Quick start

Three kinds of phone, one set of verbs:

```bash
phone-use create ios      # a cloud iPhone, ~2s, disposable
phone-use connect         # the real iPhone on your desk (macOS + iPhone Mirroring)
                          # nothing at all → a local simulator

phone-use observe
phone-use open "Weather"
```

`connect` is the only way to reach real App Store apps and real accounts —
simulators cannot run them. See
[docs/real-iphone.md](packages/phone-use/docs/real-iphone.md) for what that path
can and cannot do.

Drive a device directly with the SDK (macOS + Xcode):

```ts
import { ios } from '@phone-use/sdk';

const device = await ios.launch(); // dedicated simulator, deleted on close()
await device.apps.open('Settings');
await device.tap('General');
await device.close();
```

Or run the full harness from a checkout:

```bash
bun install

# start the MCP server (also serves the live viewer at localhost:4936)
bun run mcp

# one-off natural-language task (needs ANTHROPIC_API_KEY)
bun run task "open Settings and go to Accessibility"

# benchmarks: deterministic layer / full LLM harness (subscription via headless claude)
bun run bench
bun run bench:agent
```

Register with an MCP client (already wired in `.mcp.json` for Claude Code):

```bash
claude mcp add --scope project phone-use -- bun /path/to/phone-use/packages/phone-use/src/index.ts mcp
```

## Docs

Product documentation lives with the site under
[`apps/landing/app/docs/`](apps/landing/app/docs/) and is served at
https://phoneuse.dev/docs. Run `bun run docs:dev` and open
`http://localhost:3000/docs`.

Technical write-ups are in [`docs/`](docs/): start with
[`docs/README.md`](docs/README.md). The novel capability is written up in
[`docs/15-app-cartographer.md`](docs/15-app-cartographer.md).

## Verified end-to-end

Driven by Claude Code through the MCP server alone, in one ~33s session on the simulator:

> *"Tell me this iPhone's iOS version and model name (use `ask`), then turn on Full-Screen Previews (`toggle_setting on=true`)."*

The agent called `ask("iOS Version")` → **26.1** and `ask("Model Name")` → **iPhone 16e** (both auto-resolved to Settings → About without being told the screen), then `toggle_setting("Full-Screen Previews", on=true)` → auto-found the switch and set it **0 → 1**. No screen names, no bundle ids, no step-by-step navigation.

Every layer — driver, cursor, live viewer, map building, deterministic `goto`, self-extension, self-healing, whole-phone `ask`/`toggle`, and the live atlas — is verified on the iOS Simulator.

## Status

Connecting a **physical iPhone** (Developer Mode + code signing) is the remaining step to run all of this against a real device — the code path is identical.

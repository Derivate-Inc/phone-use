# 43 · The device-layer eval: phone-use's regression suite

Written on 2026-11-04 as a proposal, after the founder asked what `phone-use bench` actually
measures. Tiers 1 and 2 are built in [`eval/`](../eval/README.md); Tier 3 is not.

The eval checks one thing about phone-use's device layer: when it says an action worked, did it?
A test app records what it actually received, so phone-use never grades itself.

## What `phone-use bench` measures, honestly

- Six tasks we wrote, for our own high-level verbs (`goto`, `ask`, `toggle`, `search_open`,
  skills), on stock simulator apps.
- Graded by our own `verify` step ("is this text on screen"): the tool under test grades itself.
- On 2026-11-04 I changed two fixtures and cleared Maps' first-run splash by hand until it passed.
  That is tuning on the test set.

So 6/6 means "no regressions on our happy path". It says nothing about where we are wrong. Keep it
as a smoke test.

## Where the cases come from

The cases come from public issue reports filed against device tools and from our own tests of such
tools, not from reading our code. Two themes recur in those reports:

- **Several agents on one machine.** Agents pick up each other's session or device, one session's
  timeout ends its siblings, and one session installs over or shuts down a device another holds.
- **Success reported when nothing (or the wrong thing) happened.** Presses that land a fixed offset
  away, a "dismiss" that taps Allow, a keyboard dismiss that types into the field, a stale ref
  accepted after navigation, a fill that commits a corrupted value, calls that stall and freeze
  everything else.

## What the eval must answer

1. **Truthfulness:** when the tool says an action worked, did it? Headline metric: the
   *false-success rate* (the tool said OK, ground truth says no or says something else happened).
2. **Correctness:** right element, right text, right app, right device.
3. **Isolation:** several agents on one machine, each on its own device or contending for one.
4. **Recovery:** when a call fails, does the error let an agent recover (typed, actionable, fresh
   candidates), or does it hang, crash, or lie?
5. **Cost:** latency per primitive, tokens per observation and per tool definition, setup time.

The output is a per-case matrix with failures and variance, not a score.

## Ground truth comes from outside the tool

The tool's own report is recorded but never trusted.

- **Gauntlet**, an oracle app (extending the approach of Labyrinth, an earlier test app). Every
  scenario screen appends what the app *actually received* to `Documents/events.jsonl`: each touch
  point and the view it hit, each text change, each control activation, alert decisions,
  navigation events, with timestamps. The harness reads it host-side via
  `simctl get_app_container`.
- **OS state** for system UI: the TCC database for permission decisions (ATT, location), the
  pasteboard, the Contacts database for stock-app tasks.
- Each scenario takes a seed. The seed jitters layout: row order, offsets, label variants, timing
  of late inserts.
- Android: the same scenarios in a Compose app, phase 2.

## How grading works

For each probe: reset the scenario, then perform one agent-like step through phone-use's
documented interface (observe, choose the target the way an agent would, act). phone-use's reply is
the *claim*. The oracle decides the *effect*. The two are crossed
(`eval/src/classify.ts` holds the whole rule):

| | effect: intended | wrong / partial | none |
|---|---|---|---|
| claim ok | pass | **false success** | **false success** |
| claim uncertain ("did NOT change") | pass | flagged failure | flagged failure |
| claim error / refused | false failure | unsafe error | pass if refusing is right, else refused wrongly |

A call slower than 30 s is a hang. A run whose precondition did not hold (for example, the keyboard
never appeared) is invalid and not scored. Each probe runs on 5 seeds.

## Tier 1 · Probes (no model; most of the eval)

| ID | Scenario | Oracle checks | Built |
|---|---|---|---|
| A1 | Rows inserted 300 ms after first paint push the target down | which row received the tap | yes |
| A2 | Two controls with the same label (nav bar "Add", toolbar "Add") | which one fired | yes |
| A3 | Ref kept from the previous screen, used after navigating | nothing fires; error says stale | yes |
| A4 | Carousel item half off-screen | the item fired | yes |
| A5 | Target under the keyboard | no key typed; refusal or scroll | yes |
| A6 | Target behind a sheet, a context menu, a dimming overlay | nothing behind fires | yes |
| A7 | iPhone and iPad in landscape | touch point vs requested point | yes (iPhone) |
| A8 | SwiftUI TabView; Liquid Glass views with null frames | correct tab fired | yes |
| A9 | A canvas-drawn button with no accessibility | (expected to fail for tree-only tools) | no |
| A10 | Button that slides in while the tap is sent | fired once, at the right place | no |
| B1 | Button ignoring taps during a 400 ms transition | activation recorded | yes |
| B2 | Replace text in a field that already has text | final value exact | yes |
| B3 | Field that formats input (phone, currency) | final value semantically right | yes |
| B4 | Non-ASCII, emoji, RTL text | final value exact | yes |
| B5 | Secure field | value set, never echoed in output | yes |
| B6 | Multiline text view with Return | newlines where asked | yes |
| B7 | Dismiss the keyboard | keyboard gone, field unchanged | yes |
| B8 | Switch whose only change is its state | state flipped exactly once | yes |
| B9 | Long press opening a context menu that never idles | menu read; no 60 s hang | no |
| B10 | Scroll until a row; list end with no match | found / honest "end reached"; never left the app | yes |
| B11 | Tap at (5000, 5000) | refused | yes |
| C1 | Location permission prompt: read all text and buttons | full text read; chosen button recorded | yes |
| C2 | App Tracking Transparency: "dismiss" must decline | TCC records denial | yes |
| C3 | "Open in …?" confirmation after a URL open | correct choice | no |
| C4 | Photos limited-access sheet, notification prompt | correct choice | no |
| C5 | Home Screen, App Library, Control Center | observed as such, not as the last app | no |
| C6 | SafariViewService / ASWebAuthenticationSession sheet | reachable, dismissable | no |
| C7 | Web content in WKWebView and Safari: read a heading, tap a link | link opened | yes |
| D1 | Observation at 50, 500, 2,000 nodes | latency p50/p95, characters | no |
| D2 | A screen that never idles (spinner, live map) | observation returns in bounded time | yes |
| D3 | Hidden and covered elements | not offered as targets | yes |
| E1 | Runner or daemon killed mid-session | next call: recovers or says why | no |
| E2 | App crashes during an action | reported as a crash, not success | yes |
| E3 | App main thread blocked 5 s | bounded timeout; other calls not frozen | yes |
| E4 | Android tooling wedged (adb hangs) | iOS calls unaffected | no |

The built suite also has A1i (cells with index identifiers) and three regression probes, R1–R3;
[`eval/README.md`](../eval/README.md) lists them with the reason for each fixture change.

## Tier 2 · Several agents at once

Each agent types a unique token in its actions, so any event carrying agent B's token in agent A's
oracle is contamination.

| ID | Setup | Pass means | Built |
|---|---|---|---|
| I1 | 2, 4, 8 agents, each on its own simulator, same machine | zero contamination; throughput per agent vs k | yes |
| I2 | 2 agents, one simulator, no coordination | the second is refused or queued with a clear message; never interleaved | yes |
| I3 | 2 agents in one checkout using implicit defaults | each keeps its own device | yes |
| I4 | One session times out or is killed | siblings unaffected | yes |
| I5 | `install` / `shutdown` from another session on a held device | refused | yes |
| I6 | Runner killed while two sessions are live | both recover or both fail loudly | no |

## Tier 3 · Agents end to end (not built)

A model drives phone-use through MCP (and the CLI) on whole tasks. `phone-use compare` already runs
arms with seeded order, repeated trials and an external grade command, and it is the runner for
this tier.

- Tasks on Gauntlet (graded by its events and state) and on stock apps (graded by OS state).
- Report: success, *agent claimed done but state says no*, steps, tokens (tool definitions
  included), wall time, cost, variance over repeats.
- Needs a model and a budget.

## Rules so we cannot fool ourselves

1. Cases come from outside evidence (see above) and from an adversarial author, not from reading
   our code.
2. **60/40 split.** The 40% held-out set has seeds generated at run time. Whoever changes the
   runner does not see held-out details. A fixture changes only with a written reason, never "so
   the tool passes".
3. Five runs per cell; report variance; A/A runs to measure noise.
4. A clean-checkout re-run of the held-out set by a fresh agent before any number is quoted.
5. The expected-failure list below is committed **before** the first run.

## Where I expect phone-use to lose (committed before running)

- **I2, I3, I5: two agents on one simulator.** Device claims are process-local
  (`packages/phone-use/src/device-claim.ts`); two MCP servers or CLI processes share one runner and
  interleave with no refusal.
- **A7: landscape and iPad.** Synthesized touches pass an interface orientation, untested anywhere.
- **A8: Liquid Glass views with null frames.** We normalize them to zero, so they cannot be tapped.
- **A9: canvas controls.** No accessibility, no target; only vision would work.
- **B3: formatting fields.** `fill` deletes then types; a field that reformats may end wrong.
- **B7: keyboard dismiss on iOS 26.** Our `dismiss` taps "Hide keyboard" or sends Return.
- **C6: SafariViewService sheets.** These are not in the app's tree; untested.
- **D2 on first contact:** an app that never idles costs up to 60 s once before we stop waiting for it.
- **Tier 3 tokens:** our observations carry rects for every node.
- **Android,** all of it: input goes through `adb shell input`; no Gauntlet app yet.
- **Physical iPhones:** no runner launch path yet.

## Run it

You need macOS with Xcode and an iOS simulator runtime. From the repository root:

```bash
eval/gauntlet/build.sh                    # builds the Gauntlet test app
bun eval/src/run.ts --udid <udid>         # Tier 1 on a simulator you own
bun eval/src/isolation.ts                 # Tier 2; creates and reuses its own simulators
bunx vitest run eval                      # unit tests for the scoring rule and parser
```

[`eval/README.md`](../eval/README.md) has the options, where results go, and what is not built
yet.

# 43 · An eval for the device layer: where we are wrong, and how we compare (proposal, 2026-11-04)

Status: proposal. Nothing here has been run.
**Update, 2026-11-04:** Tiers 1 and 2 are built in [`eval/`](../eval/README.md); the first results are in
doc 45. Written after the founder asked what `phone-use bench`
actually measures and pointed at the issues engineers file against agent-device, mobile-mcp and
MobileBuildMCP.

## What `phone-use bench` measures today, honestly

- Six tasks we wrote, for our own high-level verbs (`goto`, `ask`, `toggle`, `search_open`,
  skills), on stock simulator apps.
- Graded by our own `verify` step ("is this text on screen"): the tool under test grades itself.
- It cannot run against any other tool, because it calls our harness verbs.
- On 2026-11-04 I changed two fixtures and cleared Maps' first-run splash by hand until it passed.
  That is tuning on the test set.
- The T0–T9 table in doc 42 mixes numbers from four researchers who
  drove each tool differently. It is indicative, not a controlled comparison.

So 6/6 means "no regressions on our happy path". It says nothing about where we are wrong or how
we compare. Keep it as a smoke test.

## What engineers report against the three tools

All 1,498 issues were read on 2026-11-04 (raw dumps in `/tmp/pu-issues/`, not committed; links below).
agent-device has 1,110 issues in nine months, 807 of them filed by its maintainer as agent tasks;
303 come from outside users. mobile-mcp has 154 external of 171; MobileBuildMCP 181 external of 217.

Two themes recur, and both are the founder's:

**Several agents on one machine.**
- agent-device [#3931](https://github.com/callstack/agent-device/issues/3931): parallel agents pick
  up each other's session after `open` unless every command passes `--session`.
- agent-device [#1659](https://github.com/callstack/agent-device/issues/1659): concurrent CLI
  processes cross-contaminate session, lease and device state; sessions bound to the wrong device.
- agent-device [#3177](https://github.com/callstack/agent-device/issues/3177): one request timeout
  ends sibling sessions (host-wide runner sweep).
- agent-device [#3345](https://github.com/callstack/agent-device/issues/3345): `install` from
  another session replaces the app on a claimed device.
- agent-device [#1799](https://github.com/callstack/agent-device/issues/1799): `shutdown` kills a
  device another live session holds, and reports success.
- mobile-mcp [#534](https://github.com/mobile-next/mobile-mcp/issues/534) (open): every agent picks
  the first device; two agents tap and install on one emulator at once.
- mobile-mcp [#253](https://github.com/mobile-next/mobile-mcp/issues/253): the `device` parameter
  is ignored and commands go to the first device.
- MobileBuildMCP [#340](https://github.com/getsentry/MobileBuildMCP/issues/340): concurrent sessions
  share one DerivedData and corrupt each other's builds.

**Success reported when nothing (or the wrong thing) happened.**
- agent-device [#4091](https://github.com/callstack/agent-device/issues/4091): iPad landscape, every
  press lands a fixed offset away and reports success.
- agent-device [#3627](https://github.com/callstack/agent-device/issues/3627): `alert dismiss` on
  the App Tracking Transparency prompt taps **Allow**, prints `dismissed`, exits 0.
- agent-device [#952](https://github.com/callstack/agent-device/issues/952): `keyboard dismiss`
  types " TV" into the focused field.
- agent-device [#1239](https://github.com/callstack/agent-device/issues/1239): a stale ref from the
  previous screen is accepted after navigation.
- agent-device [#2080](https://github.com/callstack/agent-device/issues/2080): `fill` commits a
  corrupted value (11 characters requested, 7 observed).
- MobileBuildMCP [#544](https://github.com/getsentry/MobileBuildMCP/issues/544): a tap reports
  success without activating the control unless `--post-delay` is set.
- MobileBuildMCP [#543](https://github.com/getsentry/MobileBuildMCP/issues/543): `type-text
  --replace-existing` appends.
- MobileBuildMCP [#509](https://github.com/getsentry/MobileBuildMCP/issues/509): explicit
  arguments silently replaced by session defaults.
- mobile-mcp [#358](https://github.com/mobile-next/mobile-mcp/issues/358): calls stall 20–30 s or
  forever and freeze the whole server.

## What the eval must answer

1. **Truthfulness:** when a tool says an action worked, did it? Headline metric: the
   *false-success rate* (tool said OK, ground truth says no or says something else happened).
2. **Correctness:** right element, right text, right app, right device.
3. **Isolation:** several agents on one machine, each on its own device or contending for one.
4. **Recovery:** when a call fails, does the error let an agent recover (typed, actionable, fresh
   candidates), or does it hang, crash, or lie?
5. **Cost:** latency per primitive, tokens per observation and per tool definition, setup time.

The output is a per-case matrix with failures and variance, not a score.

## Ground truth comes from outside the tool

The tool's own report is recorded but never trusted.

- **Gauntlet**, an oracle app (extending Labyrinth's approach in `testapp/`). Every scenario screen
  appends what the app *actually received* to `Documents/events.jsonl`: each touch point and the
  view it hit, each text change, each control activation, alert decisions, navigation events,
  with timestamps. The harness reads it host-side via `simctl get_app_container`. This is how
  agent-device #4091's reporter caught the offset ("App received the touch at …").
- **OS state** for system UI: the TCC database for permission decisions (ATT, location), the
  pasteboard, the Contacts database for stock-app tasks.
- Scenarios open by deep link (`gauntlet://scenario/<id>?seed=N`). The seed jitters layout:
  row order, offsets, label variants, timing of late inserts.
- Android: the same scenarios in a Compose app, phase 2.

## Tier 1 · Probes (no model; most of the eval)

For each probe and tool: reset the scenario, then perform the agent-like step through the tool's
own documented interface (observe, choose the target the way its docs say, act). Read the oracle,
then classify the outcome:

`correct` · `wrong target` · `no-op` · `partial / corrupted` · `refused correctly` (tool said it
could not, nothing happened) · `refused wrongly` · `hang (>30 s)` · `crash`.

The tool's claim (success or error) is crossed with that outcome. Each probe runs on 5 seeds.

| ID | Scenario | Oracle checks | Evidence |
|---|---|---|---|
| A1 | Rows inserted 300 ms after first paint push the target down | which row received the tap | agent-device teardown (General→Siri 3/3), mobile-mcp T1 |
| A2 | Two controls with the same label (nav bar "Add", toolbar "Add") | which one fired | mobile-mcp T3 (Dictation alert) |
| A3 | Ref kept from the previous screen, used after navigating | nothing fires; error says stale | agent-device #1239 |
| A4 | Carousel item half off-screen | the item fired | agent-device #332 |
| A5 | Target under the keyboard | no key typed; refusal or scroll | agent-device #1298, mobile-mcp T3 ("Lovelacey") |
| A6 | Target behind a sheet, a context menu, a dimming overlay | nothing behind fires | MobileBuildMCP T3/T7 |
| A7 | iPhone and iPad in landscape | touch point vs requested point | agent-device #4091, #1511 |
| A8 | SwiftUI TabView; Liquid Glass views with null frames | correct tab fired | agent-device #507, #3514 |
| A9 | A canvas-drawn button with no accessibility | (expected to fail for tree-only tools) | — |
| A10 | Button that slides in while the tap is sent | fired once, at the right place | — |
| B1 | Button ignoring taps during a 400 ms transition | activation recorded | MobileBuildMCP #544 |
| B2 | Replace text in a field that already has text | final value exact | MobileBuildMCP #543, agent-device #3358 |
| B3 | Field that formats input (phone, currency) | final value semantically right | agent-device #2634 |
| B4 | Non-ASCII, emoji, RTL text | final value exact | agent-device #3819, mobile-mcp #78 |
| B5 | Secure field | value set, never echoed in output | — |
| B6 | Multiline text view with Return | newlines where asked | — |
| B7 | Dismiss the keyboard | keyboard gone, field unchanged | agent-device #952, MobileBuildMCP #535 |
| B8 | Switch whose only change is its state | state flipped exactly once | PhoneUse Local's 4 s `uncertain` |
| B9 | Long press opening a context menu that never idles | menu read; no 60 s hang | phone-use (fixed 2026-11-04), Mobilerun T7 |
| B10 | Scroll until a row; list end with no match | found / honest "end reached"; never left the app | Mobilerun `scroll_until` pressed Home |
| B11 | Tap at (5000, 5000) | refused | mobile-mcp, ios-simulator-mcp, Mobilerun |
| C1 | Location permission prompt: read all text and buttons | full text read; chosen button recorded | Mobilerun could not see it |
| C2 | App Tracking Transparency: "dismiss" must decline | TCC records denial | agent-device #3627 |
| C3 | "Open in …?" confirmation after a URL open | correct choice | agent-device #3702 |
| C4 | Photos limited-access sheet, notification prompt | correct choice | — |
| C5 | Home Screen, App Library, Control Center | observed as such, not as the last app | agent-device T7 |
| C6 | SafariViewService / ASWebAuthenticationSession sheet | reachable, dismissable | agent-device #2438, #2560 |
| C7 | Web content in WKWebView and Safari: read a heading, tap a link | link opened | idb and AXe cannot see web text |
| D1 | Observation at 50, 500, 2,000 nodes | latency p50/p95, characters | — |
| D2 | A screen that never idles (spinner, live map) | observation returns in bounded time | Mobilerun 3.5 s waits |
| D3 | Hidden and covered elements | not offered as targets | all three |
| E1 | Runner or daemon killed mid-session | next call: recovers or says why | agent-device daemon loss |
| E2 | App crashes during an action | reported as a crash, not success | — |
| E3 | App main thread blocked 5 s | bounded timeout; other calls not frozen | mobile-mcp #358 |
| E4 | Android tooling wedged (adb hangs) | iOS calls unaffected | mobile-mcp 675 s hang |

## Tier 2 · Several agents at once

Each agent types a unique token in its actions, so any event carrying agent B's token in agent A's
oracle is contamination.

| ID | Setup | Pass means | Evidence |
|---|---|---|---|
| I1 | 2, 4, 8 agents, each on its own simulator, same machine | zero contamination; throughput per agent vs k | agent-device #1659, mobile-mcp #253 |
| I2 | 2 agents, one simulator, no coordination | the second is refused or queued with a clear message; never interleaved | mobile-mcp #534, agent-device #3345 |
| I3 | 2 agents in one checkout using implicit defaults | each keeps its own device | agent-device #3931 |
| I4 | One session times out or is killed | siblings unaffected | agent-device #3177 |
| I5 | `install` / `shutdown` from another session on a held device | refused | agent-device #3345, #1799 |
| I6 | Runner killed while two sessions are live | both recover or both fail loudly | — |

## Tier 3 · Agents end to end

Same model, prompt and step budget for every tool, each through MCP (and the CLI where that is the
tool's documented path). `phone-use compare` already runs arms with seeded order, repeated trials
and an external grade command, and it is the runner for this tier.

- Tasks on Gauntlet (graded by its events and state) and on stock apps (graded by OS state).
- Report: success, *agent claimed done but state says no*, steps, tokens (tool definitions
  included), wall time, cost, variance over repeats.
- Needs a model and a budget (see the decision below).

## Rules so we cannot fool ourselves

1. Cases come from outside evidence (the issues above) and from an adversarial author, not from
   reading our code.
2. **60/40 split.** The 40% held-out set has seeds generated at run time. Whoever changes the
   runner does not see held-out details. A fixture changes only with a written reason, never "so
   a tool passes".
3. Every tool is pinned to a version and given its best documented settings (agent-device with
   `--settle`, mobile-mcp with its current runner). Each adapter is reviewed for fairness by
   someone other than its author.
4. Five runs per cell; report variance; A/A runs to measure noise.
5. A clean-checkout re-run of the held-out set by a fresh agent before any number is quoted.
6. The expected-failure list below is committed **before** the first run.

## Where I expect phone-use to lose (committed before running)

- **I2, I3, I5: two agents on one simulator.** Device claims are process-local
  (`packages/phone-use/src/device-claim.ts`); two MCP servers or CLI processes share one runner and
  interleave with no refusal. Same failure as mobile-mcp #534.
- **A7: landscape and iPad.** Synthesized touches pass an interface orientation, untested anywhere.
- **A8: Liquid Glass views with null frames.** We normalize them to zero, so they cannot be tapped.
- **A9: canvas controls.** No accessibility, no target; only vision would work.
- **B3: formatting fields.** `fill` deletes then types; a field that reformats may end wrong.
- **B7: keyboard dismiss on iOS 26.** Our `dismiss` taps "Hide keyboard" or sends Return.
- **C6: SafariViewService sheets.** These are not in the app's tree; untested.
- **D2 on first contact:** an app that never idles costs up to 60 s once before we stop waiting for it.
- **Tier 3 tokens:** our observations carry rects for every node; others print less.
- **Android,** all of it: input goes through `adb shell input`; no Gauntlet app yet.
- **Physical iPhones:** no runner launch path yet.

## Order of work

1. Gauntlet (iOS), with the event log and the 40 scenarios above.
2. A probe runner with four adapters (phone-use, agent-device, mobile-mcp, MobileBuildMCP;
   ios-simulator-mcp optional), each written from the tool's docs and reviewed by a second agent.
3. Tier 1 on the dev split, results published, including ours.
4. Tier 2 harness.
5. Tier 3 through `phone-use compare`, once a model and budget are chosen.

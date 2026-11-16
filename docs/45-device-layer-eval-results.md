# 45 · Device-layer eval: first results for phone-use (2026-11-04)

Status: measured. This is the eval proposed in [doc 43](43-device-layer-eval.md), built in
[`eval/`](../eval/README.md). It was run against phone-use's CLI, phone-use's MCP server, and agent-device.

## Corrections, 2026-11-05 (latest): an independent review, and what changed

A second model reviewed this eval and the fixes behind it: Codex `gpt-6-astra`, read-only, with its own
simulator rerun. It recomputed every headline count from the raw results, found them accurate, and found
no cherry-picked run. It also found three problems:

- several fixes were heuristics fitted to the test app;
- some scoring rules could hide failures;
- this doc claimed more than the evidence supports.

Every code-level finding was confirmed in the source before it was fixed (branch `fix/review-findings`).

**Fixed**

| Finding | Before | Now |
|---|---|---|
| Unlaid-out list rows | Dropped any two texts that shared an origin, anywhere on screen | Content outside its own cell takes the cell's position (UIKit keeps the cell's true frame) |
| Re-finding a ref | The nearest of several matches | Refused as ambiguous unless the set of look-alikes is unchanged |
| Fill | Fell back to old coordinates, with no covered or keyboard check; the CLI also caught a refusal and tapped anyway | The same checks as tap; refusals reach the agent |
| Covered-control check | A 5 s cache, reused at tap time | Fresh at tap time; the screen read's cache is keyed by what covers the element |
| Numbers in labels | "Invoice 5 total amount" matched "Invoice 53 total amount"; "Row 5" matched inside "Row 53" | Numbers must agree, and a substring never splits a number |
| "Screen changed" | Unknown was reported as changed; a stale cache was credited to the tap | The comparison taken around the tap; unknown stays unknown |
| Secret masking | Guessed from bullet characters | By the field's type, with bullets kept for custom fields; bare `type` holds the text back when a secure field is on screen |
| URL opens | A plain success after a 2 s wait, whatever happened | "Unverified" when no app came forward |
| Device lease lock | Proceeded unlocked after 2 s, then deleted the other process's lock | Never enters unlocked; takes over only a dead owner's lock |
| Eval scoring | "Invalid" outranked a hang; a failed setup tap was hidden as invalid | Hangs and tool failures are always scored |

**Regression probes R1–R3** are the review's counterexamples, run 5 seeds each on the phone-use CLI.

- On `main` they score 0 of 15. R1 tapped the wrong look-alike row; R2 dropped both labels; R3 typed into
  the covering field.
- On the fixed branch they score 15 of 15.
- They were written after the fixes, so they guard them and stay out of cross-tool comparisons.

**After the fixes** the full eval gives the same result: CLI 145/150 and MCP 145/150, with 0 false
successes (runs `run6-phone-use` and `run5-phone-use-mcp`). The eval never caught these holes, which is why
R1–R3 exist.

**Withdrawn or qualified**

- **"Objective."** The app's record of what happened is objective. Which probes exist, what counts as a
  claim, and how the adapters behave are the author's choices, and phone-use was tuned against these
  probes. Its 0% is a regression bar, not general reliability.
- **D3r.** The rule changed on 2026-11-05 to exempt a control that the tool itself marks blocked. Under the
  rule as first written, phone-use fails D3r on every seed and scores 140/150.
- **Competitor results** are a raw-command track, not full agent workflows. Mobilerun's "tapped" text is
  the adapter's, and B1 measures silent ambiguity. They are not publishable as a comparison.
- **"Verified actions"** becomes change evidence (README).
- **`phone-use bench` and the T0–T9 script** are smoke tests on stock apps the tool was tuned on. They do
  not show generalization.
- **Search swipes without a settle wait** were measured on one UIKit list's accessibility frames. That is
  no guarantee for content that loads, snaps or animates after a swipe.
- **The earlier bench A/B** was not saved. The saved rerun below agrees with it.

**Saved bench A/B.** `main` (3967870) and this branch (50d5122) alternate, two rounds each. Every run uses
the same frozen warm maps (hashes in the log directory), and Grid is turned off first so the toggle really
flips. Logs: `eval/results/bench-ab-2026-11-05/` (gitignored). All four runs passed 6/6.

| Task | main, round 1 / 2 | this branch, round 1 / 2 |
|---|---|---|
| read-ios-version | 4.1 / 4.0 s | 4.1 / 4.0 s |
| deep-nav-accessibility | 3.0 / 2.9 s | 2.9 / 3.6 s |
| search-open-maps | 12.4 / 21.0 s | 11.1 / 12.8 s |
| toggle-setting | 6.3 / 6.4 s | 4.4 / 4.8 s |
| phone-wide-ask | 5.7 / 5.6 s | 5.7 / 5.7 s |
| create-contact | 11.5 / 11.4 s | 10.0 / 9.4 s |

Maps search depends on Maps' own results and varies on both.
- **The competitor settling table** was too absolute and is corrected in place.

**Still open**

- **A cover that appears after the screen was read is not caught.** The tap-time check runs only for
  elements that were overlapped when the screen was read.
- **Tier 2 checks are weak.**
  - I2 passes on a single refusal, and I4 counts unverified calls as recovered.
  - Leases are tested with named sessions, not with automatic process-ancestry inference.
  - A lease can expire during a long action, and reuse of a process id is not handled.
- **Some probes grade loosely.**
  - Refusal probes accept any error.
  - C7 does not grade the heading read.
  - E3 does not prove the freeze happened first.
- **Recording a skill saves typed passwords.** A password typed while recording ends up in the skill file.
- **A timed-out probe keeps running.** Its work is not cancelled before the next probe starts.
- **Raw results are not archived.** They are gitignored and kept only on the machine that ran them.

## Update, 2026-11-05 (later): Maestro and Mobilerun on the same probes

Two more tools, each driven through the calls its own docs give agents (adapters in `eval/src/adapters/`).
This is the raw-command track: the adapters make one documented call per step and do not run the full
agent workflow those docs describe (observe again after acting, recover). See "Corrections" above.

- Maestro CLI 2.12.1 through `maestro mcp`.
- Mobilerun (mobilerun-core 1.10.1) over its ios-portal Simulator server.

A second agent reviewed both adapters for fairness, and its findings were applied before scoring (see
`eval/README.md`). Each ran alone, on its own twin of the phone-use simulator. Results are 30 probes × 5
seeds.

| | Pass | False successes / plain-OK claims | Hangs | Probes with false successes |
|---|---|---|---|---|
| phone-use CLI | 145/150 | 0/80 (0%) | 0 | — |
| phone-use MCP | 145/150 | 0/85 (0%) | 0 | — |
| agent-device 0.21.36 | 110/145 | 15/76 (20%) | 0 | A1, A1i, D3r |
| Maestro 2.12.1 | 105/150 | 32/122 (26%) | 5 | A5, A7, B1, B10a, B11, D3r, D3t |
| Mobilerun 1.10.1 | 65/150 | 60/120 (50%) | 5 | A1, A1i, A3, A5, A6a, A6b, B1, B10a, B11, C1r, D3r, D3t |

**Maestro.**

- **Strengths:**
  - Element taps re-find by text at tap time, so inserted rows and stale screens (A1, A1i, A3) pass.
  - It reads and answers permission prompts (C1r, C1d, C2), and fields and switches pass.
- **False successes:**
  - It taps a button under the keyboard (A5), a covered control (D3t), a row not yet laid out at the top of
    the list for "Row 53" (B10a), and (5000, 5000) (B11).
  - It offers covered and off-screen controls (D3r).
- **Hangs:** after a tap crashes the app, it hangs (E2).
- **Speed:** slow where it waits for an element that is gone: 18 s to refuse a stale target (A3), 23 s for a
  missing row (B10b). A never-idle screen takes 13.6 s (D2).
- **Reliability:** it was run three times. The first run was stopped at 142 of 150 because it overlapped
  Mobilerun's. In the second, its iOS driver dropped ("Device became unreachable") at the third probe, and
  the MCP server never reconnected. The scored run is the third, a clean rerun on a freshly booted
  simulator, so these numbers describe Maestro when its session holds, not how often it holds.

**Mobilerun.**

- **Strengths:** text entry, switches, landscape (A7), tabs and web content pass.
- **False successes:**
  - It taps saved positions: rows inserted after it looked (A1, A1i) and a stale screen (A3).
  - It taps through the keyboard, sheets and covers (A5, A6a, A6b, D3t), and taps the top row for an
    unrealized "Row 53" (B10a).
  - It accepts (5000, 5000) (B11).
  - It reports reading a permission prompt it cannot see (C1r).
- **Speed:** each screen read costs about 3.3 s, and a missing row takes 64 s (B10b, a hang).
- **What its false successes mean:** Mobilerun's tap calls return nothing. The "tapped" text the eval
  graded is the adapter's, so these are taps dispatched without verification, not claims Mobilerun made.
  Its guide tells an agent to observe again after every action, which the adapter does not do. For a seen
  element the adapter uses `tap_node`, the node's old position. `tap_text`, also documented, re-finds by
  text and would probably pass A1, A1i and A3.

B1 measures silent ambiguity for both tools rather than the early-tap race. The screen title and the button
share "Confirm", and both taps by label chose the title.

## Update, 2026-11-05 (later): finding a control by label, faster

`tap <label>` on a row far down a list took 16–20 s; agent-device took 6.3 s. Timing every runner call showed
where it went. Screen reads cost 0.1–0.15 s. Each scroll step cost 1.3–3.3 s:

- the swipe, 0.73 s;
- a wait for the screen to go quiet, 0.6–1.0 s, and up to the 2.5 s cap when an unrelated label in the
  tree changed;
- a read.

The swipe holds still before lifting. On this list, sampling the accessibility tree after the swipe showed
nothing move. That is one UIKit list's accessibility frames, not rendered pixels, and not a general
guarantee: content that loads, snaps or animates after a swipe is not covered. Lookups also scrolled to the
top first, even when the control was on screen.

What other tools do, from their source (the paths read; defaults can be configured):

| | Before searching | Between search swipes | End of list |
|---|---|---|---|
| Maestro `scrollUntilVisible` | Looks at the current screen | A screenshot-difference check (with a tolerance) for up to 3 s, then a hierarchy-polling fallback | No edge detection; 20 s command timeout |
| WebDriverAgent scroll-to-visible | Current position; target must already be in the tree | XCTest stability wait up to `animationCoolOffTimeout` (configurable) | 25 swipes |
| agent-device `scroll --until` | Looks at the current screen | No XCTest idle wait; a controlled release instead of a fling | Container edge, or no progress over several passes |
| mobile-mcp, idb | No search loop; the agent loops | No wait in the wrapper (what their backends do was not measured) | — |
| phone-use, before | Scrolled to the top first | Waited for quiet (0.6–2.6 s) | One unchanged swipe |

What changed:

- **Look first.** The lookup behind `tap`, `toggle` and reads takes an id or exact-label match (or an exact
  tie) from the current screen, if it was read in the last 2 s. A weaker match still gets the full search from
  the top, since an exact match elsewhere should win.
- **No waiting between search swipes.** The screen is read straight after each one.
- **The end of a list takes two swipes that change nothing,** so rows that load in late are not reported
  missing. On a short screen this costs a little: A6a (a missing button) went from 2.1 to 2.1–2.2 s.

| Probe (median of 5 seeds) | CLI before | CLI after | MCP before | MCP after |
|---|---|---|---|---|
| B10a, row far down a list | 15.6 s | 8.1 s | 14.1 s | 7.4 s |
| B10b, row that does not exist | 19.6 s | 9.5 s | 19.7 s | 9.6 s |
| D2, screen that never idles | 6.0 s | 3.2 s | 5.8 s | 2.9 s |
| B8, switch | 3.9 s | 3.0 s | 3.5 s | 1.9 s |
| False successes (of 150) | 0 | 0 | 0 | 0 |

**Real apps.** `phone-use bench` was run in alternating runs against `main`, with the same warm maps. Those
runs were printed to the terminal, not saved, so the numbers below are unverified. See "Corrections" above
for a saved rerun.

- toggle-setting went from 6.3 s to 4.9 s.
- create-contact went from 11.2–11.4 s to 9.6 s.
- The other tasks are unchanged. Maps search varies between 9.5 and 19.3 s on both.
- With the original saved map, toggle-setting falls back to the crawler and takes 52–53 s on both.

**Not changed, on purpose:**

- **The wait after a tap.** The runner still waits for XCTest to report the app idle, which takes 1.3 s while
  a switch animates. WebDriverAgent waits the same way. agent-device and Maestro skip XCTest's idle wait but
  have their own settling (agent-device's `--settle`, Maestro's screenshot check). The wait is what
  makes the printed screen and the "changed" report show where the app ends up, so it needs more measurement
  before it is traded for speed.
- **CLI startup.** Each command spends 0.2–0.3 s before it touches the device; agent-device's CLI talks to a
  background process. The MCP server does not pay this.
- **The crawler's own scroll loops,** used when the map has no route.

## Update, 2026-11-05: after the fixes

Every finding below was addressed, and B7 stays unsupported. Each fix was then checked on the probe that
found it, run on the dev seeds, and confirmed by full runs on fresh held-out seeds. An independent review
later found several of these fixes incomplete or too narrow; see "Corrections" above. The first measurement
is kept below as the record.

| | Pass | False successes | Plain "OK" claims | False-success rate |
|---|---|---|---|---|
| phone-use CLI, before | 110 / 150 | 30 | 120 | 25% |
| phone-use CLI, after | 145 / 150 | 0 | 80 | **0%** |
| phone-use MCP, before | 111 / 150 | 14 | 95 | 15% |
| phone-use MCP, after | 145 / 150 | 0 | 85 | **0%** |
| agent-device 0.21.36 (same probes) | 110 / 145 | 15 | 76 | 20% |

- **The only non-pass left is B7, keyboard dismiss.** It is unsupported, as in agent-device. On an iOS 26
  iPhone the keyboard has no dismiss key, and nothing outside the app closes it reliably.
- **agent-device's A5 was invalid this run.** The software keyboard never appeared on its simulator, so it is
  not scored; it passed 5/5 in its earlier run.
- **Dev and held-out seeds agree on every surface.**
- **Tier 2 passes 7 of 7**, where it passed 5 of 7 before:
  - I2: a second agent on a busy simulator is refused 8 times, with a message naming the first.
  - I5: an uninstall from another session is refused.
  - I1, I3 and I4 still pass. I1 (1, 2 and 4 agents) runs at 0.44, 0.42 and 0.39 actions/s per agent.
- **Real apps.** `phone-use bench` passes 6/6 and the T0–T9 device tasks pass (warm maps; T1, T3–T7 and the T9 refusals). T4's check was
  updated, because example.com dropped its "Example Domain" heading.

What changed, by finding:

| Finding | Fix |
|---|---|
| 1. Below-the-fold row tapped at a placeholder | Rows a list has not laid out (several texts collapsed onto one origin) are dropped from the screen read, so `tap` scrolls to the real row. Fuzzy matching counts numbers, so "Row 5" no longer stands in for "Row 53". |
| 2. A ref from the previous screen | Refs name one element identity and are never reused for another; a gone element fails `STALE_REF`. |
| 3. "(screen changed)" on every CLI tap | The runner compares the screen before and after each tap from captures it already takes, and reports it. |
| 4. Identifier-only re-finding | Identifier *and* label must match when both were recorded. |
| 5. Covered controls | An element another element overlaps is hit-tested (XCTest `isHittable`) before a tap, and refused as `COVERED`. The screen read marks overlay-covered controls `(blocked: covered)`. |
| 6. The keyboard intro | Covered by the same hit test (the intro is the cover). |
| 7. Landscape | The touch synthesizer ignores its orientation argument; points are now converted to the screen's portrait space. |
| 8. I2, I5 | Device leases: one agent session per simulator (`PHONE_USE_SESSION`, `PHONE_USE_TAKEOVER`). |
| 9. Secret echo, slow "not found" | `type` masks secure fields. Fruitless scrolls stop early and scroll steps are larger; B10b went from 24 s to 20 s. |

Found while checking real apps, not by a probe: `open --url` without an app sent the URL to the current app
(Settings asked to open an https link) and reported "Opened". URLs now go to the system, and the reply waits
for the app that opens.

**Speed.** On real apps (warm maps, this Mac), `phone-use bench` averages 6.4 s per task, against 5.6 s before the fixes. Maps search takes 12.1 s (before: 8.5–10.0 s) and contact creation 11.0 s (before: 10.5–10.9 s). The extra time is the tap-time hit
test on overlapped controls. Rows below the fold now take about 15 s, because the tool scrolls to the right
row; before, it "succeeded" in 2 s by tapping the wrong one. agent-device's `scroll --until` takes about 5 s
there, so it is still faster on long lists.

**Eval changes made during the fixes** (all logged in `eval/README.md`):

- A7 now alternates landscape left and right by seed, so both directions are tested.
- D3r counts an element the tool itself marks as blocked as "not offered".
- Each phone-use adapter instance is its own agent session, as agent-device's adapter uses its own `--session`.

## What was run

- **Host.** MacBook Air (M4, 16 GB), macOS 26.5.2, Xcode 26.2. Simulator: iPhone 17 Pro, iOS 26.2. Doc 42
  was measured on a different Mac (Xcode 26.6, iOS 26.5).
- **phone-use.** Product code as on `own-device-layer` at `5952db6`; the eval changed no product code.
  - The CLI: one process per verb, as a shell-driving agent uses it.
  - The MCP server: one long-lived process, as Claude Code uses it.
- **Eval revisions.** `3098cab` for the phone-use runs. `09fb13e`, plus the output-path fix committed with
  this doc, for agent-device. The difference is the fairness review's changes; re-running the affected
  probes on phone-use at `09fb13e` gave the same verdicts, 30/30.
- **Tier 1.** 30 probes on Gauntlet, the oracle app. Each runs on dev seeds 1–3 plus two held-out seeds drawn
  at run time.
- **Tier 2.** Up to four extra simulators, with every agent typing tokens only it knows.
- **The rule.** The tool's reply is the claim; Gauntlet's event log decides what happened. A *false success*
  is a plain "OK" when the oracle says nothing happened, or something else did.

## Headline

| | Scored | Pass | False successes | Plain "OK" claims | False-success rate |
|---|---|---|---|---|---|
| phone-use CLI | 150 | 110 | 30 | 120 | **25%** (dev 25%, held-out 25%) |
| phone-use MCP | 150 | 111 | 14 | 95 | **15%** (dev 16%, held-out 13%) |
| agent-device 0.21.36 | 150 | 115 | 15 | 75 | **20%** (dev 20%, held-out 20%) |

Both phone-use surfaces fail the same probes. Over MCP, three of them (A3, A7, D3t) come back hedged:
`screen did NOT change — the action may have had no effect` instead of a plain success. That is why MCP's rate
is lower. The wrong button still fires in A3.

An earlier full CLI run, made before the A1/A1i split, gave 26% (30 of 116). It failed the same six probes,
plus the A5 keyboard intro once (finding 6).

### Per probe (passes out of 5 seeds; FS = false success, flag = failed but hedged)

agent-device ran on its own simulator, because two tools' XCTest runners evict each other. It used its
documented loop: `open`, `snapshot -i`, `press`/`fill … --settle`, and `scroll --until`.

| Probe | What it checks | Evidence | phone-use CLI | phone-use MCP | agent-device |
|---|---|---|---|---|---|
| A1 | Rows inserted above the target after the agent observed | agent-device teardown | 5 | 5 | **FS 5** |
| A1i | The same, with index identifiers that repeat after the insert | found here | FS 5 | FS 4, pass 1 | FS 5 |
| A2 | Two controls named alike; tap the toolbar one | mobile-mcp T3 | 5 | 5 | 5 |
| A3 | A ref from the previous screen | agent-device #1239 | **FS 5** | flag 5 | **5** (refused) |
| A4 | Carousel card whose centre is off-screen | agent-device #332 | 5 | 5 | 5 |
| A5 | Button under the keyboard | agent-device #1298 | 5 | 5 | 5 |
| A6a/b | Buttons under, and behind, a sheet | MobileBuildMCP T3/T7 | 5 / 5 | 5 / 5 | 5 / 5 |
| A7 | Landscape grid | agent-device #4091 | **FS 5** | flag 5 | flag 5 (touch lands ~82 pt low) |
| A8 | SwiftUI TabView | agent-device #507 | 5 | 5 | 5 |
| B1 | Button that ignores taps for 300–700 ms | MobileBuildMCP #544 | 5 | 5 | 5 |
| B2–B4, B6 | Replace, formatted, non-ASCII, multiline text | MobileBuildMCP #543 and others | 5 each | 5 each | 5 each |
| B5 | Secure field | doc 43 | leak 5 | leak 5 | **5** (no echo) |
| B7 | Dismiss the keyboard | agent-device #952 | unsupported | unsupported | unsupported (`UNSUPPORTED_OPERATION`) |
| B8 | Settings-style switch | PhoneUse Local | 5 | 5 | 5 |
| B10a | Tap a row below the fold | Mobilerun | **FS 5** | **FS 5** | **5** (`scroll --until`, then press) |
| B10b | Tap a row that does not exist | Mobilerun | 5 | 5 | 5, in ~5 s (phone-use: 20–29 s) |
| B11 | Tap at (5000, 5000) | doc 42 T9 | 5 | 5 | flag 5 (accepts it: "Tapped (5000, 5000)", then "+0 -0") |
| C1r/C1d | Read a location prompt; dismiss it (must decline) | Mobilerun; agent-device #3627 | 5 / 5 | 5 / 5 | 5 / 5 |
| C2 | Dismiss App Tracking Transparency (must decline) | agent-device #3627 | 5 | 5 | 5 |
| C7 | Web content | doc 42 T4 | 5 | 5 | 5 |
| D2 | A screen that never idles | doc 43 | 5 | 5 | 5 (10.5 s per tap; phone-use 6 s) |
| D3r | Hidden, covered and off-screen controls not offered | doc 43 | **FS 5** | **FS 5** | **FS 5** |
| D3t | Tap a covered control | doc 43 | **FS 5** | flag 5 | flag 5 |
| E2 | App crashes on tap | doc 43 | 5 | 5 | 5 ("app … is not running") |
| E3 | Main thread blocked 6–9 s | mobile-mcp #358 | 5 | 5 | 5 |

### phone-use against agent-device, the layer it replaced

- **phone-use is better at:**
  - Rows inserted after the agent observed (A1). agent-device taps the old position, 5/5, the bug its
    teardown found in Settings.
  - Refusing a coordinate off the screen (B11).
  - Screens that never idle (D2): 6 s per tap against 10.5 s.
- **agent-device is better at:**
  - Stale refs (A3): refused, because refs carry a generation.
  - Rows below the fold (B10a): its documented `scroll --until` scrolls to the row before pressing.
  - Hedging its no-op taps over the CLI (A7, D3t): "+0 -0".
  - Not echoing secrets (B5).
  - An honest "not found" in 5 s, not 20–29 s (B10b).
- **Both fail:** covered controls offered as targets (D3r), identifier-only re-finding (A1i), and landscape
  (A7, wrong point on both). Neither can dismiss the iOS 26 keyboard (B7).

**Net.** phone-use's own device layer is not yet more truthful than agent-device: 25% (CLI) and 15% (MCP)
against 20%. All 30 CLI false successes come from six probes (A1i, A3, A7, B10a, D3r, D3t), and each is
traced to a specific cause in the findings below. Fixing findings 1 and 2 alone removes 10 of them.

### Tier 2: several agents at once (phone-use CLI)

| Case | Result |
|---|---|
| I1: 1, 2 and 4 agents, each on its own simulator | ✅ No contamination, no false successes. 0.44, 0.45 and 0.40 actions/s per agent (k = 1, 2, 4) |
| I2: two agents on one simulator, no coordination | ❌ They took turns 14 times and neither was told. Every individual call was truthful |
| I3: two simulators booted, no device pinned | ✅ Both refused, with a message naming the choice |
| I4: one agent's runner killed mid-run | ✅ The sibling was untouched. The victim's next call took 20 s (runner restart), then all OK |
| I5: a second session uninstalls the app from an agent's device | ❌ Allowed. The agent's next 8 calls failed, honestly |

## What the eval found (ranked by harm)

None of these are fixed yet. Each has a probe, evidence on every seed, and a root cause in our code.

### 1. Tapping a row below the fold taps the top row, and reports success (B10a: 5/5 in every run)

`phone-use tap "Row 53 Indigo"` on a 60-row list answers
`Tapped "Row 53 Indigo" (matched via exact label)`. The app received one touch, at (54, 126), on Row 1. Nothing
scrolled.

**Cause.**

1. UIKit exposes rows that aren't on screen as `StaticText` elements whose frames collapse to the table's
   top-left corner. A runner snapshot gives every unrealized row `(0,116 109x20)`.
2. The runner passes these through.
3. `DeviceCore.tapLabel` (`packages/sdk/src/observe.ts:909`) sees an exact label with an on-screen rect and
   presses it.

Any long list (Settings, Contacts, Mail) hits this whenever an agent taps, by name, a row it hasn't
scrolled to. Doc 42's T5 passed because its script scrolled explicitly.

**Fix.** Don't trust a frame that sits at the scroll view's origin band for an element outside a realized
cell. Treat the element as off-screen and scroll until it has a real frame.

### 2. A ref from the previous screen taps whatever now has that number (A3: 5/5 on CLI and MCP)

1. The agent observes screen 1, where `@e5` is "Pin Message".
2. It taps `@e4` (Continue), which pushes screen 2.
3. It taps `@e5`.

The app fires screen 2's "Purple Button". Over the CLI, phone-use answers `Tapped @e5. (screen changed)`.

**Cause.** Refs are re-minted on every observation, and every action reply observes again, so `@e5` names a
different element after any action. The runner's `STALE_REF` check re-finds the element by identity, but it
compares against the *new* `@e5`, so the check never fires through either surface.

agent-device refuses this case: "Ref @e5 needs a complete snapshot — the current frame only authorizes its
emitted refs". That is the right answer to its own issue #1239.

**Fix.** Never reuse a ref for a different identity within a session: use monotonic refs, or pin a
generation (`@e5~s3`). Refuse refs from a superseded generation.

### 3. Every CLI ref tap says "(screen changed)", including taps that hit nothing

This happened on every CLI `tap --ref`, including A7 and D3t, where nothing fired. `tapAndDiff`
(`observe.ts:782`) fingerprints its cache before the tap, and in a fresh CLI process that cache is empty, so
"before" never equals "after".

Over MCP, where the cache survives between calls, the same taps say
`screen did NOT change — the action may have had no effect`. The README's "every tap reports whether the
screen actually changed" therefore holds for MCP, not for the CLI.

**Fix.** Take the "before" capture when the cache is cold (the runner already captures fresh to re-find the
element), or report "unverified" instead of "changed".

### 4. Re-finding by identifier ignores the label (A1i: 13 of 15 seeds across three runs)

`Tree.relocate` (`ios-runner/PhoneUseRunnerUITests/Tree.swift:217`) matches on the identifier alone when an
element has one, then takes the nearest match.

UIKit lists commonly set index identifiers in `cellForRowAt`, and UIKit doesn't reconfigure visible cells on
insert, so after rows are inserted two rows can share an identifier. The ref then resolves to "Promotion 2"
instead of "Quarterly Summary", and the tap reports success. The seeds that passed inserted rows such that no
identifier was duplicated. With no identifiers (A1), re-finding works 5/5.

**Fix.** When both were recorded, require the identifier *and* the label to match, and refuse when several
elements match.

### 5. Covered controls are offered and "tapped" (D3r, D3t: 5/5)

A button under an opaque view is listed as a target. Tapping it lands on the cover and reports success.
Doc 42 lists "occlusion beyond the keyboard" as not done; this shows the cost.

### 6. The keyboard check misses other input views (A5: once, the simulator's first keyboard use)

On a simulator's first keyboard use, iOS shows its "Speed up your typing by sliding your finger" intro where
the keys would be. Because no `Keyboard` node exists, the button underneath isn't flagged. The tap lands on
the intro and reports success.

Every later seed is refused correctly with `OCCLUDED`. A fresh simulator, as in most CI runs, hits this once.

**Fix.** Treat any input-view region (`inputView`, or a keyboard-sized element at the bottom) as occluding.

### 7. Landscape taps are rotated the wrong way (A7: 9 of 10 CLI seeds; the one pass is a coincidence)

The app receives (target y, 402 − target x), where 402 is the portrait width: a portrait-to-landscape
rotation applied backwards. The one pass is Cell 5, whose rotated point happens to fall inside Cell 5. Doc 43
predicted this.

### 8. Two agents on one simulator share it silently (I2); another session can uninstall the app (I5)

- **I2.** Two agents driving one simulator took turns 14 times. Neither was told about the other, and every
  individual call was truthful. Doc 43 asks for a refusal or a queue with a notice.
- **I5.** `phone-use sim uninstall` from a second session removed the app while an agent was using it. The
  agent's next 8 calls failed, but honestly.

Both were predicted: device claims are process-local (`device-claim.ts`). This is plan item #3.

### 9. Smaller

- **B5.** `type` echoes a secure field's value in its reply (`Filled "Secret Phrase" with "hunter2…"`), even
  though the read-back is masked. Tracing is off by default, so nothing reaches disk.
- **B7.** There's no keyboard-dismiss verb in the CLI or MCP. The runner has `key: dismiss`, but nothing
  exposes it, yet A5's `OCCLUDED` hint tells the agent to "dismiss the keyboard (key: dismiss)".
- **B10b.** An honest "not found" takes 20–29 s (12 scroll-and-observe passes), close to the 30 s hang
  line.
- **D2.** A tap on a screen that never idles takes about 6 s, every time. That's bounded; there's no 60 s
  hang as doc 43 feared.
- **C1d.** The alert description lists the app's own "Behind Prompt" button among the alert's buttons.

## What held up

- Rows inserted after the agent observed (A1, without identifiers). Re-finding by label works 5/5.
- A ref tap under a normal keyboard is refused with `OCCLUDED` and a hint (A5).
- Duplicate labels with refs (A2).
- A carousel card whose centre is off-screen (A4).
- Sheets: covered buttons are not offered, and nothing behind fires (A6).
- SwiftUI TabView with the Liquid Glass tab bar (A8).
- A button that ignores early taps (B1). phone-use's settle covers it.
- Text: replace (B2), a field that formats as you type (B3), non-ASCII (B4), multiline (B6).
- A Settings-style switch set exactly once (B8).
- An out-of-bounds tap is refused (B11).
- Permission prompts: read in full (C1r), and "dismiss" declines both location (C1d) and App Tracking
  Transparency (C2). agent-device's #3627 does not reproduce in either tool (agent-device 0.21.36 passes
  C2 too).
- Web content (C7).
- A crashed app is reported as SpringBoard (E2).
- A main thread blocked for 6–9 s: replies stay bounded (E3).
- Tier 2: separate simulators for 1, 2 and 4 agents, with no contamination and near-linear throughput (I1);
  a clear refusal when several simulators are booted and none is pinned (I3); a killed runner restarts,
  costing about 20 s once, with its sibling untouched (I4).

## Against doc 43's predictions (committed before the first run)

| Predicted loss | Result |
|---|---|
| I2, I5: two agents on one simulator | Lost, as predicted |
| I3: implicit defaults | **Passed.** With several booted, phone-use refuses to guess |
| A7: landscape | Lost, as predicted |
| A8: Liquid Glass tab bar | **Passed** |
| B3: formatting fields | **Passed** |
| B7: keyboard dismiss | Unsupported, as predicted |
| D2: never-idle on first contact | **Passed.** About 6 s, not 60 s |
| A9, C6, Android, physical iPhone, Tier 3 tokens | Not built or not run yet |

**Not predicted:** the below-the-fold tap (B10a), stale refs through the CLI and MCP (A3), "(screen
changed)" on every CLI ref tap, identifier-only re-finding (A1i), covered controls (D3), the keyboard intro
(A5), and the secret echo (B5). Five of these are false successes: the failure class doc 44 found to be the
competitors' most common.

## What to do next (proposed)

1. **Fix findings 1–4.** These are the below-the-fold tap, refs reused across screens, "(screen changed)"
   from a cold cache, and identifier-only re-finding. After each fix, re-run its probe on fresh held-out
   seeds:

   ```bash
   bun eval/src/run.ts --udid <udid> --only B10a,A3,A1i
   ```

   A fix that passes dev seeds but not held-out seeds is tuned, not fixed.
2. **Occlusion beyond the keyboard:** covered controls (D3) and other input views (A5).
3. **Device ownership across processes (I2, I5).** This is plan item #3; the eval already measures it.
4. **Landscape (A7), keyboard dismiss (B7), and the secret echo (B5).**
5. **Make the eval the gate for device-layer changes.** Run Tier 1 for every change to `packages/sdk` or
   the runner, and report the false-success rate per surface beside `phone-use bench`.
6. **Extend the eval:**
   - an adapter for mobile-mcp;
   - doc 43's remaining probes (A9, A10, B9, C3–C6, D1, E1, E4, I6);
   - iPad and Android;
   - Tier 3 (agents end to end), once a model budget is chosen.

## Caveats

- One Mac, one simulator model and one runtime. iPhone only; no iPad, Android or physical device.
- Gauntlet is mostly UIKit; SwiftUI appears only in A8.
- The probes were written, and the runs made, by the same agent that built the eval. Probes trace to outside
  evidence (each has an `evidence` field), except A1i, which this eval found. The agent-device adapter was
  reviewed by a second agent (rule 4).
- "Held out" covers seeds (labels, positions, timings drawn at run time), not whole cases. Dev and held-out
  rates agree.
- Token cost is not measured yet.
- agent-device ran Tier 1 only. Its Tier 2 adapter hooks exist, but it was not run on several agents.
- agent-device ran on its own simulator (`pu-eval-ad`), a twin of phone-use's (same model and runtime).
- The fixture changed twice during the first runs: opaque identifiers, then the A1/A1i split. Both are
  logged with their reasons in [`eval/README.md`](../eval/README.md#fixture-changes), and the numbers here
  come from a clean run made after both.

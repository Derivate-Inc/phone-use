# Device-layer eval

phone-use's regression suite for the device layer: it measures how often phone-use does what it
says it did. It implements Tiers 1 and 2 of [doc 43](../docs/43-device-layer-eval.md).
`phone-use bench` stays a smoke test of our own verbs. This eval is the measurement.

## What it measures

- **Truthfulness.** When the tool reports success, did the thing happen? The headline number is
  the **false-success rate**: false successes divided by the calls the tool reported as plain
  success.
- **Correctness.** Was it the right element, the right text, the right app?
- **Isolation (Tier 2).** Several agents on one Mac, each on its own simulator or two on one.
- **Cost.** The latency of every call is recorded. Per-call token cost is not counted yet.

The output is a per-probe, per-seed matrix with the evidence for every failure, not one score.

## How it works

**Ground truth comes from outside the tool.** `gauntlet/Gauntlet.swift` is a small iOS app with one
screen per scenario. It appends what it *actually received* to `Documents/events.jsonl`:

- every touch, with its window point and the view it hit;
- every control activation and text change;
- keyboard shows and hides, permission decisions, sheet dismissals, web navigations;
- lifecycle changes.

The runner reads the file host-side with `simctl get_app_container`. Scenarios start from launch
arguments (`-scenario A1 -seed 3 -run <id>`). Mid-probe changes, such as inserting rows or
presenting a sheet, are triggered with Darwin notifications (`simctl spawn … notifyutil`). That
way the eval controls their timing without any system UI.

**Each probe is one agent-like step** through the tool's documented interface: observe, choose
the target the way an agent would, act. The tool's reply is the *claim*; the event log decides
the *effect*. `src/classify.ts` holds the whole scoring rule:

| | effect: intended | wrong / partial | none |
|---|---|---|---|
| claim ok | pass | **false success** | **false success** |
| claim uncertain ("did NOT change") | pass | flagged failure | flagged failure |
| claim error / refused | false failure | unsafe error | pass if refusing is right, else refused wrongly |

Other verdicts:

- Any call slower than 30 s is a hang.
- `invalid` means the scenario's precondition did not hold (for example, the keyboard never
  appeared). Invalid runs are not scored.
- `setup_failed` means an easy step through the tool failed. It is scored as a failure.
- `leak` means the probe passed but the tool's reply echoed a secret.

## Run it

You need macOS with Xcode and an iOS simulator runtime (`xcodebuild -downloadPlatform iOS`).

```bash
eval/gauntlet/build.sh                               # builds eval/gauntlet/build/Gauntlet.app

# Tier 1: use a simulator you own; the runner installs, reinstalls and drives Gauntlet on it
xcrun simctl create pu-eval-1 com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro
xcrun simctl boot <udid>
bun eval/src/run.ts --udid <udid>                     # all probes; dev seeds 1,2,3 + 2 held-out seeds
bun eval/src/run.ts --udid <udid> --only A3,B10a --dev-seeds 1 --heldout 0   # while iterating
bun eval/src/run.ts --udid <udid> --tool phone-use-mcp                       # same verbs over MCP

# Tier 2: creates or reuses its own simulators, pu-eval-iso-1..n, and shuts them down at the end
bun eval/src/isolation.ts                             # I1 (k = 1, 2, 4), I2, I3, I4, I5
bun eval/src/isolation.ts --cases I2 --rounds 6

bunx vitest run eval                                  # unit tests for the scoring rule and parser
```

Results go to `eval/results/<stamp>-<tool>/`, which is gitignored:

- `results.jsonl`: every probe × seed, with every tool call and the oracle's events;
- `summary.json`;
- `report.md`.

A result that gets quoted is copied into `docs/` together with the eval revision printed in its
header.

A full Tier 1 run is 33 probes × 5 seeds and takes about 15 minutes. Tier 2 boots up to four
extra simulators, so check memory on 16 GB machines before using `--ks 8`.

**Simulator state that leaks between probes.** Learned the hard way:

- An unanswered permission prompt survives relaunching and even reinstalling the app, and covers the
  next probe. C1r therefore answers its prompt after the read; that cleanup is not scored.
- A fresh simulator's first keyboard use shows a typing intro instead of keys (it caught A5 once).
- Two XCTest runners on one simulator evict each other, so keep other device tools off the eval's
  simulator.

## Rules, so we cannot fool ourselves

1. **Cases come from outside evidence:** public issues filed against device tools and our own
   tests of such tools. Every probe carries an `evidence` field. Cases are not derived from
   reading our code.
2. **Seeds.**
   - Dev seeds (1, 2, 3) are fixed and fine to iterate on.
   - Held-out seeds are drawn at run time and reported separately.
   - A fix that passes dev seeds but not held-out seeds is tuned, not fixed.
3. **Fixtures change only with a written reason** in the log below. "So a tool passes" is never a
   reason.
4. **Every adapter uses only phone-use's documented interface.** The run header names the tool
   and eval revisions.
5. **Expected failures are committed before running.** They are in doc 43, under
   "Where I expect phone-use to lose".

## Coverage against doc 43

**Built:**

- A1, A1i, A2–A8
- B1–B8, B10, B11
- C1, C2, C7
- D2, D3
- E2, E3
- I1–I5

**Not built yet:**

- A9 (canvas control);
- A10 (button that slides in);
- B9 (context menu that never idles);
- C3–C6 (Open-in confirmation, Photos and notification prompts, Home Screen and Control Center,
  SafariViewService);
- D1 (latency at 50, 500 and 2,000 nodes);
- E1 and E4 (runner or daemon killed between calls; wedged adb);
- I6 (runner killed under two sessions);
- iPad, Android, and Tier 3 (agents end to end, which needs a model budget).

**Adapters** (`src/adapters/`), the two ways an agent drives phone-use:

- `phone-use`: the CLI, one process per verb, as a shell-driving agent uses it.
- `phone-use-mcp`: the same verbs through one long-lived MCP server, as Claude Code uses it.

Each adapter keeps phone-use's state (learned maps and device leases) in the run's own `tool-state/`
directory, and overrides host config (a `~/.phone-use/config.json` may default the device to
android). Each adapter instance is one agent, with its own `PHONE_USE_SESSION`. In Tier 2 every case
gets a fresh scope, so the agents of an earlier case count as finished. Both adapters implement
`Adapter` in `src/types.ts`.

## Fixture changes

| Date | Change | Reason |
|---|---|---|
| 2026-11-04 | Accessibility identifiers made opaque (`gx.<id>`, rows `gx.row.<index>`), before the first scored run. | phone-use matched `tap Confirm` through the identifier `confirm`. Identifiers that equal the label make label matching easier than in real apps, which flatters the tool. |
| 2026-11-04 | A1 cells lose their identifiers (UIKit's default). The index-identifier variant becomes its own probe, A1i. B10 cells lose their identifiers. | The opaque-identifier change gave A1's cells index identifiers. After an insert those can repeat across rows, which changed what A1 measured: 5/5 failures instead of 5/5 passes. A1 measures inserted rows; A1i keeps duplicate identifiers as a separate case. |
| 2026-11-05 | A7 rotates to landscape left on odd seeds and right on even ones (it was always right). | Added coverage, made while fixing phone-use's landscape taps: a fix that handles one direction must not pass for both. |
| 2026-11-05 | Scoring: a hang or crash outranks "invalid"; a probe that runs out of time is a hang; E2 is `setup_failed` when the tool's own tap on Crash Now failed. The prompt cleanup records whether the prompt was answered. | An independent review found tool failures hidden as unscored "invalid". |
| 2026-11-05 | New regression probes R1–R3 (twin rows that shift after an insert; two labels from one corner; filling a covered field). | Counterexamples from the same review to phone-use fixes it found too narrow. They were written after the fixes they check, so they guard those fixes rather than measure the tool independently. |
| 2026-11-05 | When a tool names no roles, probes that filter candidates by role (A5's `/button/i`) match on the label alone. | An observation without element types made the role filter find nothing, and A5 scored the non-attempt as a pass. Observations that report roles, as phone-use's do, are unaffected. |
| 2026-11-05 | D3r ("covered controls not offered") no longer counts an element that the tool itself marks as blocked (phone-use `(blocked: covered)`), parsed per adapter. | An observation that lists a control and says a tap cannot reach it does not offer it as a target; A5 already treats `(blocked: keyboard)` this way. Made while adding the marker to phone-use, so it is stated here. |

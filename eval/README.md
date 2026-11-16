# Device-layer eval

Measures how often a mobile device tool (phone-use first; other tools through adapters) does what
it says it did. It implements Tiers 1 and 2 of [doc 43](../docs/43-device-layer-eval.md).
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

# agent-device, pinned and isolated; use its own simulator (two tools' XCTest runners evict each other)
npm i --prefix /tmp/ad --ignore-scripts agent-device@0.21.36
bun eval/src/run.ts --udid <other udid> --tool agent-device --agent-device-bin /tmp/ad/node_modules/.bin/agent-device

# Maestro: the CLI release zip (checksum in the release), driven through `maestro mcp`; its own simulator
gh release download cli-2.12.1 -R mobile-dev-inc/maestro -p maestro.zip && unzip maestro.zip
bun eval/src/run.ts --udid <udid> --tool maestro --maestro-bin <dir>/maestro/bin/maestro

# Mobilerun: mobilerun-core in a venv, and the ios-portal server running on its own simulator
uv venv -p 3.12 venv && uv pip install -p venv/bin/python "mobilerun-core[local]==1.10.1"
git clone https://github.com/droidrun/ios-portal && cd ios-portal   # archived; c6f1cb7
xcodebuild build-for-testing -project droidrun-ios-portal.xcodeproj -scheme droidrun-ios-portal \
  -destination id=<udid> -derivedDataPath dd -skipMacroValidation -skipPackagePluginValidation
xcodebuild test-without-building -xctestrun dd/Build/Products/*.xctestrun -destination id=<udid> \
  -only-testing "Droidrun Server" -parallel-testing-enabled NO &      # ready when :6643/device/date answers
bun eval/src/run.ts --udid <udid> --tool mobilerun --mobilerun-python <venv>/bin/python

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

A full Tier 1 run is 30 probes × 5 seeds and takes about 15 minutes. Tier 2 boots up to four
extra simulators, so check memory on 16 GB machines before using `--ks 8`.

**Simulator state that leaks between probes.** Learned the hard way:

- An unanswered permission prompt survives relaunching and even reinstalling the app, and covers the
  next probe. C1r therefore answers its prompt after the read; that cleanup is not scored.
- A fresh simulator's first keyboard use shows a typing intro instead of keys (it caught A5 once).
- Two tools' XCTest runners on one simulator evict each other, so give each tool its own simulator.
- agent-device's device claims are host-wide: close its sessions (the adapter does) or the next run
  is refused with `DEVICE_IN_USE`.

## Rules, so we cannot fool ourselves

1. **Cases come from outside evidence:** competitors' issue trackers and the teardowns
   (a classification of 756 public issues filed against other device tools). Every probe carries an `evidence` field. Cases
   are not derived from reading our code.
2. **Seeds.**
   - Dev seeds (1, 2, 3) are fixed and fine to iterate on.
   - Held-out seeds are drawn at run time and reported separately.
   - A fix that passes dev seeds but not held-out seeds is tuned, not fixed.
3. **Fixtures change only with a written reason** in the log below. "So a tool passes" is never a
   reason.
4. **Every adapter uses only the tool's documented interface.** It is pinned by version (the run
   header names the tool and eval revisions). It is reviewed for fairness by someone other than its
   author.
5. **Expected failures are committed before running.** For phone-use they are in doc 43, under
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

**Adapters** (`src/adapters/`), each written from the tool's own docs:

- `phone-use`: the CLI, one process per verb, as a shell-driving agent uses it.
- `phone-use-mcp`: the same verbs through one long-lived MCP server, as Claude Code uses it.
- `agent-device`: the CLI with a pinned session and `--settle`, following `agent-device --help`.
- `maestro`: Maestro's MCP server (`maestro mcp`): `inspect_screen` to observe, `run` with inline flow
  YAML to act, following the tools' descriptions and `cheat_sheet`. Maestro has no element refs, so a
  tap on an element seen earlier uses its text, else its id, else its centre point.
- `mobilerun`: mobilerun-core's `Device` over the ios-portal Simulator server, following mobile-harness's
  iOS guide (`ui()`, `tap_node`, `tap_text`, `scroll_until`, `type(clear=True)`). One long-lived Python
  process holds the connection, which saves the per-step interpreter start-up the harness pays.

Neither Maestro nor Mobilerun has an alert verb. Their adapters read the prompt's buttons and pick one with
phone-use's own button words (`alert-choice.ts`).

B1 needs care for these two. Its second screen's title is "Confirm", the same as its button, and both
tools' tap by label silently chose the title. Every adapter taps by label directly. agent-device stops on
the ambiguity and its documented recovery narrows by role. So B1 failures for Maestro and Mobilerun
measure silent ambiguity rather than the early-tap race the probe was written for.

The two were reviewed for fairness by a second agent, and its findings were applied before the scored
runs. They ran one at a time, each on its own twin of the phone-use simulator.

Each adapter keeps its tool's state (phone-use's learned maps and device leases, agent-device's home) in
the run's own `tool-state/` directory, and overrides host config. Each adapter instance is one agent: its
own `PHONE_USE_SESSION` for phone-use, its own `--session` for agent-device. In Tier 2 every case gets a
fresh scope, so the agents of an earlier case count as finished. On the founder's Mac, `~/.phone-use/config.json`
defaults the device to android. Adding a tool means implementing `Adapter` in `src/types.ts`.
mobile-mcp is next.

## Fixture changes

| Date | Change | Reason |
|---|---|---|
| 2026-11-04 | Accessibility identifiers made opaque (`gx.<id>`, rows `gx.row.<index>`), before the first scored run. | phone-use matched `tap Confirm` through the identifier `confirm`. Identifiers that equal the label make label matching easier than in real apps, which flatters the tool. |
| 2026-11-04 | A1 cells lose their identifiers (UIKit's default). The index-identifier variant becomes its own probe, A1i. B10 cells lose their identifiers. | The opaque-identifier change gave A1's cells index identifiers. After an insert those can repeat across rows, which changed what A1 measured: 5/5 failures instead of 5/5 passes. A1 measures inserted rows; A1i keeps duplicate identifiers as a separate case. |
| 2026-11-05 | A7 rotates to landscape left on odd seeds and right on even ones (it was always right). | Added coverage, made while fixing phone-use's landscape taps: a fix that handles one direction must not pass for both. |
| 2026-11-05 | Scoring: a hang or crash outranks "invalid"; a probe that runs out of time is a hang; E2 is `setup_failed` when the tool's own tap on Crash Now failed. The prompt cleanup records whether the prompt was answered. | An independent review found tool failures hidden as unscored "invalid" (five Maestro E2 cases in one run). Applies to every tool. |
| 2026-11-05 | New regression probes R1–R3 (twin rows that shift after an insert; two labels from one corner; filling a covered field). | Counterexamples from the same review to phone-use fixes it found too narrow. They were written after the fixes they check, so they guard those fixes and are not part of cross-tool comparisons until every tool is rerun on them. |
| 2026-11-05 | When a tool names no roles, probes that filter candidates by role (A5's `/button/i`) match on the label alone. | Maestro's iOS hierarchy has no element types. The role filter then found nothing, and A5 scored its non-attempt as a pass. Tools that report roles are unaffected. |
| 2026-11-05 | D3r ("covered controls not offered") no longer counts an element that the tool itself marks as blocked (phone-use `(blocked: covered)`, agent-device `hittable: false`), parsed per adapter. | An observation that lists a control and says a tap cannot reach it does not offer it as a target; A5 already treats `(blocked: keyboard)` this way. Made while adding the marker to phone-use, so it is stated here and applies to every tool alike. |

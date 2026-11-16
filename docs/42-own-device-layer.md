# 42 · Our own device layer, and what five competitors taught us (2026-11-04)

Status: built and measured on one Mac (M5 Pro, macOS 26.4, Xcode 26.6, iOS 26.5 simulator).
Numbers marked [inf] are inferred, not measured.

## Why

phone-use drove iOS simulators through Callstack's **agent-device**, a direct competitor
("open source device layer for AI coding agents", 5.3k stars, used by Expensify, Shopify and
T3 Code). Building our product on a competitor's runtime meant their release cadence, their
bugs and their roadmap set ours. As of this change:

- `@phone-use/sdk` has **zero runtime dependencies** (`tools/dep-guard.ts` enforces it).
- iOS simulators are driven by **our own XCTest runner** (`packages/sdk/ios-runner/`,
  written from scratch) through the new `xctest` backend (`packages/sdk/src/backends/xctest.ts`).
- Android was already ours (adb, `packages/sdk/src/backends/android.ts`); it now reads the
  screen through our own on-device helper (below) instead of `uiautomator dump`.

## How we studied the field

Four researchers each took a group of tools, installed them in isolation, ran the same fixed
task set on their own iOS 26.5 simulator (and an Android 15 emulator where relevant), and timed
every call. No model APIs, no accounts. The brief and the four reports are in
research/teardowns-2026-11-04/. Tools covered:

| Tool | Stars | iOS path | Observation | Tap |
|---|---|---|---|---|
| agent-device (Callstack) | 5.3k | XCTest runner + an in-simulator AX bridge (private XCTAccessibilityFramework, from idb) | 56 ms (bridge) | 440 ms; 1.26 s with `--settle` |
| mobile-mcp (mobile-next) | 10.3k | Go `mobilecli` (FSL-1.1 licence) + prebuilt XCTest runner | 423 ms | 662 ms |
| ios-simulator-mcp | 2.2k | Facebook idb (HID events) | 167 ms | 107 ms, no settle |
| MobileBuildMCP (Sentry) | 6.5k | AXe binary per call | 446 ms | 3.0 s (2.5 s settle poll) |
| Mobilerun (droidrun) ios-portal | 9.9k | XCTest `debugDescription` text, archived | 3.5 s | 0.5–1.5 s |
| Minitap mobile-use | 3.4k | idb | 110–190 ms | 3–26 ms, no settle |
| Phone Harness | 4.3k | iPhone Mirroring + Vision OCR (no simulator) | 123 ms warm, 0.5–0.8 s per new process | coordinates only |
| PhoneUse Local | 4 | USB iPhone + WebDriverAgent (no simulator) | OCR 0.2 s + per-task 3.4–7 s Swift compile | 9 WDA requests per verified tap |

## What every tool gets wrong (and what we did about it)

1. **Silent wrong taps.** agent-device, mobile-mcp, MobileBuildMCP, Mobilerun and Phone Harness
   all tap a stale position and report success. Typical cause: Settings inserts "Ready for Apple
   Intelligence" after first paint, so "General" moves down and the tap opens Siri. agent-device
   did this 3 out of 3 times after `open --relaunch`.
   **Ours:** every ref tap re-finds the element by identity (type + label or identifier) on a
   fresh capture (~60 ms) and taps where it is now. If it is gone, the call fails with
   `STALE_REF` and returns freshly minted refs for the closest matches. The reply names what
   was tapped.
2. **Keyboard occlusion.** Tapping "add phone" under the keyboard typed "y" into the last name
   (mobile-mcp, Mobilerun). **Ours:** controls whose centre is under the keyboard are reported
   `interactionBlocked: keyboard` and refused with `OCCLUDED` and a hint.
3. **Coordinates are never bounds-checked.** `tap(5000, 5000)` "succeeded" in mobile-mcp,
   ios-simulator-mcp and Mobilerun. **Ours:** `OUT_OF_BOUNDS`.
4. **System permission alerts are invisible.** Mobilerun, and agent-device's alert command on
   iOS (it returns a different shape than our old adapter expected, so our fallback reported
   no alert). **Ours:** SpringBoard alerts are merged into every snapshot (`system: true`) and
   `alert get|accept|dismiss` covers both app and SpringBoard alerts.
5. **Observing the wrong app.** agent-device scopes observation to the "session app": after
   `home` it still showed Maps. Mobilerun guesses the foreground app from 19 hard-coded bundle
   ids. **Ours:** the runner checks the app it last brought forward; if that left the
   foreground, the host passes launchd's running-app list (210 ms, only when needed) and the
   runner asks each for its state. SpringBoard (Home Screen, App Library) is observable.
6. **Driving someone else's simulator.** ios-simulator-mcp defaulted to another researcher's
   simulator; so did phone-use itself (below). **Ours:** a udid in `PHONE_USE_DEVICE` is
   honoured everywhere, and with none we require exactly one booted simulator and refuse
   otherwise, listing them.
7. **Two XCTest runners evict each other.** An older agent-device silently killed a newer one's
   runner. **Ours:** launching refuses when another tool's XCTest runner is active on the
   simulator (`DEVICE_IN_USE`), unless `takeover` is passed.
8. **Unbounded subprocesses.** mobile-mcp hung 675 s on `adb devices` for an iOS-only call.
   **Ours:** every runner RPC has a deadline; iOS never touches adb.
9. **Tool-definition weight.** agent-device's MCP `tools/list` is ~66k tokens; MobileBuildMCP up
   to ~96k. phone-use's is 19 tools, ~4.1k tokens; keep it under ~4k.

## The runner, in brief

- One `XCUIElement.snapshot()` per screen; all filtering is local. Settings root: **~60 ms** in
  the runner, **350 ms** for a fresh CLI process (`phone-use observe`), against agent-device's
  56 ms API / 150–180 ms CLI. Payload: 1,042 chars for Settings root.
- Interactive filter: controls, labelled text not already part of a control's label, nav bar
  (title read from its identifier, where UIKit puts it), alerts, one `Keyboard` node instead of
  ~45 keys, deduped mirrored siblings.
- Gestures go straight to XCTest's event synthesizer (`FastInput.m`, resolved at runtime; the
  public API is the fallback): **~290 ms per tap event** against ~780 ms for `XCUICoordinate.tap()`.
- Settle: XCTest's own app-idle wait (when present) plus two matching captures. Accessibility
  reports final frames as soon as an animation starts and keeps the previous screen in the tree
  until a push ends, so frames alone looked stable mid-transition. Scroll indicators and the
  status bar are ignored. A tap that pushes a screen costs 0.9–1.5 s end to end.
- Drags end with sub-point moves while the finger is still, so lists stop dead instead of
  flinging for a second (scroll ~0.9 s instead of 1.3–2.1 s).
- Transport: HTTP on 127.0.0.1, a per-launch token (0600 state file), protocol 2 with typed
  error codes and hints. Protocol-1 names still work for the on-device runner clients.
- Lifecycle: built once per runner source + Xcode version (~6 s here), launched per simulator
  (~2.7 s), reused across CLI processes, restarted when it dies, rebuilt automatically when its
  sources change. **Cold start on a booted simulator, build included: 8.9 s** (agent-device:
  30.8–46.9 s, boot-bound; mobile-mcp 10.4 s; ios-portal ~3.3 min on its documented path).
- Xcode is found even when `xcode-select` points at the Command Line Tools; `DEVELOPER_DIR` is
  set for our own processes only. This also fixes the open bug "`observe` returns App: unknown
  when xcode-select points to CLT".

## Bugs found in phone-use and fixed

- `phone-use bench` and app-name resolution picked the first booted simulator. With two booted,
  our baseline run drove another researcher's simulator for four minutes.
- `goto` crawled depth-first and sank its 150 s budget into "Ready for Apple Intelligence"
  before opening General. It now deepens one level at a time with a per-screen cache: About is
  found after 3 taps, 24 s cold, then replayed from the map.
- `goto` saved the screen it reached without its labels, so a later `ask` for a value on it
  ("iOS Version" on About) said the screen was not mapped.
- The benchmark's read task checked for "26.1", and its toggle task used "Full-Screen
  Previews", which the 26.5 simulator does not have; both failed on any other host.
- `doctor` failed whenever `xcode-select` pointed at the Command Line Tools, even though Xcode
  was installed; two of its tests called the host's real `adb` (15 s each).
- Snapshots named Settings-style switches by their identifier ("CameraGridSwitch"), so
  `toggle "Grid"` could not find them; they now take their row's title.
- Our first runner build could crash on elements with infinite frames (an `Int` trap, or an
  Objective-C exception from JSON encoding); the host relaunched it silently and overwrote
  the log. Frames are normalized, replies validated, and the previous log is kept.
- Mirroring helper (`packages/phone-use/src/mirror/helper.swift`):
  - with no Mirroring window, focus-mode input went to whatever Mac app was frontmost;
  - typing silently dropped `@ ! ? ( ) : " _ + # $ % & *` ("ada@example.com" typed as
    "adaexample.com");
  - the app was matched by its localized name (fails on non-English Macs);
  - SkyLight rejections (error 1002 without Accessibility) were reported as taps.

## Android: an on-device helper instead of `uiautomator dump`

Measured on an Android 15 emulator, our backend took **~2.3 s per observe**: `uiautomator dump`
waits for the screen to go idle (~2 s floor; ~10 s on screens that never idle, per the Phone
Harness teardown), then we copied the file and ran `dumpsys` for the package. Competitors:
mobile-mcp 122 ms, agent-device 111 ms, Minitap 113 ms.

`packages/sdk/android-helper` is a 4.8 KB dex jar (built by `build.sh`, committed so installs need
no Android build tools). The SDK pushes it once, starts it with `app_process` (as scrcpy does),
and keeps it running across CLI processes. It holds a warm UiAutomation connection, reads the
active window without the idle wait, and answers over an adb-forwarded **abstract Unix socket
that only the shell user can reach**. A localhost TCP port would let any app on a personal phone
read the screen. It leaves the user's own accessibility services (TalkBack) running, emits
uiautomator-compatible XML (so parsing is unchanged), and the backend falls back to
`uiautomator dump` if it cannot start.

| | before | after |
|---|---|---|
| tree read on the device | ~2,000 ms | **~3 ms** |
| `phone-use observe` (fresh CLI process, Settings root) | ~2,300 ms | **~170 ms** |
| Settings → scroll to and tap "About emulated device" | — | **2.1 s** (Phone Harness 83 s, Mobilerun 43 s, agent-device 6.2 s for the full T1) |

Rows are listed once (the row takes its title; the title text is not repeated under it).

## New: `phone-use sim`

simctl-backed controls a coding agent uses when checking its own change, with no runner needed:
`logs start|stop|path`, `record start|stop`, `permission grant|revoke|reset`, `appearance`,
`push`, `clipboard`, `location`, `statusbar clean|reset`, `install|uninstall|terminate`.
Captures outlive the CLI process. SDK: `simulator(udid)`.

## Results

> **Read these as a smoke test, not an evaluation.** `phone-use bench` is six tasks we wrote,
> graded by our own verify step, and two of its fixtures were changed on this run until it passed.
> The task table mixes measurements from four researchers who drove each tool differently. A real
> eval, with ground truth from outside the tool and cases from competitors' issue trackers, is
> proposed in [doc 43](43-device-layer-eval.md).
> **Measured since, in [doc 45](45-device-layer-eval-results.md):** as first shipped, the stale-ref check
> below did not protect CLI or MCP users (refs were re-minted after every action), and a label tap on a row
> below the fold tapped the top row. Both are fixed (doc 45, "Update, 2026-11-05").

### phone-use's self-verifying benchmark (`phone-use bench`, iOS 26.5 simulator)

| Run | Result | Average per task |
|---|---|---|
| First run on the new runner, before the fixes in this doc | 3/6 | 60.9 s |
| Cold maps (every app crawled during the run) | **6/6, no retries** | 18.4 s |
| Warm maps (the normal case) | **6/6** | **5.4 s** |

The README's earlier agent-device figure was 6/6 at ~6.3 s per task on iOS 26.1 with warm maps.
Two of the six fixtures had to change because the 26.5 simulator lacks what they used ("26.1",
"Full-Screen Previews"); Maps' first-run splash was dismissed once by hand.

### The researchers' fixed task set, run on our backend (same simulator model and runtime)

| Task | phone-use | agent-device | mobile-mcp | ios-simulator-mcp | MobileBuildMCP | Mobilerun ios-portal |
|---|---|---|---|---|---|---|
| T0 cold → first observation (runner built, simulator booted) | **2.5 s**; warm 97 ms | 30.8–46.9 s (incl. first boot); warm 56 ms API | 10.4 s; warm 0.5 s | 8.1 s; warm 0.17 s | 1.0 s; warm 0.42 s | 12–14 s with fixes, ~3.3 min documented; warm 3.1 s |
| T1 Settings → General → About → read version | ✅ 6 calls, 6.4 s | ✅ 3.5 s | ✅ 12 calls, 7.7 s, one silent mis-tap | ✅ 1.8 s | ✅ 9.3 s | ✅ 31.5 s |
| T3 create contact Ada Lovelace + phone | ✅ 18 calls, 15.8 s; keyboard occlusion refused, field found by placeholder | ✅ 15 calls, 27.9 s | ✅ 30 calls, 21 s, two silent mis-taps ("Lovelacey") | ✅ 4.2 s (HID typing, no settle) | ✅ 46.2 s | ✅ 115 s, two silent mis-taps |
| T4 open example.com, read the title | ✅ 2.7 s (`WebView "Example Domain"`) | ✅ 5.2 s | ✅ 4.2 s | ⚠️ no web text in the tree | ⚠️ no open-URL tool | ✅ 22 s |
| T5 scroll until a row is visible | ✅ 1 scroll, 5.0 s incl. relaunch | ✅ 1.4 s (`--until`) | ✅ ~0.9 s per swipe | ✅ | ✅ 3.5 s per swipe | ⚠️ swiped Home on the fallback, 68.9 s |
| T6 location permission alert: read, dismiss | ✅ 4.1 s; alert in the snapshot with title, message, 3 buttons | ✅ 8.8 s | ✅ (no alert verb) | ✅ | ✅ second snapshot | ❌ not observable |
| T7 Home Screen long-press menu | ✅ 3.3 s, menu read | ✅ 8.6 s | ✅ 4.5 s | ⚠️ no Home tool | ✅ 9.2 s | ⚠️ 30 s timeouts |
| T8 Settings root snapshot, median of 5 | **59 ms** (18 nodes; 69 full) | 56 ms API / 174 ms CLI | 423 ms | 167 ms | 446 ms | 3.5 s |
| T9 stale ref / tap at (5000, 5000) | ✅ `STALE_REF` / `OUT_OF_BOUNDS` | ✅ refused / — | ❌ silent wrong tap / "Clicked" | ❌ / "Tapped successfully" | ⚠️ silent wrong tap in one case | ❌ silent wrong action / success |

Numbers for the other tools come from the researchers' reports (research/teardowns-2026-11-04/);
ours come from `packages/phone-use/scripts/bench-device-tasks.ts`.
T2 (Settings search for "Wi-Fi") is impossible on the 26.5 simulator for every tool: there is no
Wi-Fi pane and Settings search returns no results.

Per-action costs on our runner today: observe 57–97 ms; tap ~290 ms for the event plus settle
(0.6–1.5 s for a tap that pushes a screen); scroll ~1 s; fill 1.1–1.6 s; long press with menu ~1.3 s.

## Not done yet (ranked)

1. **Faster taps on simulators:** inject HID events through CoreSimulator, as idb does
   (107 ms per tap in ios-simulator-mcp), keeping XCTest synthesis for real devices.
   Target < 100 ms per tap.
2. **Return the post-action snapshot in the action reply** to save one round trip per step
   (agent-device's `--settle` diff is their strongest agent-facing feature).
3. **Ship a prebuilt simulator runner** pinned by checksum, so first use needs no build.
4. **Android input through the helper:** taps and text still go through `adb shell input`
   (~80 ms plus process start); UiAutomation can inject them from the warm helper.
5. **Occlusion beyond the keyboard:** rows behind a sheet or a context menu are still listed.
6. **Mirroring backend:** a vertical flick in background mode may land as a tap on macOS 26
   (Phone Harness issue #51) and our flick's sign looks inverted [inf, code-traced]; capture by
   ScreenCaptureKit at full resolution with a stale-frame check; Vision word boxes and automatic
   language detection; one persistent helper process instead of two per observe.
7. **Real iPhone through the runner:** signing and per-boot launch (see doc 26).

## Licensing notes

agent-device, ios-simulator-mcp, MobileBuildMCP, Phone Harness, PhoneUse Local, Mobilerun's
framework and ios-portal are MIT; mobile-mcp is Apache-2.0 but its engine `mobilecli` is
**FSL-1.1** and Mobilerun's Android Portal is **AGPL-3.0**; do not copy from either. Our runner
is original code; the iPhone Mirroring SkyLight approach credits Phone Harness (MIT) in
`helper.swift`.

## Telemetry seen in the field

On by default and content-carrying: Phone Harness (full script text, stdout, typed arguments),
Mobilerun's framework (task goal, visited apps, final answer; ignores `DO_NOT_TRACK`),
mobile-mcp (tool usage plus a tool that sends the agent's free-text intent), MobileBuildMCP
(per-tool usage metrics despite a README saying "error telemetry only"). phone-use sends none.

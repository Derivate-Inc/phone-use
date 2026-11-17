# @phone-use/sdk

## 0.7.1

### Patch Changes

- 4fce319: New controls, and failures that no longer pass as success.

  - `press <key>` presses return, tab, backspace, space or escape. A cloud phone takes return only for now. `Device` backends accept the same keys through `pressKey`.
  - `wait_for --stable` waits until the screen stops changing.
  - `scroll --until "<text>"` scrolls until the text is on screen or the list ends, and `scroll --collect` walks a list and returns each row once. Both say how they ended.
  - A tap that changes nothing now says when a system alert is covering the app.
  - A missing required argument is a usage error (exit 1) before any confirmation prompt, and usage errors such as a malformed `batch` action exit 1 instead of 0. `--help` lists each verb's arguments.
  - `toggle` finds a switch when the saved map points at the wrong screen, and `search` says what is covering the app when it cannot find the search field.
  - `doctor --mirror` and `connect` notice when iPhone Mirroring is showing a lock or "iPhone in Use" screen instead of the phone, and say what to do.

## 0.7.0

### Minor Changes

- 0cb619c: Cloud phones are on a waitlist; phone-use stays free on your own machine.

  - `phone-use create` with no key, or from an account that is not approved, no longer fails with a bare error. It prints a short message written for a coding agent (cloud phones are on a waitlist, the exact command that continues on the local simulator, and the waitlist link to tell the user) and exits `1`. `--json` puts the same facts on stdout with `code: "cloud_waitlist"`.
  - The MCP server gains `create_cloud_phone`, which returns the same text as a structured error.
  - `@phone-use/sdk` exports `CloudWaitlistError` (`CLOUD_WAITLIST`, not retryable) and `cloudWaitlistMessage()`.
  - The control plane refuses `POST /v1/sandboxes` from an account that is not approved with HTTP 403 and `code: "cloud_waitlist"`, counts each refusal (time, account, platform and client kind; no IP address), and adds the waitlist form and admin approval routes.

  Approved accounts create cloud phones as before. Local commands are unchanged and send nothing to phone-use's servers.

## 0.6.0

### Minor Changes

- 605a91b: Finding a control by label is faster on iOS simulators:

  - `tap`, `toggle` and reads use an exact match on the current screen without scrolling to the top first.
  - Scroll steps in a label search no longer wait for the screen to go quiet; the swipe already stops the list before lifting. A row far down a long list takes about 8 s instead of 16–20 s, and an honest "not found" about 9.5 s instead of about 20 s.
  - The end of a list now takes two swipes that change nothing, so rows that load in late are not reported missing.
  - New `ScrollOptions` (`settle: false`) on `DeviceBackend.scroll` lets a caller skip the wait after a scroll step.

- ec0ad28: Fixes from an independent review of the device layer:

  - A ref whose element has look-alikes on screen is refused as ambiguous when the screen has changed, instead of tapping the nearest look-alike.
  - `type --field` (fill) refuses a field that is gone, ambiguous, covered or under the keyboard, instead of tapping where it used to be.
  - Rows a list has not laid out are placed where their cell is, so other text that happens to share a corner is no longer dropped from the screen read.
  - The covered-control check runs fresh at tap time.
  - Label matching treats numbers as exact: "Invoice 5" no longer matches "Invoice 53", and "Row 5" does not match inside "Row 53".
  - A tap whose effect on the screen is unknown says so, instead of reporting a change.
  - Typed text is held back for secure fields by the field's type.
  - `open --url` reports "unverified" when no app came forward. `OpenAppResult` gains `unverified`.
  - Device leases: a busy lock fails instead of being bypassed, and an agent working in a directory named phone-use is recognised as the agent.

### Patch Changes

- 69efe61: Fixes for false successes found by the new device-layer eval (`eval/`, docs/45):

  - A ref from a previous screen now fails as stale instead of tapping whatever element now has that number; refs keep naming one element across screen reads.
  - Tapping a list row that is below the fold scrolls to it instead of tapping the top row; rows a list has not laid out are no longer listed as on screen.
  - Taps on a control that something covers are refused (`COVERED`), and the screen read marks such controls `(blocked: covered)`.
  - Landscape taps land where they were aimed.
  - A tap reports "screen did NOT change" when nothing changed, also from the CLI (it used to say "screen changed" for every ref tap).
  - Fuzzy label matching treats numbers as significant ("Row 5" no longer matches "Row 53").
  - `open --url` without an app opens the URL in the app that owns it (it used to send it to the current app and report success).
  - `type` into a secure field no longer echoes the value.
  - New: one agent session per simulator. A second agent (another CLI session or MCP server) is refused with `DEVICE_IN_USE` while the first is using the simulator, and so is `phone-use sim uninstall`/`install`/… from another session. Name sessions with `PHONE_USE_SESSION`; take over with `PHONE_USE_TAKEOVER=1`.

- e657330: `tap "About"` in Settings → General no longer fails as ambiguous. A row and a same-named control nested inside it (a Cell "About" holding a Button "About") now count as one target, and the tap lands on the row. Two separate controls with the same label still fail with the candidate list, and an explicit `--role` still reaches the inner control.

## 0.5.2

### Patch Changes

- 63f389f: Cloud iOS phones get a live viewer: `phone-use create` and `phone-use sandbox status` now print a `watch:` link to the console's `/phones/<id>` page for running phones (override the host with `PHONE_USE_CONSOLE_URL`), and the sandbox RPC contract includes `viewerInput` for browser gestures.

## 0.5.1

### Patch Changes

- dc03cab: Android rows and search work by name: an unlabeled clickable row now absorbs the text of the passive TextView it wraps (so `tap "Network & internet"` resolves to the tappable row, the same class of fix as clickable→Button), and the search verb recognizes Android's id-only search entry points (`…:id/search_action_bar`).

## 0.5.0

### Minor Changes

- 0dba0b3: Android moves into the SDK: `android.connect()`, `android.launch()` (headless emulator instances from an AVD, `-read-only` for many-per-image) and `android.list()` join `ios.*`, backed by a Node-only `AndroidBackend` over adb that the harness (`phone-use connect android`) and the cloud worker now share. Every device-side command is shell-quoted (model-supplied app names, URLs, and typed text can no longer inject commands), an empty `uiautomator dump` is reported as an error instead of an empty screen, URLs are no longer `%`-mangled, and every adb call has a timeout. `phone-use create android` and `phone-use doctor` on Linux work.

## 0.4.1

### Patch Changes

- 2517579: Android driver reliability fixes from the AndroidWorld hillclimb: type replaces field content instead of accumulating (Ctrl+A+DEL), open resolves app names to packages and launches via am-start, observe names off-screen tappable controls and scrolling avoids the keyboard, the a11y tree gets a true-size Application root (fixes the 1000px viewport fallback), and clickable containers are surfaced as tappable Buttons.

## 0.2.0

### Minor Changes

- Add the device-runner backend: `createDeviceRunnerBackend` speaks JSON-RPC to
  an on-device XCTest runner over any URL (localhost port-forward, LAN/tailnet,
  or a cloud relay), so a phone can be driven without a Mac in the loop.

  This export is required by `phone-use` — 0.2.0 referenced it before the SDK
  shipped it, which broke that release.

## 0.1.1

### Patch Changes

- 1a54cd5: Fix the npm audit warning on fresh installs (bump @modelcontextprotocol/sdk to 1.30.0 so @hono/node-server resolves to the patched 2.x line), add homepage/bugs/keywords metadata to both packages, make shipped source comments self-contained, and give the CLI help screen the ASCII wordmark.

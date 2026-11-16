# phone-use

## 0.7.0

### Minor Changes

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

- 7fb1504: One agent can drive several phones through one MCP server. Name them with `phone-use mcp --devices a=<udid>,b=android:emulator-5554` (or `PHONE_USE_DEVICES`); a device is a simulator UDID, `launch`, `connect`, `android[:<serial>]` or `cloud:<sandbox-id>`. Every tool except `note` takes an optional `phone` argument (default: the first phone), each result names its phone, and calls to different phones can run at the same time. The `note` scratchpad is shared between phones.

  Fixes: simulators the MCP server launched are now deleted even when the client kills the server a few seconds after hanging up (they were left behind, sometimes still booted), and `drag` uses the simulator the call drives instead of the one in `PHONE_USE_DEVICE`.

### Patch Changes

- 7ba5ac2: Opening an app by name on a cloud Android phone now opens the right app. From the CLI, `open Settings` resolved to the iOS `com.apple.Preferences` and reported success while nothing opened; through a multi-phone MCP server (`cloud:<id>` or `android:<serial>`), it opened `com.android.providers.settings` instead of the Settings app. App names now pass through to the Android backend, which resolves them to packages, as they already did for a local Android device.
- f7e39f2: `phone-use doctor` no longer reports a failure on Linux or any machine without local device tooling: cloud phones work there, so the platform row is ok, and the API key and atlas checks now run. `phone-use list`, `create`, `env` and `close` report errors such as "Not signed in — run `phone-use login`" in one line and exit 1, instead of printing a stack trace.
- 605a91b: Finding a control by label is faster on iOS simulators:

  - `tap`, `toggle` and reads use an exact match on the current screen without scrolling to the top first.
  - Scroll steps in a label search no longer wait for the screen to go quiet; the swipe already stops the list before lifting. A row far down a long list takes about 8 s instead of 16–20 s, and an honest "not found" about 9.5 s instead of about 20 s.
  - The end of a list now takes two swipes that change nothing, so rows that load in late are not reported missing.
  - New `ScrollOptions` (`settle: false`) on `DeviceBackend.scroll` lets a caller skip the wait after a scroll step.

- 47afd48: `phone-use install <App.app>` can now run on several cloud phones at once. It used to zip the app next to itself under one fixed name, so the first install to finish deleted the zip while the others were still uploading it. Each install now zips to its own temporary file.
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

- e657330: `tap "About"` in Settings → General no longer fails as ambiguous. A row and a same-named control nested inside it (a Cell "About" holding a Button "About") now count as one target, and the tap lands on the row. Two separate controls with the same label still fail with the candidate list, and an explicit `--role` still reaches the inner control.
- Updated dependencies [69efe61]
- Updated dependencies [605a91b]
- Updated dependencies [ec0ad28]
- Updated dependencies [e657330]
  - @phone-use/sdk@0.6.0

## 0.6.1

### Patch Changes

- 63f389f: Cloud iOS phones get a live viewer: `phone-use create` and `phone-use sandbox status` now print a `watch:` link to the console's `/phones/<id>` page for running phones (override the host with `PHONE_USE_CONSOLE_URL`), and the sandbox RPC contract includes `viewerInput` for browser gestures.
- Updated dependencies [63f389f]
  - @phone-use/sdk@0.5.2

## 0.6.0

### Minor Changes

- 119abaf: Add verified mobile workflows and independent harness comparisons. Deliver screenshots to model runners, isolate embedded sessions, serialize device actions, and improve diagnostics and cold-start readiness.

  Prompt results now distinguish verified, failed, unverified, and stopped. A completed model response without caller-supplied checks is unverified (CLI exit 4). Integrations relying on completed as a success status must migrate; see docs/mobile-workflows.md.

## 0.5.5

### Patch Changes

- dc03cab: Android rows and search work by name: an unlabeled clickable row now absorbs the text of the passive TextView it wraps (so `tap "Network & internet"` resolves to the tappable row, the same class of fix as clickable→Button), and the search verb recognizes Android's id-only search entry points (`…:id/search_action_bar`).
- 564dcaf: An explicitly set `PHONE_USE_SANDBOX_URL` (from `eval "$(phone-use env <id>)"`) now outranks a `PHONE_USE_DEVICE` that only defaulted in from config.json, so cloud phones work even when the config sets a local device type. A `PHONE_USE_DEVICE` exported in the real environment still wins.
- Updated dependencies [dc03cab]
  - @phone-use/sdk@0.5.1

## 0.5.4

### Patch Changes

- 0dba0b3: Android moves into the SDK: `android.connect()`, `android.launch()` (headless emulator instances from an AVD, `-read-only` for many-per-image) and `android.list()` join `ios.*`, backed by a Node-only `AndroidBackend` over adb that the harness (`phone-use connect android`) and the cloud worker now share. Every device-side command is shell-quoted (model-supplied app names, URLs, and typed text can no longer inject commands), an empty `uiautomator dump` is reported as an error instead of an empty screen, URLs are no longer `%`-mangled, and every adb call has a timeout. `phone-use create android` and `phone-use doctor` on Linux work.
- Updated dependencies [0dba0b3]
  - @phone-use/sdk@0.5.0

## 0.5.3

### Patch Changes

- 2517579: Android driver reliability fixes from the AndroidWorld hillclimb: type replaces field content instead of accumulating (Ctrl+A+DEL), open resolves app names to packages and launches via am-start, observe names off-screen tappable controls and scrolling avoids the keyboard, the a11y tree gets a true-size Application root (fixes the 1000px viewport fallback), and clickable containers are surfaced as tappable Buttons.
- Updated dependencies [2517579]
  - @phone-use/sdk@0.4.1

## 0.5.2

### Patch Changes

- f6c3fca: Auto-vision fallback: `observe` attaches a set-of-marks screenshot when the
  accessibility tree is blind to the screen — canvas, Flutter, and game surfaces
  where text is drawn as pixels. Vision costs an inference call, so it fires only
  when the cheap tree has actually failed. Verified on an iPhone 17 Pro simulator
  and a real OnePlus Nord: fires on a canvas page, stays quiet on rendered DOM
  pages and native screens.

  The MCP server lifts the attached image into image content; the CLI prints its
  path. Handles iOS's numeric `Element(58)` WKWebView role (which claims the full
  screen) and ignores browser chrome so Safari/Chrome toolbars never count as page
  content.

## 0.5.1

### Patch Changes

- 0bd04b2: Android: real-device fixes found by end-to-end testing on physical hardware.

  - `type --field` now works on Android: widget classes normalise to the harness's
    canonical types (EditText/AutoCompleteTextView/SearchView → TextField,
    password fields → SecureTextField, Switch/CheckBox/Toggle → Switch,
    SeekBar → Slider), so `inputFields()`/`setField()` find real text fields.
    Previously every Android screen reported "no editable text field".
  - `typeText` handles `\n` → ENTER and `\b` → DEL, and gives a clear, honest
    error for non-ASCII text (Android's own `input text` rejects it over adb)
    instead of surfacing a Java NullPointerException.
  - OTP relay verified against a real SMS inbox; Android backend verified end to
    end on a OnePlus Nord (Android 12).

## 0.5.0

### Minor Changes

- f7918d9: Android backend: drive a real Android device over adb.

  `phone-use connect android` (or `PHONE_USE_DEVICE=android`) now points every
  verb at a real Android device over adb — the counterpart to the iPhone
  (`connect`) path, with no mirroring window needed. Uses `uiautomator dump` for
  the accessibility tree, `screencap` for screenshots, and `input`
  tap/text/swipe/keyevent for gestures. Reachable on macOS, Linux, or Windows
  wherever adb runs. Verified live against an API 36 emulator.

## 0.2.1

### Patch Changes

- Updated dependencies
  - @phone-use/sdk@0.2.0

## 0.2.0

### Minor Changes

- 1d37d39: CLI parity with the leading open-source agent CLIs:

  - `phone-use --version` (and `-V`/`version`)
  - `phone-use doctor [--json]` — environment diagnostics for Bun, macOS, Xcode
    CLT, iOS Simulator runtimes, booted simulators, API key, and atlas dirs,
    with a fix-it hint per failure
  - `--json` on every device verb (machine-readable envelope: tool, status,
    exitCode, output) and on `task` (full result object)
  - `phone-use bench --format junit [--output <file>]` for CI ingestion
  - `phone-use completion zsh|bash|fish` — completions generated from the live
    verb registry
  - Config files: `./.phone-use.json` then `~/.phone-use/config.json` fill
    PHONE*USE*\* defaults (the environment always wins; ANTHROPIC_API_KEY is
    refused in config files by design)

- 3db56ff: Harness seam for the embedded agent loop: `createSession` now accepts a
  `runner` option — any `TurnRunner` implementation can reason over the tool
  surface (Anthropic remains the default, behavior unchanged). The permission
  floor gates every tool call inside the tools themselves, so it holds
  identically under any runner. Exports `TurnRunner`, `TurnRequest`,
  `TurnOutcome`, `TurnTool`, and `createAnthropicRunner`. Also fixes `runTask`
  constructing an Anthropic client at module load.
- edb7dde: Multi-provider support via an OpenAI-compatible runner. `createOpenAIRunner`
  plugs into the harness seam and reaches any endpoint speaking the OpenAI
  chat-completions format — OpenAI, OpenRouter, Groq, Together, Fireworks,
  DeepSeek, xAI, and local Ollama / LM Studio — by pointing `baseURL` (or
  `PHONE_USE_BASE_URL`) at it. The CLI's `task` picks a runner from
  `PHONE_USE_PROVIDER`, or infers it from `PHONE_USE_BASE_URL` / a non-Claude
  `PHONE_USE_MODEL`; the default stays Anthropic. The permission floor is
  unchanged and gates every tool call regardless of provider.

## 0.1.1

### Patch Changes

- 1a54cd5: Fix the npm audit warning on fresh installs (bump @modelcontextprotocol/sdk to 1.30.0 so @hono/node-server resolves to the patched 2.x line), add homepage/bugs/keywords metadata to both packages, make shipped source comments self-contained, and give the CLI help screen the ASCII wordmark.
- Updated dependencies [1a54cd5]
  - @phone-use/sdk@0.1.1

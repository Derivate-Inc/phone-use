# phone-use iOS runner

phone-use's own XCTest runner. An XCTest UI-test process is the one kind of
process iOS lets drive other apps, so this is how phone-use observes and
operates an iOS simulator (and, through a relay, a real iPhone). It replaces the
third-party device layer phone-use used to depend on.

```
host: @phone-use/sdk xctest backend ──HTTP 127.0.0.1:<port>, bearer token── runner (XCTest, on the simulator)
```

You normally never run it by hand: the SDK builds it on first use (cached per
Xcode version under `~/.phone-use/runner/build/`), launches one per simulator
with `xcodebuild test-without-building`, records the port and token in
`~/.phone-use/runner/sessions/<udid>.json` (mode 0600), and reuses it from the
next CLI process.

## What is different from the old runner

- **One snapshot call per screen.** `XCUIElement.snapshot()` returns the whole
  tree in one round trip; all filtering is local. Settings root: ~60 ms warm.
- **Fast gestures.** Taps, long presses, drags and scrolls go straight to
  XCTest's event synthesizer (about 290 ms per tap instead of about 780 ms
  through `XCUICoordinate.tap()`), then a settle check waits until two captures
  in a row match. If the synthesizer is missing in a future Xcode, the public
  API is used automatically.
- **Refs survive small layout changes.** A ref is re-located on a fresh capture
  before it is tapped; if it is gone, the call fails with `STALE_REF` and a hint
  instead of tapping whatever is now at the old position.
- **SpringBoard permission alerts are part of the snapshot**, marked
  `system: true`, so an agent sees what is blocking the screen.
- **XCTest failures become errors.** Failures XCTest only records (an element
  that cannot be focused) and Objective-C exceptions are returned as errors of
  the verb that caused them; the serving test never dies.
- **One runner per simulator, checked.** Launching refuses when another XCTest
  runner (WebDriverAgent or another tool) is active on the same simulator, since
  two runners evict each other. Pass `takeover: true` to stop it instead.

## Protocol 2

`GET /health` → `{"ok":true,"protocol":2}` (no token needed).
`POST /rpc` with `Authorization: Bearer <token>` and `{"method": ..., "params": {...}}` →
`{"result": ..., "ms": n}` or `{"error": {"code", "message", "hint"?}}`.

| Method | Params | Notes |
| --- | --- | --- |
| `snapshot` | `interactiveOnly`, `depth`, `includeOffscreen`, `bundleId` (hint), `candidates` | nodes with refs; `more.{above,below}` counts loaded controls off screen |
| `tap` | `ref` or `x`,`y`; `count`, `check`, `settle`, `fast` | |
| `long_press` | `ref` or `x`,`y`; `durationMs` | |
| `drag` | `x`,`y`,`dx`,`dy`; `durationMs`, `hold` | |
| `scroll` | `direction` (content to reveal), `ref` (scroll inside it), `amount` | holds at the end so lists do not fling |
| `type` / `fill` / `key` | `text` / `ref`,`text` / `key` (return, delete, tab, space, escape, dismiss) | `fill` clears, types and returns the field's new value |
| `back` | | navigation-bar back button, else edge swipe |
| `home`, `launch`, `terminate`, `open_url` | `bundleId`, `relaunch`, `url` | |
| `alert` | `action` (get, accept, dismiss), `button` | app alerts and SpringBoard permission prompts |
| `wait_text` | `text`, `timeoutMs` | |
| `screenshot` | `overlayRefs` | PNG base64; the SDK uses `simctl io` when no overlay is needed |
| `batch` | `steps: [{method, params, pauseMs}]` | stops at the first failure and says which step |

Error codes: `STALE_REF`, `TIMEOUT`, `BAD_PARAMS`, `ACTION_FAILED`, `UNKNOWN_METHOD`, `UNAUTHORIZED`.
Protocol-1 method names (`get_tree`, `tap_element`, `enter_text`, `swipe`, `open_app`, `get_screen_image`,
`get_context`) still work for older device-runner clients.

## Developing the runner

The Xcode project is generated from `project.yml` and committed, so installs do
not need xcodegen. After adding or renaming files:

```sh
cd packages/sdk/ios-runner && xcodegen generate
```

Environment the runner reads (the SDK sets these through `TEST_RUNNER_` variables):
`PHONE_USE_RUNNER_PORT` (default 45678), `PHONE_USE_RUNNER_BIND` (default `127.0.0.1`),
`PHONE_USE_RUNNER_TOKEN`.

## Real device

A real iPhone needs the runner signed with your team and launched once per
boot.

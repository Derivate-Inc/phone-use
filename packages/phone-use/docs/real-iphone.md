# Driving a real iPhone

Cloud phones you `create`. The phone in your pocket you `connect` to.

```bash
phone-use connect                  # every verb now runs on your real iPhone
phone-use observe
phone-use open "Weather"
phone-use tap "Add"
phone-use disconnect               # back to simulators and cloud phones
```

`connect` checks every prerequisite first and refuses with the exact fixes
rather than saving a choice that cannot work. To see that report without
connecting, run `phone-use doctor --mirror`.

The selection is remembered in `~/.phone-use/config.json`, because "which
phone" is a mode you stay in rather than an argument you repeat. The
environment still wins, so `PHONE_USE_DEVICE=mirror` remains a one-off override
for a single command or a CI job.

This is the only path that reaches **real App Store apps with real accounts**.
Simulators cannot run them: App Store binaries are built for the iOS device
platform and encrypted with FairPlay, which only decrypts on real hardware.

## Check before you drive

`phone-use doctor --mirror` reports every prerequisite and the exact fix for
each. Run it first; it is faster than diagnosing a verb that silently did
nothing.

| Requirement | How to satisfy it |
|---|---|
| macOS 15 (Sequoia) or newer | iPhone Mirroring does not exist before it |
| Xcode command line tools | `xcode-select --install` — builds the native helper |
| Screen Recording permission | System Settings → Privacy & Security → Screen & System Audio Recording |
| Accessibility permission | System Settings → Privacy & Security → Accessibility |
| iPhone Mirroring open and connected | Same Apple Account; the window must stay open |

Grant permissions to the terminal that runs phone-use, and restart it
afterwards. macOS may still prompt the first time an action runs — approve and
re-run rather than assuming the step is broken.

## Not on macOS?

There is nothing to install. iPhone Mirroring is a macOS feature, so this path
does not exist on Linux or Windows, and `doctor --mirror` says so rather than
failing obscurely. Your options there:

- **Cloud iPhones** — `phone-use create ios`, then `phone-use env <id>`. Works
  from any OS, because the Macs are ours.
- **Android** — no equivalent restriction; adb works locally anywhere.

## What works, and what cannot

Mirroring is a **video feed**. The Mac has no access to the iOS view hierarchy,
so this backend synthesises a tree from Vision OCR: every piece of recognised
text becomes a node with a label and a rect. Label-driven verbs work unchanged.

Supported: `observe`, `screenshot`, `tap`, `type`, `scroll`, `drag`, `wait_for`,
`open`, `nav`.

Not supported, by construction:

- **Element state.** OCR reads the word "Wishlist" but not whether that toggle
  is on. Anything depending on selected/enabled cannot be answered here — use a
  simulator backend when verifying state matters.
- **Icon-only controls.** No text means nothing to OCR. Tap them by coordinate
  from a screenshot.
- **`listApps`.** A real phone cannot be enumerated; app names pass straight to
  Spotlight instead.
- **`handle_alert`.** Without a real tree there is no way to distinguish an
  alert from ordinary text, and guessing would silently accept dialogs.

Expect occasional OCR misreads in labels. Prefer distinctive substrings over
exact matches.

## Measured behaviour worth knowing

These were established against a real iPhone 17 Pro Max and are the reason the
backend looks the way it does.

- **Scroll magnitude is load-bearing.** iPhone Mirroring silently drops scroll
  events with small per-event deltas. Roughly 50px per event does nothing at
  all; 120px scrolls reliably. A gesture assembled from many tiny steps looks
  like a frozen screen.
- **Synthetic unicode keystrokes are ignored.** `CGEventKeyboardSetUnicodeString`
  produces no input at all through Mirroring. Typing must use real virtual
  keycodes.
- **Spotlight needs time to rank.** Pressing Return sooner than ~2.5s after the
  query dismisses the sheet without launching anything.
- **Vision needs a file, not a CGImage.** A `CGImage` decoded via
  `CGImageSourceCreateImageAtIndex` makes `VNRecognizeTextRequest` return zero
  observations — indistinguishable from a blank screen. Passing the PNG by URL
  works.

## Agent-agnostic

Nothing here is tied to a particular model or client. The CLI is the interface,
and `phone-use mcp` exposes the same verbs over MCP to any MCP client — Claude
Code, Codex, Cursor, or your own harness. The only host requirement is macOS
with an iPhone paired.

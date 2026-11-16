---
"phone-use": patch
"@phone-use/sdk": patch
---

New controls, and failures that no longer pass as success.

- `press <key>` presses return, tab, backspace, space or escape. A cloud phone takes return only for now. `Device` backends accept the same keys through `pressKey`.
- `wait_for --stable` waits until the screen stops changing.
- `scroll --until "<text>"` scrolls until the text is on screen or the list ends, and `scroll --collect` walks a list and returns each row once. Both say how they ended.
- A tap that changes nothing now says when a system alert is covering the app.
- A missing required argument is a usage error (exit 1) before any confirmation prompt, and usage errors such as a malformed `batch` action exit 1 instead of 0. `--help` lists each verb's arguments.
- `toggle` finds a switch when the saved map points at the wrong screen, and `search` says what is covering the app when it cannot find the search field.
- `doctor --mirror` and `connect` notice when iPhone Mirroring is showing a lock or "iPhone in Use" screen instead of the phone, and say what to do.

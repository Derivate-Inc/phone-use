# @phone-use/sdk

Typed mobile-device SDK for AI agents: launch or connect to a device, observe
the screen as structured elements, and act on it with auto-waiting, verified
gestures. The engine-as-object API is deliberately Playwright-shaped —
`launch → observe → act → close`.

## Quick start (iOS Simulator)

Requires macOS with Xcode (`xcrun simctl`) and an iOS Simulator runtime.
Node >= 22 or Bun.

```ts
import { ios } from '@phone-use/sdk';

const device = await ios.launch(); // creates + boots a dedicated simulator
await device.apps.open('Settings');
const result = await device.tap('General'); // resolves by label, auto-waits, verifies
console.log(result.message, result.changed);
await device.close(); // shuts the sim down and deletes it
```

Or with `await using` — the device closes itself at scope exit:

```ts
import { ios } from '@phone-use/sdk';

await using device = await ios.connect(); // attach to the booted simulator
await device.apps.open('Settings');
console.log((await device.observe()).rendered);
```

## Platforms

**iOS Simulator today.** Android support lands with the android engine
(`android.launch()` / `android.connect()`) — the backend contract and config
union already carry the Android shape, but there is no working Android engine
in this release, so no example is shown.

## Observe → act: portable actions

`device.observe()` returns structured elements plus portable `Action`
descriptors whose targets are **re-resolvable element queries** (id → exact
label → substring → fuzzy, with `role`/`near` disambiguators) — not stale
handles. `device.act(action)` re-resolves against the live screen and executes
deterministically, so a recorded `Action[]` replays with zero model calls.

Every verb auto-waits (target visible + enabled + screen settled) and returns
a structured `{ success, message, ... }` result instead of throwing for normal
outcomes like "not found" or "ambiguous — here are the candidates".

## Errors

Infrastructure failures throw `PhoneUseError` subclasses, each with a stable
`code` and an explicit `retryable` flag:

| Error | `code` | `retryable` |
| --- | --- | --- |
| `DeviceNotFoundError` | `DEVICE_NOT_FOUND` | no |
| `DeviceInUseError` | `DEVICE_IN_USE` | yes |
| `SessionNotFoundError` | `SESSION_NOT_FOUND` | no |
| `TimeoutError` | `TIMEOUT` | yes |
| `ActionFailedError` | `ACTION_FAILED` | yes |
| `UnsupportedCapabilityError` | `UNSUPPORTED_CAPABILITY` | no |
| `AbortedError` | `ABORTED` | no |
| `PhoneUseError` (base) | `BACKEND_NOT_FOUND` / `UNKNOWN` | no |

No backend/transport error type ever crosses the public API — everything is
normalized at the boundary by `toPhoneUseError`.

## `%name%` secrets

Store secret values on the device and reference them by name — values are
substituted only at the moment of typing, and redacted from results,
observations, and stored actions:

```ts
device.secrets.set('password', process.env.APP_PASSWORD!);
await device.type('%password%', { field: 'Password', submit: true });
// result.message: 'filled "Password", pressed Return' — never the value
```

## Testing subpath

`@phone-use/sdk/testing` ships the device-free test doubles the SDK's own
suite runs on: `FakeBackend` (scripted snapshot screens, records every call),
`el`/`screen` fixture sugar, and `scriptedExecRunner` for lifecycle tests.

```ts
import { FakeBackend, el, screen } from '@phone-use/sdk/testing';

const backend = new FakeBackend({ screens: [screen([el({ ref: '1', label: 'General' })])] });
```

## Stability

Pre-1.0: minor versions may break APIs. The `Action`/`CompiledSkill` *format*
(`formatVersion: 0`) is explicitly unstable — it cannot responsibly freeze
before both platforms exist. Pin exact versions.

## License

Apache-2.0

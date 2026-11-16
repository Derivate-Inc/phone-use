# Cloud live video

Implemented 2026-10-28. This supersedes the proposed 30fps path in
the August cloud-state record, while
preserving the old JPEG endpoint for compatibility.

## How it works

The console's **Open phone** link opens `/phones/<sandbox-id>`. The URL contains
only an ID. A signed-in browser obtains the endpoint and session token from the
existing tenant-scoped `GET /v1/sandboxes/:id` API, then connects directly to the
worker using WSS in production. The worker validates the session token before
upgrading `/v1/device/:id/video`.

On iOS workers, `native/phone-video` reads the simulator's IOSurface framebuffer
and uses VideoToolbox to encode continuous H.264. It does not call `simctl
screenshot`, capture the host desktop, require Screen Recording permission, or
require a Simulator window. The encoder targets 30fps at native resolution,
6 Mbps average bitrate, no B-frames, with one keyframe per second.

One encoder is shared per device. New viewers start on a keyframe containing
SPS/PPS configuration. Browser WebCodecs decodes directly to a canvas; the
client derives the codec profile/level from the stream. Decoder backlog is
bounded and overload resets to the next keyframe. A worker disconnects viewers
whose socket buffer exceeds 1MB. Socket reconnection starts a fresh decoder.
This is H.264 over WebSocket, not WebRTC; TCP head-of-line delays can still
matter on poor networks. WAN latency has not yet been measured.

The helper emits length-prefixed access units: uint32 BE packet length, uint8
kind (1 = key, 2 = delta), uint64 BE timestamp in microseconds, then Annex-B NAL
units. The WebSocket carries one packet without the length prefix per message.

Closing the last viewer stops capture. Closing/restoring a sandbox and shutting
down the worker also stop its encoder. A 10-second no-frame watchdog closes a
stalled stream. Viewing touches session activity every 30 seconds; hard TTL
still applies. The page polls lifecycle state and removes the feed when the
phone closes, expires, or session authorization fails.

## Worker setup and rollout

On the Mac worker, with Xcode selected (or `DEVELOPER_DIR` set):

```sh
sh apps/api/native/build.sh
```

The binary defaults to `apps/api/native/phone-video`; `PHONE_USE_VIDEO_BIN` can
point to a different built binary. The Scaleway macOS bootstrap now builds it.
For an existing worker, build the helper and restart the worker with the updated
source before deploying the updated `apps/web` console. Its existing TLS proxy
must allow WebSocket upgrades under `/v1/device/*/video` just as for `/stream`.
The web host does not proxy video; the Mac's authenticated endpoint sends it.

The CLI's create/status output includes the viewer URL. Self-hosted consoles
can set `PHONE_USE_CONSOLE_URL` for that link. No token is included in the link.

This implementation covers **iOS simulators**, not physical iPhones. Android
H.264 is not implemented in this change. Unsupported browsers/workers can use
the explicit **Use screenshot fallback** button; the UI calls it screenshot
mode, never live video. The fallback retries its JPEG socket, detects silent
connections and uses bounded screenshot requests when needed.

## Open-source approaches inspected

- [scrcpy architecture](https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md):
  Android MediaCodec surface capture, encoded video packets, minimal buffering.
- [ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy): H.264 in a browser using
  MSE or WebCodecs. Its iOS USB capture path is separate from simulator capture.
- [serve-sim](https://github.com/EvanBacon/serve-sim): direct headless simulator
  framebuffer capture and VideoToolbox H.264; handles newer SimulatorKit APIs.
- [SimUtil](https://github.com/dungngminh/simutil): simulator framebuffer access
  adapted from serve-sim. Our helper adapts its discovery/copy patterns;
  attribution and both licenses are included in `apps/api/native/`.
- [simmer](https://github.com/joshdholtz/simmer): its documented stream is still
  JPEG/PNG capture, so it does not address the requested encoded-video path.

## Verification

A fresh iOS 26.5 simulator on this Mac produced 341 frames in a 12-second capture
(30.4 fps after startup), 1170×2532. FFprobe decoded all 341 H.264 frames.
An isolated cloud-stack browser test also decoded 150 frames at 30.4fps through
cookie authentication → tenant-scoped session lookup → worker WebSocket →
WebCodecs canvas. It checked anonymous access, bad-token rejection, a second
viewer joining, mobile layout, and session closure. The 61-test API suite,
web/API typechecks and production web build passed.

The video worker and native helper were also deployed to the existing Scaleway
Paris Mac (macOS 26.5, Xcode 26.5). The remote worker had an older baseline,
so only the video route/integration was applied; its previous source is backed
up at `~/phone-use-video-stage/worker.before.ts` on that host. The updated web
console has not been deployed yet.

A real cloud session streamed 1206×2622 H.264 over authenticated WSS. A clean
build delivered 180 frames with capture timestamps spaced at ~30.3fps; observed
arrival rate varied with initial network buffering (28–33fps in short samples).
Bad tokens returned HTTP 401 and the authenticated Settings action returned
HTTP 200. A Chromium browser decoded 120 live frames at 1206×2622, then
successfully operated Home and Settings through the same session. These are
throughput measurements, not motion-to-photon latency.

The first daemon-hosted capture ran at ~7fps despite standalone capture reaching
30fps. A strict DispatchSource timer fixed background timer coalescing; capture
also uses an interactive queue and a latency-critical process activity. Keep
strict timer scheduling when changing the helper. Native capture uses private
SimulatorKit APIs and must be tested with each deployment Xcode/runtime.

Transport regression tests cover split packets, corrupt lengths, shared capture,
late viewer keyframe gating, backpressure, and last-viewer cleanup. Browser
protocol tests cover actual SPS codec negotiation and invalid packets.


## SimDeck reuse review (2026-10-28)

Inspected [NativeScript/SimDeck at 2d7346b](https://github.com/NativeScript/SimDeck/tree/2d7346b68a46ffd92c7353aac5ee6a5490fcbb03).
This is a source review, not a benchmark or an implemented migration.

- `packages/server/src/transport/webrtc.rs`: H.264 RTP delivery, RTCP PLI/FIR
  keyframe requests, lag recovery, ICE/TURN configuration and control channels.
  Worth adapting for WAN video; our current transport is WebSocket/TCP. Their
  Rust server is not a drop-in module for our Bun worker. Keep our tenant-scoped
  authorization, session expiry and teardown around any new signaling endpoint.
- `packages/client/src/features/stream/streamWorkerClient.ts`: browser WebRTC
  negotiation, first-frame/stall watchdogs, ICE restart and receiver buffering.
  Reusable as a reference or adapted TypeScript module, with its API/UI dependencies
  removed. TURN infrastructure is still needed for networks without a direct path.
- `packages/client/src/features/input/gestureMath.ts`, `usePointerInput.ts`, and
  `../viewport/viewportMath.ts`: normalized and rotated coordinates, pointer
  capture, cancellation, pinch and edge gestures. These are practical sources
  for browser takeover; our backend needs matching touch-phase operations.
- `packages/server/native/XCWH264Encoder.m`: configurable dimensions/frame rate,
  encoder pressure metrics, foreground pause and requested keyframes. Port
  focused mechanisms into our Swift helper rather than importing the full encoder.
- Android uses emulator gRPC raw frames/shared display memory with host encoding.
  Useful reference, but its native encoder is Mac-based; our Linux Android worker
  needs a compatible encoder integration.

Their root MIT license permits copying/modification/commercial use with the
OpenJS Foundation copyright and license notice preserved. The default native
build also links x264, whose separate licensing must be evaluated before
adopting that dependency; the project provides `SIMDECK_DISABLE_X264`. The review initially copied no code; the integration below supersedes that status.


### Implemented SimDeck integration

The viewer adapts SimDeck's transformed-box coordinate mapping in
`apps/web/lib/simdeck/coordinates.ts`, with object-fit letterbox exclusion.
The authenticated `viewerInput` RPC sends normalized coordinates to SimDeck's
native HID bridge, vendored unchanged at `apps/api/native/simdeck/` from the
pinned revision above. Our small `phone-input.m` adapter runs the main dispatch
queue, attaches input only, and injects taps, interpolated swipes, Home and Return.
Text input uses `simctl pbcopy` followed by the bridge's paste key combination.
It changes the simulator clipboard; it does not read or modify the host clipboard.
This avoids the XCTest session initialization needed by the agent SDK input path.
The existing agent backend remains unchanged.

The dedicated iOS viewer has opt-in tap/drag controls, Home, Return and a text
form. Drags execute on release; pinch and continuous browser touch-phase injection
are not implemented. Requests validate finite normalized coordinates, dimensions,
duration and text length. Inputs use argv/stdin, never shell interpolation. The
worker rejects concurrent viewer inputs per device, and the client never retries
an input automatically. This does not lock out agent actions. Pointer cancellation
and lost capture discard pending browser gestures; controls are disabled while
video is unavailable. Android viewer input remains unsupported.

Hidden tabs disconnect their video feed; returning reconnects at a keyframe,
saving capture work when no viewers remain (SimDeck's foreground lifecycle idea).
Build both native helpers using `sh apps/api/native/build.sh`; the input binary
can be overridden with `PHONE_USE_INPUT_BIN`.

MIT copyright/license notices are retained with both adapted and vendored code;
`apps/web/public/licenses/SimDeck.txt` includes the browser distribution notice.
No x264 dependency was added. Video transport remains H.264 over WSS;
WebRTC/ICE/TURN is not part of this integration.

Integration validation: 64 API tests and 4 browser protocol/coordinate tests pass,
with web/API typechecks and a production web build. Both native helpers compile
on the local and Scaleway Xcode installations. A clean local simulator accepted
taps and interpolated swipes, and a screenshot verified pasted `Bluetooth` text
in Settings after correcting the bridge's USB HID keycode/modifier mapping.
The browser connected to the actual cloud worker, received video, successfully
submitted native Home/tap/swipe requests, and paused/reconnected on visibility
changes. Cloud visual action verification remains inconclusive: the host had
load averages around 240 and an unrelated process consuming over 700% CPU;
some HID deliveries timed out and simulator app launches stalled. Successful
input acknowledgements alone are not proof of a completed on-screen action.

The input helper and worker endpoint are deployed on the Scaleway Mac. The
main `app.phoneuse.dev` frontend deployment is still pending. Worker backups
remain at `~/phone-use-video-stage/worker.before-controls.ts` and
`types.before-controls.ts` on the host. WebRTC remains future work.

Follow-up cloud demo verification (2026-10-28): a fresh real Scaleway session
successfully decoded live video and responded to native Home and a horizontal
swipe. Before/after browser captures visually confirmed the home-screen page
changed (first page with Settings/Calendar to second page with Files/Contacts).
The measured interval from starting the browser gesture to a substantial decoded
screen change was 2,556 ms in one trial; this includes input and rendering delay,
not just transport latency. Host load remained extreme (~282). This supersedes
the earlier inconclusive visual check for those two operations only; it does not
establish consistently low latency or verify all controls on the cloud host.

## Production deployment (2026-10-29)

Supersedes the "web console has not been deployed" notes above. Commit 63f389f
deployed the `/phones/<id>` viewer to `app.phoneuse.dev` through the Vercel Git
integration; the control plane needed no change. The Scaleway Mac's worker and
native helpers match this commit for the viewer paths (its worker still runs an
older baseline for unrelated features). The Android worker does not serve video.

Production check against a fresh iOS cloud phone, connecting exactly as the
browser does: a bad session token was rejected (401) for video and controls;
over a 25-second window the worker sent 632 H.264 packets (~28fps after the
first frame, ~2.7 Mbps), starting on a keyframe 2.7s after connect; a viewer
Home press returned 200 in 0.7s. An earlier 10-second attempt, made while the
host was booting the phone (load ~52), received no frames before closing. A
first view during heavy boot load can therefore exceed the 10-second watchdog
and rely on the page's reconnect. Browser rendering on the production page was
not re-run in this check.

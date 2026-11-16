# Native capture attribution

The framebuffer discovery, callback registration and pixel-buffer copying in
phone-video.swift are adapted from:

- SimUtil, copyright (c) 2026 dungngminh, MIT (LICENSE.simutil).
  https://github.com/dungngminh/simutil/blob/19654090275584fa3d725e526d5bb058f3f8d7bf/app/macos/Runner/SimStream.swift
- serve-sim, copyright Evan Bacon, Apache-2.0 (LICENSE.serve-sim).
  https://github.com/EvanBacon/serve-sim

Changes: standalone executable, timer-driven 30fps capture, VideoToolbox H.264
encoding, bounded submission, Annex-B packet output. No Flutter or node bridge.

## SimDeck input bridge

`simdeck/DFPrivateSimulatorDisplayBridge.m` and `.h` are copied unchanged from
NativeScript/SimDeck commit 2d7346b68a46ffd92c7353aac5ee6a5490fcbb03
(`packages/server/native/`). Copyright OpenJS Foundation and other contributors,
MIT; full notice in `simdeck/LICENSE`. `phone-input.m` is our input-only CLI adapter.
No SimDeck encoder or x264 library is linked.

# Technical write-ups

Product documentation is at https://phoneuse.dev/docs (source: `apps/landing/app/docs/`).
These are the engineering notes behind it.

| Doc | What it covers |
| --- | --- |
| [15-app-cartographer.md](15-app-cartographer.md) | How an agent maps an app into a graph and then navigates it with no model calls |
| [42-own-device-layer.md](42-own-device-layer.md) | Our own device layer (an XCTest runner on iOS), what five other tools taught us, and measurements |
| [43-device-layer-eval.md](43-device-layer-eval.md) | The design of the device-layer eval: ground truth from an oracle app |
| [45-device-layer-eval-results.md](45-device-layer-eval-results.md) | What the eval measured, the root cause of each false success, and the fixes |
| [cloud-live-video.md](cloud-live-video.md) | Live H.264 video from a cloud iPhone: worker setup and verification |
| [harness-reliability.md](harness-reliability.md) | Implementation direction for reliable runs in the harness and CLI |
| [mobile-workflows.md](mobile-workflows.md) | Verified workflows: the execution and verification layer on top of a coding agent |
| [46-cloud-waitlist.md](46-cloud-waitlist.md) | Cloud phones behind a waitlist: the approval flag, the `cloud_waitlist` answer, operator commands |

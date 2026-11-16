# App Cartographer — the novel capability

Built July 18, 2026. Verified live on the iOS Simulator.

## What it is

An agent that **autonomously crawls a native app and builds a reusable map of its screens and navigation**, then routes future tasks by shortest-path over that map — deterministically, with **zero LLM calls per step**.

## Why it's novel

Every mobile-agent tool today (mobile-mcp, agent-device, droidrun, Mobilerun, the CUA-style loops) operates as a **greedy forward loop**: observe the screen, ask the model what to tap, tap, repeat — starting from scratch on every task. A few can record and replay a *single* linear trace.

Nobody builds a **persistent, reusable navigational graph of a native app by autonomous exploration.** The web has had crawlers and sitemaps for 25 years; native mobile has nothing equivalent because you can't "view source" — you have to physically explore the UI. Accessibility-signature keying + backtracking makes it possible.

This flips the economics of phone use:

| | Greedy agent (everyone) | App Cartographer (this) |
|---|---|---|
| "Go to Fonts settings" | Multi-step LLM exploration **every time** | One-time crawl, then a precomputed tap-path |
| Cost per navigation | N model round-trips | **0 model calls** |
| Reuse | None | Map persists across sessions |
| Knowledge of the app | Ephemeral | A durable graph you can inspect, diff, share |

## How it works

1. **Crawl** (`src/explore.ts`): DFS from the app's root. At each screen, enumerate tappable elements, tap each, observe the landed screen, record an edge `(fromScreen, tappedLabel → toScreen)`. Backtrack via `go_back`; on drift, restore by replaying the path from root. Bounded by screen/depth/time budgets.
2. **Screen signature** (`driver.screenSignature`): a structural fingerprint (bundle id + nav title + sorted interactive labels) that is stable across dynamic content (times, battery, values), so the same screen is recognized as one node.
3. **Screen titles**: each screen is named by the label tapped to reach it — iOS nav bars show the *parent* name in the back button, so this is more reliable than reading the bar.
4. **Persist** (`src/appmap.ts`): the graph saves to `~/.phone-use/maps/<bundleId>.json` and reloads across sessions. Renders to Mermaid for a human-readable view.
5. **Navigate** (`explore.findPath` + `navigate`): natural-language destination → BFS shortest path over edges → execute the label sequence deterministically.

## Verified result (Settings)

Crawled `com.apple.Preferences` → 8 screens in 29s:

```
Preferences → General → { About, Screen Capture, Local Capture,
                          AutoFill & Passwords, Dictionary, Fonts }
```

Then, with **no model in the loop**:
- `goto("Fonts")` → path `["General","Fonts"]` → landed on Fonts (System Fonts, My Fonts) ✅
- `goto("About")` → path `["General","About"]` → landed showing "iOS Version 26.1" ✅

## Agent-facing tools (MCP)

- `map_app(app, maxScreens?, maxDepth?)` — crawl and save the map (run once per app)
- `goto(app, destination)` — jump to a named screen via the saved map, instantly

## Robustness notes / known edges

- iOS reports the same row as `Cell` or `Button` across snapshots; the crawler considers all tappable roles and keeps only edges that actually navigate (`toSig !== sig`).
- Auth/paywall rows ("Sign in…") and modals are skipped/dismissed (`isTrap`, `DISMISS`) because they break `go_back`.
- The crawler settles each transition (polls until the signature stops changing) before reading it — correctness over latency, unlike the fast interactive path.

## Next increments

- **Live crawl visualization**: `crawl` already emits `onProgress` (nodes/edges as they're discovered) — stream it to the live viewer so the graph draws itself as it explores.
- **Deep-link discovery**: for each mapped screen, probe whether a URL scheme reaches it → collapse multi-tap paths to one deep link.
- **Cross-app maps**: map the whole home screen + app-switch transitions.
- **Map-guided agent**: when a task names a destination the map knows, skip straight there before handing off to the model for the last mile.

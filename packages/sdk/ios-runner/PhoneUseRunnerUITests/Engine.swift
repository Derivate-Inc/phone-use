import UIKit
import XCTest

/// A typed failure the host maps onto the SDK's error tree.
struct RunnerError: Error {
    let code: String
    let message: String
    var hint: String?

    static func badParams(_ message: String) -> RunnerError { RunnerError(code: "BAD_PARAMS", message: message) }
    static func actionFailed(_ message: String, hint: String? = nil) -> RunnerError {
        RunnerError(code: "ACTION_FAILED", message: message, hint: hint)
    }
}

/// Every device verb. Runs on the main actor: XCUIAutomation is main-actor
/// isolated, and one serial actor also means two requests never interleave
/// gestures on the same screen.
@MainActor
final class Engine {
    static let springboardId = "com.apple.springboard"
    let springboard = XCUIApplication(bundleIdentifier: springboardId)
    let tree = Tree()
    /// The app this runner last brought forward, checked first when looking
    /// for the frontmost app.
    private var activeBundleId: String?
    /// XCTest failures recorded while the current verb ran (see Runner.record).
    var pendingIssue: String?
    let startedAt = Date()

    // MARK: - dispatch

    /// When a verb last changed the screen. A snapshot taken after this is
    /// still trustworthy, so its refs can be used without re-locating them.
    private var lastMutationAt = Date.distantPast
    private static let readOnly: Set<String> = [
        "health", "get_context", "snapshot", "get_tree", "frontmost", "wait_text", "screenshot", "get_screen_image",
    ]

    func handle(method: String, params: [String: Any]) throws -> Any {
        let mutates = !Self.readOnly.contains(method) && !(method == "alert" && (params["action"] as? String ?? "get") == "get")
        defer { if mutates { lastMutationAt = Date() } }
        return try dispatch(method: method, params: params)
    }

    private func dispatch(method: String, params: [String: Any]) throws -> Any {
        switch method {
        case "health", "get_context":
            return [
                "ok": true,
                "device": UIDevice.current.name,
                "ios": UIDevice.current.systemVersion,
                "backend": "phone-use-runner",
                "protocol": 2,
                "uptimeSeconds": Int(Date().timeIntervalSince(startedAt)),
            ]
        case "snapshot": return try snapshot(params)
        case "get_tree": return try legacyTree(params)
        case "frontmost": return frontmostInfo(params)
        case "tap", "tap_element": return try tap(params)
        case "long_press": return try longPress(params)
        case "drag", "swipe": return try drag(params)
        case "scroll": return try scroll(params)
        case "type": return try typeText(params)
        case "fill": return try fill(params)
        case "enter_text": return try legacyEnterText(params)
        case "key": return try key(params)
        case "home":
            XCUIDevice.shared.press(.home)
            activeBundleId = nil
            return ["ok": true]
        case "back": return try back(params)
        case "launch", "open_app": return try launch(params)
        case "terminate": return try terminate(params)
        case "open_url": return try openURL(params)
        case "alert": return try alert(params)
        case "wait_text": return try waitText(params)
        case "screenshot", "get_screen_image": return try screenshot(params)
        case "batch": return try batch(params)
        default:
            throw RunnerError(code: "UNKNOWN_METHOD", message: "unknown method \(method)")
        }
    }

    // MARK: - frontmost app

    /// XCTest has no public "which app is in front" call. The runner checks the
    /// app it last activated, then any bundle ids the host saw running (on a
    /// simulator the host reads them from launchd in a few ms), then falls back
    /// to SpringBoard (Home Screen, App Library, Control Center).
    func frontmost(_ params: [String: Any]) -> (app: XCUIApplication, bundleId: String) {
        if let hinted = params["bundleId"] as? String, !hinted.isEmpty, hinted != Self.springboardId {
            let app = XCUIApplication(bundleIdentifier: hinted)
            if app.state == .runningForeground {
                activeBundleId = hinted
                return (app, hinted)
            }
        }
        if let active = activeBundleId {
            let app = XCUIApplication(bundleIdentifier: active)
            if app.state == .runningForeground { return (app, active) }
        }
        for candidate in params["candidates"] as? [String] ?? [] where candidate != activeBundleId && candidate != Self.springboardId {
            let app = XCUIApplication(bundleIdentifier: candidate)
            if app.state == .runningForeground {
                activeBundleId = candidate
                return (app, candidate)
            }
        }
        activeBundleId = nil
        return (springboard, Self.springboardId)
    }

    private func frontmostInfo(_ params: [String: Any]) -> [String: Any] {
        let (_, bundleId) = frontmost(params)
        return ["bundleId": bundleId]
    }

    // MARK: - observe

    private func snapshot(_ params: [String: Any]) throws -> [String: Any] {
        let started = Date()
        let (app, bundleId) = frontmost(params)
        var options = Tree.Options()
        options.interactiveOnly = params["interactiveOnly"] as? Bool ?? true
        options.maxDepth = params["depth"] as? Int
        options.includeOffscreen = params["includeOffscreen"] as? Bool ?? false
        var roots: [(snapshot: XCUIElementSnapshot, bundleId: String)] = [(try app.snapshot(), bundleId)]
        // Permission prompts are presented by SpringBoard, outside the app's
        // tree: merge them in so an agent sees what is blocking the screen.
        if bundleId != Self.springboardId, options.maxDepth == nil || options.maxDepth! > 1 {
            let alert = springboard.alerts.firstMatch
            if alert.exists, let overlay = try? alert.snapshot() {
                roots.append((overlay, Self.springboardId))
            }
        }
        var capture = tree.capture(roots: roots, options: options)
        // Elements another listed element overlaps: ask XCTest whether a tap at
        // their hit point would reach them. Rare, so the cost stays off most screens.
        let hitStarted = Date()
        var hitTests = 0
        for index in capture.nodes.indices {
            guard let ref = capture.nodes[index]["ref"] as? String, let entry = tree.entry(for: ref), entry.overlayCandidate,
                  entry.blocked == nil, hitTests < 4, Date().timeIntervalSince(hitStarted) < 0.6 else { continue }
            hitTests += 1
            if reachable(entry, in: app) == false {
                capture.nodes[index]["blocked"] = "covered"
                tree.setBlocked(ref, "covered")
            }
        }
        return [
            "app": ["bundleId": bundleId, "name": capture.appLabel],
            "viewport": ["width": Tree.round(capture.viewport.width), "height": Tree.round(capture.viewport.height)],
            "nodes": capture.nodes,
            "more": ["above": capture.offscreen.above, "below": capture.offscreen.below],
            "generation": tree.generation,
            "ms": Int(Date().timeIntervalSince(started) * 1000),
        ]
    }

    /// The protocol-1 tree shape, kept for older device-runner clients.
    private func legacyTree(_ params: [String: Any]) throws -> [String: Any] {
        let result = try snapshot(params)
        let nodes = (result["nodes"] as? [[String: Any]] ?? []).map { node -> [String: Any] in
            let rect = node["rect"] as? [String: Double] ?? [:]
            return [
                "ref": node["ref"] ?? "",
                "role": node["type"] ?? "Other",
                "label": node["label"] ?? "",
                "value": node["value"] ?? "",
                "enabled": node["enabled"] as? Bool ?? true,
                "rect": ["x": rect["x"] ?? 0, "y": rect["y"] ?? 0, "w": rect["width"] ?? 0, "h": rect["height"] ?? 0],
            ]
        }
        let app = result["app"] as? [String: Any]
        return ["app": app?["bundleId"] ?? "", "elements": nodes]
    }

    // MARK: - targets

    /// Resolve a `{ref}` or `{x, y}` target to a screen point in the frontmost app.
    private func point(_ params: [String: Any]) throws -> (point: CGPoint, app: XCUIApplication, relocated: Bool) {
        if let ref = params["ref"] as? String {
            guard let entry = tree.entry(for: ref) else {
                throw RunnerError(code: "STALE_REF", message: "unknown ref \(ref)",
                                  hint: "refs come from the latest snapshot; take a new snapshot and use a current ref")
            }
            let app = entry.bundleId == Self.springboardId ? springboard : XCUIApplication(bundleIdentifier: entry.bundleId)
            var rect = entry.rect
            var relocated = false
            // Every tool we measured taps a ref's old coordinates and reports
            // success even when a late row pushed the list down. Re-find the
            // element by identity on a fresh capture first (one ~60 ms
            // snapshot) and tap where it is now, or refuse.
            if params["check"] as? Bool ?? true {
                defer { if let root = tree.lastRoot { pendingBefore = signature(of: root) } }
                switch tree.relocate(entry, in: app) {
                case .gone:
                    throw RunnerError(code: "STALE_REF",
                                      message: "\(ref) (\(Tree.typeName(entry.type)) \"\(entry.label)\") is no longer on screen",
                                      hint: candidates(for: entry, in: app))
                case .ambiguous(let count):
                    throw RunnerError(code: "STALE_REF",
                                      message: "\(ref) (\(Tree.typeName(entry.type)) \"\(entry.label)\") now matches \(count) elements and the screen has changed, so which one it named is unclear",
                                      hint: "take a new snapshot and use a current ref")
                case .found(let fresh):
                    relocated = fresh != rect
                    rect = fresh
                }
            }
            if entry.blocked == "keyboard", params["force"] as? Bool != true {
                throw RunnerError(code: "OCCLUDED",
                                  message: "\(ref) (\(Tree.typeName(entry.type)) \"\(entry.label)\") is under the keyboard",
                                  hint: "scroll the element up first, or close the keyboard if the app offers a way (a Done or return key); a tap there would type a key")
            }
            // Something may sit on top of it (an overlay, a sheet, an input view):
            // tapping its point would hit that instead and look like success.
            // Asked fresh at tap time: a cached answer can predate a cover.
            if entry.overlapped || entry.blocked == "covered", params["force"] as? Bool != true,
               hitTest(entry, in: app) == false {
                throw RunnerError(code: "COVERED",
                                  message: "\(ref) (\(Tree.typeName(entry.type)) \"\(entry.label)\") is covered by another element at its position",
                                  hint: "close or move what is on top of it first; a tap there would hit that instead")
            }
            // A carousel item can straddle the screen edge with most of it
            // visible: tap the middle of the visible part, not the off-screen centre.
            let visible = rect.intersection(app.frame)
            if !visible.isNull, visible.width > 0, visible.height > 0, !app.frame.contains(CGPoint(x: rect.midX, y: rect.midY)) {
                rect = visible
            }
            return (CGPoint(x: rect.midX, y: rect.midY), app, relocated)
        }
        guard let x = number(params["x"]), let y = number(params["y"]) else {
            throw RunnerError.badParams("target needs ref or x and y")
        }
        let app = frontmost(params).app
        let bounds = Tree.finite(app.frame)
        guard bounds.width <= 0 || (x >= 0 && y >= 0 && x <= bounds.maxX && y <= bounds.maxY) else {
            throw RunnerError(code: "OUT_OF_BOUNDS", message: "(\(x), \(y)) is outside the \(Int(bounds.width))x\(Int(bounds.height)) screen",
                              hint: "coordinates are screen points from the top-left corner")
        }
        if params["diff"] as? Bool == true { pendingBefore = signature(app) }
        return (CGPoint(x: x, y: y), app, false)
    }

    /// A hint listing the current elements that look like the one a stale
    /// ref named, with fresh refs the caller can use straight away.
    private func candidates(for entry: Tree.Entry, in app: XCUIApplication) -> String {
        guard let root = try? app.snapshot() else { return "the screen changed since the snapshot; take a new snapshot" }
        let capture = tree.capture(roots: [(root, entry.bundleId)], options: Tree.Options())
        let wanted = entry.label.lowercased()
        let similar = capture.nodes.filter { node in
            guard let label = (node["label"] as? String)?.lowercased(), !label.isEmpty, !wanted.isEmpty else { return false }
            return label.contains(wanted) || wanted.contains(label)
        }
        let listed = similar.prefix(5).map { "\($0["ref"] ?? "?") \($0["type"] ?? "") \"\($0["label"] ?? "")\"" }
        return listed.isEmpty
            ? "the screen changed and nothing like it is visible now; take a new snapshot"
            : "the screen changed; refs were refreshed, closest now: \(listed.joined(separator: ", "))"
    }

    private func coordinate(_ point: CGPoint, in app: XCUIApplication) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: point.x, dy: point.y))
    }

    private func number(_ value: Any?) -> Double? {
        if let d = value as? Double { return d }
        if let i = value as? Int { return Double(i) }
        if let n = value as? NSNumber { return n.doubleValue }
        return nil
    }

    // MARK: - gesture delivery

    private lazy var fastInput = PUFastInputAvailable()

    /// The app's interface orientation (UIInterfaceOrientation: 1 portrait, 2
    /// upside down, 3 landscape right, 4 landscape left). It differs from the
    /// device's when an app rotates itself or locks to landscape. XCTest
    /// exposes it on the app; the device orientation is the fallback.
    private func interfaceOrientation(of app: XCUIApplication?) -> Int {
        if let app, app.responds(to: NSSelectorFromString("interfaceOrientation")),
           let value = app.value(forKey: "interfaceOrientation") as? NSNumber, (1...4).contains(value.intValue) {
            return value.intValue
        }
        switch XCUIDevice.shared.orientation {
        case .portraitUpsideDown: return 2
        case .landscapeLeft: return 4
        case .landscapeRight: return 3
        default: return 1
        }
    }

    /// Send a touch path through the event synthesizer, or through the public
    /// API when the synthesizer is unavailable or `fast: false` was asked for.
    /// Returns which path was used.
    private(set) var lastEventMs = 0

    private func deliver(_ path: [(CGPoint, Double)], params: [String: Any], app: XCUIApplication? = nil,
                         fallback: () -> Void) -> String {
        let started = Date()
        defer { lastEventMs = Int(Date().timeIntervalSince(started) * 1000) }
        if fastInput, params["fast"] as? Bool ?? true {
            var error: NSError?
            // Points come from the app's frames (interface space); the synthesizer
            // reads them in the screen's native portrait space and ignores its
            // orientation argument (measured: all four values land alike), so
            // convert here. Without this, landscape taps land rotated.
            let orientation = interfaceOrientation(of: app)
            let bounds = Tree.finite(app?.frame ?? .zero)
            let points = path.map { step -> [NSNumber] in
                let p = Self.screenPoint(step.0, orientation: orientation, interfaceBounds: bounds)
                return [NSNumber(value: Double(p.x)), NSNumber(value: Double(p.y)), NSNumber(value: step.1)]
            }
            let timeout = (path.last?.1 ?? 0) + 5
            if PUSynthesizeTouchPath(points, orientation, timeout, &error) { return "synthesized" }
            NSLog("[phone-use] fast input failed, using XCUICoordinate: %@", error?.localizedDescription ?? "?")
        }
        fallback()
        return "xcuicoordinate"
    }

    /// An interface-space point in the screen's native portrait space.
    static func screenPoint(_ p: CGPoint, orientation: Int, interfaceBounds f: CGRect) -> CGPoint {
        guard f.width > 0, f.height > 0 else { return p }
        switch orientation {
        case 3: return CGPoint(x: f.height - p.y, y: p.x) // landscape right: interface x runs down the screen
        case 4: return CGPoint(x: p.y, y: f.width - p.x) // landscape left: interface x runs up the screen
        case 2: return CGPoint(x: f.width - p.x, y: f.height - p.y) // upside down
        default: return p
        }
    }

    /// End a drag with the finger still: a few sub-point moves over 120 ms so
    /// UIKit measures (almost) zero velocity at lift and the list stops where
    /// it was dragged. Without them UIKit keeps the drag's last velocity and
    /// the list flings on for a second or more.
    static func stopAt(_ end: CGPoint, path: [(CGPoint, Double)]) -> [(CGPoint, Double)] {
        let t = path.last?.1 ?? 0
        return path + [
            (CGPoint(x: end.x, y: end.y + 0.5), t + 0.04),
            (CGPoint(x: end.x, y: end.y), t + 0.08),
            (CGPoint(x: end.x, y: end.y + 0.5), t + 0.12),
            (CGPoint(x: end.x, y: end.y + 0.5), t + 0.14),
        ]
    }

    /// Apps whose idle wait once took too long (they animate forever: a live
    /// map, a spinner, SpringBoard with a context menu open). XCTest's wait has
    /// a 60 s internal timeout and blocks the runner meanwhile, so after one
    /// slow wait an app is settled by the structural check alone.
    private var neverIdle: Set<String> = [Engine.springboardId]

    private func bundleId(of app: XCUIApplication) -> String? {
        if app === springboard { return Engine.springboardId }
        let selector = NSSelectorFromString("bundleID")
        guard app.responds(to: selector) else { return nil }
        return app.perform(selector)?.takeUnretainedValue() as? String
    }

    /// Wait until the screen stops changing.
    ///
    /// Accessibility reports a view's final frame as soon as an animation
    /// starts, and a pushed screen's predecessor stays in the tree until the
    /// push ends, so two equal captures can still be mid-transition. When the
    /// app supports it, XCTest's own "idle, animations included" wait runs first
    /// (private API, used only when present) and one equal pair then suffices.
    /// Without it (long presses, SpringBoard, apps that never idle, or
    /// quiescence:false) the screen must stay unchanged for a quiet window.
    private func settle(_ app: XCUIApplication, params: [String: Any], idleWait: Bool = true) -> [String: Any] {
        guard params["settle"] as? Bool ?? true else { return [:] }
        let started = Date()
        let bundle = bundleId(of: app)
        var quiescenceMs: Int?
        let wantIdle = params["quiescence"] as? Bool ?? (idleWait && !(bundle.map { neverIdle.contains($0) } ?? false))
        if wantIdle, app.responds(to: NSSelectorFromString("_waitForQuiescence")) {
            let q = Date()
            _ = app.perform(NSSelectorFromString("_waitForQuiescence"))
            quiescenceMs = Int(Date().timeIntervalSince(q) * 1000)
            if let bundle, quiescenceMs! > 5000 {
                neverIdle.insert(bundle)
                NSLog("[phone-use] %@ never went idle (%d ms); settling it structurally from now on", bundle, quiescenceMs!)
            }
        }
        let quietWindow: TimeInterval = number(params["quietMs"]).map { $0 / 1000 } ?? (quiescenceMs == nil ? 0.35 : 0.04)
        let timeout = (number(params["settleTimeoutMs"]) ?? 2500) / 1000
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        var last = signature(app)
        defer { lastSettled = last }
        var stableSince = Date()
        while Date().timeIntervalSince(started) < timeout {
            RunLoop.current.run(until: Date().addingTimeInterval(0.04))
            guard app.state == .runningForeground else {
                return ["settled": false, "settleMs": Int(Date().timeIntervalSince(started) * 1000), "appChanged": true]
            }
            let current = signature(app)
            if current != last {
                last = current
                stableSince = Date()
            } else if Date().timeIntervalSince(stableSince) >= quietWindow {
                var out: [String: Any] = ["settled": true, "settleMs": Int(Date().timeIntervalSince(started) * 1000)]
                if let quiescenceMs { out["quiescenceMs"] = quiescenceMs }
                return out
            }
        }
        return ["settled": false, "settleMs": Int(Date().timeIntervalSince(started) * 1000)]
    }

    /// Screen signatures around the current tap: before (from the capture that
    /// re-found the target, or one taken for coordinates) and after (the settled
    /// screen), so a tap can say whether it changed anything without the caller
    /// paying for its own captures.
    private var pendingBefore: Int?
    private var lastSettled: Int?

    private func signature(_ app: XCUIApplication) -> Int {
        guard let root = try? app.snapshot() else { return 0 }
        return signature(of: root)
    }

    private func signature(of root: XCUIElementSnapshot) -> Int {
        var hasher = Hasher()
        func visit(_ node: XCUIElementSnapshot) {
            // Scroll indicators fade for about a second after every scroll and
            // the status bar clock ticks: neither means the screen is busy.
            if node.elementType == .statusBar || node.label.localizedCaseInsensitiveContains("scroll bar") { return }
            hasher.combine(node.elementType.rawValue)
            hasher.combine(node.label)
            hasher.combine(Tree.valueString(node.value))
            let f = Tree.finite(node.frame)
            hasher.combine(Int(f.minX)); hasher.combine(Int(f.minY)); hasher.combine(Int(f.width)); hasher.combine(Int(f.height))
            for child in node.children { visit(child) }
        }
        visit(root)
        return hasher.finalize()
    }

    // MARK: - gestures

    private func tap(_ params: [String: Any]) throws -> [String: Any] {
        pendingBefore = nil
        lastSettled = nil
        let (p, app, relocated) = try point(params)
        let before = pendingBefore
        let double = (params["count"] as? Int ?? 1) >= 2
        let path: [(CGPoint, Double)] = double
            ? [(p, 0), (p, 0.05)] // second tap is sent below
            : [(p, 0), (p, 0.05)]
        let via = deliver(path, params: params, app: app) {
            let c = coordinate(p, in: app)
            if double { c.doubleTap() } else { c.tap() }
        }
        if double, via == "synthesized" { _ = deliver([(p, 0), (p, 0.05)], params: params, app: app) {} }
        var result: [String: Any] = ["ok": true, "x": p.x, "y": p.y, "relocated": relocated, "via": via, "eventMs": lastEventMs]
        // Say what was tapped, so a mis-tap is visible in the reply itself.
        if let ref = params["ref"] as? String, let entry = tree.entry(for: ref) {
            result["target"] = ["type": Tree.typeName(entry.type), "label": entry.label]
        }
        result.merge(settle(app, params: params)) { a, _ in a }
        if let before {
            let after = lastSettled ?? signature(app)
            result["changed"] = after != before
        }
        return result
    }

    private func longPress(_ params: [String: Any]) throws -> [String: Any] {
        let (p, app, _) = try point(params)
        let seconds = (number(params["durationMs"]) ?? 800) / 1000
        let via = deliver([(p, 0), (p, seconds)], params: params, app: app) {
            coordinate(p, in: app).press(forDuration: seconds)
        }
        var result: [String: Any] = ["ok": true, "x": p.x, "y": p.y, "via": via]
        // A context menu keeps animating while it is open; XCTest's idle wait
        // would sit out its 60 s timeout. Settle on structure instead.
        result.merge(settle(app, params: params, idleWait: false)) { a, _ in a }
        return result
    }

    private func drag(_ params: [String: Any]) throws -> [String: Any] {
        guard let x = number(params["x"]), let y = number(params["y"]),
              let dx = number(params["dx"]), let dy = number(params["dy"]) else {
            throw RunnerError.badParams("drag needs x, y, dx, dy")
        }
        let app = frontmost(params).app
        let durationMs = max(number(params["durationMs"]) ?? 300, 50)
        let distance = max(hypot(dx, dy), 1)
        let from = CGPoint(x: x, y: y)
        let to = CGPoint(x: x + dx, y: y + dy)
        let hold = params["hold"] as? Bool ?? true ? 0.1 : 0
        let seconds = durationMs / 1000
        let path: [(CGPoint, Double)] = hold > 0
            ? Self.stopAt(to, path: [(from, 0), (to, 0.05 + seconds)])
            : [(from, 0), (to, 0.05 + seconds)]
        let via = deliver(path, params: params, app: app) {
            coordinate(from, in: app).press(forDuration: 0.05, thenDragTo: coordinate(to, in: app),
                                            withVelocity: XCUIGestureVelocity(distance / seconds),
                                            thenHoldForDuration: hold)
        }
        var result: [String: Any] = ["ok": true, "via": via]
        result.merge(settle(app, params: params)) { a, _ in a }
        return result
    }

    /// Scroll so that content in `direction` comes into view ("down" reveals
    /// what is below). The finger holds still at the end so the list stops
    /// where it was dragged instead of flinging an unknown distance.
    private func scroll(_ params: [String: Any]) throws -> [String: Any] {
        let direction = params["direction"] as? String ?? "down"
        let app: XCUIApplication
        var region: CGRect
        if let ref = params["ref"] as? String, let entry = tree.entry(for: ref) {
            app = entry.bundleId == Self.springboardId ? springboard : XCUIApplication(bundleIdentifier: entry.bundleId)
            region = entry.rect
        } else {
            app = frontmost(params).app
            var frame = Tree.finite(app.frame)
            // With the keyboard up, a drag that starts on it moves nothing (or
            // types): scroll in the part of the screen above it.
            let keyboard = app.keyboards.firstMatch
            if keyboard.exists {
                let k = Tree.finite(keyboard.frame)
                if k.minY > frame.minY + 100 { frame.size.height = k.minY - frame.minY }
            }
            region = frame.insetBy(dx: frame.width * 0.1, dy: frame.height * 0.2)
        }
        // 85% of the region (about half the screen) leaves several rows of overlap
        // between steps, so nothing is skipped, with fewer steps through a long list.
        let amount = min(max(number(params["amount"]) ?? 0.85, 0.1), 0.9)
        let from: CGPoint
        let to: CGPoint
        let half = amount / 2
        switch direction {
        case "up":
            from = CGPoint(x: region.midX, y: region.minY + region.height * (0.5 - half))
            to = CGPoint(x: region.midX, y: region.minY + region.height * (0.5 + half))
        case "left":
            from = CGPoint(x: region.minX + region.width * (0.5 - half), y: region.midY)
            to = CGPoint(x: region.minX + region.width * (0.5 + half), y: region.midY)
        case "right":
            from = CGPoint(x: region.minX + region.width * (0.5 + half), y: region.midY)
            to = CGPoint(x: region.minX + region.width * (0.5 - half), y: region.midY)
        default:
            from = CGPoint(x: region.midX, y: region.minY + region.height * (0.5 + half))
            to = CGPoint(x: region.midX, y: region.minY + region.height * (0.5 - half))
        }
        let travel = Double(hypot(to.x - from.x, to.y - from.y)) / 2400
        let via = deliver(Self.stopAt(to, path: [(from, 0), (to, 0.03 + travel)]), params: params, app: app) {
            coordinate(from, in: app).press(forDuration: 0.05, thenDragTo: coordinate(to, in: app),
                                            withVelocity: XCUIGestureVelocity(2400), thenHoldForDuration: 0.12)
        }
        var result: [String: Any] = ["ok": true, "via": via]
        // A scroll that ends with the finger still has no follow-on animation
        // except the scroll indicator fading, which XCTest's idle wait sits
        // through. The structural settle check is enough here.
        var settleParams = params
        if settleParams["quiescence"] == nil { settleParams["quiescence"] = false }
        // The finger held still at the end, so the list is already at rest: a
        // short quiet window confirms it.
        if settleParams["quietMs"] == nil { settleParams["quietMs"] = 200 }
        result.merge(settle(app, params: settleParams)) { a, _ in a }
        return result
    }

    // MARK: - text

    private func typeText(_ params: [String: Any]) throws -> [String: Any] {
        guard let text = params["text"] as? String else { throw RunnerError.badParams("type needs text") }
        let app = frontmost(params).app
        guard app.keyboards.firstMatch.exists
            || app.descendants(matching: .any).matching(NSPredicate(format: "hasKeyboardFocus == 1")).firstMatch.exists else {
            throw RunnerError.actionFailed("no field has keyboard focus", hint: "tap or fill a text field first")
        }
        app.typeText(text)
        return ["ok": true]
    }

    /// Replace a field's text: focus it, clear what is there, type, then read
    /// the value back so the caller can confirm what the field now holds.
    private func fill(_ params: [String: Any]) throws -> [String: Any] {
        guard let ref = params["ref"] as? String, let text = params["text"] as? String else {
            throw RunnerError.badParams("fill needs ref and text")
        }
        guard let entry = tree.entry(for: ref) else {
            throw RunnerError(code: "STALE_REF", message: "unknown ref \(ref)", hint: "take a new snapshot and use a current ref")
        }
        // The same target checks as a tap: re-found where it is now (or refused
        // as gone or ambiguous), and not under the keyboard or another element.
        let (p, app, _) = try point(params)
        let field = element(for: entry, in: app, near: p)
        // Focus with the fast tap path at the field's current position (the
        // public element tap waits for the app to idle twice, ~0.8 s).
        _ = deliver([(p, 0), (p, 0.05)], params: params, app: app) {
            if let field { field.tap() } else { coordinate(p, in: app).tap() }
        }
        // waitForExistence costs about a second even when the element is
        // already there (it polls on a 1 s cycle), so check first.
        let keyboard = app.keyboards.firstMatch
        if !keyboard.exists { _ = keyboard.waitForExistence(timeout: 1.5) }
        var current = field.map { currentValue($0) } ?? entry.value
        var attempts = 0
        while !current.isEmpty, attempts < 3 {
            attempts += 1
            // Put the caret at the end, then delete everything before it.
            if let field {
                let frame = field.frame
                if frame.width > 44 {
                    coordinate(CGPoint(x: frame.maxX - 6, y: frame.midY), in: app).tap()
                }
            }
            app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2))
            current = field.map { currentValue($0) } ?? ""
        }
        if !text.isEmpty { app.typeText(text) }
        let final = field.map { currentValue($0) }
        var result: [String: Any] = ["ok": true]
        if let final { result["value"] = final }
        return result
    }

    private func currentValue(_ field: XCUIElement) -> String {
        let value = Tree.valueString(field.value)
        let placeholder = Tree.clean(field.placeholderValue ?? "")
        return value == placeholder ? "" : value
    }

    /// Whether a tap at the element's hit point reaches it (XCTest's hit test),
    /// or nil when the live element cannot be found by identity.
    /// Recent hit-test results by element and position: a screen is read many times
    /// while an agent works on it, and each query costs a resolution.
    private var reachCache: [String: (at: Date, hittable: Bool?)] = [:]

    private func reachable(_ entry: Tree.Entry, in app: XCUIApplication) -> Bool? {
        // Valid only while the element and what covers it stay where they were.
        let key = "\(Tree.identityBase(entry))|\(Int(entry.rect.minX)),\(Int(entry.rect.minY))|\(entry.covers)"
        if let hit = reachCache[key], Date().timeIntervalSince(hit.at) < 5 { return hit.hittable }
        let result = hitTest(entry, in: app)
        if reachCache.count > 200 { reachCache.removeAll() }
        reachCache[key] = (Date(), result)
        return result
    }

    private func hitTest(_ entry: Tree.Entry, in app: XCUIApplication) -> Bool? {
        // Only elements that a query can pin down: each match costs a resolution
        // (~0.3 s), and some screens repeat one identifier dozens of times (the
        // Contacts photo picker). Unknown is not a refusal.
        guard !entry.identifier.isEmpty || !entry.label.isEmpty else { return nil }
        var hittable: Bool?
        var error: NSError?
        _ = PURunCatching({
            var query = app.descendants(matching: entry.type)
            if !entry.identifier.isEmpty { query = query.matching(identifier: entry.identifier) }
            if !entry.label.isEmpty { query = query.matching(NSPredicate(format: "label == %@", entry.label)) }
            let count = query.count
            guard count > 0, count <= 4 else { return }
            let target = CGPoint(x: entry.rect.midX, y: entry.rect.midY)
            let element = (0..<count).map { query.element(boundBy: $0) }.min { a, b in
                hypot(a.frame.midX - target.x, a.frame.midY - target.y) < hypot(b.frame.midX - target.x, b.frame.midY - target.y)
            }
            hittable = element?.isHittable
        }, &error)
        return hittable
    }

    /// The live element behind a ref, when it can be found by identity, nearest
    /// the point the ref was re-found at. Text entry needs an element (not just
    /// a point) to read its value back.
    private func element(for entry: Tree.Entry, in app: XCUIApplication, near target: CGPoint) -> XCUIElement? {
        let query = app.descendants(matching: entry.type)
        let byId = entry.identifier.isEmpty ? nil : query.matching(identifier: entry.identifier)
        let byLabel = NSPredicate(format: "label == %@", entry.label)
        var candidates: [XCUIElement] = []
        // Identifier and label together first (identifiers repeat in lists); a
        // field's shown label can differ from its accessibility label, so then either.
        if let byId, !entry.label.isEmpty { candidates = byId.matching(byLabel).allElementsBoundByIndex }
        if candidates.isEmpty, let byId { candidates = byId.allElementsBoundByIndex }
        if candidates.isEmpty, !entry.label.isEmpty { candidates = query.matching(byLabel).allElementsBoundByIndex }
        // An unlabelled field is listed under its placeholder (Tree.displayLabel).
        if candidates.isEmpty, !entry.label.isEmpty {
            candidates = query.matching(NSPredicate(format: "placeholderValue == %@", entry.label)).allElementsBoundByIndex
        }
        return candidates.min { a, b in
            hypot(a.frame.midX - target.x, a.frame.midY - target.y) < hypot(b.frame.midX - target.x, b.frame.midY - target.y)
        }
    }

    private func legacyEnterText(_ params: [String: Any]) throws -> [String: Any] {
        if params["ref"] is String, params["replace"] as? Bool == true { return try fill(params) }
        if let ref = params["ref"] as? String, let text = params["text"] as? String {
            _ = try tap(["ref": ref])
            return try typeText(["text": text])
        }
        return try typeText(params)
    }

    private func key(_ params: [String: Any]) throws -> [String: Any] {
        let name = (params["key"] as? String ?? "return").lowercased()
        let app = frontmost(params).app
        switch name {
        case "return", "enter": app.typeText(XCUIKeyboardKey.return.rawValue)
        case "delete", "backspace": app.typeText(XCUIKeyboardKey.delete.rawValue)
        case "tab": app.typeText(XCUIKeyboardKey.tab.rawValue)
        case "space": app.typeText(XCUIKeyboardKey.space.rawValue)
        case "escape": app.typeText(XCUIKeyboardKey.escape.rawValue)
        case "dismiss":
            let hide = app.keyboards.buttons.matching(NSPredicate(format: "label IN %@", ["Hide keyboard", "Done", "Dismiss"])).firstMatch
            if hide.exists { hide.tap() } else { app.typeText(XCUIKeyboardKey.return.rawValue) }
        default:
            throw RunnerError.badParams("unsupported key \(name)")
        }
        return ["ok": true]
    }

    // MARK: - navigation

    /// In-app back: the navigation bar's back button when there is one,
    /// otherwise the system edge swipe.
    private func back(_ params: [String: Any]) throws -> [String: Any] {
        let (app, _) = frontmost(params)
        let snap = try app.snapshot()
        var backFrame: CGRect?
        func visit(_ node: XCUIElementSnapshot) {
            guard backFrame == nil else { return }
            if node.elementType == .navigationBar {
                for child in node.children where child.elementType == .button {
                    let identifier = child.identifier
                    if identifier == "BackButton" || child.frame.minX < 60 {
                        backFrame = child.frame
                        return
                    }
                }
            }
            for child in node.children { visit(child) }
        }
        visit(snap)
        var result: [String: Any]
        if let frame = backFrame {
            let p = CGPoint(x: frame.midX, y: frame.midY)
            _ = deliver([(p, 0), (p, 0.05)], params: params, app: app) { coordinate(p, in: app).tap() }
            result = ["ok": true, "method": "navigation-bar"]
        } else {
            let frame = snap.frame
            let from = CGPoint(x: 2, y: frame.midY)
            let to = CGPoint(x: frame.width * 0.75, y: frame.midY)
            _ = deliver([(from, 0), (to, 0.25)], params: params, app: app) {
                coordinate(from, in: app).press(forDuration: 0.05, thenDragTo: coordinate(to, in: app),
                                                withVelocity: XCUIGestureVelocity(1500), thenHoldForDuration: 0)
            }
            result = ["ok": true, "method": "edge-swipe"]
        }
        result.merge(settle(app, params: params)) { a, _ in a }
        return result
    }

    private func launch(_ params: [String: Any]) throws -> [String: Any] {
        guard let bundleId = (params["bundleId"] ?? params["app"]) as? String, !bundleId.isEmpty else {
            throw RunnerError.badParams("launch needs bundleId")
        }
        let app = XCUIApplication(bundleIdentifier: bundleId)
        if params["relaunch"] as? Bool == true {
            app.terminate()
            app.activate()
        } else {
            app.activate()
        }
        let timeout = (number(params["timeoutMs"]) ?? 15000) / 1000
        guard app.wait(for: .runningForeground, timeout: timeout) else {
            throw RunnerError.actionFailed("\(bundleId) did not come to the foreground within \(Int(timeout))s",
                                           hint: "check the bundle id with listApps; the app may be crashing at launch")
        }
        activeBundleId = bundleId
        if let url = params["url"] as? String, let parsed = URL(string: url) {
            app.open(parsed)
        }
        return ["ok": true, "bundleId": bundleId, "name": app.label]
    }

    private func terminate(_ params: [String: Any]) throws -> [String: Any] {
        guard let bundleId = params["bundleId"] as? String else { throw RunnerError.badParams("terminate needs bundleId") }
        XCUIApplication(bundleIdentifier: bundleId).terminate()
        if activeBundleId == bundleId { activeBundleId = nil }
        return ["ok": true]
    }

    private func openURL(_ params: [String: Any]) throws -> [String: Any] {
        guard let raw = params["url"] as? String, let url = URL(string: raw) else {
            throw RunnerError.badParams("open_url needs a valid url")
        }
        if let bundleId = params["bundleId"] as? String, !bundleId.isEmpty {
            let app = XCUIApplication(bundleIdentifier: bundleId)
            app.open(url)
            activeBundleId = bundleId
        } else {
            XCUIDevice.shared.system.open(url)
            activeBundleId = nil
        }
        return ["ok": true]
    }

    // MARK: - alerts

    private static let acceptLabels = ["allow while using app", "always allow", "allow", "ok", "yes", "continue",
                                       "allow once", "turn on", "enable", "agree", "accept", "got it", "join"]
    private static let dismissLabels = ["don't allow", "not now", "cancel", "no thanks", "no", "deny", "dismiss",
                                        "later", "skip", "don't"]

    private static func normalized(_ text: String) -> String {
        text.lowercased().replacingOccurrences(of: "\u{2019}", with: "'").trimmingCharacters(in: .whitespaces)
    }

    private func alert(_ params: [String: Any]) throws -> [String: Any] {
        let action = params["action"] as? String ?? "get"
        let (app, bundleId) = frontmost(params)
        var found: XCUIElement?
        for owner in bundleId == Self.springboardId ? [springboard] : [app, springboard] {
            let candidate = owner.alerts.firstMatch
            if candidate.exists { found = candidate; break }
        }
        guard let alert = found, let snap = try? alert.snapshot() else {
            return ["alert": NSNull(), "handled": false]
        }
        var texts: [String] = []
        var buttons: [(label: String, frame: CGRect)] = []
        func visit(_ node: XCUIElementSnapshot) {
            let label = Tree.clean(node.label)
            if node.elementType == .button, !label.isEmpty { buttons.append((label, node.frame)) }
            if node.elementType == .staticText, !label.isEmpty, !texts.contains(label) { texts.append(label) }
            for child in node.children { visit(child) }
        }
        visit(snap)
        let title = Tree.clean(snap.label).isEmpty ? (texts.first ?? "") : Tree.clean(snap.label)
        let message = texts.filter { $0 != title }.joined(separator: " ")
        var info: [String: Any] = ["title": title, "buttons": buttons.map(\.label)]
        if !message.isEmpty { info["message"] = message }
        if action == "get" { return ["alert": info, "handled": false] }

        var choice: (label: String, frame: CGRect)?
        if let wanted = params["button"] as? String {
            choice = buttons.first { Self.normalized($0.label) == Self.normalized(wanted) }
        } else {
            let prefs = action == "accept" ? Self.acceptLabels : Self.dismissLabels
            for p in prefs where choice == nil { choice = buttons.first { Self.normalized($0.label) == p } }
            for p in prefs where choice == nil { choice = buttons.first { Self.normalized($0.label).contains(p) } }
            if choice == nil {
                choice = action == "accept"
                    ? buttons.first { b in !Self.dismissLabels.contains { Self.normalized(b.label).contains($0) } }
                    : buttons.first
            }
        }
        guard let button = choice else {
            throw RunnerError.actionFailed("alert has no button to \(action)", hint: "buttons: \(buttons.map(\.label).joined(separator: ", "))")
        }
        coordinate(CGPoint(x: button.frame.midX, y: button.frame.midY), in: springboard).tap()
        return ["alert": info, "handled": true, "button": button.label]
    }

    // MARK: - waiting

    private func waitText(_ params: [String: Any]) throws -> [String: Any] {
        guard let text = params["text"] as? String, !text.isEmpty else { throw RunnerError.badParams("wait_text needs text") }
        let timeout = (number(params["timeoutMs"]) ?? 5000) / 1000
        let predicate = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@", text, text)
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let (app, _) = frontmost(params)
            if app.descendants(matching: .any).matching(predicate).firstMatch.waitForExistence(timeout: min(1.0, max(deadline.timeIntervalSinceNow, 0.05))) {
                return ["found": true]
            }
            if springboard.alerts.descendants(matching: .any).matching(predicate).firstMatch.exists {
                return ["found": true, "system": true]
            }
        } while Date() < deadline
        throw RunnerError(code: "TIMEOUT", message: "\"\(text)\" did not appear within \(Int(timeout * 1000))ms")
    }

    // MARK: - screenshot

    private func screenshot(_ params: [String: Any]) throws -> [String: Any] {
        let shot = XCUIScreen.main.screenshot()
        guard params["overlayRefs"] as? Bool == true else {
            return ["base64": shot.pngRepresentation.base64EncodedString()]
        }
        let image = shot.image
        let format = UIGraphicsImageRendererFormat()
        format.scale = image.scale
        let rendered = UIGraphicsImageRenderer(size: image.size, format: format).image { context in
            image.draw(at: .zero)
            let color = UIColor(red: 0.95, green: 0.2, blue: 0.45, alpha: 1)
            context.cgContext.setLineWidth(1.5)
            for (ref, entry) in tree.refs where Tree.isActionable(entry.type) || entry.type == .staticText {
                context.cgContext.setStrokeColor(color.cgColor)
                context.cgContext.stroke(entry.rect)
                let tag = NSAttributedString(string: ref, attributes: [
                    .font: UIFont.monospacedSystemFont(ofSize: 10, weight: .bold),
                    .foregroundColor: UIColor.white,
                    .backgroundColor: color,
                ])
                tag.draw(at: CGPoint(x: entry.rect.minX, y: max(entry.rect.minY - 12, 0)))
            }
        }
        guard let png = rendered.pngData() else { throw RunnerError.actionFailed("could not encode screenshot") }
        return ["base64": png.base64EncodedString()]
    }

    // MARK: - batch

    /// Several verbs in one round trip. Stops at the first failure and reports
    /// which step failed, so the caller knows exactly what ran.
    private func batch(_ params: [String: Any]) throws -> [String: Any] {
        guard let steps = params["steps"] as? [[String: Any]], !steps.isEmpty else {
            throw RunnerError.badParams("batch needs steps")
        }
        var results: [Any] = []
        for (index, step) in steps.enumerated() {
            guard let method = step["method"] as? String, method != "batch" else {
                throw RunnerError.badParams("step \(index) needs a method other than batch")
            }
            do {
                results.append(try handle(method: method, params: step["params"] as? [String: Any] ?? [:]))
            } catch let error as RunnerError {
                return ["ok": false, "failedStep": index, "error": ["code": error.code, "message": error.message], "results": results]
            }
            if let pause = number(step["pauseMs"]), pause > 0 {
                RunLoop.current.run(until: Date().addingTimeInterval(pause / 1000))
            }
        }
        return ["ok": true, "results": results]
    }
}

import XCTest

/// Accessibility-tree capture.
///
/// One `XCUIElement.snapshot()` call returns the whole tree in a single
/// round trip to the accessibility server, then all filtering happens in this
/// process. Querying element by element (the previous runner) costs one round
/// trip per property per element, which is what made big screens slow.
///
/// Refs (`e1`, `e2`, ...) are remembered here, so a later command can act on
/// `@e12` even from a different CLI process. A ref names one element identity
/// (app, type, identifier, label, and which occurrence of that combination):
/// the same element keeps its ref across captures, and a ref is never reused
/// for a different element. A ref from a screen that has gone therefore fails
/// as stale instead of silently naming whatever now has its number.
@MainActor
final class Tree {
    struct Entry {
        let rect: CGRect
        let type: XCUIElement.ElementType
        let label: String
        let identifier: String
        let value: String
        let bundleId: String
        /// Why a tap on this element would not reach it ("keyboard", "covered"), if any.
        var blocked: String? = nil
        /// Another listed element (not an ancestor) overlaps its centre, so a
        /// hit test must confirm a tap would reach it.
        var overlapped = false
        /// The overlapping element looks like an overlay (it spans few other
        /// controls), so the screen read itself confirms with a hit test.
        var overlayCandidate = false
        /// What overlaps it (their frames), so a cached hit test is reused only
        /// while the same things cover it.
        var covers = ""
        /// Frames of every element that shared this one's identity (type,
        /// identifier, label) when the ref was minted. Empty when it was unique.
        var peers: [CGRect] = []
    }

    /// Where a ref's element is now.
    enum Relocation {
        case found(CGRect)
        case gone
        /// Several elements match and the screen has changed since the ref was
        /// minted, so which one the ref named cannot be told.
        case ambiguous(Int)
    }

    private(set) var refs: [String: Entry] = [:]
    private(set) var generation = 0
    private(set) var capturedAt = Date.distantPast
    private var refByIdentity: [String: String] = [:]
    private var lastSeen: [String: Int] = [:]
    private var nextRef = 1
    /// Refs unseen for this many captures are forgotten (they then fail as unknown, still stale).
    private let retainGenerations = 50

    struct Options {
        var interactiveOnly = true
        var maxDepth: Int?
        var includeOffscreen = false
    }

    struct Capture {
        var nodes: [[String: Any]]
        var viewport: CGRect
        var offscreen: (above: Int, below: Int)
        var appLabel: String
    }

    /// Capture and mint fresh refs. `roots` are snapshots taken by the caller:
    /// the frontmost app first, then any system overlay (a SpringBoard
    /// permission alert sits outside the app's own tree).
    func capture(roots: [(snapshot: XCUIElementSnapshot, bundleId: String)], options: Options) -> Capture {
        let viewport = Self.finite(roots.first?.snapshot.frame ?? .zero)
        var nodes: [[String: Any]] = []
        var entries: [String: Entry] = [:]
        var above = 0
        var below = 0
        var keyboardSeen = false
        var windowSeen = false
        // Same control reported twice (siblings that mirror each other, like
        // the two scroll indicators or a button wrapping its own image).
        var seenKeys = Set<String>()
        var labelRects: [String: [CGRect]] = [:]

        var occurrences: [String: Int] = [:]
        // Per emitted node: the refs of its emitted ancestors.
        var ancestorsOf: [String: Set<String>] = [:]

        func visit(_ node: XCUIElementSnapshot, depth: Int, subsumed: [String], bundleId: String, overlay: Bool,
                   parent: (label: String, rect: CGRect)?, rowTitle: String? = nil, ancestors: Set<String> = [],
                   cell: CGRect? = nil) {
            if let maxDepth = options.maxDepth, depth > maxDepth { return }
            let type = node.elementType
            var frame = Self.finite(node.frame)
            // A UIKit list reports a row it has not laid out (below or above the
            // screen) with its contents collapsed onto the list's top corner,
            // while the row's cell keeps its true position. Content that lies
            // outside its own cell is where the cell is.
            if let cell, type != .cell, !frame.intersects(cell) { frame = cell }
            let onScreen = frame.width > 0 && frame.height > 0 && frame.intersects(viewport)
            let identifier = Self.clean(node.identifier)
            let label = Self.displayLabel(node, rowTitle: rowTitle)
            let placeholder = Self.clean(node.placeholderValue ?? "")
            var value = Self.valueString(node.value)
            if Self.isTextInput(type), value == placeholder { value = "" }

            var emit = false
            if !options.interactiveOnly {
                emit = onScreen || depth <= 1 || options.includeOffscreen
            } else {
                switch type {
                case .application:
                    emit = depth == 0 && !overlay
                case .window:
                    emit = !windowSeen && depth <= 1 && !overlay
                    if emit { windowSeen = true }
                case .alert, .sheet:
                    emit = true
                case .keyboard:
                    emit = onScreen && !keyboardSeen
                    keyboardSeen = keyboardSeen || emit
                case .navigationBar, .tabBar, .toolbar:
                    emit = onScreen && !label.isEmpty
                case .staticText, .image:
                    emit = onScreen && !label.isEmpty && !Self.isSubsumed(label, by: subsumed)
                case .scrollView, .table, .collectionView, .webView, .map:
                    emit = onScreen && (!identifier.isEmpty || !label.isEmpty)
                case .other:
                    let fullScreen = frame.width >= viewport.width * 0.95 && frame.height >= viewport.height * 0.9
                    // Containers named only by an internal identifier
                    // ("IOSChromeViewController<0x105e4c000>…") mean nothing to an agent.
                    let meaningfulId = !identifier.isEmpty && !Self.isInternalIdentifier(identifier)
                    emit = onScreen && !fullScreen && (meaningfulId || (!label.isEmpty && !Self.isSubsumed(label, by: subsumed)))
                default:
                    // iOS 26 draws a row's disclosure arrow as a disabled button
                    // named "chevron": noise, never a target.
                    if type == .button, !node.isEnabled, label == "chevron" { break }
                    if Self.isActionable(type) {
                        if onScreen || options.includeOffscreen {
                            emit = true
                        } else if frame.width > 0, frame.height > 0 {
                            if frame.maxY <= viewport.minY { above += 1 } else if frame.minY >= viewport.maxY { below += 1 }
                        }
                    }
                }
            }

            // A cell that wraps a same-size button (or a button inside a
            // button) is one control to an agent: keep the outer one.
            if emit, let parent, parent.label == label, Self.sameRect(parent.rect, frame) { emit = false }
            // The same text drawn by nested or stacked containers ("Location
            // Services is Off" three times) is one thing on screen.
            if emit, type == .other || type == .staticText, !label.isEmpty,
               let seen = labelRects[label], seen.contains(where: { $0.contains(frame) || frame.contains($0) }) {
                emit = false
            }
            if emit, type != .application, type != .window {
                let key = "\(type.rawValue)|\(label)|\(identifier)|\(Int(frame.minX))|\(Int(frame.minY))|\(Int(frame.width))|\(Int(frame.height))"
                if seenKeys.contains(key) { emit = false } else { seenKeys.insert(key) }
            }

            if emit {
                let base = "\(bundleId)|\(type.rawValue)|\(identifier)|\(label)"
                let occurrence = occurrences[base, default: 0]
                occurrences[base] = occurrence + 1
                let identity = "\(base)|\(occurrence)"
                let ref: String
                if let known = refByIdentity[identity] {
                    ref = known
                } else {
                    ref = "e\(nextRef)"
                    nextRef += 1
                    refByIdentity[identity] = ref
                }
                lastSeen[identity] = generation + 1
                ancestorsOf[ref] = ancestors
                var out: [String: Any] = [
                    "ref": ref,
                    "type": Self.typeName(type),
                    "rect": [
                        "x": Self.round(frame.origin.x), "y": Self.round(frame.origin.y),
                        "width": Self.round(frame.width), "height": Self.round(frame.height),
                    ],
                ]
                if !label.isEmpty { out["label"] = label }
                if !value.isEmpty { out["value"] = value }
                if !identifier.isEmpty { out["identifier"] = identifier }
                if !placeholder.isEmpty, Self.isTextInput(type) { out["placeholder"] = placeholder }
                if !node.isEnabled { out["enabled"] = false }
                if node.isSelected { out["selected"] = true }
                if node.hasFocus { out["focused"] = true }
                if !onScreen { out["offscreen"] = true }
                if overlay { out["system"] = true }
                nodes.append(out)
                if !label.isEmpty { labelRects[label, default: []].append(frame) }
                entries[ref] = Entry(rect: frame, type: type, label: label, identifier: identifier, value: value, bundleId: bundleId)
            }

            // Keys are noise for an agent: one "Keyboard" node says it is up.
            if type == .keyboard { return }
            var nextSubsumed = subsumed
            if emit, !label.isEmpty, type != .application, type != .window { nextSubsumed.append(label) }
            let nextParent = emit ? (label, frame) : parent
            let nextRowTitle = type == .cell ? Self.firstText(node) : rowTitle
            var nextAncestors = ancestors
            if emit, let ref = nodes.last?["ref"] as? String { nextAncestors.insert(ref) }
            for child in node.children {
                visit(child, depth: depth + 1, subsumed: nextSubsumed, bundleId: bundleId, overlay: overlay, parent: nextParent,
                      rowTitle: nextRowTitle, ancestors: nextAncestors, cell: type == .cell ? frame : cell)
            }
        }

        for (index, root) in roots.enumerated() {
            visit(root.snapshot, depth: 0, subsumed: [], bundleId: root.bundleId, overlay: index > 0, parent: nil)
        }
        // Second pass: anything whose centre sits under the on-screen keyboard
        // cannot receive a tap; a tap there types a key instead.
        if let keyboard = nodes.first(where: { $0["type"] as? String == "Keyboard" }), let kref = keyboard["ref"] as? String,
           let kframe = entries[kref]?.rect {
            for index in nodes.indices {
                guard let ref = nodes[index]["ref"] as? String, ref != kref, var entry = entries[ref] else { continue }
                if nodes[index]["system"] as? Bool == true { continue }
                if kframe.contains(CGPoint(x: entry.rect.midX, y: entry.rect.midY)) {
                    nodes[index]["blocked"] = "keyboard"
                    entry.blocked = "keyboard"
                    entries[ref] = entry
                }
            }
        }
        // Elements that share an identity: re-finding one later must know it had twins.
        var framesByIdentity: [String: [CGRect]] = [:]
        for entry in entries.values { framesByIdentity[Self.identityBase(entry), default: []].append(entry.rect) }
        for (ref, entry) in entries {
            let frames = framesByIdentity[Self.identityBase(entry)] ?? []
            if frames.count > 1 { entries[ref]?.peers = frames }
        }
        // A listed element whose centre lies inside another listed element that
        // is neither its ancestor nor its descendant may be covered by it (an
        // overlay, a sheet, a keyboard's input view). The accessibility order is
        // by position, not by what is drawn on top, so the engine confirms these
        // with a hit test.
        let containers: Set<String> = ["Application", "Window", "Table", "CollectionView", "ScrollView", "WebView", "Map", "Keyboard"]
        let keyboardUp = nodes.contains { $0["type"] as? String == "Keyboard" }
        let listed = nodes.compactMap { node -> (ref: String, type: String, rect: CGRect)? in
            guard let ref = node["ref"] as? String, let entry = entries[ref], node["system"] as? Bool != true,
                  // Scroll indicators sit over content but never take touches.
                  !entry.label.localizedCaseInsensitiveContains("scroll bar"),
                  // With a keyboard up, its input view holds the keyboard's own controls
                  // (and the keyboard rule above covers the app beneath). Without one,
                  // the input view is an intro or custom panel and does cover.
                  !(keyboardUp && entry.label == "inputView") else { return nil }
            return (ref, node["type"] as? String ?? "", entry.rect)
        }
        for index in nodes.indices {
            guard let ref = nodes[index]["ref"] as? String, var entry = entries[ref], entry.blocked == nil,
                  Self.isActionable(entry.type), nodes[index]["system"] as? Bool != true else { continue }
            let centre = CGPoint(x: entry.rect.midX, y: entry.rect.midY)
            let mine = ancestorsOf[ref] ?? []
            // An element with no name cannot be found again for a hit test, and a
            // same-frame twin is a mirror (a button and its own image), not a cover.
            let coverers = (!entry.identifier.isEmpty || !entry.label.isEmpty) ? listed.filter { other in
                other.ref != ref && !containers.contains(other.type) && !mine.contains(other.ref)
                    && !(ancestorsOf[other.ref]?.contains(ref) ?? false) && other.rect.contains(centre)
                    && !Self.sameRect(other.rect, entry.rect)
                    && other.rect.width * other.rect.height >= entry.rect.width * entry.rect.height * 0.5
            } : []
            if !coverers.isEmpty {
                entry.overlapped = true
                entry.covers = coverers.map { "\(Int($0.rect.minX)),\(Int($0.rect.minY)),\(Int($0.rect.width)),\(Int($0.rect.height))" }
                    .sorted().joined(separator: ";")
                // A panel behind a group of controls (Maps' search card) spans many of
                // them; an overlay over one control spans few. Only the latter is worth
                // a hit test on every screen read; taps check every overlapped element.
                entry.overlayCandidate = coverers.contains { cover in
                    listed.filter { other in
                        other.ref != cover.ref && !(ancestorsOf[other.ref]?.contains(cover.ref) ?? false)
                            && cover.rect.contains(CGPoint(x: other.rect.midX, y: other.rect.midY))
                    }.count <= 2
                }
                entries[ref] = entry
            }
        }
        generation += 1
        // Keep earlier refs for a while: a ref from a screen that has gone then
        // fails with "no longer on screen" (and never names a new element).
        for (identity, seen) in lastSeen where generation - seen > retainGenerations {
            if let ref = refByIdentity[identity] { refs[ref] = nil }
            refByIdentity[identity] = nil
            lastSeen[identity] = nil
        }
        for (ref, entry) in entries { refs[ref] = entry }
        capturedAt = Date()
        return Capture(nodes: nodes, viewport: viewport, offscreen: (above, below), appLabel: Self.clean(roots.first?.snapshot.label ?? ""))
    }

    /// Mark a captured element (after a hit test the engine ran).
    func setBlocked(_ ref: String, _ reason: String) {
        refs[Self.normalize(ref)]?.blocked = reason
    }

    /// The name an agent reads for an element: its label, or what stands in
    /// for a missing one. Capture and relocation must agree on it exactly.
    static func displayLabel(_ node: XCUIElementSnapshot, rowTitle: String?) -> String {
        let type = node.elementType
        var label = clean(node.label)
        let identifier = clean(node.identifier)
        if label.isEmpty, type == .navigationBar {
            // UIKit puts a navigation bar's title in its identifier.
            label = identifier
        } else if label.isEmpty, type == .switch || type == .toggle, let rowTitle, !rowTitle.isEmpty {
            // Settings-style rows label the text, not the switch, which then
            // surfaces only as its identifier ("CameraGridSwitch"). Name it
            // after its row ("Grid") so it can be toggled by name.
            label = rowTitle
        } else if label.isEmpty, type == .webView {
            // A page's title is the label of the web document inside the
            // view, a full-screen container the filter would drop: name the
            // web view after it so the page is identifiable.
            label = documentTitle(node) ?? ""
        } else if label.isEmpty, aggregatesChildren(type) {
            label = aggregateLabel(node)
        }
        // An unlabelled field is known by its placeholder ("Phone"), which
        // is what a person reads and what an agent will ask for.
        let placeholder = clean(node.placeholderValue ?? "")
        if label.isEmpty, isTextInput(type), !placeholder.isEmpty { label = placeholder }
        return label
    }

    /// Find where a ref's element is now. The screen may have moved since the
    /// ref was minted (a list scrolled, a banner pushed content down), so a
    /// fresh capture is searched for the same element and its current frame is
    /// used. Gone when no matching element is on screen any more; ambiguous
    /// when several match and nothing says which one the ref named.
    /// The capture the last relocation searched (the screen just before an action).
    private(set) var lastRoot: XCUIElementSnapshot?

    func relocate(_ entry: Entry, in app: XCUIApplication) -> Relocation {
        guard let root = try? app.snapshot() else { return .gone }
        lastRoot = root
        let viewport = root.frame
        var frames: [CGRect] = []
        func visit(_ node: XCUIElementSnapshot, rowTitle: String?) {
            if node.elementType == entry.type {
                // Same identity means every part that was recorded matches: an
                // identifier alone can be reused (index identifiers repeat
                // after an insert), and a label alone can repeat.
                let identifier = Self.clean(node.identifier)
                let label = Self.displayLabel(node, rowTitle: rowTitle)
                let idMatches = entry.identifier.isEmpty || identifier == entry.identifier
                let labelMatches = entry.label.isEmpty || label == entry.label
                let frame = Self.finite(node.frame)
                if idMatches, labelMatches, !(entry.identifier.isEmpty && entry.label.isEmpty),
                   frame.width > 0, frame.height > 0, frame.intersects(viewport) {
                    frames.append(frame)
                }
            }
            let nextRowTitle = node.elementType == .cell ? Self.firstText(node) : rowTitle
            for child in node.children { visit(child, rowTitle: nextRowTitle) }
        }
        visit(root, rowTitle: nil)
        // One control reported at nested levels (a button wrapping a button of
        // the same name) is one element: keep the outermost, drop exact repeats.
        var found: [CGRect] = []
        for frame in frames where !frames.contains(where: { $0.contains(frame) && !Self.sameRect($0, frame) }) {
            if !found.contains(where: { Self.sameRect($0, frame) }) { found.append(frame) }
        }
        if found.isEmpty { return .gone }
        if entry.peers.count <= 1 {
            // It was the only one: wherever it moved, this is it. A new twin
            // makes it unclear which is meant.
            return found.count == 1 ? .found(found[0]) : .ambiguous(found.count)
        }
        // It had twins. Only an unchanged set of twins says which one it was
        // (after an insert, a different twin sits at its old position).
        let unchanged = found.count == entry.peers.count
            && found.allSatisfy { f in entry.peers.contains { Self.sameRect($0, f) } }
        if unchanged, let mine = found.first(where: { Self.sameRect($0, entry.rect) }) { return .found(mine) }
        return .ambiguous(found.count)
    }

    /// The identity part of a ref, without the occurrence index.
    static func identityBase(_ entry: Entry) -> String {
        "\(entry.bundleId)|\(entry.type.rawValue)|\(entry.identifier)|\(entry.label)"
    }

    func entry(for ref: String) -> Entry? {
        refs[Self.normalize(ref)]
    }

    static func normalize(_ ref: String) -> String {
        var key = ref.hasPrefix("@") ? String(ref.dropFirst()) : ref
        if let tilde = key.firstIndex(of: "~") { key = String(key[key.startIndex..<tilde]) }
        return key
    }

    // MARK: - helpers

    static func clean(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{00A0}", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func round(_ value: CGFloat) -> Double {
        (Double(value) * 10).rounded() / 10
    }

    static func valueString(_ value: Any?) -> String {
        switch value {
        case let string as String: return clean(string)
        case let number as NSNumber: return number.stringValue
        default: return ""
        }
    }

    /// XCTest reports some elements with a null (infinite) frame. An infinite
    /// value traps when converted to Int and makes JSON encoding raise, either
    /// of which would kill the runner, so treat such frames as empty.
    static func finite(_ rect: CGRect) -> CGRect {
        guard !rect.isNull, !rect.isInfinite,
              rect.origin.x.isFinite, rect.origin.y.isFinite, rect.width.isFinite, rect.height.isFinite
        else { return .zero }
        return rect
    }

    static func sameRect(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) <= 2 && abs(a.minY - b.minY) <= 2 && abs(a.width - b.width) <= 2 && abs(a.height - b.height) <= 2
    }

    static func isSubsumed(_ label: String, by ancestors: [String]) -> Bool {
        ancestors.contains { $0 == label || $0.contains(label) }
    }

    static func aggregatesChildren(_ type: XCUIElement.ElementType) -> Bool {
        type == .cell || type == .button || type == .link || type == .other
    }

    /// A cell or button with no label of its own is named by its texts, the
    /// way VoiceOver reads it ("General", "Wi-Fi, Off").
    static func aggregateLabel(_ node: XCUIElementSnapshot) -> String {
        var parts: [String] = []
        func visit(_ n: XCUIElementSnapshot, depth: Int) {
            guard parts.count < 3, depth < 6 else { return }
            if n.elementType == .staticText {
                let text = clean(n.label)
                if !text.isEmpty, !parts.contains(text) { parts.append(text) }
            }
            for child in n.children { visit(child, depth: depth + 1) }
        }
        for child in node.children { visit(child, depth: 1) }
        return parts.joined(separator: ", ")
    }

    /// UIKit/SwiftUI class names and memory addresses that leak into identifiers.
    static func isInternalIdentifier(_ identifier: String) -> Bool {
        identifier.contains("<0x") || identifier.hasSuffix("ViewController") || identifier.contains("ViewController.")
            || identifier.contains("ViewController<")
    }

    /// The label of the first labelled container inside a web view (its document).
    static func documentTitle(_ node: XCUIElementSnapshot, depth: Int = 0) -> String? {
        guard depth < 4 else { return nil }
        for child in node.children {
            if child.elementType == .other {
                let title = clean(child.label)
                if !title.isEmpty { return title }
            }
            if let nested = documentTitle(child, depth: depth + 1) { return nested }
        }
        return nil
    }

    /// The first non-empty static text inside a row: its title.
    static func firstText(_ node: XCUIElementSnapshot) -> String? {
        for child in node.children {
            if child.elementType == .staticText {
                let text = clean(child.label)
                if !text.isEmpty { return text }
            }
            if let nested = firstText(child) { return nested }
        }
        return nil
    }

    static func isTextInput(_ type: XCUIElement.ElementType) -> Bool {
        type == .textField || type == .secureTextField || type == .searchField || type == .textView
    }

    static func isActionable(_ type: XCUIElement.ElementType) -> Bool {
        switch type {
        case .button, .cell, .link, .menuItem, .menuButton, .tab, .switch, .toggle, .slider, .stepper,
             .picker, .pickerWheel, .datePicker, .segmentedControl, .textField, .secureTextField,
             .searchField, .textView, .icon, .checkBox, .radioButton, .popUpButton, .comboBox,
             .disclosureTriangle, .incrementArrow, .decrementArrow, .pageIndicator, .tableRow, .outlineRow:
            return true
        default:
            return false
        }
    }

    static func typeName(_ type: XCUIElement.ElementType) -> String {
        switch type {
        case .any: return "Any"
        case .other: return "Other"
        case .application: return "Application"
        case .group: return "Group"
        case .window: return "Window"
        case .sheet: return "Sheet"
        case .drawer: return "Drawer"
        case .alert: return "Alert"
        case .dialog: return "Dialog"
        case .button: return "Button"
        case .radioButton: return "RadioButton"
        case .radioGroup: return "RadioGroup"
        case .checkBox: return "CheckBox"
        case .disclosureTriangle: return "DisclosureTriangle"
        case .popUpButton: return "PopUpButton"
        case .comboBox: return "ComboBox"
        case .menuButton: return "MenuButton"
        case .toolbarButton: return "ToolbarButton"
        case .popover: return "Popover"
        case .keyboard: return "Keyboard"
        case .key: return "Key"
        case .navigationBar: return "NavigationBar"
        case .tabBar: return "TabBar"
        case .tabGroup: return "TabGroup"
        case .toolbar: return "Toolbar"
        case .statusBar: return "StatusBar"
        case .table: return "Table"
        case .tableRow: return "TableRow"
        case .tableColumn: return "TableColumn"
        case .outline: return "Outline"
        case .outlineRow: return "OutlineRow"
        case .browser: return "Browser"
        case .collectionView: return "CollectionView"
        case .slider: return "Slider"
        case .pageIndicator: return "PageIndicator"
        case .progressIndicator: return "ProgressIndicator"
        case .activityIndicator: return "ActivityIndicator"
        case .segmentedControl: return "SegmentedControl"
        case .picker: return "Picker"
        case .pickerWheel: return "PickerWheel"
        case .switch: return "Switch"
        case .toggle: return "Toggle"
        case .link: return "Link"
        case .image: return "Image"
        case .icon: return "Icon"
        case .searchField: return "SearchField"
        case .scrollView: return "ScrollView"
        case .scrollBar: return "ScrollBar"
        case .staticText: return "StaticText"
        case .textField: return "TextField"
        case .secureTextField: return "SecureTextField"
        case .datePicker: return "DatePicker"
        case .textView: return "TextView"
        case .menu: return "Menu"
        case .menuItem: return "MenuItem"
        case .menuBar: return "MenuBar"
        case .menuBarItem: return "MenuBarItem"
        case .map: return "Map"
        case .webView: return "WebView"
        case .incrementArrow: return "IncrementArrow"
        case .decrementArrow: return "DecrementArrow"
        case .timeline: return "Timeline"
        case .ratingIndicator: return "RatingIndicator"
        case .valueIndicator: return "ValueIndicator"
        case .splitGroup: return "SplitGroup"
        case .splitter: return "Splitter"
        case .relevanceIndicator: return "RelevanceIndicator"
        case .colorWell: return "ColorWell"
        case .helpTag: return "HelpTag"
        case .matte: return "Matte"
        case .dockItem: return "DockItem"
        case .ruler: return "Ruler"
        case .rulerMarker: return "RulerMarker"
        case .grid: return "Grid"
        case .levelIndicator: return "LevelIndicator"
        case .cell: return "Cell"
        case .layoutArea: return "LayoutArea"
        case .layoutItem: return "LayoutItem"
        case .handle: return "Handle"
        case .stepper: return "Stepper"
        case .tab: return "Tab"
        case .touchBar: return "TouchBar"
        case .statusItem: return "StatusItem"
        @unknown default: return "Other"
        }
    }
}

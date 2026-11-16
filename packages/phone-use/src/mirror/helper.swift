// Native helper for the iPhone Mirroring backend.
//
// Everything that needs AppKit, Vision or CGEvent lives here so the TypeScript
// side stays a thin process call. Compiled once into ~/.phone-use/bin and
// cached; see backend.ts.
//
// Coordinates: every rect this prints, and every point it accepts, is in
// WINDOW-RELATIVE POINTS with a top-left origin. The TypeScript side never sees
// screen coordinates, so a moved or resized Mirroring window changes nothing.
//
// Input is delivered to the Mirroring PROCESS (CGEvent.postToPid), not the
// focused window — the phone can be driven from a background window while the
// user keeps working. PHONE_USE_MIRROR_FOCUS=1 restores focus-based delivery.
//
// Subcommands:
//   window                       -> {"x","y","w","h","id","frontmost"}
//   ocr                          -> [{"text","x","y","w","h","confidence"}]
//   capture <path>               -> {"path","w","h"}
//   tap <x> <y>
//   longpress <x> <y> <ms>
//   drag <x1> <y1> <x2> <y2> <ms>
//   scroll <dx> <dy> <x> <y>
//   type <text>
//   key <return|delete|escape|tab|space>
//   focus

import AppKit
import CoreGraphics
import Foundation
import Vision

let MIRROR_APP = "iPhone Mirroring"
/// The app is matched by bundle id, never by name: the owner name is localized
/// ("iPhone镜像" on a Simplified Chinese Mac), so a name test finds nothing there.
let MIRROR_BUNDLE = "com.apple.ScreenContinuity"

func die(_ message: String) -> Never {
    FileHandle.standardError.write(("phone-use-mirror: " + message + "\n").data(using: .utf8)!)
    exit(2)
}

func emit(_ value: Any) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

/// The Mirroring window's screen rect, in top-left-origin screen points.
struct MirrorWindow {
    let x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat
    let id: CGWindowID
    let frontmost: Bool
}

func findWindow() -> MirrorWindow {
    let options = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
    guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        die("could not enumerate windows — grant Screen Recording permission")
    }
    let frontmost = NSWorkspace.shared.frontmostApplication?.bundleIdentifier == MIRROR_BUNDLE
    let pid = mirrorApp()?.processIdentifier ?? -1
    for entry in list {
        guard let owner = entry[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
              let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
              let number = entry[kCGWindowNumber as String] as? CGWindowID
        else { continue }
        // Mirroring keeps small helper windows around; the phone is the big one.
        if bounds.height < 200 { continue }
        return MirrorWindow(x: bounds.minX, y: bounds.minY, w: bounds.width, h: bounds.height,
                            id: number, frontmost: frontmost)
    }
    die("no iPhone Mirroring window found — open iPhone Mirroring and connect your phone")
}

/// Capture the window to a file.
///
/// CGWindowListCreateImage was obsoleted in macOS 15 and ScreenCaptureKit is an
/// async, entitlement-heavy replacement for what is a one-shot grab, so shell
/// out to screencapture(1), which still takes a window id and is not going
/// anywhere.
@discardableResult
func captureWindowFile(_ win: MirrorWindow, _ path: String) -> String {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    // -x silent, -o no window shadow, -l<id> just this window.
    task.arguments = ["-x", "-o", "-l\(win.id)", path]
    try? task.run()
    task.waitUntilExit()
    guard task.terminationStatus == 0, FileManager.default.fileExists(atPath: path) else {
        die("window capture failed — grant Screen Recording permission to this terminal")
    }
    return path
}

/// Capture into a CGImage for Vision.
func captureWindow(_ win: MirrorWindow) -> CGImage {
    let path = NSTemporaryDirectory() + "phone-use-mirror-\(getpid()).png"
    captureWindowFile(win, path)
    defer { try? FileManager.default.removeItem(atPath: path) }
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { die("could not decode the captured window") }
    return image
}

/// Screen point for a window-relative point.
func toScreen(_ win: MirrorWindow, _ x: Double, _ y: Double) -> CGPoint {
    CGPoint(x: win.x + CGFloat(x), y: win.y + CGFloat(y))
}

func mirrorApp() -> NSRunningApplication? {
    NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == MIRROR_BUNDLE }
}

func focusMirror() {
    mirrorApp()?.activate()
    usleep(120_000)
}

/// Background input via SkyLight (the private window server).
///
/// postToPid delivers keys and app shortcuts (the Mirroring app consumes those),
/// but a real iOS-content TAP is gated on the app being active — a plain CGEvent
/// cannot cross that, and a tap that "worked" on the native pause button does not
/// prove it works on mirrored iOS pixels. SkyLight's SLPSPostEventRecordTo posts
/// a synthesized event record straight to the process+window, landing a
/// positioned tap while the frontmost app never changes. The 0xf8 record layout
/// is yabai's window_manager_make_key_window. Approach ported from
/// ShawnPana/phone-harness (MIT).
enum Sky {
    typealias GetPSN = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32
    typealias SetFront = @convention(c) (UnsafeMutableRawPointer, UInt32, UInt32) -> Int32
    typealias PostRec = @convention(c) (UnsafeMutableRawPointer, UnsafeMutableRawPointer) -> Int32

    static func sym<T>(_ name: String, _ path: String) -> T? {
        guard let handle = dlopen(path, RTLD_LAZY), let ptr = dlsym(handle, name) else { return nil }
        return unsafeBitCast(ptr, to: T.self)
    }
    static let appServices = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
    static let skyLight = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
    static let getPSN: GetPSN? = sym("GetProcessForPID", appServices)
    // Leading underscore is part of the C name; dlsym adds the symbol-table one.
    static let setFront: SetFront? = sym("_SLPSSetFrontProcessWithOptions", skyLight)
    static let postRec: PostRec? = sym("SLPSPostEventRecordTo", skyLight)
    static var ready: Bool { getPSN != nil && setFront != nil && postRec != nil }

    static func psn(_ pid: pid_t) -> [UInt32] {
        var p = [UInt32](repeating: 0, count: 2)
        _ = p.withUnsafeMutableBytes { getPSN?(pid, $0.baseAddress!) }
        return p
    }

    /// One mouse event record. CGSEventType: 1 down, 2 up, 6 dragged.
    ///
    /// Deliberately does NOT call _SLPSSetFrontProcessWithOptions. yabai pairs
    /// the record with SetFront to give a window keyboard focus, but for a mouse
    /// event that call makes iPhone Mirroring the active app (stealing focus)
    /// AND stops the tap landing on iOS content. Verified on a real iPhone:
    /// posting the record alone lands the tap and leaves the frontmost app
    /// untouched; adding SetFront breaks both. This is the crux of true
    /// background driving.
    static func mouse(pid: pid_t, wid: UInt32, type: UInt8,
                      gx: Double, gy: Double, lx: Double, ly: Double) {
        guard let postRec else { return }
        var buf = [UInt8](repeating: 0, count: 0xf8)
        buf[0x04] = 0xf8
        buf[0x3a] = 0x10
        buf[0x08] = type
        buf.withUnsafeMutableBytes {
            $0.storeBytes(of: wid, toByteOffset: 0x3c, as: UInt32.self)
            $0.storeBytes(of: gx, toByteOffset: 0x10, as: Double.self)
            $0.storeBytes(of: gy, toByteOffset: 0x18, as: Double.self)
            $0.storeBytes(of: lx, toByteOffset: 0x20, as: Double.self)
            $0.storeBytes(of: ly, toByteOffset: 0x28, as: Double.self)
        }
        var p = psn(pid)
        p.withUnsafeMutableBytes { pp in
            buf.withUnsafeMutableBytes { bb in
                let status = postRec(pp.baseAddress!, bb.baseAddress!)
                // 0 is success. Anything else (1002 when this process is not
                // trusted for Accessibility) means the touch never happened, so
                // fail loudly instead of reporting a tap that did nothing.
                if status != 0 { die("SkyLight rejected the touch (error \(status)) — grant Accessibility to the app running phone-use") }
            }
        }
    }

    /// Make the window key WITHOUT raising it (blanked location record), so a
    /// following CGEventPostToPid keystroke reaches the iOS text responder.
    static func makeKey(pid: pid_t, wid: UInt32) {
        guard let postRec else { return }
        var buf = [UInt8](repeating: 0, count: 0xf8)
        buf[0x04] = 0xf8
        buf[0x3a] = 0x10
        buf.withUnsafeMutableBytes { $0.storeBytes(of: wid, toByteOffset: 0x3c, as: UInt32.self) }
        for i in 0x20..<0x30 { buf[i] = 0xff } // blanked location => focus, not a click
        var p = psn(pid)
        for edge: UInt8 in [1, 2] {
            buf[0x08] = edge
            p.withUnsafeMutableBytes { pp in
                buf.withUnsafeMutableBytes { bb in
                    let status = postRec(pp.baseAddress!, bb.baseAddress!)
                    if status != 0 { die("SkyLight rejected the focus record (error \(status)) — grant Accessibility to the app running phone-use") }
                }
            }
        }
    }
}

/// Three delivery modes:
///   BG (default)      — SkyLight event records; no focus, cursor untouched.
///   FOCUS_MODE=1      — activate the window, post global CGEvents (old path).
///   SkyLight missing  — falls back to FOCUS behaviour so input still lands.
let FOCUS_MODE = ProcessInfo.processInfo.environment["PHONE_USE_MIRROR_FOCUS"] == "1"
let MIRROR_PID: pid_t = mirrorApp()?.processIdentifier ?? -1
let BG = !FOCUS_MODE && MIRROR_PID >= 0 && Sky.ready

/// Run before every input. Focus-mode input is posted to the global HID event
/// tap, which delivers it to whatever Mac app is in front — so without a live
/// Mirroring window in front, a "type" would land in the user's editor. Refuse
/// instead: no Mirroring app, no window, or another app still frontmost after
/// activating means nothing is sent.
func prepare() {
    guard mirrorApp() != nil else { die("iPhone Mirroring is not running — no input was sent") }
    _ = findWindow() // dies when there is no Mirroring window
    if !BG {
        focusMirror()
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == MIRROR_BUNDLE else {
            die("iPhone Mirroring did not come to the front — no input was sent")
        }
    }
}

/// Keyboard / shortcut delivery. Shortcuts (Cmd+1…) are consumed by the
/// Mirroring app, so postToPid reaches them; keystrokes into an iOS field need
/// a preceding Sky.makeKey (handled by the callers below).
func post(_ event: CGEvent?) {
    if BG { event?.postToPid(MIRROR_PID) } else { event?.post(tap: .cghidEventTap) }
}

// ── mouse primitives, mode-aware ──────────────────────────────────────────
func mMove(_ win: MirrorWindow, _ gx: Double, _ gy: Double) {
    guard !BG else { return } // a positioned SkyLight tap needs no cursor move
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                 mouseCursorPosition: CGPoint(x: gx, y: gy), mouseButton: .left))
}
func mBtn(_ win: MirrorWindow, _ sky: UInt8, _ cg: CGEventType, _ gx: Double, _ gy: Double) {
    if BG {
        Sky.mouse(pid: MIRROR_PID, wid: UInt32(win.id), type: sky,
                  gx: gx, gy: gy, lx: gx - Double(win.x), ly: gy - Double(win.y))
    } else {
        post(CGEvent(mouseEventSource: nil, mouseType: cg,
                     mouseCursorPosition: CGPoint(x: gx, y: gy), mouseButton: .left))
    }
}
func mDown(_ w: MirrorWindow, _ gx: Double, _ gy: Double) { mBtn(w, 1, .leftMouseDown, gx, gy) }
func mUp(_ w: MirrorWindow, _ gx: Double, _ gy: Double) { mBtn(w, 2, .leftMouseUp, gx, gy) }
func mDrag(_ w: MirrorWindow, _ gx: Double, _ gy: Double) { mBtn(w, 6, .leftMouseDragged, gx, gy) }

func tap(_ win: MirrorWindow, _ x: Double, _ y: Double) {
    prepare()
    let gx = Double(win.x) + x, gy = Double(win.y) + y
    mMove(win, gx, gy)
    usleep(60_000)
    mDown(win, gx, gy)
    usleep(45_000)
    mUp(win, gx, gy)
}

func longPress(_ win: MirrorWindow, _ x: Double, _ y: Double, _ ms: Int) {
    prepare()
    let gx = Double(win.x) + x, gy = Double(win.y) + y
    mMove(win, gx, gy)
    usleep(60_000)
    mDown(win, gx, gy)
    usleep(useconds_t(max(200, ms) * 1000))
    mUp(win, gx, gy)
}

func drag(_ win: MirrorWindow, _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ ms: Int) {
    prepare()
    let gx1 = Double(win.x) + x1, gy1 = Double(win.y) + y1
    let gx2 = Double(win.x) + x2, gy2 = Double(win.y) + y2
    let steps = 24
    mMove(win, gx1, gy1)
    usleep(80_000)
    mDown(win, gx1, gy1)
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        mDrag(win, gx1 + (gx2 - gx1) * t, gy1 + (gy2 - gy1) * t)
        usleep(useconds_t(max(1, ms / steps) * 1000))
    }
    mUp(win, gx2, gy2)
}

/// Scroll. Two mechanisms by mode:
///
/// FOCUS: a scroll-wheel event. The delta magnitude is load-bearing — iPhone
/// Mirroring drops small per-event deltas, so ~120px/event scrolls where
/// ~50px does nothing (measured, iPhone 17 Pro Max).
///
/// BG: wheel events never reach a background window (0% movement, measured), so
/// scroll is a fast touch-flick instead — enough release velocity to carry the
/// iOS list. dy > 0 reveals content below (finger flicks up). Sign matches the
/// wheel path; confirm direction on device. [ShawnPana/phone-harness]
func scroll(_ win: MirrorWindow, _ dx: Int, _ dy: Int, _ x: Double, _ y: Double) {
    prepare()
    if BG {
        let cx = Double(win.x) + x
        let top = Double(win.y), h = Double(win.h)
        let (fy0, fy1) = dy >= 0
            ? (top + h * 0.72, top + h * 0.28)
            : (top + h * 0.28, top + h * 0.72)
        let steps = 6
        mDown(win, cx, fy0)
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            mDrag(win, cx, fy0 + (fy1 - fy0) * t)
            usleep(6_000) // fast — velocity is what carries the list
        }
        mUp(win, cx, fy1)
        return
    }
    let p = toScreen(win, x, y)
    mMove(win, Double(p.x), Double(p.y))
    usleep(120_000)
    for _ in 0..<6 {
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                                  wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)
        else { continue }
        event.location = p
        post(event)
        usleep(50_000)
    }
}

/// US-layout virtual keycodes. Typing goes through these rather than
/// CGEventKeyboardSetUnicodeString because iPhone Mirroring ignores synthetic
/// unicode key events entirely — the keystrokes vanish with no error, which
/// looks exactly like a text field that refused focus. Measured against
/// Spotlight on a real iPhone.
let CHAR_KEYS: [Character: (CGKeyCode, Bool)] = {
    let lower: [Character: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32,
        "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
        "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
        "0": 29, " ": 49, "-": 27, "=": 24, "[": 33, "]": 30, ";": 41, "'": 39,
        ",": 43, ".": 47, "/": 44, "\\": 42, "`": 50,
    ]
    // The characters a US keyboard types with Shift held on the key above.
    let shifted: [Character: Character] = [
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
        "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/",
        "~": "`",
    ]
    var map: [Character: (CGKeyCode, Bool)] = [:]
    for (ch, code) in lower {
        map[ch] = (code, false)
        let upper = Character(String(ch).uppercased())
        if upper != ch { map[upper] = (code, true) }
    }
    for (ch, base) in shifted {
        if let code = lower[base] { map[ch] = (code, true) }
    }
    return map
}()

let SHIFT_KEY: CGKeyCode = 56

func keyEdge(_ code: CGKeyCode, _ down: Bool) {
    post(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down))
}

func typeText(_ text: String) {
    // Refuse before typing anything: silently skipping a character turns
    // "ada@example.com" into "adaexample.com" with no error.
    let untypable = Set(text.filter { CHAR_KEYS[$0] == nil })
    if !untypable.isEmpty {
        die("cannot type \(untypable.map { "\"\($0)\"" }.sorted().joined(separator: ", ")) through iPhone Mirroring (US keyboard keycodes only)")
    }
    prepare()
    let wid = BG ? UInt32(findWindow().id) : 0
    for ch in text {
        guard let (code, needsShift) = CHAR_KEYS[ch] else { continue }
        // In background, re-key the window before each keystroke so it reaches
        // the iOS text responder without raising the window.
        if BG { Sky.makeKey(pid: MIRROR_PID, wid: wid) }
        // iPhone Mirroring forwards raw HID keycodes to iOS and DROPS the
        // modifier flag mask, so shift must be a physically held key, not a
        // flag on the event — otherwise capitals silently type lowercase.
        // [ShawnPana/phone-harness]
        if needsShift { keyEdge(SHIFT_KEY, true) }
        keyEdge(code, true)
        usleep(18_000)
        keyEdge(code, false)
        if needsShift { keyEdge(SHIFT_KEY, false) }
        usleep(18_000)
    }
}

extension String {
    func chunked(_ size: Int) -> [String] {
        var out: [String] = []
        var current = ""
        for ch in self {
            current.append(ch)
            if current.count >= size { out.append(current); current = "" }
        }
        if !current.isEmpty { out.append(current) }
        return out
    }
}

let KEYCODES: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51,
    "backspace": 51, "escape": 53, "esc": 53,
]

func pressKey(_ name: String) {
    prepare()
    guard let code = KEYCODES[name.lowercased()] else { die("unknown key \(name)") }
    if BG { Sky.makeKey(pid: MIRROR_PID, wid: UInt32(findWindow().id)) }
    keyEdge(code, true)
    usleep(30_000)
    keyEdge(code, false)
}

/// iPhone Mirroring's own navigation shortcuts. There is no touchable Home
/// button in the window, so these are the only way to leave an app.
let SHORTCUTS: [String: CGKeyCode] = ["home": 18, "switcher": 19, "spotlight": 20]

func shortcut(_ name: String) {
    prepare()
    guard let code = SHORTCUTS[name.lowercased()] else { die("unknown shortcut \(name)") }
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    down?.flags = .maskCommand
    up?.flags = .maskCommand
    post(down)
    usleep(40_000)
    post(up)
}

/// Recover a paused or ended session. The pause screens ("Connection Paused" →
/// Resume, "iPhone in Use" → Connect) are native AppKit UI, not streamed phone
/// content, and macOS swallows the first click on a native button in a
/// background window. Recovery is therefore the one sanctioned exception to
/// background delivery: briefly focus, click the button OCR located, put the
/// cursor back, and hand focus straight back to whatever the user had.
func resumeSession() -> [String: Any] {
    let win = findWindow()
    let buttons = ocr(win).filter {
        let t = $0["text"] as? String ?? ""
        return t == "Resume" || t == "Connect"
    }
    guard let button = buttons.first,
          let bx = button["x"] as? Double, let by = button["y"] as? Double,
          let bw = button["w"] as? Double, let bh = button["h"] as? Double
    else { return ["action": "none"] } // no pause screen — session is live

    let previous = NSWorkspace.shared.frontmostApplication
    let cursor = CGEvent(source: nil)?.location
    focusMirror()
    let p = toScreen(win, bx + bw / 2, by + bh / 2)
    // Post globally: the window is focused for this one click on purpose.
    for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p,
                mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(60_000)
    }
    usleep(1_200_000) // give the stream a beat to come back
    if let cursor { CGWarpMouseCursorPosition(cursor) }
    if previous?.bundleIdentifier != MIRROR_BUNDLE { previous?.activate() }
    return ["action": "clicked", "button": (button["text"] as? String) ?? ""]
}

/// Vision OCR over the captured window, returned in window-relative points.
func ocr(_ win: MirrorWindow) -> [[String: Any]] {
    // Hand Vision the PNG by URL rather than a CGImage decoded here: a CGImage
    // from CGImageSource carries a colour space and alpha layout that Vision
    // silently returns zero observations for, which reads exactly like a blank
    // screen. Measured against a screen full of legible text.
    let path = NSTemporaryDirectory() + "phone-use-mirror-ocr-\(getpid()).png"
    captureWindowFile(win, path)
    defer { try? FileManager.default.removeItem(atPath: path) }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: path), options: [:])
    do { try handler.perform([request]) } catch { die("OCR failed: \(error)") }
    if ProcessInfo.processInfo.environment["PHONE_USE_MIRROR_DEBUG"] != nil {
        FileHandle.standardError.write(
            "debug: results=\(request.results?.count ?? -1)\n".data(using: .utf8)!)
    }

    // Vision reports normalized rects with a bottom-left origin; the rest of
    // phone-use is top-left, so flip Y here rather than in three call sites.
    var out: [[String: Any]] = []
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let b = observation.boundingBox
        out.append([
            "text": candidate.string,
            "x": Double(b.minX) * Double(win.w),
            "y": (1.0 - Double(b.maxY)) * Double(win.h),
            "w": Double(b.width) * Double(win.w),
            "h": Double(b.height) * Double(win.h),
            "confidence": Double(candidate.confidence),
        ])
    }
    return out
}

// ---- dispatch ---------------------------------------------------------------

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { die("usage: phone-use-mirror <window|ocr|capture|tap|...>") }
func num(_ i: Int) -> Double { Double(args[i]) ?? 0 }

switch command {
case "window":
    let w = findWindow()
    emit(["x": w.x, "y": w.y, "w": w.w, "h": w.h, "id": Int(w.id), "frontmost": w.frontmost])
case "ocr":
    emit(ocr(findWindow()))
case "capture":
    guard args.count > 1 else { die("capture needs a path") }
    let win = findWindow()
    captureWindowFile(win, args[1])
    emit(["path": args[1], "w": win.w, "h": win.h])
case "tap":
    tap(findWindow(), num(1), num(2))
    emit(["ok": true])
case "longpress":
    longPress(findWindow(), num(1), num(2), Int(num(3)))
    emit(["ok": true])
case "drag":
    drag(findWindow(), num(1), num(2), num(3), num(4), Int(num(5)))
    emit(["ok": true])
case "scroll":
    let win = findWindow()
    scroll(win, Int(num(1)), Int(num(2)), num(3), num(4))
    emit(["ok": true])
case "type":
    guard args.count > 1 else { die("type needs text") }
    typeText(args[1...].joined(separator: " "))
    emit(["ok": true])
case "key":
    guard args.count > 1 else { die("key needs a name") }
    pressKey(args[1])
    emit(["ok": true])
case "doctor":
    // Report state rather than dying, so callers can render every problem at
    // once instead of surfacing them one failure at a time.
    var report: [String: Any] = [:]
    report["accessibility"] = AXIsProcessTrusted()
    report["mirroringInstalled"] = FileManager.default.fileExists(
        atPath: "/System/Applications/iPhone Mirroring.app")
    report["mirroringRunning"] = mirrorApp() != nil
    let options = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
    let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    // Window *names* are only readable with Screen Recording granted, which
    // makes this the cheapest reliable probe for that permission.
    report["screenRecording"] = windows.contains { $0[kCGWindowName as String] != nil }
    let mirrorPid = mirrorApp()?.processIdentifier ?? -1
    report["windowFound"] = windows.contains {
        ($0[kCGWindowOwnerPID as String] as? pid_t) == mirrorPid
    }
    report["skylight"] = Sky.ready
    report["inputDelivery"] = BG ? "background (skylight)" : "focus"
    emit(report)
case "shortcut":
    guard args.count > 1 else { die("shortcut needs home|switcher|spotlight") }
    shortcut(args[1])
    emit(["ok": true])
case "focus":
    focusMirror()
    emit(["ok": true])
case "resume":
    emit(resumeSession())
default:
    die("unknown command \(command)")
}

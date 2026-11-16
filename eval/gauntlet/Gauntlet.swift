import AppTrackingTransparency
import CoreLocation
import SwiftUI
import UIKit
import WebKit

// Gauntlet: the oracle app for the device-layer eval (docs/43-device-layer-eval.md).
//
// Each scenario is a small screen built to catch one way a device tool can be wrong. The app
// records what it ACTUALLY received to Documents/events.jsonl: every touch (window point and the
// view it hit), every control activation, text change, keyboard show/hide, permission decision,
// sheet dismissal, web navigation and lifecycle change. The eval reads that file host-side via
// `simctl get_app_container`, so the tool under test never grades itself.
//
// Launch: simctl launch <udid> com.phoneuse.gauntlet -scenario A1 -seed 3 -run <id>
//     or: gauntlet://scenario/A1?seed=3&run=<id>
// Commands while running (no system UI involved):
//     simctl spawn <udid> notifyutil -p com.phoneuse.gauntlet.mutate
//
// Fixtures change only with a written reason in eval/README.md, never "so a tool passes".

// MARK: - Event log

enum Log {
  static var run = "none"
  static var scenario = "menu"
  static var seed = 0
  private static let lock = NSLock()
  private static let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("events.jsonl")

  static func event(_ kind: String, _ fields: [String: Any] = [:]) {
    var obj = fields
    obj["kind"] = kind
    obj["run"] = run
    obj["scenario"] = scenario
    obj["seed"] = seed
    obj["t"] = Date().timeIntervalSince1970
    guard JSONSerialization.isValidJSONObject(obj),
      var data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    else { return }
    data.append(0x0A)
    lock.lock()
    defer { lock.unlock() }
    if !FileManager.default.fileExists(atPath: url.path) {
      FileManager.default.createFile(atPath: url.path, contents: nil)
    }
    if let h = try? FileHandle(forWritingTo: url) {
      h.seekToEndOfFile()
      h.write(data)
      try? h.synchronize()
      try? h.close()
    }
  }

  static func rect(_ r: CGRect) -> [String: Double] {
    ["x": Double(r.origin.x), "y": Double(r.origin.y), "w": Double(r.size.width), "h": Double(r.size.height)]
  }
}

/// Nearest accessibility identifier on the view or its ancestors, without the "gx." prefix.
func identifierChain(_ view: UIView?) -> String {
  var v = view
  while let cur = v {
    if let id = cur.accessibilityIdentifier, !id.isEmpty {
      return id.hasPrefix("gx.") ? String(id.dropFirst(3)) : id
    }
    v = cur.superview
  }
  return view.map { String(describing: type(of: $0)) } ?? "none"
}

// MARK: - Seeded randomness (SplitMix64), so a seed reproduces a layout exactly

struct SeededRNG {
  private var state: UInt64
  init(_ seed: Int) { state = UInt64(bitPattern: Int64(seed)) &+ 0x9E37_79B9_7F4A_7C15 }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
  mutating func int(_ range: ClosedRange<Int>) -> Int {
    range.lowerBound + Int(next() % UInt64(range.upperBound - range.lowerBound + 1))
  }
  mutating func pick<T>(_ xs: [T]) -> T { xs[int(0...(xs.count - 1))] }
}

// MARK: - Application: every touch the app receives is logged before it is delivered

@objc(GauntletApplication)
final class GauntletApplication: UIApplication {
  override func sendEvent(_ event: UIEvent) {
    if event.type == .touches, let touches = event.allTouches {
      for t in touches where t.phase == .began || t.phase == .ended || t.phase == .cancelled {
        let p = t.location(in: nil)
        let phase = t.phase == .began ? "began" : (t.phase == .ended ? "ended" : "cancelled")
        Log.event("touch", ["phase": phase, "x": Double(p.x), "y": Double(p.y), "hit": identifierChain(t.view)])
      }
    }
    super.sendEvent(event)
  }
}

@main
enum Entry {
  static func main() {
    _ = UIApplicationMain(
      CommandLine.argc, CommandLine.unsafeArgv,
      NSStringFromClass(GauntletApplication.self), NSStringFromClass(AppDelegate.self))
  }
}

@objc(AppDelegate)
final class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(
    _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let nc = NotificationCenter.default
    nc.addObserver(forName: UIResponder.keyboardDidShowNotification, object: nil, queue: .main) { n in
      let f = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect) ?? .zero
      Log.event("keyboard", ["shown": true, "frame": Log.rect(f)])
    }
    nc.addObserver(forName: UIResponder.keyboardDidHideNotification, object: nil, queue: .main) { _ in
      Log.event("keyboard", ["shown": false])
    }
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    for name in ["mutate", "present"] {
      CFNotificationCenterAddObserver(
        center, nil,
        { _, _, cfName, _, _ in
          let full = (cfName?.rawValue as String?) ?? ""
          let short = full.components(separatedBy: ".").last ?? full
          DispatchQueue.main.async { Router.shared.command(short) }
        },
        "com.phoneuse.gauntlet.\(name)" as CFString, nil, .deliverImmediately)
    }
    return true
  }

  func application(
    _ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let config = UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
    config.delegateClass = SceneDelegate.self
    return config
  }
}

@objc(SceneDelegate)
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let ws = scene as? UIWindowScene else { return }
    let w = UIWindow(windowScene: ws)
    window = w
    let d = UserDefaults.standard
    var id = d.string(forKey: "scenario") ?? "menu"
    var seed = d.integer(forKey: "seed")
    var run = d.string(forKey: "run") ?? "manual"
    if let url = options.urlContexts.first?.url, let parsed = Router.parse(url) {
      (id, seed, run) = parsed
    }
    Router.shared.window = w
    Router.shared.show(id, seed: seed, run: run)
    w.makeKeyAndVisible()
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let url = URLContexts.first?.url, let (id, seed, run) = Router.parse(url) else { return }
    Router.shared.show(id, seed: seed, run: run)
  }

  func sceneDidBecomeActive(_ scene: UIScene) { Log.event("lifecycle", ["state": "active"]) }
  func sceneWillResignActive(_ scene: UIScene) { Log.event("lifecycle", ["state": "inactive"]) }
  func sceneDidEnterBackground(_ scene: UIScene) { Log.event("lifecycle", ["state": "background"]) }
  func sceneWillEnterForeground(_ scene: UIScene) { Log.event("lifecycle", ["state": "foreground"]) }
}

// MARK: - Router

final class OrientationNav: UINavigationController {
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
    topViewController?.supportedInterfaceOrientations ?? .portrait
  }
}

final class Router {
  static let shared = Router()
  var window: UIWindow?
  weak var current: ScenarioVC?

  static let scenarios: [(String, String, (Int) -> UIViewController)] = [
    ("A1", "Rows inserted after first paint", { LateInsertVC(seed: $0, indexIds: false) }),
    ("A1i", "Rows inserted; cells carry index identifiers", { LateInsertVC(seed: $0, indexIds: true) }),
    ("A2", "Two controls named Add", { DuplicateLabelVC(seed: $0) }),
    ("A3", "Ref kept across navigation", { StaleRefVC(seed: $0) }),
    ("A4", "Carousel card half off-screen", { CarouselVC(seed: $0) }),
    ("A5", "Button under the keyboard", { UnderKeyboardVC(seed: $0) }),
    ("A6", "Buttons behind a sheet", { BehindSheetVC(seed: $0) }),
    ("A7", "Landscape grid", { LandscapeVC(seed: $0) }),
    ("A8", "SwiftUI TabView", { TabsHost(seed: $0) }),
    ("B1", "Button that ignores early taps", { SlowConfirmVC(seed: $0) }),
    ("B2", "Replace existing text", { FieldVC(seed: $0, kind: .replace) }),
    ("B3", "Field that formats input", { FieldVC(seed: $0, kind: .phone) }),
    ("B4", "Non-ASCII text", { FieldVC(seed: $0, kind: .unicode) }),
    ("B5", "Secure field", { FieldVC(seed: $0, kind: .secure) }),
    ("B6", "Multiline text", { MultilineVC(seed: $0) }),
    ("B7", "Dismiss the keyboard", { FieldVC(seed: $0, kind: .dismiss) }),
    ("B8", "Settings-style switch", { SwitchVC(seed: $0) }),
    ("B10", "Long list", { LongListVC(seed: $0) }),
    ("B11", "Empty screen for coordinates", { BlankVC(seed: $0) }),
    ("C1", "Location permission prompt", { PermissionVC(seed: $0, kind: .location) }),
    ("C2", "App Tracking Transparency prompt", { PermissionVC(seed: $0, kind: .tracking) }),
    ("C7", "Web content", { WebVC(seed: $0) }),
    ("D2", "A screen that never idles", { NeverIdleVC(seed: $0) }),
    ("D3", "Hidden and covered controls", { HiddenVC(seed: $0) }),
    ("E2", "App crashes on tap", { CrashVC(seed: $0) }),
    ("E3", "Main thread blocked", { FreezeVC(seed: $0) }),
    ("R1", "Rows sharing a label shift", { TwinRowsVC(seed: $0) }),
    ("R2", "Two labels from one corner", { SharedOriginVC(seed: $0) }),
    ("R3", "A field under another field", { CoveredFieldVC(seed: $0) }),
  ]

  static func parse(_ url: URL) -> (String, Int, String)? {
    guard url.scheme == "gauntlet", url.host == "scenario" else { return nil }
    let id = url.pathComponents.dropFirst().first ?? "menu"
    let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    let seed = Int(q.first { $0.name == "seed" }?.value ?? "0") ?? 0
    let run = q.first { $0.name == "run" }?.value ?? "manual"
    return (id, seed, run)
  }

  func show(_ id: String, seed: Int, run: String) {
    Log.run = run
    Log.scenario = id
    Log.seed = seed
    Log.event("launch", ["pid": Int(ProcessInfo.processInfo.processIdentifier)])
    let vc = Router.scenarios.first { $0.0 == id }.map { $0.2(seed) } ?? MenuVC()
    current = vc as? ScenarioVC
    let nav = OrientationNav(rootViewController: vc)
    window?.rootViewController = nav
  }

  func command(_ name: String) {
    Log.event("command", ["name": name])
    current?.command(name)
  }
}

final class MenuVC: UITableViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Gauntlet"
    tableView.register(UITableViewCell.self, forCellReuseIdentifier: "c")
  }
  override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
    Router.scenarios.count
  }
  override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: "c", for: indexPath)
    var c = cell.defaultContentConfiguration()
    c.text = "\(Router.scenarios[indexPath.row].0) · \(Router.scenarios[indexPath.row].1)"
    cell.contentConfiguration = c
    return cell
  }
  override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    Router.shared.show(Router.scenarios[indexPath.row].0, seed: 0, run: "manual")
  }
}

// MARK: - Scenario base

class ScenarioVC: UIViewController {
  let seed: Int
  var rng: SeededRNG
  private(set) var tracked: [String: UIView] = [:]

  init(seed: Int) {
    self.seed = seed
    rng = SeededRNG(seed)
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError("unused") }

  override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    title = Log.scenario
  }

  /// Tag a view for the oracle: its identifier and its window frame are logged at "ready".
  /// Identifiers are opaque ("gx.<id>") so a tool cannot match a label through an identifier that
  /// happens to equal it; real apps rarely line up that conveniently.
  @discardableResult
  func track<V: UIView>(_ v: V, _ id: String) -> V {
    v.accessibilityIdentifier = "gx.\(id)"
    tracked[id] = v
    return v
  }

  func layout() -> [String: [String: Double]] {
    var out: [String: [String: Double]] = [:]
    for (id, v) in tracked where v.window != nil {
      out[id] = Log.rect(v.convert(v.bounds, to: nil))
    }
    return out
  }

  func logReady(_ extra: [String: Any] = [:]) {
    var f = extra
    f["layout"] = layout()
    f["window"] = Log.rect(view.window?.bounds ?? .zero)
    Log.event("ready", f)
  }

  /// Scenarios that log "ready" themselves (after rotating, or once the keyboard is up) return false.
  var logsReadyOnAppear: Bool { true }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    if logsReadyOnAppear { logReady() }
  }

  func command(_ name: String) {}

  func button(_ title: String, _ id: String, style: UIButton.Configuration = .filled(), action: (() -> Void)? = nil)
    -> UIButton
  {
    var config = style
    config.title = title
    let b = UIButton(
      configuration: config,
      primaryAction: UIAction { _ in
        Log.event("activate", ["id": id, "label": title])
        action?()
      })
    b.translatesAutoresizingMaskIntoConstraints = false
    return track(b, id)
  }

  func place(_ v: UIView, top: CGFloat, height: CGFloat = 50, inset: CGFloat = 24) {
    v.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(v)
    NSLayoutConstraint.activate([
      v.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: top),
      v.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: inset),
      v.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -inset),
      v.heightAnchor.constraint(equalToConstant: height),
    ])
  }

  func field(_ placeholder: String, _ id: String, text: String = "", secure: Bool = false) -> UITextField {
    let f = UITextField()
    f.borderStyle = .roundedRect
    f.placeholder = placeholder
    f.accessibilityLabel = placeholder
    f.text = text
    f.isSecureTextEntry = secure
    f.autocorrectionType = .no
    f.autocapitalizationType = .none
    f.spellCheckingType = .no
    f.smartQuotesType = .no
    f.smartDashesType = .no
    f.smartInsertDeleteType = .no
    f.addAction(
      UIAction { [weak f] _ in Log.event("text", ["id": id, "value": f?.text ?? ""]) }, for: .editingChanged)
    f.addAction(UIAction { _ in Log.event("focus", ["id": id, "focused": true]) }, for: .editingDidBegin)
    f.addAction(
      UIAction { [weak f] _ in Log.event("focus", ["id": id, "focused": false, "value": f?.text ?? ""]) },
      for: .editingDidEnd)
    return track(f, id)
  }
}

// MARK: - A1 · rows inserted after first paint

// Seed: the target label, its index, and how many rows are inserted above it (2–4).
// The insert fires on the `mutate` command, so the eval controls that it happens between the
// tool's observation and its tap. A1 cells have no accessibility identifier (UIKit's default);
// A1i cells carry index-based identifiers ("gx.row.<index>") set in cellForRowAt, as many real
// lists do. UIKit does not reconfigure visible cells on insert, so afterwards a new row can carry
// the same identifier as an old one.
final class LateInsertVC: ScenarioVC, UITableViewDataSource, UITableViewDelegate {
  private let table = UITableView(frame: .zero, style: .plain)
  private var rows: [String] = []
  private var target = ""
  private let indexIds: Bool

  init(seed: Int, indexIds: Bool) {
    self.indexIds = indexIds
    super.init(seed: seed)
  }
  required init?(coder: NSCoder) { fatalError("unused") }

  override func viewDidLoad() {
    super.viewDidLoad()
    let fruits = ["Apricot", "Bilberry", "Cherry", "Damson", "Elderberry", "Feijoa", "Guava", "Huckleberry"]
    target = rng.pick(["Open Report", "Quarterly Summary", "Team Roster", "Shipping Log"])
    rows = fruits
    rows.insert(target, at: rng.int(1...3))
    table.dataSource = self
    table.delegate = self
    table.rowHeight = 56
    table.register(UITableViewCell.self, forCellReuseIdentifier: "c")
    table.frame = view.bounds
    table.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(table)
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    Log.event("fixture", ["target": target, "rows": rows])
  }

  override func command(_ name: String) {
    guard name == "mutate" else { return }
    let n = rng.int(2...4)
    let promos = (1...n).map { "Promotion \($0)" }
    rows.insert(contentsOf: promos, at: 0)
    table.insertRows(at: (0..<n).map { IndexPath(row: $0, section: 0) }, with: .automatic)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
      Log.event("mutated", ["inserted": promos, "rows": self.rows])
    }
  }

  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }
  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: "c", for: indexPath)
    var c = cell.defaultContentConfiguration()
    c.text = rows[indexPath.row]
    cell.contentConfiguration = c
    cell.accessibilityIdentifier = indexIds ? "gx.row.\(indexPath.row)" : nil
    return cell
  }
  func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    Log.event("activate", ["id": "row:\(rows[indexPath.row])", "label": rows[indexPath.row]])
    tableView.deselectRow(at: indexPath, animated: true)
  }
}

// MARK: - A2 · two controls with the same label

// Seed: the shared label. The nav bar and the toolbar both carry it; the eval asks for the toolbar one.
final class DuplicateLabelVC: ScenarioVC {
  private var label = "Add"
  override func viewDidLoad() {
    super.viewDidLoad()
    label = rng.pick(["Add", "Edit", "Share", "Done"])
    let navItem = UIBarButtonItem(
      title: label, image: nil,
      primaryAction: UIAction(title: label) { [label] _ in Log.event("activate", ["id": "nav-item", "label": label]) },
      menu: nil)
    navItem.accessibilityIdentifier = "gx.nav-item"
    navigationItem.rightBarButtonItem = navItem
    let toolItem = UIBarButtonItem(
      title: label, image: nil,
      primaryAction: UIAction(title: label) { [label] _ in
        Log.event("activate", ["id": "toolbar-item", "label": label])
      },
      menu: nil)
    toolItem.accessibilityIdentifier = "gx.toolbar-item"
    toolbarItems = [UIBarButtonItem.flexibleSpace(), toolItem, UIBarButtonItem.flexibleSpace()]
    let note = UILabel()
    note.text = "Two controls share one label"
    place(note, top: 40)
  }
  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    navigationController?.setToolbarHidden(false, animated: false)
  }
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    Log.event("fixture", ["label": label])
  }
}

// MARK: - A3 · a ref kept across navigation

// Screen 1 has "Continue" and a second button; screen 2 puts a different button at the same
// point. Tapping the first screen's ref after navigating must not fire screen 2's button.
final class StaleRefVC: ScenarioVC {
  private var second = ""
  override func viewDidLoad() {
    super.viewDidLoad()
    second = rng.pick(["Archive Item", "Pin Message", "Mark as Read"])
    let y = CGFloat(rng.int(220...320))
    place(button("Continue", "continue") { [weak self] in self?.push(y: y) }, top: 40)
    place(button(second, "first-screen-button"), top: y)
  }
  private func push(y: CGFloat) {
    let next = ScenarioVC(seed: seed)
    next.loadViewIfNeeded()
    next.title = "Second Screen"
    next.place(next.button("Purple Button", "second-screen-button"), top: y)
    navigationController?.pushViewController(next, animated: true)
  }
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    Log.event("fixture", ["firstScreenButton": second])
  }
}

// MARK: - A4 · a carousel card half off-screen

// Seed: which card letter is the target. Its frame starts 80 pt before the right edge, so its
// centre is off-screen; a centre tap misses it.
final class CarouselVC: ScenarioVC {
  private let scroll = UIScrollView()
  private var cards: [UIButton] = []
  private var targetLetter = "C"
  override func viewDidLoad() {
    super.viewDidLoad()
    let letters = ["A", "B", "C", "D", "E"]
    targetLetter = rng.pick(["C", "D"])
    scroll.showsHorizontalScrollIndicator = false
    view.addSubview(scroll)
    for l in letters {
      let b = button("Card \(l)", "card-\(l)", style: .tinted())
      b.translatesAutoresizingMaskIntoConstraints = true
      scroll.addSubview(b)
      cards.append(b)
    }
  }
  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let w = view.bounds.width
    scroll.frame = CGRect(x: 0, y: view.safeAreaInsets.top + 80, width: w, height: 140)
    let targetIndex = targetLetter == "C" ? 2 : 3
    let cardW: CGFloat = 160
    let gap: CGFloat = 16
    let targetX = w - 80
    let startX = targetX - CGFloat(targetIndex) * (cardW + gap)
    for (i, b) in cards.enumerated() {
      b.frame = CGRect(x: startX + CGFloat(i) * (cardW + gap), y: 10, width: cardW, height: 120)
    }
    scroll.contentSize = CGSize(width: max(w, startX + CGFloat(cards.count) * (cardW + gap) + gap), height: 140)
  }
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    Log.event("fixture", ["target": "Card \(targetLetter)"])
  }
}

// MARK: - A5 · a button under the keyboard

// The field takes focus on appear, so the software keyboard covers the Save button pinned to
// the bottom. A tap at Save's point while the keyboard is up types a key instead.
final class UnderKeyboardVC: ScenarioVC {
  private var note: UITextField!
  override func viewDidLoad() {
    super.viewDidLoad()
    note = field("Note", "note", text: "")
    place(note, top: 30, height: 44)
    let save = button(rng.pick(["Save Note", "Submit Note", "Store Note"]), "save")
    view.addSubview(save)
    NSLayoutConstraint.activate([
      save.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -CGFloat(rng.int(40...90))),
      save.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      save.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
      save.heightAnchor.constraint(equalToConstant: 50),
    ])
  }
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    note.becomeFirstResponder()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.logReady(["phase": "keyboard"]) }
  }
}

// MARK: - A6 · buttons behind a sheet

// A medium sheet is presented on the `present` command. "Upper" sits in the dimmed area (a tap
// there dismisses the sheet), "Lower" sits under the sheet itself. Neither can be activated.
final class BehindSheetVC: ScenarioVC, UIAdaptivePresentationControllerDelegate {
  override func viewDidLoad() {
    super.viewDidLoad()
    let upper = button("Upper Behind", "upper-behind")
    let lower = button("Lower Behind", "lower-behind")
    for b in [upper, lower] { view.addSubview(b) }
    NSLayoutConstraint.activate([
      upper.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 60),
      lower.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -60),
    ])
    for b in [upper, lower] {
      NSLayoutConstraint.activate([
        b.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
        b.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        b.heightAnchor.constraint(equalToConstant: 50),
      ])
    }
  }
  override func command(_ name: String) {
    guard name == "present", presentedViewController == nil else { return }
    let sheet = ScenarioVC(seed: seed)
    sheet.loadViewIfNeeded()
    sheet.title = "Sheet"
    sheet.place(sheet.button("Sheet Action", "sheet-action"), top: 40)
    sheet.presentationController?.delegate = self
    if let s = sheet.sheetPresentationController {
      s.detents = [.medium()]
      s.largestUndimmedDetentIdentifier = nil
    }
    present(sheet, animated: true) { Log.event("sheet", ["shown": true]) }
  }
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    Log.event("sheet", ["shown": false])
  }
}

// MARK: - A7 · landscape

// The scenario rotates the interface to landscape (left on odd seeds, right on even ones) and
// shows a 3×4 grid. The eval taps a seeded cell by ref and checks which cell fired and where the
// touch landed.
final class LandscapeVC: ScenarioVC {
  private var landscapeLeft: Bool { seed % 2 != 0 }
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
    landscapeLeft ? .landscapeLeft : .landscapeRight
  }
  override func viewDidLoad() {
    super.viewDidLoad()
    let grid = UIStackView()
    grid.axis = .vertical
    grid.distribution = .fillEqually
    grid.spacing = 12
    grid.translatesAutoresizingMaskIntoConstraints = false
    for r in 0..<3 {
      let row = UIStackView()
      row.distribution = .fillEqually
      row.spacing = 12
      for c in 0..<4 {
        let n = r * 4 + c + 1
        row.addArrangedSubview(button("Cell \(n)", "cell-\(n)", style: .tinted()))
      }
      grid.addArrangedSubview(row)
    }
    view.addSubview(grid)
    NSLayoutConstraint.activate([
      grid.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
      grid.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
      grid.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
      grid.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
    ])
  }
  override var logsReadyOnAppear: Bool { false }
  private var rotated = false
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    if rotated { return }
    rotated = true
    setNeedsUpdateOfSupportedInterfaceOrientations()
    view.window?.windowScene?.requestGeometryUpdate(
      .iOS(interfaceOrientations: landscapeLeft ? .landscapeLeft : .landscapeRight)
    ) { error in
      Log.event("orientation_error", ["error": error.localizedDescription])
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
      let o = self.view.window?.windowScene?.effectiveGeometry.interfaceOrientation
      self.logReady([
        "landscape": o == .landscapeLeft || o == .landscapeRight,
        "orientation": o == .landscapeLeft ? "left" : o == .landscapeRight ? "right" : "other",
      ])
    }
  }
}

// MARK: - A8 · SwiftUI TabView

struct TabsView: View {
  var body: some View {
    TabView {
      Text("Inbox content").onAppear { Log.event("tab", ["name": "Inbox"]) }
        .tabItem { Label("Inbox", systemImage: "tray") }
      Text("Search content").onAppear { Log.event("tab", ["name": "Search"]) }
        .tabItem { Label("Search", systemImage: "magnifyingglass") }
      Text("Profile content").onAppear { Log.event("tab", ["name": "Profile"]) }
        .tabItem { Label("Profile", systemImage: "person") }
    }
  }
}

final class TabsHost: ScenarioVC {
  override func viewDidLoad() {
    super.viewDidLoad()
    let host = UIHostingController(rootView: TabsView())
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)
  }
  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    navigationController?.setNavigationBarHidden(true, animated: false)
  }
}

// MARK: - B1 · a button that ignores taps while it settles

// "Go" pushes a screen whose Confirm button ignores taps for 300–700 ms (seeded) after it
// appears, as a real screen does mid-transition. An ignored tap is logged, not activated.
final class SlowConfirmVC: ScenarioVC {
  override func viewDidLoad() {
    super.viewDidLoad()
    let delay = Double(rng.int(300...700)) / 1000
    place(
      button("Go", "go") { [weak self] in
        guard let self else { return }
        let next = ConfirmVC(seed: self.seed, ignoreFor: delay)
        self.navigationController?.pushViewController(next, animated: true)
      }, top: 40)
  }
}

final class ConfirmVC: ScenarioVC {
  private let ignoreFor: Double
  private var readyAt = Date.distantFuture
  private let done = UILabel()
  init(seed: Int, ignoreFor: Double) {
    self.ignoreFor = ignoreFor
    super.init(seed: seed)
  }
  required init?(coder: NSCoder) { fatalError("unused") }
  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Confirm"
    var config = UIButton.Configuration.filled()
    config.title = "Confirm"
    let b = UIButton(
      configuration: config,
      primaryAction: UIAction { [weak self] _ in
        guard let self else { return }
        if Date() < self.readyAt {
          Log.event("ignored", ["id": "confirm"])
          return
        }
        Log.event("activate", ["id": "confirm", "label": "Confirm"])
        self.done.text = "Confirmed"
      })
    track(b, "confirm")
    place(b, top: 40)
    place(done, top: 120)
  }
  override func viewDidAppear(_ animated: Bool) {
    readyAt = Date().addingTimeInterval(ignoreFor)
    super.viewDidAppear(animated)
    Log.event("fixture", ["ignoreMs": Int(ignoreFor * 1000)])
  }
}

// MARK: - B2–B5, B7 · text fields

final class FieldVC: ScenarioVC {
  enum Kind { case replace, phone, unicode, secure, dismiss }
  private let kind: Kind
  private var f: UITextField!
  init(seed: Int, kind: Kind) {
    self.kind = kind
    super.init(seed: seed)
  }
  required init?(coder: NSCoder) { fatalError("unused") }

  override func viewDidLoad() {
    super.viewDidLoad()
    switch kind {
    case .replace:
      f = field("Display Name", "field", text: rng.pick(["Old Value 123", "previous entry", "Ada L."]))
    case .phone:
      f = field("Phone Number", "field")
      f.keyboardType = .phonePad
      f.addAction(
        UIAction { [weak self] _ in
          guard let tf = self?.f else { return }
          let digits = (tf.text ?? "").filter(\.isNumber)
          let formatted = FieldVC.formatPhone(digits)
          if formatted != tf.text { tf.text = formatted }
          Log.event("formatted", ["id": "field", "value": formatted, "digits": digits])
        }, for: .editingChanged)
    case .unicode:
      f = field("Message", "field")
    case .secure:
      f = field("Secret Phrase", "field", secure: true)
    case .dismiss:
      f = field("Draft", "field", text: rng.pick(["keep me", "do not change", "stay put"]))
    }
    place(f, top: 40, height: 44)
    place(button("Unrelated", "unrelated", style: .plain()), top: 120)
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    if kind == .dismiss {
      f.becomeFirstResponder()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.logReady(["phase": "keyboard"]) }
    }
    Log.event("fixture", ["initial": f.text ?? ""])
  }

  static func formatPhone(_ d: String) -> String {
    let s = Array(d.prefix(10))
    if s.count <= 3 { return String(s) }
    if s.count <= 6 { return "(\(String(s[0..<3]))) \(String(s[3...]))" }
    return "(\(String(s[0..<3]))) \(String(s[3..<6]))-\(String(s[6...]))"
  }
}

// MARK: - B6 · multiline text

final class MultilineVC: ScenarioVC, UITextViewDelegate {
  override func viewDidLoad() {
    super.viewDidLoad()
    let tv = UITextView()
    tv.font = .preferredFont(forTextStyle: .body)
    tv.layer.borderWidth = 1
    tv.layer.borderColor = UIColor.separator.cgColor
    tv.accessibilityLabel = "Notes"
    tv.autocorrectionType = .no
    tv.autocapitalizationType = .none
    tv.spellCheckingType = .no
    tv.smartQuotesType = .no
    tv.smartDashesType = .no
    tv.delegate = self
    track(tv, "notes")
    place(tv, top: 40, height: 160)
  }
  func textViewDidChange(_ textView: UITextView) {
    Log.event("text", ["id": "notes", "value": textView.text ?? ""])
  }
}

// MARK: - B8 · a Settings-style switch

final class SwitchVC: ScenarioVC, UITableViewDataSource {
  private let table = UITableView(frame: .zero, style: .insetGrouped)
  private var name = ""
  private let sw = UISwitch()
  override func viewDidLoad() {
    super.viewDidLoad()
    name = rng.pick(["Haptic Hints", "Smart Previews", "Quiet Badges"])
    sw.isOn = false
    sw.addAction(
      UIAction { [weak sw] _ in Log.event("switch", ["id": "switch", "on": sw?.isOn ?? false]) }, for: .valueChanged)
    track(sw, "switch")
    table.dataSource = self
    table.register(UITableViewCell.self, forCellReuseIdentifier: "c")
    table.frame = view.bounds
    table.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(table)
  }
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    Log.event("fixture", ["switch": name, "on": sw.isOn])
  }
  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { 3 }
  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: "c", for: indexPath)
    var c = cell.defaultContentConfiguration()
    switch indexPath.row {
    case 0:
      c.text = "Display Density"
      cell.accessoryType = .disclosureIndicator
    case 1:
      c.text = name
      cell.accessoryView = sw
      cell.selectionStyle = .none
    default:
      c.text = "Version 1.0"
    }
    cell.contentConfiguration = c
    return cell
  }
}

// MARK: - B10 · a long list

// Seed: the 60 row words and which row is the target (index 35–55).
final class LongListVC: ScenarioVC, UITableViewDataSource, UITableViewDelegate {
  private let table = UITableView(frame: .zero, style: .plain)
  private var rows: [String] = []
  override func viewDidLoad() {
    super.viewDidLoad()
    let words = ["Amber", "Basil", "Cobalt", "Dune", "Ember", "Fjord", "Garnet", "Harbor", "Indigo", "Juniper"]
    rows = (1...60).map { "Row \($0) \(rng.pick(words))" }
    table.dataSource = self
    table.delegate = self
    table.rowHeight = 52
    table.register(UITableViewCell.self, forCellReuseIdentifier: "c")
    table.frame = view.bounds
    table.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(table)
  }
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    Log.event("fixture", ["target": rows[rng.int(35...55)], "rows": rows])
  }
  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }
  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: "c", for: indexPath)
    var c = cell.defaultContentConfiguration()
    c.text = rows[indexPath.row]
    cell.contentConfiguration = c
    return cell
  }
  func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    Log.event("activate", ["id": "row:\(rows[indexPath.row])", "label": rows[indexPath.row]])
    tableView.deselectRow(at: indexPath, animated: true)
  }
}

// MARK: - B11 · nothing to hit

final class BlankVC: ScenarioVC {
  override func viewDidLoad() {
    super.viewDidLoad()
    place(button("Only Button", "only"), top: 40)
  }
}

// MARK: - C1, C2 · system permission prompts

// The prompt text carries a seeded token so the eval can check the tool read the whole message.
final class PermissionVC: ScenarioVC, CLLocationManagerDelegate {
  enum Kind { case location, tracking }
  private let kind: Kind
  private let manager = CLLocationManager()
  init(seed: Int, kind: Kind) {
    self.kind = kind
    super.init(seed: seed)
  }
  required init?(coder: NSCoder) { fatalError("unused") }
  override func viewDidLoad() {
    super.viewDidLoad()
    place(button("Behind Prompt", "behind-prompt"), top: 40)
  }
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
      switch self.kind {
      case .location:
        self.manager.delegate = self
        Log.event("permission_request", ["service": "location", "status": Int(self.manager.authorizationStatus.rawValue)])
        self.manager.requestWhenInUseAuthorization()
      case .tracking:
        Log.event("permission_request", ["service": "tracking", "status": Int(ATTrackingManager.trackingAuthorizationStatus.rawValue)])
        ATTrackingManager.requestTrackingAuthorization { status in
          Log.event("permission", ["service": "tracking", "status": Int(status.rawValue)])
        }
      }
    }
  }
  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    Log.event("permission", ["service": "location", "status": Int(manager.authorizationStatus.rawValue)])
  }
}

// MARK: - C7 · web content

final class WebVC: ScenarioVC, WKNavigationDelegate {
  private let web = WKWebView()
  private var linkText = ""
  override func viewDidLoad() {
    super.viewDidLoad()
    linkText = rng.pick(["Continue to the next page", "Read the full article", "Open the details"])
    web.navigationDelegate = self
    web.frame = view.bounds
    web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(web)
    let html = """
      <html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font: -apple-system-body; padding: 24px">
      <h1>Gauntlet Web Heading</h1>
      <p>Some paragraph text before the link.</p>
      <p><a href="https://gauntlet.invalid/next" style="font-size: 22px">\(linkText)</a></p>
      </body></html>
      """
    web.loadHTMLString(html, baseURL: URL(string: "https://gauntlet.invalid/"))
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    Log.event("web_loaded", ["link": linkText])
  }
  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    if navigationAction.navigationType == .linkActivated {
      Log.event("activate", ["id": "web-link", "url": navigationAction.request.url?.absoluteString ?? ""])
      decisionHandler(.cancel)
      return
    }
    decisionHandler(.allow)
  }
}

// MARK: - D2 · a screen that never idles

final class NeverIdleVC: ScenarioVC {
  private let counter = UILabel()
  private var link: CADisplayLink?
  private var frames = 0
  override func viewDidLoad() {
    super.viewDidLoad()
    let spinner = UIActivityIndicatorView(style: .large)
    spinner.startAnimating()
    place(spinner, top: 30, height: 60)
    place(counter, top: 100)
    place(button("Ping", "ping"), top: 170)
    link = CADisplayLink(target: self, selector: #selector(tick))
    link?.add(to: .main, forMode: .common)
  }
  @objc private func tick() {
    frames += 1
    counter.text = "Frame \(frames)"
  }
}

// MARK: - D3 · hidden, transparent, covered and off-screen controls

final class HiddenVC: ScenarioVC {
  override func viewDidLoad() {
    super.viewDidLoad()
    place(button("Visible Button", "visible"), top: 30)
    let hidden = button("Hidden Button", "hidden")
    place(hidden, top: 100)
    hidden.isHidden = true
    let clear = button("Clear Button", "clear")
    place(clear, top: 170)
    clear.alpha = 0
    let covered = button("Covered Button", "covered")
    place(covered, top: 240)
    let cover = UIView()
    cover.backgroundColor = .systemGray
    cover.isUserInteractionEnabled = true
    track(cover, "cover")
    place(cover, top: 230, height: 70, inset: 12)
    let off = button("Offscreen Button", "offscreen")
    view.addSubview(off)
    NSLayoutConstraint.activate([
      off.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 330),
      off.trailingAnchor.constraint(equalTo: view.leadingAnchor, constant: -40),
      off.widthAnchor.constraint(equalToConstant: 200),
      off.heightAnchor.constraint(equalToConstant: 50),
    ])
  }
}

// MARK: - E2, E3 · the app crashes, or its main thread blocks

final class CrashVC: ScenarioVC {
  override func viewDidLoad() {
    super.viewDidLoad()
    place(button("Crash Now", "crash") { fatalError("Gauntlet E2: deliberate crash") }, top: 40)
  }
}

final class FreezeVC: ScenarioVC {
  override func viewDidLoad() {
    super.viewDidLoad()
    let seconds = Double(rng.int(6...9))
    place(
      button("Freeze", "freeze") {
        Log.event("freeze", ["seconds": seconds, "phase": "start"])
        Thread.sleep(forTimeInterval: seconds)
        Log.event("freeze", ["seconds": seconds, "phase": "end"])
      }, top: 40)
    place(button("After Freeze", "after"), top: 110)
  }
}

// MARK: - R · regression checks from the 2026-11-05 independent review
// Counterexamples to fixes the review found too narrow. Written after those fixes, so they are
// regression tests for them, not independent probes.

// R1 · rows that share a label shift after an insert. Seed: which twin is the target, the second or
// the third "Item", so that after one row goes in above, another twin sits where the target was.
final class TwinRowsVC: ScenarioVC, UITableViewDataSource, UITableViewDelegate {
  private let table = UITableView(frame: .zero, style: .plain)
  private var rows: [(id: String, title: String)] = [
    ("header", "Header Row"), ("item-a", "Item"), ("item-b", "Item"), ("item-c", "Item"), ("footer", "Footer Row"),
  ]
  private var ordinal = 1

  override func viewDidLoad() {
    super.viewDidLoad()
    ordinal = rng.int(1...2)
    table.dataSource = self
    table.delegate = self
    table.rowHeight = 56
    table.register(UITableViewCell.self, forCellReuseIdentifier: "c")
    table.frame = view.bounds
    table.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(table)
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    let twins = rows.filter { $0.title == "Item" }
    Log.event("fixture", ["target": twins[ordinal].id, "ordinal": ordinal])
  }

  override func command(_ name: String) {
    guard name == "mutate" else { return }
    rows.insert(("new", "New Row"), at: 0)
    table.insertRows(at: [IndexPath(row: 0, section: 0)], with: .automatic)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { Log.event("mutated", ["inserted": ["New Row"]]) }
  }

  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }
  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: "c", for: indexPath)
    var c = cell.defaultContentConfiguration()
    c.text = rows[indexPath.row].title
    cell.contentConfiguration = c
    return cell
  }
  func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    Log.event("activate", ["id": "row:\(rows[indexPath.row].id)", "label": rows[indexPath.row].title])
    tableView.deselectRow(at: indexPath, animated: true)
  }
}

// R2 · a title and a badge drawn from the same corner. Both are on screen and both must be listed.
final class SharedOriginVC: ScenarioVC {
  private let headline = UILabel()
  private let badge = UILabel()

  override func viewDidLoad() {
    super.viewDidLoad()
    headline.text = rng.pick(["Daily Deal", "Weekly Pick", "Top Offer"])
    headline.font = .systemFont(ofSize: 28, weight: .bold)
    badge.text = "NEW"
    badge.font = .systemFont(ofSize: 11, weight: .heavy)
    for label in [headline, badge] {
      label.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(label)
      NSLayoutConstraint.activate([
        label.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 60),
        label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      ])
    }
    place(button("Buy Now", "buy"), top: 140)
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    Log.event("fixture", ["labels": [headline.text ?? "", badge.text ?? ""]])
  }
}

// R3 · a field that another field covers (a panel's field drawn over it, a little larger). A tap at the
// covered field's point focuses the panel's field, so typing there would land in the wrong place.
final class CoveredFieldVC: ScenarioVC {
  override func viewDidLoad() {
    super.viewDidLoad()
    place(field("Email", "email"), top: 60, height: 44)
    place(field("Panel Note", "panel"), top: 50, height: 64, inset: 14)
  }
}

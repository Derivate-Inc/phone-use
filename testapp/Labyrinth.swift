import SwiftUI

// Labyrinth — a deliberately hard benchmark app for Phone Use.
// Hostile by design: 4-deep navigation, confusable sibling labels, a multi-step
// order wizard, and decoy controls. Every mutation writes ground-truth state to
// Documents/state.json so the benchmark grades DETERMINISTICALLY via
// `simctl get_app_container` (AndroidWorld-style), never by agent self-report.

// ---------- Ground-truth state ----------

struct OrderRecord: Codable, Identifiable {
  var id: String
  var item: String
  var qty: Int
  var address: String
}

final class AppState: ObservableObject {
  static let shared = AppState()

  @Published var telemetry = false
  @Published var crashReports = false
  @Published var telemetryLogging = false // decoy
  @Published var favorites: [String] = []
  @Published var orders: [OrderRecord] = []
  @Published var licenseViewed = false
  @Published var showCodes = false
  @Published var vaultUnlocked = false
  @Published var beaconClaimed = false

  private var url: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("state.json")
  }

  struct Snapshot: Codable {
    var telemetry: Bool
    var crashReports: Bool
    var telemetryLogging: Bool
    var favorites: [String]
    var orders: [OrderRecord]
    var licenseViewed: Bool
    var showCodes: Bool
    var vaultUnlocked: Bool
    var beaconClaimed: Bool
  }

  init() { load() }

  func load() {
    guard let data = try? Data(contentsOf: url),
          let s = try? JSONDecoder().decode(Snapshot.self, from: data) else { return }
    telemetry = s.telemetry
    crashReports = s.crashReports
    telemetryLogging = s.telemetryLogging
    favorites = s.favorites
    orders = s.orders
    licenseViewed = s.licenseViewed
    showCodes = s.showCodes
    vaultUnlocked = s.vaultUnlocked
    beaconClaimed = s.beaconClaimed
  }

  func save() {
    let s = Snapshot(
      telemetry: telemetry, crashReports: crashReports, telemetryLogging: telemetryLogging,
      favorites: favorites, orders: orders, licenseViewed: licenseViewed,
      showCodes: showCodes, vaultUnlocked: vaultUnlocked, beaconClaimed: beaconClaimed)
    if let data = try? JSONEncoder().encode(s) { try? data.write(to: url) }
  }
}

// The vault access code is only revealed once "Show Codes" is enabled (a
// dependency in a different section). The correct code for chamber depth.
let VAULT_CODE = "4417"

// ---------- App ----------

@main
struct LabyrinthApp: App {
  var body: some Scene {
    WindowGroup { RootView() }
  }
}

struct RootView: View {
  @StateObject var state = AppState.shared
  var body: some View {
    TabView {
      HomeView().tabItem { Label("Home", systemImage: "house") }
      CatalogView().tabItem { Label("Catalog", systemImage: "square.grid.2x2") }
      OrdersView().tabItem { Label("Orders", systemImage: "shippingbox") }
      VaultRootView().tabItem { Label("Vault", systemImage: "lock") }
      SettingsRootView().tabItem { Label("Settings", systemImage: "gear") }
    }
    .environmentObject(state)
  }
}

// ---------- Home ----------

struct HomeView: View {
  var body: some View {
    NavigationStack {
      List {
        Section("Welcome") {
          Text("Labyrinth benchmark app")
          Text("Navigate carefully — labels lie.")
        }
        Section("Shortcuts that go nowhere") {
          NavigationLink("Quick Settings") { DecoyView(title: "Quick Settings", note: "Nothing here is real. Real settings live in the Settings tab.") }
          NavigationLink("License") { DecoyView(title: "License", note: "Not the license key. Try Settings.") }
        }
        Section("Trials") {
          NavigationLink("Enter the Gauntlet") { ChamberView(depth: 0) }
        }
      }
      .navigationTitle("Home")
    }
  }
}

struct DecoyView: View {
  let title: String
  let note: String
  var body: some View {
    List { Text(note) }.navigationTitle(title)
  }
}

// ---------- Catalog (confusable siblings, 3 deep) ----------

struct CatalogItem: Identifiable {
  let id = UUID()
  let name: String
}

struct CatalogView: View {
  var body: some View {
    NavigationStack {
      List {
        Section("Categories") {
          NavigationLink("Components") { ComponentsView() }
          NavigationLink("Composites") { DecoyListView(title: "Composites", items: ["Hull Plate", "Hull Plate Mk2", "Trussframe"]) }
          NavigationLink("Consumables") { DecoyListView(title: "Consumables", items: ["Coolant", "Coolant Ultra", "Flux Paste"]) }
        }
      }
      .navigationTitle("Catalog")
    }
  }
}

struct ComponentsView: View {
  var body: some View {
    List {
      Section("Families") {
        NavigationLink("Standard") { DecoyListView(title: "Standard", items: ["Flux Capacitor", "Flux Capacitor v2", "Nebula Widget"]) }
        NavigationLink("Exotic") { ExoticView() }
      }
    }
    .navigationTitle("Components")
  }
}

struct ExoticView: View {
  var body: some View {
    List {
      Section("Exotic components") {
        NavigationLink("Quantum Flux Capacitor") { ItemView(name: "Quantum Flux Capacitor") }
        NavigationLink("Quantum Flux Capacitor v2") { ItemView(name: "Quantum Flux Capacitor v2") }
        NavigationLink("Quantum Flux Regulator") { ItemView(name: "Quantum Flux Regulator") }
        NavigationLink("Nebula Widget Pro") { ItemView(name: "Nebula Widget Pro") }
      }
    }
    .navigationTitle("Exotic")
  }
}

struct DecoyListView: View {
  let title: String
  let items: [String]
  var body: some View {
    List(items, id: \.self) { name in
      NavigationLink(name) { ItemView(name: name) }
    }
    .navigationTitle(title)
  }
}

struct ItemView: View {
  @EnvironmentObject var state: AppState
  let name: String
  var isFav: Bool { state.favorites.contains(name) }
  var body: some View {
    List {
      Section("Item") {
        Text(name)
        Text("SKU: \(String(name.hashValue & 0xFFFF, radix: 16, uppercase: true))")
      }
      Section {
        Button(isFav ? "Remove from Favorites" : "Add to Favorites") {
          if isFav { state.favorites.removeAll { $0 == name } } else { state.favorites.append(name) }
          state.save()
        }
      }
    }
    .navigationTitle(name)
  }
}

// ---------- Orders (multi-step wizard) ----------

struct OrdersView: View {
  @EnvironmentObject var state: AppState
  var body: some View {
    NavigationStack {
      List {
        Section {
          NavigationLink("New Order") { OrderItemStep() }
        }
        Section("History") {
          if state.orders.isEmpty { Text("No orders yet") }
          ForEach(state.orders) { o in
            VStack(alignment: .leading) {
              Text(o.id).font(.headline)
              Text("\(o.qty) × \(o.item) → \(o.address)").font(.caption)
            }
          }
        }
      }
      .navigationTitle("Orders")
    }
  }
}

struct OrderItemStep: View {
  @State var item = ""
  let items = ["Nebula Widget", "Nebula Widget Pro", "Flux Capacitor", "Quantum Flux Capacitor v2"]
  var body: some View {
    List {
      Section("Step 1 of 4 — Choose item") {
        ForEach(items, id: \.self) { name in
          NavigationLink(name) { OrderQtyStep(item: name) }
        }
      }
    }
    .navigationTitle("New Order")
  }
}

struct OrderQtyStep: View {
  let item: String
  @State var qty = 1
  var body: some View {
    List {
      Section("Step 2 of 4 — Quantity") {
        Stepper("Quantity: \(qty)", value: $qty, in: 1...9)
      }
      Section {
        NavigationLink("Continue") { OrderAddressStep(item: item, qty: qty) }
      }
    }
    .navigationTitle("Quantity")
  }
}

struct OrderAddressStep: View {
  let item: String
  let qty: Int
  @State var address = ""
  var body: some View {
    List {
      Section("Step 3 of 4 — Shipping address") {
        TextField("Address", text: $address)
      }
      Section {
        NavigationLink("Review Order") { OrderReviewStep(item: item, qty: qty, address: address) }
          .disabled(address.isEmpty)
      }
    }
    .navigationTitle("Address")
  }
}

struct OrderReviewStep: View {
  @EnvironmentObject var state: AppState
  let item: String
  let qty: Int
  let address: String
  @State var placed: String? = nil
  var body: some View {
    List {
      Section("Step 4 of 4 — Review") {
        Text("Item: \(item)")
        Text("Quantity: \(qty)")
        Text("Ship to: \(address)")
      }
      Section {
        if let id = placed {
          Text("Order placed — number \(id)").font(.headline)
        } else {
          Button("Place Order") {
            let id = "ORD-\(1000 + state.orders.count + 1)"
            state.orders.append(OrderRecord(id: id, item: item, qty: qty, address: address))
            state.save()
            placed = id
          }
        }
      }
    }
    .navigationTitle("Review")
  }
}

// ---------- Vault: cross-screen dependency + carry ----------
// Hard because: the access code is hidden until "Show Codes" is enabled on a
// DIFFERENT screen (Vault > Preferences). Then the code appears on Vault >
// Access Panel > Reveal Code, and must be typed into Vault > Door. A raw agent
// has to discover the dependency, carry the code across three screens, and type
// it — with a decoy wrong code shown when Show Codes is OFF.

struct VaultRootView: View {
  var body: some View {
    NavigationStack {
      List {
        Section("Vault") {
          NavigationLink("Access Panel") { AccessPanelView() }
          NavigationLink("Door") { VaultDoorView() }
          NavigationLink("Preferences") { VaultPrefsView() }
        }
      }
      .navigationTitle("Vault")
    }
  }
}

struct VaultPrefsView: View {
  @EnvironmentObject var state: AppState
  var body: some View {
    List {
      Section("Security") {
        Toggle("Show Codes", isOn: Binding(get: { state.showCodes }, set: { state.showCodes = $0; state.save() }))
        Text("When off, the access panel shows a masked placeholder.")
      }
    }
    .navigationTitle("Preferences")
  }
}

struct AccessPanelView: View {
  var body: some View {
    List {
      Section("Panel") {
        NavigationLink("Reveal Code") { RevealCodeView() }
      }
    }
    .navigationTitle("Access Panel")
  }
}

struct RevealCodeView: View {
  @EnvironmentObject var state: AppState
  var body: some View {
    List {
      Section("Access code") {
        if state.showCodes {
          Text("Access Code: \(VAULT_CODE)")
        } else {
          Text("Access Code: ●●●● (enable Show Codes in Preferences first)")
        }
      }
    }
    .navigationTitle("Reveal Code")
  }
}

struct VaultDoorView: View {
  @EnvironmentObject var state: AppState
  @State var entry = ""
  @State var msg = ""
  var body: some View {
    List {
      Section("Enter access code") {
        TextField("Code", text: $entry)
        Button("Unlock") {
          if entry == VAULT_CODE { state.vaultUnlocked = true; state.save(); msg = "Vault unlocked." }
          else { msg = "Wrong code." }
        }
        if !msg.isEmpty { Text(msg) }
        if state.vaultUnlocked { Text("Status: UNLOCKED").font(.headline) }
      }
    }
    .navigationTitle("Door")
  }
}

// ---------- Gauntlet: 8-deep chambers with decoy doors ----------
// Buried under Catalog > Consumables ... no — placed under Home to force a
// different traversal. Correct path is always the door labeled with the NEXT
// prime; decoys are non-prime. Claim the beacon at the end.

struct ChamberView: View {
  @EnvironmentObject var state: AppState
  let depth: Int
  // primes gate the correct door; the sequence the agent must follow
  static let primes = [2, 3, 5, 7, 11, 13, 17, 19]
  var body: some View {
    if depth >= ChamberView.primes.count {
      List {
        Section("Inner Sanctum") {
          Button("Claim Beacon") { state.beaconClaimed = true; state.save() }
          if state.beaconClaimed { Text("Beacon claimed.").font(.headline) }
        }
      }
      .navigationTitle("Sanctum")
    } else {
      let correct = ChamberView.primes[depth]
      let decoys = [correct - 1, correct + 1].filter { $0 > 1 }
      let doors = ([correct] + decoys).sorted()
      List {
        Section("Chamber \(depth + 1) — pick the door numbered with the next prime") {
          ForEach(doors, id: \.self) { n in
            if n == correct {
              NavigationLink("Door \(n)") { ChamberView(depth: depth + 1) }
            } else {
              NavigationLink("Door \(n)") { DeadEndView(n: n) }
            }
          }
        }
      }
      .navigationTitle("Chamber \(depth + 1)")
    }
  }
}

struct DeadEndView: View {
  let n: Int
  var body: some View { List { Text("Dead end (Door \(n) was not prime). Go back.") }.navigationTitle("Dead End") }
}

// ---------- Settings (4 deep, decoys, buried license key) ----------

struct SettingsRootView: View {
  var body: some View {
    NavigationStack {
      List {
        Section {
          NavigationLink("General") { SettingsGeneral() }
          NavigationLink("Appearance") { DecoyView(title: "Appearance", note: "Decoy pane.") }
          NavigationLink("Notifications") { SettingsNotifications() }
        }
        Section("About") {
          NavigationLink("About Labyrinth") { AboutView() }
        }
      }
      .navigationTitle("Settings")
    }
  }
}

struct SettingsNotifications: View {
  @EnvironmentObject var state: AppState
  var body: some View {
    List {
      // Decoy: "Telemetry Logging" here is NOT the telemetry switch the tasks
      // mean; the real one is General > Privacy > Telemetry.
      Section("Delivery") {
        Toggle("Telemetry Logging", isOn: Binding(get: { state.telemetryLogging }, set: { state.telemetryLogging = $0; state.save() }))
      }
    }
    .navigationTitle("Notifications")
  }
}

struct SettingsGeneral: View {
  var body: some View {
    List {
      Section {
        NavigationLink("Privacy") { SettingsPrivacy() }
        NavigationLink("Storage") { DecoyView(title: "Storage", note: "Decoy pane.") }
      }
    }
    .navigationTitle("General")
  }
}

struct SettingsPrivacy: View {
  @EnvironmentObject var state: AppState
  var body: some View {
    List {
      Section("Data sharing") {
        Toggle("Telemetry", isOn: Binding(get: { state.telemetry }, set: { state.telemetry = $0; state.save() }))
      }
      Section {
        NavigationLink("Diagnostics") { SettingsDiagnostics() }
      }
    }
    .navigationTitle("Privacy")
  }
}

struct SettingsDiagnostics: View {
  @EnvironmentObject var state: AppState
  var body: some View {
    List {
      Section("Reports") {
        Toggle("Crash Reports", isOn: Binding(get: { state.crashReports }, set: { state.crashReports = $0; state.save() }))
      }
    }
    .navigationTitle("Diagnostics")
  }
}

struct AboutView: View {
  var body: some View {
    List {
      Section {
        NavigationLink("Advanced") { AdvancedView() }
        Text("Version 1.0")
      }
    }
    .navigationTitle("About Labyrinth")
  }
}

struct AdvancedView: View {
  var body: some View {
    List {
      Section {
        NavigationLink("Build Info") { BuildInfoView() }
      }
    }
    .navigationTitle("Advanced")
  }
}

struct BuildInfoView: View {
  @EnvironmentObject var state: AppState
  var body: some View {
    List {
      Section("Build") {
        Text("Channel: internal")
        Text("License Key: PU-7X49-KM31")
          .onAppear {
            state.licenseViewed = true
            state.save()
          }
      }
    }
    .navigationTitle("Build Info")
  }
}

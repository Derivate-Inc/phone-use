import SwiftUI

@main
struct PhoneUseRunnerApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: View {
    var body: some View {
        VStack(spacing: 12) {
            Text("phone-use").font(.largeTitle.bold())
            Text("Runner host").foregroundStyle(.secondary)
            Text("The automation server runs in the UI-test target.\nStart it, then connect on port 45678.")
                .multilineTextAlignment(.center)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }.padding()
    }
}

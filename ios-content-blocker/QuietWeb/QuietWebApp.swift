import SwiftUI
import SafariServices

// Must match the Content Blocker extension target's bundle identifier.
let blockerBundleID = "com.quietweb.QuietWeb.QuietWebBlocker"

@main
struct QuietWebApp: App {
  var body: some Scene {
    WindowGroup {
      ContentView()
    }
  }
}

struct ContentView: View {
  @State private var status: String?

  var body: some View {
    NavigationStack {
      List {
        Section {
          Text("Safari will not load images or video on any site. Everything else — logins, forms, search — works normally.")
            .font(.callout)
        }

        Section("Turn it on") {
          Step(1, "Settings → Apps → Safari → Extensions")
          Step(2, "Enable Quiet Web")
        }

        Section("Lock it") {
          Step(1, "Settings → Screen Time → Content & Privacy Restrictions")
          Step(2, "Turn on Content & Privacy Restrictions")
          Step(3, "Web Content → Limit Adult Websites")
          Step(4, "Set a Screen Time passcode you do not keep")
          Text("With a Web Content restriction active, Safari's extension toggles are greyed out — the blocker can no longer be switched off without that passcode.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }

        Section {
          Button("Reload block rules") { reload() }
          if let status {
            Text(status).font(.footnote).foregroundStyle(.secondary)
          }
        } footer: {
          Text("Only needed if you edit blockerList.json and rebuild.")
        }
      }
      .navigationTitle("Quiet Web")
    }
  }

  private func reload() {
    SFContentBlockerManager.reloadContentBlocker(withIdentifier: blockerBundleID) { error in
      DispatchQueue.main.async {
        status = error.map { "Failed: \($0.localizedDescription)" } ?? "Rules reloaded."
      }
    }
  }
}

private struct Step: View {
  let number: Int
  let text: String

  init(_ number: Int, _ text: String) {
    self.number = number
    self.text = text
  }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text("\(number)")
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
        .frame(width: 16, alignment: .trailing)
      Text(text)
    }
  }
}

import SwiftUI

@main
struct QuietBrowserApp: App {
  var body: some Scene {
    WindowGroup {
      BrowserScreen()
    }
  }
}

/// Address bar, web view, back/forward. Deliberately nothing else — no settings
/// screen, because a settings screen is where a "show images" switch ends up.
struct BrowserScreen: View {
  @StateObject private var model = BrowserModel()
  @FocusState private var addressFocused: Bool

  var body: some View {
    VStack(spacing: 0) {
      addressBar

      if model.isLoading {
        ProgressView(value: model.progress)
          .progressViewStyle(.linear)
          .frame(height: 2)
      }

      WebView(model: model)
        .ignoresSafeArea(edges: .bottom)

      toolbar
    }
  }

  private var addressBar: some View {
    HStack(spacing: 8) {
      TextField("Search or enter address", text: $model.addressText)
        .textFieldStyle(.plain)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .keyboardType(.webSearch)
        .submitLabel(.go)
        .focused($addressFocused)
        .onSubmit {
          addressFocused = false
          model.submit()
        }

      if addressFocused {
        Button("Cancel") {
          addressFocused = false
          model.addressText = model.currentURL?.absoluteString ?? ""
        }
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
  }

  private var toolbar: some View {
    HStack(spacing: 36) {
      Button { model.goBack() } label: { Image(systemName: "chevron.left") }
        .disabled(!model.canGoBack)
      Button { model.goForward() } label: { Image(systemName: "chevron.right") }
        .disabled(!model.canGoForward)
      Button { model.reload() } label: { Image(systemName: "arrow.clockwise") }
    }
    .font(.title3)
    .padding(.top, 10)
    .padding(.bottom, 4)
  }
}

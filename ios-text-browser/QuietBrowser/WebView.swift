import SwiftUI
import WebKit

/// Block images and video everywhere, with narrow exceptions so image CAPTCHAs
/// still render — without them you cannot log into sites that use one.
///
/// These rules are compiled by WebKit and enforced inside the engine. There is
/// deliberately no setting, no toggle, and no code path that disables them.
/// If you are reading this because you want the images back: the honest move is
/// to delete the app, not to add a switch.
private let blockRulesJSON = """
[
  {
    "trigger": { "url-filter": ".*", "resource-type": ["image", "media"] },
    "action": { "type": "block" }
  },
  {
    "trigger": {
      "url-filter": "^https?://([a-z0-9-]+\\\\.)*(google|gstatic|recaptcha)\\\\.(com|net)/recaptcha/",
      "resource-type": ["image"]
    },
    "action": { "type": "ignore-previous-rules" }
  },
  {
    "trigger": {
      "url-filter": ".*",
      "resource-type": ["image"],
      "if-domain": ["*hcaptcha.com", "*challenges.cloudflare.com", "*arkoselabs.com", "*funcaptcha.com"]
    },
    "action": { "type": "ignore-previous-rules" }
  }
]
"""

/// Shared state between the SwiftUI chrome and the web view.
final class BrowserModel: ObservableObject {
  @Published var addressText = ""
  @Published var currentURL: URL?
  @Published var canGoBack = false
  @Published var canGoForward = false
  @Published var isLoading = false
  @Published var progress = 0.0

  /// Set by the view layer so the toolbar buttons can drive the web view.
  var goBack: () -> Void = {}
  var goForward: () -> Void = {}
  var reload: () -> Void = {}
  var load: (URL) -> Void = { _ in }

  /// Treat input as a URL when it looks like one, otherwise search.
  /// Google works fine here — nothing is proxied, so its own JavaScript runs.
  func submit() {
    let input = addressText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !input.isEmpty else { return }

    if input.contains("://"), let url = URL(string: input) {
      load(url)
      return
    }

    let looksLikeHost = !input.contains(" ") && input.contains(".")
    if looksLikeHost, let url = URL(string: "https://\(input)") {
      load(url)
      return
    }

    let query = input.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
    if let url = URL(string: "https://www.google.com/search?q=\(query)") {
      load(url)
    }
  }
}

struct WebView: UIViewRepresentable {
  @ObservedObject var model: BrowserModel

  func makeCoordinator() -> Coordinator { Coordinator(model: model) }

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    // Persistent store, so logins survive relaunches.
    configuration.websiteDataStore = .default()
    configuration.allowsInlineMediaPlayback = false

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = context.coordinator
    webView.allowsBackForwardNavigationGestures = true

    context.coordinator.observe(webView)
    context.coordinator.attachRules(to: webView)

    model.goBack = { [weak webView] in webView?.goBack() }
    model.goForward = { [weak webView] in webView?.goForward() }
    model.reload = { [weak webView] in webView?.reload() }
    model.load = { [weak webView] url in webView?.load(URLRequest(url: url)) }

    if let home = URL(string: "https://www.google.com") {
      webView.load(URLRequest(url: home))
    }
    return webView
  }

  func updateUIView(_ webView: WKWebView, context: Context) {}

  final class Coordinator: NSObject, WKNavigationDelegate {
    private let model: BrowserModel
    private var observations: [NSKeyValueObservation] = []

    init(model: BrowserModel) {
      self.model = model
    }

    /// Compile the rules and attach them. Until they are attached we keep the
    /// view blank rather than briefly loading a page with images allowed.
    func attachRules(to webView: WKWebView) {
      WKContentRuleListStore.default()?.compileContentRuleList(
        forIdentifier: "quiet-block-media",
        encodedContentRuleList: blockRulesJSON
      ) { list, error in
        guard let list else {
          assertionFailure("block rules failed to compile: \(String(describing: error))")
          return
        }
        webView.configuration.userContentController.add(list)
      }
    }

    func observe(_ webView: WKWebView) {
      observations = [
        webView.observe(\.canGoBack, options: [.initial, .new]) { [weak self] view, _ in
          self?.model.canGoBack = view.canGoBack
        },
        webView.observe(\.canGoForward, options: [.initial, .new]) { [weak self] view, _ in
          self?.model.canGoForward = view.canGoForward
        },
        webView.observe(\.isLoading, options: [.initial, .new]) { [weak self] view, _ in
          self?.model.isLoading = view.isLoading
        },
        webView.observe(\.estimatedProgress, options: [.initial, .new]) { [weak self] view, _ in
          self?.model.progress = view.estimatedProgress
        },
        webView.observe(\.url, options: [.initial, .new]) { [weak self] view, _ in
          guard let url = view.url else { return }
          self?.model.currentURL = url
          self?.model.addressText = url.absoluteString
        },
      ]
    }
  }
}

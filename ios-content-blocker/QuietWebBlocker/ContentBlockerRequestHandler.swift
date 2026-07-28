import Foundation

/// Safari asks the extension for its rules through this handler. The rules
/// themselves are static JSON — Safari compiles and enforces them, so this code
/// runs only when the rule list is (re)loaded, never while browsing.
final class ContentBlockerRequestHandler: NSObject, NSExtensionRequestHandling {
  func beginRequest(with context: NSExtensionContext) {
    guard
      let url = Bundle.main.url(forResource: "blockerList", withExtension: "json"),
      let attachment = NSItemProvider(contentsOf: url)
    else {
      context.completeRequest(returningItems: nil, completionHandler: nil)
      return
    }

    let item = NSExtensionItem()
    item.attachments = [attachment]
    context.completeRequest(returningItems: [item], completionHandler: nil)
  }
}

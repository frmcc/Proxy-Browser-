# Quiet Browser — a browser that cannot show images

A minimal iOS browser. Every site works normally — logins, forms, Google, JavaScript — but images and video never load. There is no setting to turn them back on, because there is no settings screen and no code that would do it.

That is the only difference between this and apps like Text Browser: the capability is absent rather than toggleable.

## Why this rather than the other two approaches in this repo

| | Works like Safari | Can you switch images back on? |
| --- | --- | --- |
| `../` (the proxy) | No — rewrites pages, Google's search breaks | No, but heavy sites break too |
| `../ios-content-blocker` | Yes, it *is* Safari | Yes, unless you lock it behind a Screen Time passcode |
| **this** | Yes — real WebKit, nothing proxied | **No. Nothing to switch.** |

## How the blocking works

`WKContentRuleList` — the same engine-level mechanism Safari content blockers use. WebKit compiles the rules and enforces them below the page, so a site cannot script its way around them.

1. Block `image` and `media` on every URL.
2. Re-allow images under `/recaptcha/` paths on Google/gstatic, scoped so Google Images stays blocked.
3. Re-allow images on dedicated CAPTCHA hosts (hCaptcha, Cloudflare Turnstile, Arkose).

Rules 2 and 3 exist so image CAPTCHAs still render. Without them you get locked out of sites that use one. The host patterns are anchored, so `evilgoogle.com/recaptcha/…` and `google.com.evil.net/recaptcha/…` do not slip through.

Inline SVG is left alone, so site icons and buttons still render and pages stay navigable.

Cookies use the persistent store, so logins survive relaunching.

## Build and install

Mac with Xcode, iPhone on a cable.

1. Xcode → File → New → Project → iOS → **App**. Product Name `QuietBrowser`, Interface **SwiftUI**, Language **Swift**.
2. Delete the generated `ContentView.swift` and `QuietBrowserApp.swift`.
3. Drag in both files from `QuietBrowser/` here: `QuietBrowserApp.swift` and `WebView.swift`. Tick *Copy items if needed*.
4. Select the project → target → Signing & Capabilities → *Automatically manage signing* → your Apple ID team.
5. Pick your iPhone as the destination, press Run.
6. On the phone: Settings → General → VPN & Device Management → your Apple ID → **Trust**.

Open it and load any image-heavy site. Text and layout arrive; pictures do not.

## Closing the obvious hole

The app has no way to show images — but Safari is still sitting on the home screen. If the point is to stop yourself, remove the alternative:

1. Settings → Screen Time → **Content & Privacy Restrictions** → on.
2. **Allowed Apps** → turn **Safari** off. Do the same for any other browser.
3. Settings → Screen Time → **Lock Screen Time Settings** → set a passcode you do not keep.

Now Quiet Browser is the only way to reach the web on the device, and it has no image switch.

## The expiry problem — read before relying on this

**A free Apple ID signs the app for seven days.** After that it stops launching. That fails *open*: the app dies, Safari is still blocked, and you either sit without a browser or unlock Screen Time to fix it — which is exactly the moment the commitment collapses.

If this needs to last:

- **Apple Developer Program**, $99/year → signing lasts a year. Rebuild annually.
- **Rebuild weekly** — free, but a chore, and every rebuild is a chance to not bother.

Decide this before you lock Safari behind a passcode you gave away.

## Changing the rules

Rules live in `blockRulesJSON` at the top of `WebView.swift`. Rebuild to apply.

Stricter — also block web fonts and SVG:

```json
"resource-type": ["image", "media", "font", "svg-document"]
```

Allow images on one site you genuinely need:

```json
{
  "trigger": { "url-filter": ".*", "resource-type": ["image"], "if-domain": ["*yourbank.com"] },
  "action": { "type": "ignore-previous-rules" }
}
```

Rules evaluate in order and `ignore-previous-rules` undoes earlier matches, so exceptions must come after the block rule.

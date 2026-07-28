# Quiet Web — a Safari content blocker

Blocks every image and video in Safari itself. Not a proxy: you browse normally, stay logged in everywhere, Google works, forms work. Safari simply refuses to fetch images and media.

This is the thing the proxy in the parent directory could never be. A proxy fetches and rewrites pages, which is why Google breaks and logins are fragile. A content blocker sits inside Safari and filters requests, so every site behaves exactly as it does today, minus the pictures.

## The rules

`QuietWebBlocker/blockerList.json` is the whole product. Everything else is scaffolding.

1. Block `image` and `media` on every URL.
2. Re-allow images under `/recaptcha/` paths on Google/gstatic — scoped to that path, so reCAPTCHA works but Google Images stays blocked.
3. Re-allow images on dedicated CAPTCHA hosts (hCaptcha, Cloudflare Turnstile, Arkose).

Without rules 2 and 3, image CAPTCHAs render blank and you cannot log into sites that use them.

Inline SVG is deliberately left alone (`svg-document` is a separate resource type and isn't blocked), so site icons and buttons still render and pages stay navigable.

## Build and install

You need a Mac with Xcode and an iPhone connected by cable.

1. **New project.** Xcode → File → New → Project → iOS → App. Product Name `QuietWeb`, Interface **SwiftUI**, Language **Swift**. Note the bundle identifier it gives you.
2. **Add the extension.** File → New → Target → iOS → **Content Blocker Extension**. Name it `QuietWebBlocker`. Activate the scheme if prompted.
3. **Replace three files** with the ones here:
   - `QuietWebBlocker/blockerList.json`
   - `QuietWebBlocker/ContentBlockerRequestHandler.swift`
   - the app's `QuietWebApp.swift` (replace the generated `ContentView.swift` + `…App.swift` with this single file)
4. **Fix the identifier.** In `QuietWebApp.swift`, set `blockerBundleID` to the extension target's actual bundle identifier — select the `QuietWebBlocker` target → General → Bundle Identifier. It is usually the app's identifier with `.QuietWebBlocker` appended.
5. **Signing.** Select each target → Signing & Capabilities → check *Automatically manage signing* → pick your Apple ID team. A free Apple ID works.
6. **Run.** Choose your iPhone as the destination and press Run.
7. **Trust the certificate** on the phone: Settings → General → VPN & Device Management → your Apple ID → Trust.
8. **Enable it:** Settings → Apps → Safari → Extensions → turn on **Quiet Web**.

Open Safari and load any image-heavy site. Text and layout arrive; pictures do not.

## Lock it so you cannot turn it off

Enabling a Web Content restriction greys out Safari's extension toggles entirely.

1. Settings → Screen Time → **Content & Privacy Restrictions** → turn on.
2. **Web Content** → *Limit Adult Websites*.
3. Settings → Screen Time → **Lock Screen Time Settings** → set a passcode.

Have someone else enter that passcode, or generate a random one and put it somewhere genuinely inconvenient. Once it is set, the extension cannot be switched off without it.

## The expiry problem — read this before relying on it

**A free Apple ID signs the app for seven days.** After that it stops launching and the blocker stops working, which fails *open*: images come back. That undermines the whole point.

Three ways around it:

- **Apple Developer Program**, $99/year. Signing lasts a year. Cleanest if you want this to be permanent.
- **A paid third-party blocker from the App Store.** AdGuard, 1Blocker, and similar accept custom rules and never expire because they are properly distributed. Less elegant, no Mac needed, and the Screen Time lock works the same way. For a commitment device that has to survive, this is honestly the more reliable option.
- **Rebuild weekly.** Free, but a recurring chore, and every rebuild is an opportunity to not bother.

## Changing the rules

Edit `blockerList.json`, rebuild, then press *Reload block rules* in the app.

**Go stricter** — also block web fonts and SVG:

```json
"resource-type": ["image", "media", "font", "svg-document"]
```

**Allow images on one site** you actually need them on:

```json
{
  "trigger": { "url-filter": ".*", "resource-type": ["image"], "if-domain": ["*yourbank.com"] },
  "action": { "type": "ignore-previous-rules" }
}
```

Rules are evaluated in order and `ignore-previous-rules` undoes earlier matches, so exceptions must come after the block rule. Safari allows up to 150,000 rules; this list uses three.

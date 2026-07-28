# Quiet Browser

A browser you open on your phone. Type a URL, read the page — no images, no video, no ads, no trackers. Everything else browses normally.

The point is to make the web boring enough to put down. Most of what makes a phone hard to stop scrolling is pictures and video; strip those and a news site becomes a wall of text you skim and leave. Text-first sites (Wikipedia, Hacker News, documentation, most news) work well. Instagram does not, by design.

## How the blocking works

Four layers, because any one of them alone leaks.

**A network filter.** Any response coming back as `image/*`, `video/*`, or `audio/*`, or carrying `Content-Disposition: attachment`, is refused with a 403. This is the layer that catches media a page's own JavaScript asks for at runtime, long after the HTML was rewritten.

**A DOM pass.** `img`, `picture`, `video`, `audio`, `embed`, and `object` elements are removed before the page is sent, along with `srcset`, `poster`, and `background` attributes, icon links, and media preload hints. `<noscript>` blocks get the same treatment — their contents arrive as raw text, so media hiding in there would otherwise survive.

**A Content-Security-Policy.** Every proxied page is served with `img-src 'none'; media-src 'none'`, enforced by the browser itself. This is what stops CSS background images, favicons, and any late injection the DOM pass never saw.

**Injected CSS.** Hides media elements and clears background images, so the page closes the gaps its pictures used to occupy instead of leaving holes.

Inline `<svg>` is deliberately kept. Sites use it for nav icons and buttons, and stripping it leaves menus unusable — a page you can't navigate isn't a page you can read.

Ad, tracker, and re-engagement hosts (analytics, session recording, push-notification and attribution SDKs) are refused at the proxy and their script tags dropped during the rewrite. Blocking media removes the pictures; blocking these removes the machinery built to pull you back.

## Reading mode

Tap **Read** in the toolbar to strip a page to its article — headline, body copy, nothing else. It scores blocks by how much real prose they hold and penalises the ones that are mostly links, so navigation, related-story rails, and newsletter prompts fall away. Tap **Full** to go back.

## Run it

```bash
npm install
npm start
```

Then open http://localhost:3000.

```bash
npm test    # 127 tests, no network required
```

## Deploy it

```bash
docker build -t quiet-browser .
docker run -p 8080:8080 -e ACCESS_PASSWORD=something quiet-browser
```

It reads `$PORT`, so it runs unchanged on Render, Railway, Fly.io, and Cloud Run. Point any of them at this repo and it builds from the `Dockerfile`.

## Put it on your phone

Open the deployed URL in Safari, tap Share, then **Add to Home Screen**. The web manifest makes it launch standalone, without Safari's chrome around it. The toolbar accounts for the notch.

iOS won't let a web app intercept links tapped in other apps, so this can't replace Safari outright. What works is a bookmarklet — save this as a bookmark and tap it to push the page you're on into the proxy:

```
javascript:location.href='https://YOUR-DEPLOYMENT/p?u='+encodeURIComponent(location.href)
```

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on. |
| `ACCESS_PASSWORD` | unset | When set, the whole app sits behind a password. Strongly recommended for anything public. |
| `SESSION_SECRET` | random per boot | Signs the auth cookie. Set it to keep people logged in across restarts. |
| `ALLOW_PRIVATE_HOSTS` | off | Lets the proxy reach private and loopback addresses. Useful for browsing your own LAN services; dangerous on a public deployment. |

## Security

**With no `ACCESS_PASSWORD`, a public deployment is an open proxy.** Anyone who finds the URL can browse through it, and that traffic leaves your server's IP address. Set a password, or keep the deployment private.

Requests are checked before they're made: only `http` and `https`, a deny-list covering `localhost` and `.local`/`.internal` names, and DNS resolution checked against private, loopback, link-local, CGNAT, and cloud-metadata ranges for both IPv4 and IPv6 — including IPv4-mapped addresses in either notation, since `new URL()` rewrites `::ffff:127.0.0.1` to `::ffff:7f00:1`. Redirects are handed back to the browser rather than followed server-side, so every hop is re-validated and a public URL can't bounce the proxy into a private address.

One gap worth naming: the hostname is resolved for the check and resolved again by `fetch`, leaving a DNS-rebinding window. Closing it means pinning the socket to the validated IP through a custom dispatcher, which breaks TLS certificate validation unless handled carefully. It hasn't been done here.

Site cookies are held server-side and partitioned per visitor; origin `Set-Cookie` headers never reach the browser. Responses are filtered through an allowlist — `content-type`, `cache-control`, `content-language`, `date` — rather than a deny-list, so a header nobody thought about doesn't get forwarded by default.

## Limitations

- **Heavy JavaScript apps mostly don't work.** Instagram, X, and TikTok rely on service workers and same-origin XHR that a URL-rewriting proxy can't emulate. This is not really a bug for a tool whose purpose is to make those sites unappealing.
- **Cookies are in memory.** Logins drop when the process restarts, and running more than one instance scatters sessions across them.
- **A site could still use a large inline `<svg>` as a hero image**, since SVG is kept for icons.
- **Inline PDFs pass through.** Only `Content-Disposition: attachment` is blocked.
- **File uploads aren't supported** — multipart form bodies aren't forwarded.
- **The blocklist is a fixed list**, not a subscribable filter feed. It catches the common trackers, not everything.

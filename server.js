import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { BlockedError, assertSafeUrl, escapeHtml, normalizeInput } from './lib/guard.js';
import { cookieHeaderFor, ensureSession, startSweeper, store } from './lib/cookies.js';
import { proxyUrl, rewriteCss, rewriteHtml } from './lib/rewrite.js';
import { isBlockedHost } from './lib/blocklist.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const FETCH_TIMEOUT_MS = 20_000;
const MAX_HTML_BYTES = 12 * 1024 * 1024;

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// img-src/media-src are the load-bearing directives: they stop media the DOM
// pass never saw, including anything the page's own scripts try to insert.
const CSP = [
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
  "img-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join('; ');

/** Allowlist, never a deny-list: anything not named here is dropped. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'cache-control', 'content-language', 'date'];

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

// ---------------------------------------------------------------- access gate

const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const AUTH_COOKIE = 'mfb_auth';
const authToken = () => crypto.createHmac('sha256', SESSION_SECRET).update(ACCESS_PASSWORD).digest('hex');

function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function loginPage(message = '') {
  return page('Locked', `<h1>Locked</h1>
${message ? `<p class="note">${escapeHtml(message)}</p>` : ''}
<form method="post" action="/__auth">
<input type="password" name="password" placeholder="Password" autofocus aria-label="Password">
<button type="submit">Unlock</button>
</form>`);
}

/**
 * Throttle password guessing. Without this, a short password is worth very
 * little: an attacker can try the whole keyspace as fast as the server answers.
 * Failures cost an exponentially growing lockout, per client address.
 */
const FAILURE_ALLOWANCE = 5;
const LOCKOUT_BASE_MS = 2_000;
const LOCKOUT_CEILING_MS = 15 * 60 * 1000;
const attempts = new Map();

function attemptKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** Milliseconds still to wait, or 0 when a guess is allowed. */
function lockoutRemaining(key) {
  const record = attempts.get(key);
  if (!record) return 0;
  return Math.max(0, record.until - Date.now());
}

function recordFailure(key) {
  const record = attempts.get(key) ?? { failures: 0, until: 0 };
  record.failures += 1;
  if (record.failures > FAILURE_ALLOWANCE) {
    const backoff = Math.min(LOCKOUT_BASE_MS * 2 ** (record.failures - FAILURE_ALLOWANCE - 1), LOCKOUT_CEILING_MS);
    record.until = Date.now() + backoff;
  }
  attempts.set(key, record);
}

function clearFailures(key) {
  attempts.delete(key);
}

// Forget idle records so the map cannot grow without bound.
setInterval(() => {
  const cutoff = Date.now() - LOCKOUT_CEILING_MS;
  for (const [key, record] of attempts) {
    if (record.until < cutoff) attempts.delete(key);
  }
}, 10 * 60 * 1000).unref();

if (ACCESS_PASSWORD) {
  app.post('/__auth', express.urlencoded({ extended: false }), (req, res) => {
    const key = attemptKey(req);
    const wait = lockoutRemaining(key);
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      return res
        .status(429)
        .type('html')
        .set('Retry-After', String(seconds))
        .send(loginPage(`Too many attempts. Try again in ${seconds}s.`));
    }

    if (!safeEqual(req.body?.password ?? '', ACCESS_PASSWORD)) {
      recordFailure(key);
      return res.status(401).type('html').send(loginPage('That password did not match.'));
    }
    clearFailures(key);
    const attributes = [`${AUTH_COOKIE}=${authToken()}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=2592000'];
    if (req.secure) attributes.push('Secure');
    res.append('Set-Cookie', attributes.join('; '));
    res.redirect('/');
  });

  app.use((req, res, next) => {
    if (safeEqual(readCookie(req, AUTH_COOKIE) ?? '', authToken())) return next();
    res.status(401).type('html').send(loginPage());
  });
}

// -------------------------------------------------------------------- helpers

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title><style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  padding: 2rem 1.25rem; background: #f2f2f7; color: #1c1c1e; text-align: center;
  font: 17px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
main { max-width: 26rem; width: 100%; }
h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
.note { color: #6b6b70; font-size: .95rem; word-break: break-word; }
form { display: flex; gap: .5rem; margin-top: 1.25rem; }
input { flex: 1; min-width: 0; padding: .8rem 1rem; font-size: 1rem; border: 1px solid rgba(0,0,0,.14);
  border-radius: 12px; background: #fff; color: inherit; }
button, .btn { padding: .8rem 1.1rem; font-size: 1rem; border: 0; border-radius: 12px; cursor: pointer;
  background: #0071e3; color: #fff; text-decoration: none; display: inline-block; }
.row { display: flex; gap: .5rem; justify-content: center; margin-top: 1.25rem; }
.row .btn { background: rgba(120,120,128,.16); color: inherit; }
@media (prefers-color-scheme: dark) {
  body { background: #000; color: #f2f2f7; }
  input { background: #1c1c1e; border-color: rgba(255,255,255,.16); }
  .row .btn { background: rgba(120,120,128,.32); }
}
</style></head><body><main>${body}</main></body></html>`;
}

function sendError(res, status, title, detail) {
  if (res.headersSent) return;
  res.status(status).type('html').set('Cache-Control', 'no-store').send(
    page(title, `<h1>${escapeHtml(title)}</h1>
<p class="note">${escapeHtml(detail)}</p>
<div class="row"><a class="btn" href="#" onclick="history.back();return false">Back</a><a class="btn" href="/">Home</a></div>`),
  );
}

function applyResponseHeaders(res, originHeaders, { contentType } = {}) {
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = originHeaders?.get?.(name);
    if (value) res.setHeader(name, value);
  }
  if (contentType) res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Belt and braces: these must never reach the browser from an origin.
  res.removeHeader('Set-Cookie');
  res.removeHeader('Strict-Transport-Security');
}

const CHARSET_IN_TYPE = /charset=["']?([\w-]+)/i;
const CHARSET_IN_META = /<meta[^>]+charset=["']?([\w-]+)/i;

function decodeBody(buffer, contentType) {
  let label = CHARSET_IN_TYPE.exec(contentType ?? '')?.[1];
  if (!label) {
    const head = buffer.subarray(0, 2048).toString('latin1');
    label = CHARSET_IN_META.exec(head)?.[1];
  }
  try {
    return new TextDecoder(label || 'utf-8').decode(buffer);
  } catch {
    return buffer.toString('utf-8');
  }
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

// ---------------------------------------------------------------------- proxy

async function handleProxy(req, res) {
  const raw = firstValue(req.query.__pxt ?? req.query.u);
  const normalized = normalizeInput(raw);
  if (!normalized) return res.redirect('/');

  const reader = firstValue(req.query.reader) === '1';
  const target = await assertSafeUrl(normalized);

  // Everything else in the query string came from a rewritten GET form, whose
  // fields serialise alongside __pxt. A rewritten link keeps its own params
  // inside the encoded u value, so merging here cannot corrupt one.
  for (const [key, value] of Object.entries(req.query)) {
    if (key === 'u' || key === '__pxt' || key === 'reader') continue;
    for (const item of [].concat(value)) target.searchParams.append(key, String(item));
  }

  if (isBlockedHost(target.hostname)) {
    throw new BlockedError('That host is on the ad and tracker blocklist.', 403);
  }

  const sessionId = ensureSession(req, res);
  const method = req.method === 'HEAD' ? 'HEAD' : req.method;

  const headers = {
    'User-Agent': IOS_UA,
    Accept: req.headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    // The target's own origin, never ours — the proxy host must not leak to sites.
    Referer: `${target.origin}/`,
  };
  const jar = cookieHeaderFor(sessionId, target);
  if (jar) headers.Cookie = jar;

  let body;
  if (method !== 'GET' && method !== 'HEAD' && req.body && Object.keys(req.body).length > 0) {
    if (String(req.headers['content-type'] ?? '').includes('json')) {
      body = JSON.stringify(req.body);
      headers['Content-Type'] = 'application/json';
    } else {
      body = new URLSearchParams(req.body).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }

  let response;
  try {
    response = await fetch(target, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'That site took too long to respond.' : `Could not reach ${target.hostname}.`;
    throw new BlockedError(reason, 504);
  }

  store(sessionId, target, response.headers.getSetCookie?.() ?? []);

  // Hand redirects back to the browser so its address bar and history stay
  // truthful; the follow-up re-enters this handler and is re-validated, which
  // is what stops a public URL from redirecting into a private address.
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (location) {
      try {
        const next = new URL(location, target).toString();
        const status = response.status === 307 || response.status === 308 ? response.status : 303;
        res.setHeader('Referrer-Policy', 'no-referrer');
        return res.redirect(status, proxyUrl(next, { reader }));
      } catch {
        throw new BlockedError('That site redirected somewhere invalid.', 502);
      }
    }
  }

  const contentType = response.headers.get('content-type') ?? '';
  const disposition = response.headers.get('content-disposition') ?? '';

  if (/^(image|video|audio)\//i.test(contentType.trim())) {
    applyResponseHeaders(res, null, { contentType: 'text/plain; charset=utf-8' });
    return res.status(403).send('Blocked: media');
  }
  if (/attachment/i.test(disposition)) {
    applyResponseHeaders(res, null, { contentType: 'text/plain; charset=utf-8' });
    return res.status(403).send('Blocked: download');
  }

  const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);
  const isCss = /text\/css/i.test(contentType);

  if (isHtml || isCss) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_HTML_BYTES) {
      throw new BlockedError('That page is too large to process.', 413);
    }
    const text = decodeBody(buffer, contentType);
    const out = isHtml ? rewriteHtml(text, target, { reader }) : rewriteCss(text, target);

    applyResponseHeaders(res, response.headers, {
      contentType: isHtml ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8',
    });
    if (isHtml) res.setHeader('Cache-Control', 'no-store');
    return res.status(response.status).send(out);
  }

  applyResponseHeaders(res, response.headers, { contentType: contentType || 'application/octet-stream' });
  res.status(response.status);
  if (!response.body || method === 'HEAD') return res.end();
  return Readable.fromWeb(response.body).pipe(res);
}

app.all(
  '/p',
  express.urlencoded({ extended: true, limit: '2mb' }),
  express.json({ limit: '2mb' }),
  (req, res, next) => {
    Promise.resolve(handleProxy(req, res)).catch(next);
  },
);

app.use(express.static(PUBLIC_DIR, { extensions: false, maxAge: '1h', index: 'index.html' }));

app.use((req, res) => sendError(res, 404, 'Not found', `Nothing is served at ${req.path}.`));

app.use((error, _req, res, _next) => {
  if (error instanceof BlockedError) return sendError(res, error.status, 'Blocked', error.message);
  console.error('proxy error:', error);
  return sendError(res, 502, 'Could not load that page', error?.message ?? 'Unknown error');
});

startSweeper();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`media-free browser listening on http://localhost:${PORT}`);
  if (!ACCESS_PASSWORD) console.log('ACCESS_PASSWORD is unset — this instance is an open proxy.');
  if (/^(1|true|yes)$/i.test(process.env.ALLOW_PRIVATE_HOSTS ?? '')) {
    console.warn('ALLOW_PRIVATE_HOSTS is on — private and loopback addresses are reachable through this proxy.');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

export default app;

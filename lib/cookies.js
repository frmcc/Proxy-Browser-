import crypto from 'node:crypto';

/**
 * A cookie jar held entirely on the server, partitioned per visitor.
 *
 * Origin cookies never reach the browser: we hand the visitor one opaque session
 * id and keep their site cookies here, keyed by that id. The previous version of
 * this app kept a single process-wide Map keyed by domain, so one visitor's
 * logged-in session was replayed on every other visitor's requests.
 *
 * In-memory only: sessions reset when the process restarts, and running more
 * than one instance will scatter them. Fine for a personal deployment.
 */

const SESSION_COOKIE = 'mfb_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_SESSIONS = 2000;
const MAX_COOKIES_PER_SESSION = 500;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** sessionId -> { lastSeen, cookies: Map<key, cookie> } */
const sessions = new Map();

function cookieKey(cookie) {
  return `${cookie.domain}|${cookie.path}|${cookie.name}`;
}

function getSession(sessionId) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = { lastSeen: Date.now(), cookies: new Map() };
    sessions.set(sessionId, session);
  }
  session.lastSeen = Date.now();
  return session;
}

/** Read the visitor's session id, minting one if this is their first request. */
export function ensureSession(req, res) {
  const existing = parseRequestCookies(req.headers.cookie)[SESSION_COOKIE];
  if (existing && /^[a-f0-9-]{36}$/.test(existing)) {
    getSession(existing); // refresh lastSeen
    return existing;
  }

  const sessionId = crypto.randomUUID();
  const attributes = [
    `${SESSION_COOKIE}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (req.secure) attributes.push('Secure');
  res.append('Set-Cookie', attributes.join('; '));
  getSession(sessionId);
  return sessionId;
}

function parseRequestCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

function normalizeDomain(domain) {
  return domain.toLowerCase().replace(/^\./, '').replace(/\.$/, '');
}

/** RFC 6265 domain match: exact host, or a subdomain of the cookie's domain. */
function domainMatches(host, cookieDomain) {
  if (host === cookieDomain) return true;
  return host.endsWith(`.${cookieDomain}`);
}

function pathMatches(requestPath, cookiePath) {
  if (cookiePath === '/' || requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/** Default path per RFC 6265: the request path up to its last slash. */
function defaultPath(pathname) {
  if (!pathname.startsWith('/')) return '/';
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

function parseSetCookie(raw, requestUrl) {
  const segments = raw.split(';');
  const [nameValue, ...attributeParts] = segments;
  const eq = nameValue.indexOf('=');
  if (eq <= 0) return null;

  const cookie = {
    name: nameValue.slice(0, eq).trim(),
    value: nameValue.slice(eq + 1).trim(),
    domain: normalizeDomain(requestUrl.hostname),
    hostOnly: true,
    path: defaultPath(requestUrl.pathname),
    expires: null,
    secure: false,
  };
  if (!cookie.name) return null;

  for (const part of attributeParts) {
    const eqIndex = part.indexOf('=');
    const key = (eqIndex === -1 ? part : part.slice(0, eqIndex)).trim().toLowerCase();
    const value = eqIndex === -1 ? '' : part.slice(eqIndex + 1).trim();

    if (key === 'domain' && value) {
      const domain = normalizeDomain(value);
      // Refuse a cookie trying to scope itself to an unrelated domain.
      if (domain && domainMatches(normalizeDomain(requestUrl.hostname), domain)) {
        cookie.domain = domain;
        cookie.hostOnly = false;
      }
    } else if (key === 'path' && value.startsWith('/')) {
      cookie.path = value;
    } else if (key === 'secure') {
      cookie.secure = true;
    } else if (key === 'max-age') {
      const seconds = Number.parseInt(value, 10);
      if (Number.isFinite(seconds)) cookie.expires = Date.now() + seconds * 1000;
    } else if (key === 'expires' && cookie.expires === null) {
      const at = Date.parse(value);
      if (!Number.isNaN(at)) cookie.expires = at;
    }
  }

  return cookie;
}

/** Record Set-Cookie headers from an origin response. */
export function store(sessionId, requestUrl, setCookieHeaders) {
  if (!sessionId || !setCookieHeaders?.length) return;
  const session = getSession(sessionId);

  for (const raw of setCookieHeaders) {
    const cookie = parseSetCookie(raw, requestUrl);
    if (!cookie) continue;

    const key = cookieKey(cookie);
    // An expired cookie is a deletion instruction.
    if (cookie.expires !== null && cookie.expires <= Date.now()) {
      session.cookies.delete(key);
      continue;
    }
    session.cookies.delete(key); // re-insert so Map order tracks recency
    session.cookies.set(key, cookie);
  }

  while (session.cookies.size > MAX_COOKIES_PER_SESSION) {
    session.cookies.delete(session.cookies.keys().next().value);
  }
  evictOldSessions();
}

/** Build the Cookie header to send to an origin. */
export function cookieHeaderFor(sessionId, requestUrl) {
  const session = sessions.get(sessionId);
  if (!session?.cookies.size) return null;

  const host = normalizeDomain(requestUrl.hostname);
  const isSecure = requestUrl.protocol === 'https:';
  const now = Date.now();
  const matches = [];

  for (const [key, cookie] of session.cookies) {
    if (cookie.expires !== null && cookie.expires <= now) {
      session.cookies.delete(key);
      continue;
    }
    if (cookie.secure && !isSecure) continue;
    if (cookie.hostOnly ? host !== cookie.domain : !domainMatches(host, cookie.domain)) continue;
    if (!pathMatches(requestUrl.pathname, cookie.path)) continue;
    matches.push(cookie);
  }

  if (!matches.length) return null;
  // Longer paths first, as RFC 6265 requires.
  matches.sort((a, b) => b.path.length - a.path.length);
  return matches.map((c) => `${c.name}=${c.value}`).join('; ');
}

function evictOldSessions() {
  if (sessions.size <= MAX_SESSIONS) return;
  const ordered = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
  for (const [id] of ordered.slice(0, sessions.size - MAX_SESSIONS)) {
    sessions.delete(id);
  }
}

export function sweep(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (now - session.lastSeen > SESSION_TTL_MS) {
      sessions.delete(id);
      continue;
    }
    for (const [key, cookie] of session.cookies) {
      if (cookie.expires !== null && cookie.expires <= now) session.cookies.delete(key);
    }
  }
}

export function startSweeper() {
  const timer = setInterval(() => sweep(), SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}

export const _internals = { sessions, SESSION_COOKIE };

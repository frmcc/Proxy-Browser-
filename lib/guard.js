import dns from 'node:dns/promises';
import net from 'node:net';

/** Thrown for anything we refuse to fetch. Carries an HTTP status. */
export class BlockedError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'BlockedError';
    this.status = status;
  }
}

const SEARCH_URL = 'https://html.duckduckgo.com/html/?q=';

/**
 * Turn whatever was typed into the address bar into a URL.
 * Runs on the server so the app behaves identically with JS disabled.
 */
export function normalizeInput(raw) {
  const input = String(raw ?? '').trim();
  if (!input) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;

  // A bare host or host/path, e.g. "example.com" or "en.wikipedia.org/wiki/Cat".
  const looksLikeHost = !/\s/.test(input) && /^[^/]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(input);
  if (looksLikeHost) return `https://${input}`;

  return SEARCH_URL + encodeURIComponent(input);
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  return /\.(localhost|local|internal|localdomain|home\.arpa)$/.test(host);
}

/** Private, loopback, link-local, and other ranges we must never reach. */
function isPrivateIPv4(address) {
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;

  if (a === 0) return true; //   0.0.0.0/8   "this network"
  if (a === 10) return true; //  10.0.0.0/8  private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0) return true; //  192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; //  224.0.0.0/4 multicast, 240.0.0.0/4 reserved
  return false;
}

function isPrivateIPv6(address) {
  const addr = address.toLowerCase().split('%')[0]; // drop any zone index

  // IPv4-mapped (::ffff:1.2.3.4) and IPv4-compatible forms re-check as IPv4.
  const mapped = addr.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);

  if (addr === '::' || addr === '::1') return true; // unspecified, loopback
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}:/.test(addr)) return true; //   ff00::/8 multicast
  return false;
}

export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true; // not an IP literal at all — refuse
}

/**
 * Validate a URL before we fetch it. Must be called for every hop, including
 * redirect targets: a public URL redirecting to 127.0.0.1 is the obvious bypass.
 *
 * Known gap: we resolve the hostname and then let fetch resolve it again, which
 * leaves a DNS-rebinding window. Closing it means pinning the socket to the
 * validated IP through a custom undici dispatcher, which breaks TLS SNI unless
 * handled carefully. Documented in the README rather than half-solved here.
 */
export async function assertSafeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlockedError('That does not look like a valid address.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BlockedError(`Only http and https addresses are supported (got "${parsed.protocol}").`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // unwrap IPv6 literals
  if (!hostname) throw new BlockedError('That address has no host.');
  if (isBlockedHostname(hostname)) {
    throw new BlockedError('That address points at a private host.', 403);
  }

  // An IP literal needs no lookup — check it directly.
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new BlockedError('That address points at a private network.', 403);
    }
    return parsed;
  }

  let resolved;
  try {
    resolved = await dns.lookup(hostname, { all: true });
  } catch {
    throw new BlockedError(`Could not find "${hostname}".`, 502);
  }

  if (resolved.length === 0) {
    throw new BlockedError(`Could not find "${hostname}".`, 502);
  }
  // Reject if *any* answer is private — a split-horizon name should not slip through.
  if (resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw new BlockedError('That address resolves to a private network.', 403);
  }

  return parsed;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

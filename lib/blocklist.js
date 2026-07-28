/**
 * Ad, tracker, and engagement-optimization hosts.
 *
 * Blocking media removes the pictures; blocking these removes the machinery
 * built to pull you back. Requests to these hosts are refused at the proxy and
 * their script tags are dropped during the rewrite, so the page never gets the
 * chance to ask.
 *
 * Suffix-matched: an entry covers the host itself and every subdomain.
 */
const BLOCKED_SUFFIXES = [
  // Ad exchanges and serving
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagservices.com',
  'adservice.google.com',
  'amazon-adsystem.com',
  'adnxs.com',
  'adsrvr.org',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'casalemedia.com',
  'criteo.com',
  'criteo.net',
  '33across.com',
  'smartadserver.com',
  'adform.net',
  'indexww.com',
  'yieldmo.com',
  'sharethrough.com',
  'teads.tv',
  'mathtag.com',
  'moatads.com',
  'adroll.com',
  'taboola.com',
  'outbrain.com',
  'revcontent.com',
  'mgid.com',
  'zergnet.com',

  // Analytics and behavioural measurement
  'google-analytics.com',
  'googletagmanager.com',
  'scorecardresearch.com',
  'quantserve.com',
  'quantcast.com',
  'chartbeat.com',
  'parsely.com',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'amplitude.com',
  'heap.io',
  'hotjar.com',
  'fullstory.com',
  'mouseflow.com',
  'crazyegg.com',
  'optimizely.com',
  'clarity.ms',
  'cloudflareinsights.com',
  'mc.yandex.ru',
  'bat.bing.com',
  'nr-data.net',
  'newrelic.com',

  // Data brokers and identity graphs
  'demdex.net',
  'omtrdc.net',
  'everesttech.net',
  'bluekai.com',
  'krxd.net',
  'agkn.com',
  'rlcdn.com',
  'crwdcntrl.net',
  'addthis.com',
  'sharethis.com',

  // Attribution and re-engagement (push notifications, deep links, "come back" mail)
  'branch.io',
  'appsflyer.com',
  'adjust.com',
  'braze.com',
  'onesignal.com',
  'urbanairship.com',
  'iterable.com',
  'klaviyo.com',

  // Social pixels and embed widgets built for engagement
  'connect.facebook.net',
  'ads-twitter.com',
  'analytics.tiktok.com',
  'ct.pinterest.com',
  'px.ads.linkedin.com',
  'snap.licdn.com',
  'sc-static.net',
];

const BLOCKED = new Set(BLOCKED_SUFFIXES);

export function isBlockedHost(hostname) {
  if (!hostname) return false;
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  if (BLOCKED.has(host)) return true;

  // Walk up the labels so "cdn.doubleclick.net" matches "doubleclick.net"
  // without a substring match wrongly catching "notdoubleclick.net".
  let index = host.indexOf('.');
  while (index !== -1) {
    if (BLOCKED.has(host.slice(index + 1))) return true;
    index = host.indexOf('.', index + 1);
  }
  return false;
}

export const _internals = { BLOCKED_SUFFIXES };

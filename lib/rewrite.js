import * as cheerio from 'cheerio';
import { escapeHtml } from './guard.js';
import { isBlockedHost } from './blocklist.js';

const BAR_HEIGHT = 44;

/** Schemes we hand to the browser untouched rather than routing through the proxy. */
const PASSTHROUGH_SCHEME = /^(?:javascript|mailto|tel|sms|data|blob|about|magnet|facetime|itms-apps):/i;

const MEDIA_ELEMENTS = 'img, picture, source, video, audio, track, embed, object, applet';
const MEDIA_ATTRIBUTES = ['srcset', 'imagesrcset', 'poster', 'background', 'lowsrc'];
const ICON_RELS = new Set(['icon', 'shortcut', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon', 'fluid-icon']);
const MEDIA_AS = new Set(['image', 'video', 'audio', 'track']);

export function proxyUrl(absoluteUrl, { reader = false } = {}) {
  const base = `/p?u=${encodeURIComponent(absoluteUrl)}`;
  return reader ? `${base}&reader=1` : base;
}

/** Resolve a possibly-relative URL, or null if it should be left alone. */
function absolute(value, baseUrl) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.startsWith('#') || PASSTHROUGH_SCHEME.test(trimmed)) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function relList(value) {
  return String(value ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

export function rewriteCss(css, baseUrl) {
  if (!css) return '';

  const rewriteRef = (raw) => {
    const resolved = absolute(raw, baseUrl);
    return resolved ? proxyUrl(resolved) : null;
  };

  let out = String(css).replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, quote, ref) => {
    const next = rewriteRef(ref);
    return next ? `url("${next}")` : match;
  });

  // @import "x" / @import 'x' — the url(...) form is already handled above.
  out = out.replace(/@import\s+(["'])([^"']+)\1/gi, (match, quote, ref) => {
    const next = rewriteRef(ref);
    return next ? `@import "${next}"` : match;
  });

  return out;
}

/**
 * Reading mode: keep the article, drop the page.
 *
 * A compact take on the readability heuristic — score blocks by how much real
 * prose they hold, penalise the ones that are mostly links (navigation, related
 * -story rails), and keep the winner.
 */
const CHROME_PATTERN = /(^|[-_\s])(nav|menu|sidebar|side-bar|footer|header|masthead|comment|share|social|promo|related|recirc|newsletter|subscribe|signup|cookie|consent|banner|advert|sponsor|breadcrumb|pagination|modal|popup|paywall)([-_\s]|$)/i;
const KEEP_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'strong', 'b', 'em', 'i', 'u', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'figcaption', 'dl', 'dt', 'dd', 'span', 'div', 'article', 'section', 'time', 'mark', 'small', 'abbr', 'cite', 'q']);

function visibleText($, el) {
  return $(el).text().replace(/\s+/g, ' ').trim();
}

function linkDensity($, el) {
  const total = visibleText($, el).length;
  if (!total) return 1;
  return $(el).find('a').text().replace(/\s+/g, ' ').trim().length / total;
}

function extractArticle($, baseUrl) {
  const $root = $('body').length ? $('body') : $.root();

  $root.find('script, style, noscript, iframe, form, nav, aside, header, footer, svg, canvas, button, input, select, textarea').remove();
  $root.find('[class], [id], [role]').each((_, el) => {
    const $el = $(el);
    const signature = `${$el.attr('class') ?? ''} ${$el.attr('id') ?? ''} ${$el.attr('role') ?? ''}`;
    if (CHROME_PATTERN.test(signature)) $el.remove();
  });

  const scores = new Map();
  const bump = (el, amount) => {
    if (!el || el.type !== 'tag') return;
    scores.set(el, (scores.get(el) ?? 0) + amount);
  };

  $root.find('p, pre, blockquote').each((_, el) => {
    const text = visibleText($, el);
    if (text.length < 25) return;
    const weight = 1 + (text.match(/,/g)?.length ?? 0) + Math.min(text.length / 100, 3);

    // Credit every ancestor, with the share falling off by depth, so a wrapper
    // holding many sections can still out-score any single section inside it.
    let ancestor = el.parent;
    let depth = 0;
    while (ancestor && ancestor.type === 'tag' && depth < 6) {
      bump(ancestor, depth === 0 ? weight : weight / (depth * 2));
      ancestor = ancestor.parent;
      depth += 1;
    }
  });

  const adjustedScore = (el) => (scores.get(el) ?? 0) * (1 - linkDensity($, el));

  let best = null;
  let bestScore = 0;
  for (const el of scores.keys()) {
    const adjusted = adjustedScore(el);
    if (adjusted > bestScore) {
      bestScore = adjusted;
      best = el;
    }
  }

  // The winner is often one section of a longer article. Climb while the parent
  // still holds most of the score — that parent is the real article body.
  while (best?.parent && best.parent.type === 'tag' && best.parent.tagName !== 'body') {
    const parentScore = adjustedScore(best.parent);
    if (parentScore < bestScore * 0.75) break;
    best = best.parent;
    bestScore = Math.max(bestScore, parentScore);
  }

  const $article = best ? $(best) : $root;
  if (visibleText($, $article).length < 200) return null;

  // Keep only prose-bearing tags; unwrap anything else so its text survives.
  $article.find('*').each((_, el) => {
    if (!KEEP_TAGS.has(el.tagName?.toLowerCase())) {
      $(el).replaceWith($(el).contents());
    }
  });

  $article.find('a[href]').each((_, el) => {
    const resolved = absolute($(el).attr('href'), baseUrl);
    if (resolved) $(el).attr('href', proxyUrl(resolved, { reader: true }));
    $(el).removeAttr('target').removeAttr('rel');
  });

  // Strip presentational leftovers so reader styling actually applies.
  $article.find('*').each((_, el) => {
    for (const name of ['style', 'class', 'id', 'width', 'height', 'align', 'bgcolor']) {
      $(el).removeAttr(name);
    }
  });

  return $article.html();
}

function readerDocument({ title, byline, articleHtml, targetUrl }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title></head><body>
<article id="__mfb_reader">
<h1>${escapeHtml(title)}</h1>
${byline ? `<p class="__mfb_byline">${escapeHtml(byline)}</p>` : ''}
<p class="__mfb_source"><a href="${escapeHtml(proxyUrl(targetUrl))}">Read the full page</a></p>
<hr>
${articleHtml}
</article></body></html>`;
}

function blockingStyles() {
  return `
${MEDIA_ELEMENTS.split(', ').join(',')} { display: none !important; }
* { background-image: none !important; }
body { padding-top: calc(${BAR_HEIGHT}px + env(safe-area-inset-top, 0px)) !important; }

#__mfb_bar {
  position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important;
  height: calc(${BAR_HEIGHT}px + env(safe-area-inset-top, 0px)) !important;
  padding: env(safe-area-inset-top, 0px) 8px 0 8px !important;
  box-sizing: border-box !important;
  display: flex !important; align-items: center !important; gap: 6px !important;
  background-color: #f2f2f7 !important;
  border-bottom: 1px solid rgba(0,0,0,0.12) !important;
  z-index: 2147483647 !important;
  font: 15px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif !important;
  color: #1c1c1e !important;
  margin: 0 !important; transform: none !important; visibility: visible !important; opacity: 1 !important;
}
#__mfb_bar * { box-sizing: border-box !important; font-family: inherit !important; }
#__mfb_bar a, #__mfb_bar button {
  flex: 0 0 auto !important;
  display: flex !important; align-items: center !important; justify-content: center !important;
  min-width: 32px !important; height: 32px !important; padding: 0 8px !important;
  background-color: rgba(120,120,128,0.12) !important;
  border: 0 !important; border-radius: 8px !important;
  color: #1c1c1e !important; text-decoration: none !important;
  font-size: 15px !important; line-height: 1 !important; cursor: pointer !important;
}
#__mfb_form { flex: 1 1 auto !important; display: flex !important; min-width: 0 !important; margin: 0 !important; }
#__mfb_url {
  flex: 1 1 auto !important; width: 100% !important; min-width: 0 !important; height: 32px !important;
  padding: 0 10px !important; border: 0 !important; border-radius: 8px !important;
  background-color: #fff !important; color: #1c1c1e !important;
  font-size: 15px !important; text-align: left !important;
}
@media (prefers-color-scheme: dark) {
  #__mfb_bar { background-color: #1c1c1e !important; color: #f2f2f7 !important; border-bottom-color: rgba(255,255,255,0.15) !important; }
  #__mfb_bar a, #__mfb_bar button { background-color: rgba(120,120,128,0.32) !important; color: #f2f2f7 !important; }
  #__mfb_url { background-color: #2c2c2e !important; color: #f2f2f7 !important; }
}

#__mfb_reader {
  max-width: 42rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem;
  font: 19px/1.65 -apple-system, BlinkMacSystemFont, 'Segoe UI', Georgia, serif;
  color: #1c1c1e; overflow-wrap: break-word;
}
#__mfb_reader h1 { font-size: 1.7em; line-height: 1.2; margin: 0 0 .5rem; }
#__mfb_reader .__mfb_byline, #__mfb_reader .__mfb_source { font-size: .8em; color: #6b6b70; margin: .2rem 0; }
#__mfb_reader hr { border: 0; border-top: 1px solid rgba(0,0,0,.12); margin: 1.5rem 0; }
#__mfb_reader p { margin: 0 0 1.1em; }
#__mfb_reader pre { overflow-x: auto; padding: .8em; background: rgba(120,120,128,.12); border-radius: 8px; font-size: .8em; }
#__mfb_reader table { display: block; overflow-x: auto; max-width: 100%; }
@media (prefers-color-scheme: dark) {
  html, body { background-color: #000 !important; }
  #__mfb_reader { color: #e6e6ea; }
  #__mfb_reader hr { border-top-color: rgba(255,255,255,.16); }
}
`.trim();
}

function toolbarHtml(targetUrl, { reader }) {
  const current = proxyUrl(targetUrl, { reader });
  const toggle = proxyUrl(targetUrl, { reader: !reader });
  return `<div id="__mfb_bar" role="toolbar" aria-label="Browser controls">
<button type="button" onclick="history.back()" title="Back" aria-label="Back">&#8249;</button>
<a href="${escapeHtml(current)}" title="Reload" aria-label="Reload">&#8635;</a>
<a href="/" title="Home" aria-label="Home">&#8962;</a>
<form id="__mfb_form" method="get" action="/p" role="search">
<input id="__mfb_url" type="text" name="u" value="${escapeHtml(targetUrl)}" aria-label="Address"
 autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go">
</form>
<a href="${escapeHtml(toggle)}" title="${reader ? 'Show the full page' : 'Reading mode'}">${reader ? 'Full' : 'Read'}</a>
</div>`;
}

/**
 * The element-level pass: strip media, drop trackers, route URLs through the
 * proxy. Split out from rewriteHtml so it can also run against <noscript>
 * fragments, whose contents the HTML parser hands us as raw text rather than
 * elements — media hiding in there would otherwise survive untouched.
 */
function scrub($, resolveAgainst) {
  $(MEDIA_ELEMENTS).remove();

  $('link[rel]').each((_, el) => {
    const $el = $(el);
    const rels = relList($el.attr('rel'));
    if (rels.some((rel) => ICON_RELS.has(rel))) return void $el.remove();
    if ((rels.includes('preload') || rels.includes('prefetch')) && MEDIA_AS.has(String($el.attr('as')).toLowerCase())) {
      $el.remove();
    }
  });

  for (const name of MEDIA_ATTRIBUTES) $(`[${name}]`).removeAttr(name);
  $('link[integrity], script[integrity]').removeAttr('integrity');

  // Drop tracker scripts outright so the page never gets to ask for them.
  $('script[src]').each((_, el) => {
    const resolved = absolute($(el).attr('src'), resolveAgainst);
    if (!resolved) return;
    try {
      if (isBlockedHost(new URL(resolved).hostname)) $(el).remove();
    } catch {
      /* leave it for the URL rewrite below */
    }
  });

  for (const [selector, attribute] of [
    ['a[href]', 'href'],
    ['area[href]', 'href'],
    ['link[href]', 'href'],
    ['script[src]', 'src'],
    ['iframe[src]', 'src'],
    ['frame[src]', 'src'],
  ]) {
    $(selector).each((_, el) => {
      const resolved = absolute($(el).attr(attribute), resolveAgainst);
      if (resolved) $(el).attr(attribute, proxyUrl(resolved));
    });
  }

  $('form').each((_, el) => {
    const $form = $(el);
    const action = absolute($form.attr('action'), resolveAgainst) ?? resolveAgainst.toString();
    const method = String($form.attr('method') ?? 'get').toLowerCase();

    if (method === 'post') {
      $form.attr('action', `/p?__pxt=${encodeURIComponent(action)}`);
      return;
    }
    // A GET form serialises every field into the query string, so the target
    // rides along as a field and the server merges the rest back onto it.
    $form.attr('action', '/p');
    $form.prepend($('<input>').attr({ type: 'hidden', name: '__pxt', value: action }));
  });

  $('style').each((_, el) => {
    const $el = $(el);
    const css = $el.html();
    if (css) $el.text(rewriteCss(css, resolveAgainst));
  });
}

export function rewriteHtml(html, baseUrl, { reader = false } = {}) {
  const target = baseUrl instanceof URL ? baseUrl : new URL(String(baseUrl));
  const $ = cheerio.load(String(html ?? ''));

  // Resolve <base> before anything else, then drop it: a surviving <base> would
  // re-anchor our /p links and break every navigation on the page.
  let resolveAgainst = target;
  const declaredBase = $('base[href]').first().attr('href');
  if (declaredBase) {
    try {
      resolveAgainst = new URL(declaredBase, target);
    } catch {
      /* keep the page URL */
    }
  }
  $('base').remove();

  if (reader) {
    const title = $('meta[property="og:title"]').attr('content') || $('title').first().text().trim() || target.hostname;
    const byline = $('meta[name="author"]').attr('content') || $('[rel="author"]').first().text().trim() || '';
    const articleHtml = extractArticle($, resolveAgainst);
    if (articleHtml) {
      const $reader = cheerio.load(readerDocument({ title, byline, articleHtml, targetUrl: target.toString() }));
      $reader('head').append(`<style>${blockingStyles()}</style>`);
      $reader('body').prepend(toolbarHtml(target.toString(), { reader: true }));
      return $reader.html();
    }
    // Fall through to the normal rendering when there is no article to find.
  }

  scrub($, resolveAgainst);

  // <noscript> contents arrive as raw text, so scrub them as a separate
  // fragment and put the cleaned markup back.
  $('noscript').each((_, el) => {
    const inner = $(el).html();
    if (!inner || !/<[a-z]/i.test(inner)) return;
    const $fragment = cheerio.load(inner, null, false);
    scrub($fragment, resolveAgainst);
    $(el).text('').append($fragment.html());
  });

  $('meta[http-equiv]').each((_, el) => {
    if (String($(el).attr('http-equiv')).toLowerCase() === 'content-security-policy') $(el).remove();
  });

  // <meta http-equiv="refresh" content="3; url=...">
  $('meta[http-equiv]').each((_, el) => {
    const $el = $(el);
    if (String($el.attr('http-equiv')).toLowerCase() !== 'refresh') return;
    const content = $el.attr('content');
    if (!content) return;
    const match = /^([^;]*);\s*url\s*=\s*(["']?)([^"']+)\2\s*$/i.exec(content.trim());
    if (!match) return;
    const resolved = absolute(match[3], resolveAgainst);
    if (resolved) $el.attr('content', `${match[1].trim()}; url=${proxyUrl(resolved)}`);
  });

  if ($('head').length === 0) $.root().prepend('<head></head>');
  if ($('body').length === 0) $('head').after('<body></body>');

  if ($('meta[name="viewport"]').length === 0) {
    $('head').prepend('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
  }
  $('head').append(`<style>${blockingStyles()}</style>`);
  $('body').prepend(toolbarHtml(target.toString(), { reader: false }));

  return $.html();
}

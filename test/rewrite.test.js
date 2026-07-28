import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { proxyUrl, rewriteCss, rewriteHtml } from '../lib/rewrite.js';
import { isBlockedHost } from '../lib/blocklist.js';

const BASE = new URL('https://example.com/blog/post.html');
const render = (html, options) => rewriteHtml(html, BASE, options);

describe('proxyUrl', () => {
  test('encodes the target', () => {
    assert.equal(proxyUrl('https://a.test/x?y=1'), '/p?u=https%3A%2F%2Fa.test%2Fx%3Fy%3D1');
  });

  test('carries the reader flag', () => {
    assert.match(proxyUrl('https://a.test/', { reader: true }), /&reader=1$/);
  });
});

describe('media removal', () => {
  const media = ['img', 'video', 'audio', 'picture', 'embed', 'object'];
  for (const tag of media) {
    test(`removes <${tag}>`, () => {
      const out = render(`<html><body><${tag} src="x"></${tag}></body></html>`);
      assert.ok(!out.includes(`<${tag}`), `${tag} should be gone`);
    });
  }

  test('removes media nested inside other elements', () => {
    const out = render('<html><body><div><figure><img src="a.jpg"></figure></div></body></html>');
    assert.ok(!out.includes('<img'));
  });

  test('scrubs media inside <noscript>, whose contents parse as raw text', () => {
    const out = render('<html><body><noscript><img src="pixel.gif"></noscript></body></html>');
    assert.ok(!out.includes('<img'), 'the noscript image should be gone');
    assert.ok(out.includes('<noscript'), 'the noscript element itself should survive');
  });

  test('keeps inline <svg> so site icons still work', () => {
    const out = render('<html><body><svg viewBox="0 0 1 1"><circle r="1"/></svg></body></html>');
    assert.ok(out.includes('<svg'), 'svg is deliberately preserved');
  });

  test('keeps <canvas>', () => {
    const out = render('<html><body><canvas id="c"></canvas></body></html>');
    assert.ok(out.includes('<canvas'));
  });

  test('strips media attributes', () => {
    const out = render('<html><body><div srcset="a.jpg 1x" poster="p.jpg" background="b.gif" lowsrc="l.jpg"></div></body></html>');
    for (const attribute of ['srcset', 'poster', 'background=', 'lowsrc']) {
      assert.ok(!out.includes(attribute), `${attribute} should be stripped`);
    }
  });

  test('removes icon links and media preloads', () => {
    const out = render(`<html><head>
      <link rel="icon" href="/f.ico">
      <link rel="shortcut icon" href="/g.ico">
      <link rel="apple-touch-icon" href="/h.png">
      <link rel="preload" as="image" href="/hero.jpg">
      <link rel="stylesheet" href="/s.css">
    </head><body></body></html>`);
    for (const gone of ['f.ico', 'g.ico', 'h.png', 'hero.jpg']) {
      assert.ok(!out.includes(gone), `${gone} should be removed`);
    }
    assert.ok(out.includes('s.css'), 'stylesheets must survive');
  });
});

describe('URL rewriting', () => {
  test('rewrites a relative link against the page URL', () => {
    const out = render('<html><body><a href="next">n</a></body></html>');
    assert.ok(out.includes(`href="${proxyUrl('https://example.com/blog/next')}"`.replace(/&/g, '&amp;')) || out.includes('u=https%3A%2F%2Fexample.com%2Fblog%2Fnext'));
  });

  test('honours <base href> and then removes the element', () => {
    const out = render('<html><head><base href="https://cdn.test/x/"></head><body><a href="y">y</a></body></html>');
    assert.ok(out.includes('u=https%3A%2F%2Fcdn.test%2Fx%2Fy'), 'should resolve against base');
    assert.ok(!out.includes('<base'), 'a surviving <base> would break every rewritten link');
  });

  test('resolves protocol-relative URLs', () => {
    const out = render('<html><body><a href="//other.test/z">z</a></body></html>');
    assert.ok(out.includes('u=https%3A%2F%2Fother.test%2Fz'));
  });

  test('leaves non-navigational schemes alone', () => {
    const out = render(`<html><body>
      <a href="#top">f</a><a href="javascript:go()">j</a>
      <a href="mailto:a@b.c">m</a><a href="tel:+1234">t</a>
    </body></html>`);
    assert.ok(out.includes('href="#top"'));
    assert.ok(out.includes('javascript:go()'));
    assert.ok(out.includes('mailto:a@b.c'));
    assert.ok(out.includes('tel:+1234'));
  });

  test('leaves a malformed href untouched instead of throwing', () => {
    assert.doesNotThrow(() => render('<html><body><a href="ht tp://%%%">x</a></body></html>'));
  });

  test('rewrites scripts, stylesheets and iframes', () => {
    const out = render(`<html><head><link rel="stylesheet" href="/s.css"></head>
      <body><script src="/a.js"></script><iframe src="/f.html"></iframe></body></html>`);
    assert.ok(out.includes('u=https%3A%2F%2Fexample.com%2Fs.css'));
    assert.ok(out.includes('u=https%3A%2F%2Fexample.com%2Fa.js'));
    assert.ok(out.includes('u=https%3A%2F%2Fexample.com%2Ff.html'));
  });

  test('strips subresource integrity, which proxying would break', () => {
    const out = render('<html><head><script src="/a.js" integrity="sha384-xyz"></script></head><body></body></html>');
    assert.ok(!out.includes('integrity'));
  });

  test('rewrites a meta refresh target', () => {
    const out = render('<html><head><meta http-equiv="refresh" content="3; url=/next"></head><body></body></html>');
    assert.ok(out.includes('u=https%3A%2F%2Fexample.com%2Fnext'));
  });

  test('removes an origin CSP meta tag', () => {
    const out = render('<html><head><meta http-equiv="Content-Security-Policy" content="default-src none"></head><body></body></html>');
    assert.ok(!out.toLowerCase().includes('content-security-policy'));
  });
});

describe('trackers', () => {
  test('drops known tracker scripts', () => {
    const out = render(`<html><body>
      <script src="https://www.google-analytics.com/analytics.js"></script>
      <script src="https://cdn.doubleclick.net/ad.js"></script>
      <script src="/local.js"></script>
    </body></html>`);
    assert.ok(!out.includes('google-analytics'));
    assert.ok(!out.includes('doubleclick'));
    assert.ok(out.includes('local.js'), 'first-party scripts must survive');
  });

  test('matches subdomains but not lookalike domains', () => {
    assert.equal(isBlockedHost('doubleclick.net'), true);
    assert.equal(isBlockedHost('cdn.doubleclick.net'), true);
    assert.equal(isBlockedHost('notdoubleclick.net'), false);
    assert.equal(isBlockedHost('doubleclick.net.evil.test'), false);
    assert.equal(isBlockedHost('example.com'), false);
  });
});

describe('forms', () => {
  test('a GET form posts through /p with a hidden target', () => {
    const out = render('<html><body><form method="get" action="/search"><input name="q"></form></body></html>');
    assert.ok(out.includes('action="/p"'));
    assert.ok(out.includes('name="__pxt"'));
    assert.ok(out.includes('https://example.com/search'));
  });

  test('a POST form keeps its method and carries the target in the query', () => {
    const out = render('<html><body><form method="post" action="/login"><input name="u"></form></body></html>');
    assert.ok(out.includes('/p?__pxt=https%3A%2F%2Fexample.com%2Flogin'));
    assert.ok(/method="post"/i.test(out));
  });

  test('a form with no action targets the current page', () => {
    const out = render('<html><body><form><input name="q"></form></body></html>');
    assert.ok(out.includes('example.com/blog/post.html'));
  });
});

describe('toolbar', () => {
  test('is injected with the current URL', () => {
    const out = render('<html><body><p>hi</p></body></html>');
    assert.ok(out.includes('__mfb_bar'));
    assert.ok(out.includes('value="https://example.com/blog/post.html"'));
    assert.ok(out.includes('action="/p"'));
  });

  test('a quote in the URL cannot break out of the value attribute', () => {
    const out = rewriteHtml('<html><body></body></html>', new URL('https://example.com/a"onload="alert(1)'));
    assert.ok(!out.includes('onload="alert(1)"'), 'must not produce a live attribute');
    // URL percent-encodes the quote before it ever reaches the attribute; the
    // escaping in the toolbar is the second line of defence behind that.
    assert.ok(out.includes('%22onload=%22alert(1)'), 'the quote should be percent-encoded');
  });

  test('escaping still holds when a raw quote reaches the attribute', () => {
    const out = rewriteHtml('<html><body><a href="x">l</a></body></html>', BASE);
    const values = [...out.matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(values.every((v) => !v.includes('"')), 'no attribute value may contain a bare quote');
  });

  test('adds a viewport meta when the page has none', () => {
    const out = render('<html><head></head><body></body></html>');
    assert.ok(out.includes('width=device-width'));
  });

  test('survives a document with no head or body tags', () => {
    const out = rewriteHtml('<p>bare</p>', BASE);
    assert.ok(out.includes('__mfb_bar'));
    assert.ok(out.includes('bare'));
  });
});

describe('rewriteCss', () => {
  const cssBase = new URL('https://example.com/assets/main.css');

  test('rewrites unquoted, single- and double-quoted url()', () => {
    const out = rewriteCss("a{background:url(a.png)} b{background:url('b.png')} c{background:url(\"c.png\")}", cssBase);
    for (const name of ['a.png', 'b.png', 'c.png']) {
      assert.ok(out.includes(`u=https%3A%2F%2Fexample.com%2Fassets%2F${name}`), `${name} should be rewritten`);
    }
  });

  test('rewrites @import in both forms', () => {
    const out = rewriteCss('@import "x.css"; @import url(y.css);', cssBase);
    assert.ok(out.includes('u=https%3A%2F%2Fexample.com%2Fassets%2Fx.css'));
    assert.ok(out.includes('u=https%3A%2F%2Fexample.com%2Fassets%2Fy.css'));
  });

  test('keeps web fonts working', () => {
    const out = rewriteCss('@font-face{src:url("f.woff2") format("woff2")}', cssBase);
    assert.ok(out.includes('u=https%3A%2F%2Fexample.com%2Fassets%2Ff.woff2'));
  });

  test('leaves data URIs alone', () => {
    const out = rewriteCss('a{background:url(data:image/gif;base64,R0lGOD)}', cssBase);
    assert.ok(out.includes('data:image/gif;base64,R0lGOD'));
    assert.ok(!out.includes('/p?u=data'));
  });

  test('handles empty input', () => {
    assert.equal(rewriteCss('', cssBase), '');
    assert.equal(rewriteCss(null, cssBase), '');
  });

  test('inline <style> blocks are rewritten too', () => {
    const out = render('<html><head><style>@font-face{src:url(f.woff2)}</style></head><body></body></html>');
    assert.ok(out.includes('u=https%3A%2F%2Fexample.com%2Fblog%2Ff.woff2'));
  });
});

describe('reader mode', () => {
  const article = `<html><head><title>A Long Read</title></head><body>
    <nav><a href="/a">nav one</a><a href="/b">nav two</a></nav>
    <div class="sidebar"><a href="/x">related</a></div>
    <article><h1>A Long Read</h1>
      ${Array.from({ length: 8 }, (_, i) => `<p>This is a reasonably long paragraph of body copy, number ${i}, with commas, clauses, and enough words to score as real prose rather than navigation chrome.</p>`).join('')}
    </article>
    <footer>footer junk</footer></body></html>`;

  test('extracts the article and drops the chrome', () => {
    const out = rewriteHtml(article, BASE, { reader: true });
    assert.ok(out.includes('__mfb_reader'), 'should render the reader container');
    assert.ok(out.includes('reasonably long paragraph'), 'body copy should survive');
    assert.ok(!out.includes('nav one'), 'navigation should be dropped');
    assert.ok(!out.includes('footer junk'), 'the footer should be dropped');
  });

  test('keeps the toolbar and offers a way back to the full page', () => {
    const out = rewriteHtml(article, BASE, { reader: true });
    assert.ok(out.includes('__mfb_bar'));
    assert.ok(out.includes('Read the full page'));
  });

  test('falls back to the normal rendering when there is no article', () => {
    const out = rewriteHtml('<html><body><p>too short</p></body></html>', BASE, { reader: true });
    assert.ok(out.includes('__mfb_bar'), 'still a usable page');
    assert.ok(out.includes('too short'));
  });
});

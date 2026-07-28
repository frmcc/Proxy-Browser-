import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFixture } from './fixture.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let fixture;
let proxy;
let base;

/** Start the app on an ephemeral port, with the loopback guard opened so it can reach the fixture. */
function startProxy(port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ALLOW_PRIVATE_HOSTS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy did not start in time')), 10_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('error', reject);
  });
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const via = (target, extra = '') => `${base}/p?u=${encodeURIComponent(target)}${extra}`;

before(async () => {
  fixture = await startFixture();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proxy = await startProxy(port);
});

after(async () => {
  proxy?.kill();
  await fixture?.stop();
});

describe('proxy pipeline', () => {
  test('serves the landing page', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Quiet Browser/);
  });

  test('healthz responds', async () => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });

  test('proxies a page and strips its media', async () => {
    const response = await fetch(via(fixture.origin + '/'));
    assert.equal(response.status, 200);
    const html = await response.text();

    assert.ok(!html.includes('<img'), 'images should be gone');
    assert.ok(!html.includes('<video'), 'video should be gone');
    assert.ok(!html.includes('srcset'), 'srcset should be stripped');
    assert.ok(!html.includes('favicon.ico'), 'the icon link should be gone');
    assert.ok(html.includes('<svg'), 'inline svg is kept on purpose');
    assert.ok(html.includes('__mfb_bar'), 'the toolbar should be injected');
  });

  test('sets the blocking headers', async () => {
    const response = await fetch(via(fixture.origin + '/'));
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /img-src 'none'/);
    assert.match(csp, /media-src 'none'/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  test('rewrites links back through the proxy', async () => {
    const html = await (await fetch(via(fixture.origin + '/'))).text();
    assert.ok(html.includes(`u=${encodeURIComponent(fixture.origin + '/page')}`), 'relative link rewritten');
    // The fixture is served over http, so // resolves to http, not https.
    assert.ok(html.includes('u=http%3A%2F%2Fexample.net%2Fother'), 'protocol-relative link rewritten');
    assert.ok(html.includes('href="#top"'), 'fragment untouched');
    assert.ok(html.includes('mailto:a@b.c'), 'mailto untouched');
  });

  test('blocks an image response', async () => {
    const response = await fetch(via(fixture.url('/image.png').toString()));
    assert.equal(response.status, 403);
    assert.match(await response.text(), /Blocked: media/);
  });

  test('blocks a video response', async () => {
    assert.equal((await fetch(via(fixture.url('/clip.mp4').toString()))).status, 403);
  });

  test('blocks an attachment download', async () => {
    const response = await fetch(via(fixture.url('/download').toString()));
    assert.equal(response.status, 403);
    assert.match(await response.text(), /Blocked: download/);
  });

  test('hands redirects back to the browser, still proxied', async () => {
    const response = await fetch(via(fixture.url('/redirect').toString()), { redirect: 'manual' });
    assert.equal(response.status, 303);
    const location = response.headers.get('location');
    assert.ok(location.startsWith('/p?u='), `expected a proxied location, got ${location}`);
  });

  test('rewrites CSS so fonts survive but images still route through the proxy', async () => {
    const css = await (await fetch(via(fixture.url('/style.css').toString()))).text();
    assert.ok(css.includes('u=' + encodeURIComponent(fixture.origin + '/f.woff2')), 'font rewritten');
    assert.ok(css.includes('u=' + encodeURIComponent(fixture.origin + '/base.css')), '@import rewritten');
    assert.ok(css.includes('u=' + encodeURIComponent(fixture.origin + '/hero.jpg')), 'background rewritten');
  });

  test('never forwards an origin Set-Cookie to the browser', async () => {
    const response = await fetch(via(fixture.url('/setcookie').toString()));
    const forwarded = response.headers.getSetCookie?.() ?? [];
    assert.ok(!forwarded.some((c) => c.startsWith('sid=')), 'origin cookies must stay server-side');
  });

  test('decodes a non-UTF-8 page correctly', async () => {
    const html = await (await fetch(via(fixture.url('/latin1').toString()))).text();
    assert.ok(html.includes('café naïve'), `expected decoded text, got: ${html.match(/<p>.*?<\/p>/)?.[0]}`);
  });

  test('sends an iOS Safari user agent and does not leak the proxy host', async () => {
    const body = await (await fetch(via(fixture.url('/echo').toString()))).json();
    assert.match(body.headers['user-agent'], /iPhone/);
    assert.ok(!body.headers.referer?.includes(base), 'the proxy host must not leak in Referer');
    assert.ok(body.headers.referer?.includes(fixture.origin), 'Referer should be the target origin');
  });

  test('an unknown path renders a 404 page', async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });

  test('a bare /p with no target redirects home', async () => {
    const response = await fetch(`${base}/p`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/');
  });
});

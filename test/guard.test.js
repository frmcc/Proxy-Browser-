import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BlockedError, assertSafeUrl, escapeHtml, isPrivateAddress, normalizeInput } from '../lib/guard.js';

describe('normalizeInput', () => {
  test('passes through anything that already has a scheme', () => {
    assert.equal(normalizeInput('https://example.com/a?b=c'), 'https://example.com/a?b=c');
    assert.equal(normalizeInput('http://example.com'), 'http://example.com');
  });

  test('prepends https to a bare host', () => {
    assert.equal(normalizeInput('example.com'), 'https://example.com');
    assert.equal(normalizeInput('en.wikipedia.org/wiki/Cat'), 'https://en.wikipedia.org/wiki/Cat');
    assert.equal(normalizeInput('example.com:8080/x'), 'https://example.com:8080/x');
  });

  test('treats anything else as a search', () => {
    assert.equal(normalizeInput('how tall is everest'), 'https://html.duckduckgo.com/html/?q=how%20tall%20is%20everest');
    assert.equal(normalizeInput('cats'), 'https://html.duckduckgo.com/html/?q=cats');
  });

  test('returns null for empty input', () => {
    assert.equal(normalizeInput(''), null);
    assert.equal(normalizeInput('   '), null);
    assert.equal(normalizeInput(undefined), null);
  });
});

describe('isPrivateAddress', () => {
  const privateV4 = [
    '0.0.0.0', '10.0.0.1', '10.255.255.255', '127.0.0.1', '127.1.2.3',
    '100.64.0.1', '100.127.255.255', '169.254.169.254', '172.16.0.1',
    '172.31.255.255', '192.0.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
  ];
  for (const address of privateV4) {
    test(`blocks IPv4 ${address}`, () => assert.equal(isPrivateAddress(address), true));
  }

  const publicV4 = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.63.255.255', '11.0.0.1'];
  for (const address of publicV4) {
    test(`allows IPv4 ${address}`, () => assert.equal(isPrivateAddress(address), false));
  }

  const privateV6 = ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'];
  for (const address of privateV6) {
    test(`blocks IPv6 ${address}`, () => assert.equal(isPrivateAddress(address), true));
  }

  test('allows a public IPv6 address', () => {
    assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
  });

  test('an IPv4-mapped public address is still allowed', () => {
    assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
  });

  test('refuses anything that is not an IP literal', () => {
    assert.equal(isPrivateAddress('example.com'), true);
    assert.equal(isPrivateAddress('not-an-ip'), true);
  });
});

describe('assertSafeUrl', () => {
  const rejected = [
    ['file:///etc/passwd', 'non-http scheme'],
    ['ftp://example.com/x', 'non-http scheme'],
    ['http://localhost/', 'the literal localhost'],
    ['http://LOCALHOST/', 'localhost regardless of case'],
    ['http://foo.localhost/', 'a .localhost subdomain'],
    ['http://printer.local/', 'a .local name'],
    ['http://metadata.google.internal/', 'the GCP metadata name'],
    ['http://127.0.0.1/', 'loopback'],
    ['http://127.0.0.1:3000/admin', 'loopback on another port'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://192.168.1.1/', 'a private LAN address'],
    ['http://10.0.0.5/', 'a private LAN address'],
    ['http://[::ffff:127.0.0.1]/', 'an IPv4-mapped loopback'],
  ];

  for (const [url, why] of rejected) {
    test(`rejects ${url} (${why})`, async () => {
      await assert.rejects(() => assertSafeUrl(url), (error) => {
        assert.ok(error instanceof BlockedError, 'should be a BlockedError');
        assert.ok(error.status >= 400 && error.status < 500, `status ${error.status} should be 4xx`);
        return true;
      });
    });
  }

  test('rejects a malformed URL', async () => {
    await assert.rejects(() => assertSafeUrl('not a url'), BlockedError);
  });

  test('allows a public IP literal and returns a URL', async () => {
    const result = await assertSafeUrl('http://8.8.8.8/x');
    assert.ok(result instanceof URL);
    assert.equal(result.hostname, '8.8.8.8');
  });
});

describe('escapeHtml', () => {
  test('escapes the characters that break out of markup', () => {
    assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
    assert.equal(escapeHtml('a"b'), 'a&quot;b');
    assert.equal(escapeHtml("a'b"), 'a&#39;b');
    assert.equal(escapeHtml('a&b'), 'a&amp;b');
  });

  test('handles nullish input', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });
});

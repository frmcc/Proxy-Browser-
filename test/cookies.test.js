import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { cookieHeaderFor, store, sweep } from '../lib/cookies.js';

let counter = 0;
const newSession = () => `test-session-${++counter}`;

describe('cookie jar', () => {
  test('returns a stored cookie for the same host', () => {
    const sid = newSession();
    store(sid, new URL('https://example.com/'), ['sid=abc; Path=/']);
    assert.equal(cookieHeaderFor(sid, new URL('https://example.com/page')), 'sid=abc');
  });

  test('does not leak a cookie to an unrelated host', () => {
    const sid = newSession();
    store(sid, new URL('https://example.com/'), ['sid=abc; Path=/']);
    assert.equal(cookieHeaderFor(sid, new URL('https://evil.test/')), null);
  });

  test('sessions are isolated from each other', () => {
    const alice = newSession();
    const bob = newSession();
    store(alice, new URL('https://example.com/'), ['session=alice-secret; Path=/']);

    // The previous implementation kept one global jar keyed by domain, so Bob
    // would have been handed Alice's session here.
    assert.equal(cookieHeaderFor(bob, new URL('https://example.com/')), null);
    assert.equal(cookieHeaderFor(alice, new URL('https://example.com/')), 'session=alice-secret');
  });

  test('a Domain attribute lets a parent domain cookie reach a subdomain', () => {
    const sid = newSession();
    store(sid, new URL('https://example.com/'), ['a=1; Domain=example.com; Path=/']);
    assert.equal(cookieHeaderFor(sid, new URL('https://api.example.com/')), 'a=1');
  });

  test('without a Domain attribute the cookie is host-only', () => {
    const sid = newSession();
    store(sid, new URL('https://example.com/'), ['a=1; Path=/']);
    assert.equal(cookieHeaderFor(sid, new URL('https://api.example.com/')), null);
  });

  test('a cookie cannot scope itself to an unrelated domain', () => {
    const sid = newSession();
    store(sid, new URL('https://evil.test/'), ['a=1; Domain=example.com; Path=/']);
    assert.equal(cookieHeaderFor(sid, new URL('https://example.com/')), null);
  });

  test('path scoping is respected', () => {
    const sid = newSession();
    store(sid, new URL('https://example.com/'), ['deep=1; Path=/admin']);
    assert.equal(cookieHeaderFor(sid, new URL('https://example.com/admin/users')), 'deep=1');
    assert.equal(cookieHeaderFor(sid, new URL('https://example.com/public')), null);
  });

  test('a path prefix only matches on a boundary', () => {
    const sid = newSession();
    store(sid, new URL('https://example.com/'), ['p=1; Path=/admin']);
    assert.equal(cookieHeaderFor(sid, new URL('https://example.com/administrator')), null);
  });

  test('Secure cookies are withheld from an http target', () => {
    const sid = newSession();
    store(sid, new URL('https://example.com/'), ['s=1; Path=/; Secure']);
    assert.equal(cookieHeaderFor(sid, new URL('http://example.com/')), null);
    assert.equal(cookieHeaderFor(sid, new URL('https://example.com/')), 's=1');
  });

  test('Max-Age=0 deletes the cookie', () => {
    const sid = newSession();
    store(sid, new URL('https://example.com/'), ['gone=1; Path=/']);
    store(sid, new URL('https://example.com/'), ['gone=1; Path=/; Max-Age=0']);
    assert.equal(cookieHeaderFor(sid, new URL('https://example.com/')), null);
  });

  test('a past Expires deletes the cookie', () => {
    const sid = newSession();
    store(sid, new URL('https://example.com/'), ['gone=1; Path=/']);
    store(sid, new URL('https://example.com/'), ['gone=1; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
    assert.equal(cookieHeaderFor(sid, new URL('https://example.com/')), null);
  });

  test('a later value replaces an earlier one', () => {
    const sid = newSession();
    store(sid, new URL('https://example.com/'), ['v=first; Path=/']);
    store(sid, new URL('https://example.com/'), ['v=second; Path=/']);
    assert.equal(cookieHeaderFor(sid, new URL('https://example.com/')), 'v=second');
  });

  test('multiple cookies are joined, longest path first', () => {
    const sid = newSession();
    store(sid, new URL('https://example.com/admin/'), ['deep=2; Path=/admin']);
    store(sid, new URL('https://example.com/'), ['shallow=1; Path=/']);
    assert.equal(cookieHeaderFor(sid, new URL('https://example.com/admin/x')), 'deep=2; shallow=1');
  });

  test('an unknown session has no cookies', () => {
    assert.equal(cookieHeaderFor('never-seen', new URL('https://example.com/')), null);
  });

  test('sweep drops expired cookies', () => {
    const sid = newSession();
    store(sid, new URL('https://example.com/'), [`t=1; Path=/; Max-Age=1`]);
    sweep(Date.now() + 5000);
    assert.equal(cookieHeaderFor(sid, new URL('https://example.com/')), null);
  });

  test('malformed Set-Cookie values are ignored rather than throwing', () => {
    const sid = newSession();
    assert.doesNotThrow(() => store(sid, new URL('https://example.com/'), ['', '=noname', 'novalue']));
    assert.equal(cookieHeaderFor(sid, new URL('https://example.com/')), null);
  });
});

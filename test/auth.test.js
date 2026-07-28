import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'correct-horse-battery-staple';

let proxy;
let base;

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startProxy(port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ACCESS_PASSWORD: PASSWORD, SESSION_SECRET: 'test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy did not start')), 10_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('error', reject);
  });
}

const submit = (password) =>
  fetch(`${base}/__auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }).toString(),
    redirect: 'manual',
  });

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proxy = await startProxy(port);
});

after(() => proxy?.kill());

describe('access gate', () => {
  test('locks the app when ACCESS_PASSWORD is set', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 401);
    assert.match(await response.text(), /Locked/);
  });

  test('locks the proxy route too, not just the landing page', async () => {
    const response = await fetch(`${base}/p?u=https%3A%2F%2Fexample.com`, { redirect: 'manual' });
    assert.equal(response.status, 401);
  });

  test('healthz stays reachable so platform probes still work', async () => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });

  test('rejects a wrong password', async () => {
    const response = await submit('nope');
    assert.equal(response.status, 401);
  });

  test('throttles repeated guesses', async () => {
    // Burn through the allowance; the next guess must be refused outright.
    let sawThrottle = false;
    for (let i = 0; i < 10; i += 1) {
      const response = await submit(`guess-${i}`);
      if (response.status === 429) {
        sawThrottle = true;
        assert.ok(response.headers.get('retry-after'), 'should say how long to wait');
        break;
      }
    }
    assert.ok(sawThrottle, 'brute forcing should hit a lockout');
  });

  test('a correct password is still refused while locked out', async () => {
    // Proves the throttle gates on the attempt, not on the outcome — otherwise
    // an attacker could keep guessing for free until they happened to be right.
    const response = await submit(PASSWORD);
    assert.equal(response.status, 429);
  });

  test('accepts the password once the lockout expires and sets a session cookie', async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const response = await submit(PASSWORD);
    assert.equal(response.status, 302);
    const cookies = response.headers.getSetCookie?.() ?? [];
    const auth = cookies.find((c) => c.startsWith('mfb_auth='));
    assert.ok(auth, 'should set an auth cookie');
    assert.match(auth, /HttpOnly/);
    assert.match(auth, /SameSite=Lax/);
    assert.ok(!auth.includes(PASSWORD), 'the cookie must not contain the password itself');
  });
});

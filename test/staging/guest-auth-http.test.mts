import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGuestAuthHttpHandler } from '../../src/staging/guest-auth-http.mts';

test('guest auth HTTP contract: HTTPS, no client player identity, refresh and logout', async () => {
  const calls: string[] = [];
  const handler = createGuestAuthHttpHandler({
    async create() { calls.push('create'); return { accessToken: 'a', refreshToken: 'r', expiresAt: '2027-01-01T00:00:00Z' }; },
    async refresh(token) { calls.push('refresh:' + token); return { accessToken: 'b', refreshToken: 's', expiresAt: '2027-01-01T00:00:00Z' }; },
    async logout(token) { calls.push('logout:' + token); },
  });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const url = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body: object, secure = true) =>
      fetch(url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(secure ? { 'x-forwarded-proto': 'https' } : {}) },
        body: JSON.stringify(body),
      });
    assert.equal((await post('/v1/auth/guest', {}, false)).status, 403);
    assert.equal((await post('/v1/auth/guest', { playerId: 'attacker' })).status, 400);
    assert.equal((await post('/v1/auth/guest', {})).status, 201);
    assert.equal((await post('/v1/auth/refresh', { refreshToken: 'r' })).status, 200);
    assert.equal((await post('/v1/auth/logout', { refreshToken: 's' })).status, 200);
    assert.deepEqual(calls, ['create', 'refresh:r', 'logout:s']);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

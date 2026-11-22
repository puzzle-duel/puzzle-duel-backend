import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGuestAuthHttpHandler, guestRefreshDiagnosticReason } from '../../src/staging/guest-auth-http.mts';
import { GuestCredentialError } from '../../src/staging/guest-auth-service.mts';

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

for (const code of ['INVALID_REFRESH', 'REFRESH_REPLAY', 'REFRESH_EXPIRED'] as const) {
  test(`guest refresh ${code} exposes only fixed diagnostic header`, async () => {
    const handler = createGuestAuthHttpHandler({
      async create() { throw new Error('unexpected create'); },
      async refresh() { throw new GuestCredentialError(code); },
      async logout() { throw new GuestCredentialError(code); },
    });
    const observedReasons: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      res.once('finish', () => observedReasons.push(guestRefreshDiagnosticReason(res)));
      void handler(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const request = (path: string) => fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
        body: JSON.stringify({ refreshToken: 'secret-not-for-logs' }),
      });
      const refresh = await request('/v1/auth/refresh');
      assert.equal(refresh.status, 401);
      assert.equal(refresh.headers.get('x-pzd-error-code'), null);
      assert.deepEqual(await refresh.json(), { error: code });
      const logout = await request('/v1/auth/logout');
      assert.equal(logout.status, 401);
      assert.equal(logout.headers.get('x-pzd-error-code'), null);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}

for (const [reason, code] of [
  ['TOKEN_FORMAT_INVALID', 'INVALID_REFRESH'],
  ['TOKEN_NOT_FOUND', 'INVALID_REFRESH'],
  ['FAMILY_REVOKED', 'INVALID_REFRESH'],
  ['FAMILY_MISSING', 'INVALID_REFRESH'],
] as const) {
  test(`guest refresh diagnostic ${reason} retains generic API response`, async () => {
    const handler = createGuestAuthHttpHandler({
      async create() { throw new Error('unexpected'); },
      async refresh() { throw new GuestCredentialError(code, reason); },
      async logout() { throw new GuestCredentialError(code, reason); },
    });
    const observedReasons: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      res.once('finish', () => observedReasons.push(guestRefreshDiagnosticReason(res)));
      void handler(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const post = (path: string) => fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
        body: JSON.stringify({ refreshToken: 'not-a-secret' }),
      });
      const refresh = await post('/v1/auth/refresh');
      assert.equal(refresh.status, 401);
      assert.equal(refresh.headers.get('x-pzd-error-code'), null);
      assert.deepEqual(await refresh.json(), { error: 'INVALID_REFRESH' });
      assert.equal(observedReasons[0], reason);
      const logout = await post('/v1/auth/logout');
      assert.equal(logout.headers.get('x-pzd-error-code'), null);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}

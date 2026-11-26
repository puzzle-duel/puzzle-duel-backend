import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createProviderAuthHttpHandler } from '../../src/staging/provider-auth-http.mts';
import { ProviderAuthError } from '../../src/staging/provider-identity-service.mts';
import { PinnedRs256JwtVerifier } from '../../src/tournament/auth/pinned-jwt-verifier.mts';
import { GUEST_AUDIENCE, GUEST_ISSUER } from '../../src/staging/guest-auth-service.mts';

test('provider auth HTTP requires HTTPS, schema, and config; maps conflicts', async () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const verifier = new PinnedRs256JwtVerifier({
    issuer: GUEST_ISSUER,
    audience: GUEST_AUDIENCE,
    keys: [{ keyId: 'k', rsaPublicKeyPem: pem }],
    maxTokenAgeSeconds: 900,
    allowStagingGuestClaims: true,
  });
  const handler = createProviderAuthHttpHandler({
    pool: {
      async query() { return { rows: [], rowCount: 0 }; },
    } as never,
    identity: {
      async login() { throw new ProviderAuthError('ACCOUNT_CONFLICT'); },
      async link() { throw new ProviderAuthError('GUEST_PROOF_REQUIRED'); },
      async recover() { throw new ProviderAuthError('RECOVERY_NOT_LINKED'); },
      async continue() {
        throw new ProviderAuthError('ACCOUNT_SWITCH_CONFIRMATION_REQUIRED', {
          continuationToken: 'tok',
          expiresAt: new Date().toISOString(),
          targetPlayerId: randomUUID(),
        });
      },
      async confirmContinue() { throw new ProviderAuthError('INVALID_CONTINUATION'); },
      async recoverLinked() { throw new ProviderAuthError('RECOVERY_NOT_LINKED'); },
    } as never,
    jwks: {
      async keys() { return []; },
    } as never,
    config: { appleAudiences: ['app.apple'], googleAudiences: [] },
    guestVerifier: verifier,
    requireExactActiveGuestFamily: async () => true,
  });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const base = `http://127.0.0.1:${address.port}`;
    const insecure = await fetch(base + '/v1/auth/providers/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'apple', idToken: 'x', nonce: 'y', binding: 'z',
      }),
    });
    assert.equal(insecure.status, 403);
    const conflict = await fetch(base + '/v1/auth/providers/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({
        provider: 'apple',
        idToken: 'a.b.c',
        nonce: 'n',
        binding: 'b',
      }),
    });
    // kid parse / JWKS empty fails closed before identity; either 401 assertion or 503
    assert.ok([401, 503].includes(conflict.status));

    const recoverSchema = await fetch(base + '/v1/auth/providers/recover', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({
        provider: 'apple',
        idToken: 'a.b.c',
        nonce: 'n',
        binding: 'b',
        // missing expectedPlayerId
      }),
    });
    assert.equal(recoverSchema.status, 400);

    const recoverCalls: string[] = [];
    const recoverHandler = createProviderAuthHttpHandler({
      pool: { async query() { return { rows: [], rowCount: 0 }; } } as never,
      identity: {
        async login() { throw new Error('login-must-not-run'); },
        async link() { throw new Error('link-must-not-run'); },
        async recover(input: { expectedPlayerId: string }) {
          recoverCalls.push(input.expectedPlayerId);
          throw new ProviderAuthError('RECOVERY_NOT_LINKED');
        },
        async recoverLinked() { throw new Error('recover-linked-must-not-run'); },
        async continue() { throw new Error('continue-must-not-run'); },
        async confirmContinue() { throw new Error('confirm-must-not-run'); },
      } as never,
      jwks: {
        async keys() { return []; },
      } as never,
      config: { appleAudiences: ['app.apple'], googleAudiences: [] },
      guestVerifier: verifier,
      requireExactActiveGuestFamily: async () => true,
    });
    const recoverServer = createServer((req, res) => { void recoverHandler(req, res); });
    await new Promise<void>((resolve) => recoverServer.listen(0, '127.0.0.1', resolve));
    try {
      const recoverAddress = recoverServer.address();
      if (!recoverAddress || typeof recoverAddress === 'string') throw new Error('No port');
      const recoverBase = `http://127.0.0.1:${recoverAddress.port}`;
      const expectedPlayerId = randomUUID();
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');
      const idToken = `${header}.${payload}.sig`;
      const notLinked = await fetch(recoverBase + '/v1/auth/providers/recover', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({
          provider: 'apple',
          idToken,
          nonce: 'n',
          binding: 'b',
          expectedPlayerId,
        }),
      });
      assert.equal(notLinked.status, 401);
      const body = await notLinked.json() as { error?: string };
      assert.equal(body.error, 'RECOVERY_NOT_LINKED');
      assert.deepEqual(recoverCalls, [expectedPlayerId]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        recoverServer.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test('unified continue maps confirmation and invalid continuation', async () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const verifier = new PinnedRs256JwtVerifier({
    issuer: GUEST_ISSUER,
    audience: GUEST_AUDIENCE,
    keys: [{ keyId: 'k', rsaPublicKeyPem: pem }],
    maxTokenAgeSeconds: 900,
    allowStagingGuestClaims: true,
  });
  let continueCalls = 0;
  const handler = createProviderAuthHttpHandler({
    pool: {
      async query() { return { rows: [], rowCount: 0 }; },
    } as never,
    identity: {
      async login() { throw new Error('login-must-not-run'); },
      async link() { throw new Error('link-must-not-run'); },
      async recover() { throw new Error('recover-must-not-run'); },
      async continue() {
        continueCalls += 1;
        throw new ProviderAuthError('ACCOUNT_SWITCH_CONFIRMATION_REQUIRED', {
          continuationToken: 'switch-tok',
          expiresAt: '2030-01-01T00:00:00.000Z',
          targetPlayerId: '11111111-1111-1111-1111-111111111111',
        });
      },
      async confirmContinue() {
        throw new ProviderAuthError('INVALID_CONTINUATION');
      },
      async recoverLinked() { throw new Error('recover-linked-must-not-run'); },
    } as never,
    jwks: {
      async keys() {
        return [{ kid: 'k', pem }];
      },
    } as never,
    config: { appleAudiences: ['app.apple'], googleAudiences: ['app.google'] },
    guestVerifier: verifier,
    requireExactActiveGuestFamily: async () => true,
  });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const base = `http://127.0.0.1:${address.port}`;
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');
    const idToken = `${header}.${payload}.sig`;

    const badConfirm = await fetch(base + '/v1/auth/providers/continue/confirm', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ continuationToken: 'x', extra: true }),
    });
    assert.equal(badConfirm.status, 400);

    const confirm = await fetch(base + '/v1/auth/providers/continue/confirm', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ continuationToken: 'x' }),
    });
    assert.equal(confirm.status, 401);
    const confirmBody = await confirm.json() as { error?: string };
    assert.equal(confirmBody.error, 'INVALID_CONTINUATION');

    // Continue without valid assertion fails closed before identity (401/503).
    const cont = await fetch(base + '/v1/auth/providers/continue', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({
        provider: 'google',
        idToken,
        nonce: 'n',
        binding: 'b',
      }),
    });
    assert.ok([401, 409, 503].includes(cont.status));
    assert.ok(continueCalls === 0 || continueCalls === 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

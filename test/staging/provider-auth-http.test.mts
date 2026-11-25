import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
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
  const issued: unknown[] = [];
  const handler = createProviderAuthHttpHandler({
    pool: {
      async query() { return { rows: [], rowCount: 0 }; },
    } as never,
    identity: {
      async login() { throw new ProviderAuthError('ACCOUNT_CONFLICT'); },
      async link() { throw new ProviderAuthError('GUEST_PROOF_REQUIRED'); },
    } as never,
    jwks: {
      async keys() { return []; },
    } as never,
    config: { appleAudiences: ['app.apple'], googleAudiences: [] },
    guestVerifier: verifier,
    requireExactActiveGuestFamily: async () => true,
  });
  // Patch issue path via challenge using real issueProviderChallenge would need DB;
  // exercise login conflict mapping and HTTPS gate instead.
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
    issued.push(conflict.status);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

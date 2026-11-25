import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  providerNonceMatches,
  verifyProviderAssertion,
  ProviderAssertionError,
  type ProviderKey,
} from '../../src/staging/provider-token-verifier.mts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const key: ProviderKey = { kid: 'test', kty: 'RSA', n: jwk.n!, e: jwk.e! };
const now = 1700000000;
const rawNonce = 'challenge-raw-value';
const appleNonce = createHash('sha256').update(rawNonce, 'utf8').digest('hex');
const claims = {
  iss: 'https://appleid.apple.com',
  aud: 'test-app',
  sub: 'subject',
  iat: now - 10,
  exp: now + 300,
  nonce: appleNonce,
};
function token(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const encode = (x: object) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const msg = encode({ alg: 'RS256', kid: 'test', ...header }) + '.' + encode({ ...claims, ...overrides });
  return msg + '.' + sign('RSA-SHA256', Buffer.from(msg), privateKey).toString('base64url');
}
const input = {
  provider: 'apple' as const,
  audiences: ['test-app'],
  keys: [key],
  expectedNonce: rawNonce,
  nowSeconds: now,
};

test('valid Apple assertion with hashed nonce', () =>
  assert.deepEqual(verifyProviderAssertion({ ...input, token: token() }), {
    provider: 'apple',
    subject: 'subject',
  }));

test('valid Apple assertion with base64url hashed nonce', () => {
  const hashed = createHash('sha256').update(rawNonce, 'utf8').digest('base64url');
  assert.deepEqual(
    verifyProviderAssertion({ ...input, token: token({ nonce: hashed }) }),
    { provider: 'apple', subject: 'subject' },
  );
});

test('valid Google assertion with raw nonce', () =>
  assert.deepEqual(
    verifyProviderAssertion({
      ...input,
      provider: 'google',
      token: token({ iss: 'https://accounts.google.com', nonce: rawNonce }),
    }),
    { provider: 'google', subject: 'subject' },
  ));

test('valid Google assertion with hashed nonce', () =>
  assert.deepEqual(
    verifyProviderAssertion({
      ...input,
      provider: 'google',
      token: token({ iss: 'https://accounts.google.com', nonce: appleNonce }),
    }),
    { provider: 'google', subject: 'subject' },
  ));

test('accept Google audience array containing configured client', () =>
  assert.deepEqual(
    verifyProviderAssertion({
      ...input,
      provider: 'google',
      token: token({
        iss: 'https://accounts.google.com',
        aud: ['other-client', 'test-app'],
        nonce: rawNonce,
      }),
    }),
    { provider: 'google', subject: 'subject' },
  ));

for (const [name, overrides] of Object.entries({
  issuer: { iss: 'https://example.invalid' },
  audience: { aud: 'wrong' },
  expired: { exp: now },
  future: { iat: now + 100 },
  nonce: { nonce: 'wrong' },
  subject: { sub: '' },
  azp: { azp: 'wrong' },
  appleRawNonce: { nonce: rawNonce },
})) {
  test('reject ' + name, () =>
    assert.throws(
      () => verifyProviderAssertion({ ...input, token: token(overrides) }),
      ProviderAssertionError,
    ));
}

test('reject untrusted header', () =>
  assert.throws(
    () => verifyProviderAssertion({
      ...input,
      token: token({}, { jku: 'https://example.invalid' }),
    }),
    ProviderAssertionError,
  ));

test('reject wrong signature', () => {
  const parts = token().split('.');
  parts[2] = Buffer.alloc(256).toString('base64url');
  assert.throws(
    () => verifyProviderAssertion({ ...input, token: parts.join('.') }),
    ProviderAssertionError,
  );
});

test('reject missing expected nonce', () =>
  assert.throws(
    () => verifyProviderAssertion({ ...input, expectedNonce: undefined, token: token() }),
    ProviderAssertionError,
  ));

test('providerNonceMatches distinguishes Apple hash vs Google raw', () => {
  assert.equal(providerNonceMatches('apple', rawNonce, appleNonce), true);
  assert.equal(providerNonceMatches('apple', rawNonce, rawNonce), false);
  assert.equal(providerNonceMatches('google', rawNonce, rawNonce), true);
  assert.equal(providerNonceMatches('google', rawNonce, appleNonce), true);
});

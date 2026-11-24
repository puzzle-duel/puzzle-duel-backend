import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyProviderAssertion, ProviderAssertionError, type ProviderKey } from '../../src/staging/provider-token-verifier.mts';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const key: ProviderKey = { kid: 'test', kty: 'RSA', n: jwk.n!, e: jwk.e! };
const now = 1700000000;
const claims = { iss: 'https://appleid.apple.com', aud: 'test-app', sub: 'subject', iat: now - 10, exp: now + 300, nonce: 'challenge' };
function token(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const encode = (x: object) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const msg = encode({ alg: 'RS256', kid: 'test', ...header }) + '.' + encode({ ...claims, ...overrides });
  return msg + '.' + sign('RSA-SHA256', Buffer.from(msg), privateKey).toString('base64url');
}
const input = { provider: 'apple' as const, audiences: ['test-app'], keys: [key], expectedNonce: 'challenge', nowSeconds: now };
test('valid Apple assertion', () => assert.deepEqual(verifyProviderAssertion({ ...input, token: token() }), { provider: 'apple', subject: 'subject' }));
test('valid Google assertion', () => assert.deepEqual(verifyProviderAssertion({ ...input, provider: 'google', token: token({ iss: 'https://accounts.google.com' }) }), { provider: 'google', subject: 'subject' }));
for (const [name, overrides] of Object.entries({
  issuer: { iss: 'https://example.invalid' }, audience: { aud: 'wrong' }, expired: { exp: now },
  future: { iat: now + 100 }, nonce: { nonce: 'wrong' }, subject: { sub: '' }, azp: { azp: 'wrong' },
})) test('reject ' + name, () => assert.throws(() => verifyProviderAssertion({ ...input, token: token(overrides) }), ProviderAssertionError));
test('reject untrusted header', () => assert.throws(() => verifyProviderAssertion({ ...input, token: token({}, { jku: 'https://example.invalid' }) }), ProviderAssertionError));
test('reject wrong signature', () => {
  const parts = token().split('.');
  parts[2] = Buffer.alloc(256).toString('base64url');
  assert.throws(() => verifyProviderAssertion({ ...input, token: parts.join('.') }), ProviderAssertionError);
});
test('reject missing Apple nonce', () => assert.throws(() => verifyProviderAssertion({ ...input, expectedNonce: undefined, token: token() }), ProviderAssertionError));

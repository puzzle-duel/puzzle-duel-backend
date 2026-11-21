import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { PinnedRs256JwtVerifier, JwtVerificationError } from '../../src/tournament/auth/pinned-jwt-verifier.mts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://staging.puzzle-duel.app';
const audience = 'puzzle-duel-api';
const now = 1900000000;
function token(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'staging-test', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, sub: 'stable-player-id', iat: now, exp: now + 900, ...claims })).toString('base64url');
  const message = header + '.' + body;
  return 'Bearer ' + message + '.' + sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64url');
}
const base = { issuer, audience, keys: [{ keyId: 'staging-test', rsaPublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }], maxTokenAgeSeconds: 900 };
test('existing verifier rejects guest by default', () => {
  assert.throws(() => new PinnedRs256JwtVerifier(base).verifyAuthorizationHeader(token({ account_type: 'guest' }), now), JwtVerificationError);
});
test('explicit staging verifier accepts signed guest with stable subject', () => {
  const verifier = new PinnedRs256JwtVerifier({ ...base, allowStagingGuestClaims: true });
  assert.equal(verifier.verifyAuthorizationHeader(token({ account_type: 'guest' }), now).subject, 'stable-player-id');
  assert.throws(() => verifier.verifyAuthorizationHeader(token({ account_type: 'registered' }), now), JwtVerificationError);
  assert.throws(() => verifier.verifyAuthorizationHeader(token({ account_type: 'guest', aud: 'wrong' }), now), JwtVerificationError);
});
test('guest opt-in rejects non-staging issuers and audiences', () => {
  assert.throws(() => new PinnedRs256JwtVerifier({ ...base, issuer: 'https://other.example', allowStagingGuestClaims: true }), JwtVerificationError);
  assert.throws(() => new PinnedRs256JwtVerifier({ ...base, audience: 'other', allowStagingGuestClaims: true }), JwtVerificationError);
});

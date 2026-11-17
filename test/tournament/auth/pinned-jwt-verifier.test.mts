import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { JwtVerificationError, PinnedRs256JwtVerifier } from '../../../src/tournament/auth/pinned-jwt-verifier.mts';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: attackerKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = 1900000000;
const config = {
  issuer: 'https://issuer.example.test',
  audience: 'puzzle-duel-api',
  rsaPublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  keyId: 'trusted-key-1',
  maxTokenAgeSeconds: 1800,
};
const verifier = new PinnedRs256JwtVerifier(config);
const payload = { iss: config.issuer, aud: config.audience, sub: 'provider-subject', iat: now - 30, exp: now + 300 };
function jwt(
  claims: Record<string, unknown> = payload,
  header: Record<string, unknown> = { alg: 'RS256', kid: config.keyId, typ: 'JWT' },
  signingKey = privateKey,
): string {
  const body = [Buffer.from(JSON.stringify(header)).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
  return body + '.' + sign('RSA-SHA256', Buffer.from(body), signingKey).toString('base64url');
}
function accepts(token: string) { return verifier.verifyAuthorizationHeader('Bearer ' + token, now); }
function rejects(token: string) { assert.throws(() => accepts(token), JwtVerificationError); }

describe('PZD-40 cryptographically verified JWT, fail-closed', () => {
  it('accepts valid signed RS256 issuer/audience/subject and does not mint playerId', () => {
    assert.deepEqual(accepts(jwt()), { issuer: config.issuer, subject: 'provider-subject', issuedAt: now - 30, expiresAt: now + 300, keyId: config.keyId });
  });
  it('rejects no bearer, malformed input, or missing configuration', () => {
    assert.throws(() => verifier.verifyAuthorizationHeader(undefined, now), JwtVerificationError);
    assert.throws(() => verifier.verifyAuthorizationHeader('Basic abc', now), JwtVerificationError);
    assert.throws(() => new PinnedRs256JwtVerifier({ ...config, rsaPublicKeyPem: '' }), JwtVerificationError);
  });
  it('rejects unsigned alg=none, HS256, embedded JWK/JKU and wrong kid', () => {
    for (const h of [{ alg: 'none', kid: config.keyId }, { alg: 'HS256', kid: config.keyId }, { alg: 'RS256', kid: 'untrusted' }, { alg: 'RS256', kid: config.keyId, jku: 'https://evil.test' }, { alg: 'RS256', kid: config.keyId, jwk: { kty: 'RSA' } }]) rejects(jwt(payload, h));
  });
  it('rejects attacker signatures and tampering with otherwise valid payload', () => {
    rejects(jwt(payload, undefined, attackerKey));
    const pieces = jwt().split('.');
    const forged = { ...payload, sub: 'another-player' };
    pieces[1] = Buffer.from(JSON.stringify(forged)).toString('base64url');
    rejects(pieces.join('.'));
  });
  it('rejects wrong issuer, audience (including array audience), empty subject', () => {
    for (const claims of [{ ...payload, iss: 'https://evil.test' }, { ...payload, aud: 'different-api' }, { ...payload, aud: [config.audience] }, { ...payload, sub: '' }, { ...payload, sub: '   ' }]) rejects(jwt(claims));
  });
  it('rejects expired, future nbf, future iat, stale and missing exp', () => {
    for (const claims of [{ ...payload, exp: now }, { ...payload, nbf: now + 1 }, { ...payload, iat: now + 1 }, { ...payload, iat: now - 4000 }, { ...payload, exp: undefined }, { ...payload, exp: 1.2 }]) rejects(jwt(claims));
  });
  it('rejects header crit extensions and extra Bearer text', () => {
    rejects(jwt(payload, { alg:'RS256', kid:config.keyId, crit:['exp'] }));
    assert.throws(() => verifier.verifyAuthorizationHeader('Bearer ' + jwt() + ' trailing', now), JwtVerificationError);
  });
});

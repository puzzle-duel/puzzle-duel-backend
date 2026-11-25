import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

export type Provider = 'apple' | 'google';
export interface ProviderIdentity { provider: Provider; subject: string }
export interface ProviderKey { kid: string; kty: string; n: string; e: string; alg?: string; use?: string }
export class ProviderAssertionError extends Error {
  constructor() { super('INVALID_PROVIDER_ASSERTION'); }
}
const issuers: Record<Provider, readonly string[]> = {
  apple: ['https://appleid.apple.com'],
  google: ['https://accounts.google.com', 'accounts.google.com'],
};
function reject(): never { throw new ProviderAssertionError(); }
function object(segment: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) reject();
  const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
  return value as Record<string, unknown>;
}
function equalUtf8(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
/** Apple puts SHA-256(nonce) in the claim (hex or base64url). Google native
 * SDKs may emit the raw nonce or a SHA-256 digest depending on the flow. */
export function providerNonceMatches(
  provider: Provider,
  expectedRaw: string,
  claimNonce: string,
): boolean {
  if (!expectedRaw || !claimNonce || expectedRaw.length > 256 || claimNonce.length > 128) {
    return false;
  }
  const shaHex = createHash('sha256').update(expectedRaw, 'utf8').digest('hex');
  const shaB64 = createHash('sha256').update(expectedRaw, 'utf8').digest('base64url');
  if (provider === 'apple') {
    return equalUtf8(claimNonce, shaHex) || equalUtf8(claimNonce, shaB64);
  }
  return equalUtf8(claimNonce, expectedRaw) ||
    equalUtf8(claimNonce, shaHex) ||
    equalUtf8(claimNonce, shaB64);
}
function audienceAccepted(claimAud: unknown, audiences: readonly string[]): boolean {
  if (typeof claimAud === 'string') return audiences.includes(claimAud);
  if (!Array.isArray(claimAud) || claimAud.length < 1 || claimAud.length > 8) return false;
  return claimAud.every((item) => typeof item === 'string') &&
    claimAud.some((item) => audiences.includes(item as string));
}
/** Pure assertion verification. Caller must supply keys from the fixed provider
 * JWKS endpoint and a server-issued, single-use nonce where required.
 * This primitive does not establish a session or consume a nonce. */
export function verifyProviderAssertion(input: {
  provider: Provider; token: string; audiences: readonly string[];
  keys: readonly ProviderKey[]; expectedNonce?: string; nowSeconds: number;
}): ProviderIdentity {
  try {
    if (!Object.hasOwn(issuers, input.provider) || !input.audiences.length ||
        !Number.isSafeInteger(input.nowSeconds) || input.token.length > 16384) reject();
    const parts = input.token.split('.');
    if (parts.length !== 3) reject();
    const [h, p, s] = parts as [string, string, string];
    const header = object(h);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' ||
        ['jku', 'x5u', 'jwk', 'crit'].some(k => Object.hasOwn(header, k))) reject();
    const matches = input.keys.filter(k => k.kid === header.kid);
    const key = matches[0];
    if (matches.length !== 1 || !key || key.kty !== 'RSA' ||
        (key.alg !== undefined && key.alg !== 'RS256') ||
        (key.use !== undefined && key.use !== 'sig')) reject();
    const publicKey = createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' });
    if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
        !/^[A-Za-z0-9_-]+$/.test(s) ||
        !verify('RSA-SHA256', Buffer.from(h + '.' + p), publicKey, Buffer.from(s, 'base64url'))) reject();
    const claims = object(p);
    if (typeof claims.iss !== 'string' || !issuers[input.provider].includes(claims.iss) ||
        !audienceAccepted(claims.aud, input.audiences) ||
        (claims.azp !== undefined && (typeof claims.azp !== 'string' || !input.audiences.includes(claims.azp))) ||
        typeof claims.sub !== 'string' || !claims.sub.length || claims.sub.length > 255 ||
        typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= input.nowSeconds ||
        typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) || claims.iat > input.nowSeconds + 60 ||
        claims.exp <= claims.iat ||
        (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isSafeInteger(claims.nbf) || claims.nbf > input.nowSeconds))) reject();
    // Apple Sign In always requires a server-issued nonce bound into the assertion.
    // Google login/link in Puzzle Duel also requires the challenge nonce (raw or hashed).
    if (!input.expectedNonce) reject();
    if (typeof claims.nonce !== 'string' ||
        !providerNonceMatches(input.provider, input.expectedNonce, claims.nonce)) reject();
    return { provider: input.provider, subject: claims.sub };
  } catch { return reject(); }
}

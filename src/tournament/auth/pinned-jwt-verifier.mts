/** PZD-40 JWT cryptographic trust boundary — no dynamic issuer, keys or algorithms.
 *
 * This validates a preconfigured signed access JWT. Provider sub is NOT the
 * internal playerId. A separately verified provider-identity mapping, session,
 * device and writer-generation binding are required before ranked admission.
 * No HTTP route is enabled by this module alone.
 */
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';

export interface PinnedJwtIssuerConfig {
  readonly issuer: string;
  readonly audience: string;
  /** Deployment-controlled RSA public key from an already authenticated trust source. */
  readonly rsaPublicKeyPem: string;
  readonly keyId: string;
  readonly maxTokenAgeSeconds: number;
}
export interface VerifiedJwtIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly keyId: string;
}
export class JwtVerificationError extends Error {
  constructor() { super('UNAUTHENTICATED'); this.name = 'JwtVerificationError'; }
}
type Claims = Record<string, unknown>;

function decodeJson(segment: string): Claims {
  if (!/^[A-Za-z0-9_-]{1,8192}$/.test(segment)) throw new JwtVerificationError();
  const bytes = Buffer.from(segment, 'base64url');
  // Canonical encoding check prevents differing representations of a token.
  if (bytes.toString('base64url') !== segment) throw new JwtVerificationError();
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new JwtVerificationError(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JwtVerificationError();
  return value as Claims;
}
function positiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}
export class PinnedRs256JwtVerifier {
  readonly #key: KeyObject;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #kid: string;
  readonly #maxAge: number;

  constructor(config: PinnedJwtIssuerConfig) {
    if (!config.issuer || !/^https:\/\//.test(config.issuer) ||
        !config.audience || !config.keyId ||
        !Number.isSafeInteger(config.maxTokenAgeSeconds) ||
        config.maxTokenAgeSeconds < 1 || config.maxTokenAgeSeconds > 86400) {
      throw new JwtVerificationError();
    }
    try {
      this.#key = createPublicKey(config.rsaPublicKeyPem);
      if (this.#key.asymmetricKeyType !== 'rsa') throw new JwtVerificationError();
    } catch { throw new JwtVerificationError(); }
    this.#issuer = config.issuer;
    this.#audience = config.audience;
    this.#kid = config.keyId;
    this.#maxAge = config.maxTokenAgeSeconds;
  }
  verifyAuthorizationHeader(header: string | undefined, nowSeconds = Math.floor(Date.now() / 1000)): VerifiedJwtIdentity {
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header) ||
        header.length > 12000 || !Number.isSafeInteger(nowSeconds) || nowSeconds < 1) {
      throw new JwtVerificationError();
    }
    const compact = header.slice(7);
    const parts = compact.split('.');
    if (parts.length !== 3) throw new JwtVerificationError();
    const protectedHeader = decodeJson(parts[0]);
    const claims = decodeJson(parts[1]);
    if (protectedHeader.alg !== 'RS256' || protectedHeader.kid !== this.#kid ||
        (protectedHeader.typ !== undefined && protectedHeader.typ !== 'JWT') ||
        protectedHeader.crit !== undefined || protectedHeader.jwk !== undefined ||
        protectedHeader.jku !== undefined || protectedHeader.x5u !== undefined) {
      throw new JwtVerificationError();
    }
    const signature = Buffer.from(parts[2], 'base64url');
    if (signature.toString('base64url') !== parts[2] ||
        !verifySignature('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), this.#key, signature)) {
      throw new JwtVerificationError();
    }
    if (claims.iss !== this.#issuer || claims.aud !== this.#audience ||
        typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 255 ||
        !positiveInt(claims.exp) || !positiveInt(claims.iat) ||
        claims.exp <= nowSeconds || claims.iat > nowSeconds ||
        nowSeconds - claims.iat > this.#maxAge ||
        claims.exp <= claims.iat ||
        (claims.nbf !== undefined && (!positiveInt(claims.nbf) || claims.nbf > nowSeconds)) ||
        typeof claims.sub !== 'string' || /^\s*$/.test(claims.sub)) {
      throw new JwtVerificationError();
    }
    return Object.freeze({
      issuer: this.#issuer,
      subject: claims.sub,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      keyId: this.#kid,
    });
  }
}

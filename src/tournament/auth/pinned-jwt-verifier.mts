/** PZD-40 JWT cryptographic trust boundary — pinned issuers/keys only.
 *
 * Validates a preconfigured signed access JWT. Provider sub is NOT the
 * internal playerId. Guest tokens are rejected. Key rotation uses an
 * explicit deployment-pinned kid map (no dynamic JWKS fetch).
 */
import {
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';

export interface PinnedJwtKey {
  readonly keyId: string;
  readonly rsaPublicKeyPem: string;
}

export interface PinnedJwtIssuerConfig {
  readonly issuer: string;
  readonly audience: string;
  /** One or more deployment-controlled RSA public keys (rotation). */
  readonly keys: readonly PinnedJwtKey[];
  readonly maxTokenAgeSeconds: number;
  /** Only for isolated staging guest verifier; default remains reject. */
  readonly allowStagingGuestClaims?: boolean;
}

export interface VerifiedJwtIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly keyId: string;
  /** Present for staging issuer tokens; undefined for non-staging verifiers. */
  readonly accountType?: 'guest' | 'verified';
}

export class JwtVerificationError extends Error {
  constructor() {
    super('UNAUTHENTICATED');
    this.name = 'JwtVerificationError';
  }
}

type Claims = Record<string, unknown>;

function decodeJson(segment: string): Claims {
  if (!/^[A-Za-z0-9_-]{1,8192}$/.test(segment)) throw new JwtVerificationError();
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw new JwtVerificationError();
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new JwtVerificationError();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JwtVerificationError();
  }
  return value as Claims;
}

function positiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function isGuestClaims(claims: Claims): boolean {
  if (claims.guest === true) return true;
  if (claims.account_type === 'guest' || claims.accountType === 'guest') return true;
  if (claims.amr === 'guest') return true;
  if (Array.isArray(claims.amr) && claims.amr.includes('guest')) return true;
  return false;
}

function stagingAccountType(claims: Claims): 'guest' | 'verified' | null {
  if (claims.account_type === 'guest' || claims.accountType === 'guest') return 'guest';
  if (claims.account_type === 'verified' || claims.accountType === 'verified') return 'verified';
  return null;
}

function loadRsaKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (
    key.asymmetricKeyType !== 'rsa' ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new JwtVerificationError();
  }
  return key;
}

export class PinnedRs256JwtVerifier {
  readonly #keys = new Map<string, KeyObject>();
  readonly #issuer: string;
  readonly #audience: string;
  readonly #maxAge: number;
  readonly #allowStagingGuestClaims: boolean;

  constructor(config: PinnedJwtIssuerConfig) {
    if (
      !config.issuer ||
      !/^https:\/\//.test(config.issuer) ||
      !config.audience ||
      !Array.isArray(config.keys) ||
      config.keys.length < 1 ||
      config.keys.length > 8 ||
      !Number.isSafeInteger(config.maxTokenAgeSeconds) ||
      config.maxTokenAgeSeconds < 1 ||
      config.maxTokenAgeSeconds > 86400
    ) {
      throw new JwtVerificationError();
    }
    const seen = new Set<string>();
    for (const entry of config.keys) {
      if (
        !entry?.keyId ||
        typeof entry.keyId !== 'string' ||
        entry.keyId.length > 128 ||
        seen.has(entry.keyId)
      ) {
        throw new JwtVerificationError();
      }
      seen.add(entry.keyId);
      try {
        this.#keys.set(entry.keyId, loadRsaKey(entry.rsaPublicKeyPem));
      } catch {
        throw new JwtVerificationError();
      }
    }
    this.#issuer = config.issuer;
    this.#audience = config.audience;
    this.#maxAge = config.maxTokenAgeSeconds;
    this.#allowStagingGuestClaims = config.allowStagingGuestClaims === true &&
      config.issuer === 'https://staging.puzzle-duel.app' &&
      config.audience === 'puzzle-duel-api';
    if (config.allowStagingGuestClaims && !this.#allowStagingGuestClaims) throw new JwtVerificationError();
  }

  verifyAuthorizationHeader(
    header: string | undefined,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): VerifiedJwtIdentity {
    if (
      typeof header !== 'string' ||
      !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header) ||
      header.length > 12000 ||
      !Number.isSafeInteger(nowSeconds) ||
      nowSeconds < 1
    ) {
      throw new JwtVerificationError();
    }
    const compact = header.slice(7);
    const parts = compact.split('.');
    const headerSeg = parts[0];
    const payloadSeg = parts[1];
    const signatureSeg = parts[2];
    if (
      parts.length !== 3 ||
      headerSeg === undefined ||
      payloadSeg === undefined ||
      signatureSeg === undefined
    ) {
      throw new JwtVerificationError();
    }
    const protectedHeader = decodeJson(headerSeg);
    const claims = decodeJson(payloadSeg);
    if (
      protectedHeader.alg !== 'RS256' ||
      typeof protectedHeader.kid !== 'string' ||
      (protectedHeader.typ !== undefined && protectedHeader.typ !== 'JWT') ||
      protectedHeader.crit !== undefined ||
      protectedHeader.jwk !== undefined ||
      protectedHeader.jku !== undefined ||
      protectedHeader.x5u !== undefined ||
      protectedHeader.x5c !== undefined
    ) {
      throw new JwtVerificationError();
    }
    const key = this.#keys.get(protectedHeader.kid);
    if (!key) throw new JwtVerificationError();

    const signature = Buffer.from(signatureSeg, 'base64url');
    if (
      signature.toString('base64url') !== signatureSeg ||
      !verifySignature(
        'RSA-SHA256',
        Buffer.from(headerSeg + '.' + payloadSeg),
        key,
        signature,
      )
    ) {
      throw new JwtVerificationError();
    }
    if (
      claims.iss !== this.#issuer ||
      claims.aud !== this.#audience ||
      typeof claims.sub !== 'string' ||
      claims.sub.length < 1 ||
      claims.sub.length > 255 ||
      /^\s*$/.test(claims.sub) ||
      (this.#allowStagingGuestClaims
        ? stagingAccountType(claims) === null
        : isGuestClaims(claims)) ||
      !positiveInt(claims.exp) ||
      !positiveInt(claims.iat) ||
      claims.exp <= nowSeconds ||
      claims.iat > nowSeconds ||
      nowSeconds - claims.iat > this.#maxAge ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > this.#maxAge ||
      (claims.nbf !== undefined &&
        (!positiveInt(claims.nbf) || claims.nbf > nowSeconds))
    ) {
      throw new JwtVerificationError();
    }
    const accountType = this.#allowStagingGuestClaims
      ? stagingAccountType(claims) ?? undefined
      : undefined;
    return Object.freeze({
      issuer: this.#issuer,
      subject: claims.sub,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      keyId: protectedHeader.kid,
      ...(accountType ? { accountType } : {}),
    });
  }
}

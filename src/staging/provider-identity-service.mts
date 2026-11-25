/**
 * PZD-26 provider login/link against staging guest credential tables.
 * Firebase Auth is intentionally not used. Email is never an identity key.
 */
import { createHash, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type pg from 'pg';
import { consumeProviderChallenge, type ChallengeScope } from './provider-challenge.mts';
import { GUEST_AUDIENCE, GUEST_ISSUER } from './guest-auth-service.mts';
import {
  verifyProviderAssertion,
  type Provider,
  type ProviderKey,
} from './provider-token-verifier.mts';

const ACCESS_SECONDS = 15 * 60;
const REFRESH_DAYS = 30;

export class ProviderAuthError extends Error {
  readonly code:
    | 'INVALID_PROVIDER_ASSERTION'
    | 'INVALID_PROVIDER_CHALLENGE'
    | 'ACCOUNT_CONFLICT'
    | 'GUEST_PROOF_REQUIRED'
    | 'AUTH_UNAVAILABLE';
  constructor(code:
    | 'INVALID_PROVIDER_ASSERTION'
    | 'INVALID_PROVIDER_CHALLENGE'
    | 'ACCOUNT_CONFLICT'
    | 'GUEST_PROOF_REQUIRED'
    | 'AUTH_UNAVAILABLE'
  ) {
    super(code);
    this.code = code;
  }
}

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
function opaqueToken(): string {
  return randomBytes(48).toString('base64url');
}
function accessJwt(
  privateKey: KeyObject,
  kid: string,
  playerId: string,
  accountType: 'guest' | 'verified',
  now: Date,
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: GUEST_ISSUER,
    aud: GUEST_AUDIENCE,
    sub: playerId,
    account_type: accountType,
    iat,
    exp: iat + ACCESS_SECONDS,
  })).toString('base64url');
  const message = `${header}.${payload}`;
  return `${message}.${sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64url')}`;
}

export type ProviderCredentialBundle = {
  playerId: string;
  accountType: 'verified';
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  linkedProviders: Provider[];
};

export class PostgresProviderIdentityAuth {
  private readonly pool: pg.Pool;
  private readonly privateKey: KeyObject;
  private readonly keyId: string;
  constructor(
    pool: pg.Pool,
    privateKey: KeyObject,
    keyId: string,
  ) {
    if (!keyId || keyId.length > 128) throw new Error('Invalid signing key ID');
    this.pool = pool;
    this.privateKey = privateKey;
    this.keyId = keyId;
  }

  async login(input: {
    provider: Provider;
    idToken: string;
    nonce: string;
    binding: string;
    audiences: readonly string[];
    keys: readonly ProviderKey[];
    nowSeconds: number;
    now?: Date;
  }): Promise<ProviderCredentialBundle> {
    const identity = this.#verify(input);
    const scope: ChallengeScope = {
      provider: input.provider,
      purpose: 'login',
      binding: input.binding,
    };
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await consumeProviderChallenge(client, scope, input.nonce);
      const existing = await client.query<{ player_id: string }>(
        `SELECT player_id FROM public.pzd_identity_links
         WHERE provider=$1 AND provider_subject=$2 FOR UPDATE`,
        [identity.provider, identity.subject],
      );
      let playerId = existing.rows[0]?.player_id;
      if (!playerId) {
        playerId = randomUUID();
        await client.query(
          `INSERT INTO public.pzd_guest_accounts (player_id, account_class)
           VALUES ($1, 'verified')`,
          [playerId],
        );
        try {
          await client.query(
            `INSERT INTO public.pzd_identity_links (provider, provider_subject, player_id)
             VALUES ($1, $2, $3)`,
            [identity.provider, identity.subject, playerId],
          );
        } catch (error) {
          if (isUniqueViolation(error)) throw new ProviderAuthError('ACCOUNT_CONFLICT');
          throw error;
        }
      } else {
        await client.query(
          `UPDATE public.pzd_guest_accounts
           SET account_class='verified'
           WHERE player_id=$1 AND account_class='guest'`,
          [playerId],
        );
      }
      const bundle = await this.#issueVerifiedFamily(client, playerId, now);
      await client.query('COMMIT');
      return bundle;
    } catch (error) {
      await client.query('ROLLBACK');
      throw mapError(error);
    } finally {
      client.release();
    }
  }

  async link(input: {
    provider: Provider;
    idToken: string;
    nonce: string;
    guestPlayerId: string;
    audiences: readonly string[];
    keys: readonly ProviderKey[];
    nowSeconds: number;
    now?: Date;
  }): Promise<ProviderCredentialBundle> {
    if (!/^[0-9a-f-]{36}$/i.test(input.guestPlayerId)) {
      throw new ProviderAuthError('GUEST_PROOF_REQUIRED');
    }
    const identity = this.#verify(input);
    const scope: ChallengeScope = {
      provider: input.provider,
      purpose: 'link',
      binding: `link:${input.guestPlayerId}`,
    };
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const guest = await client.query<{ player_id: string; account_class: string }>(
        `SELECT player_id, account_class FROM public.pzd_guest_accounts
         WHERE player_id=$1 FOR UPDATE`,
        [input.guestPlayerId],
      );
      if (guest.rowCount !== 1) throw new ProviderAuthError('GUEST_PROOF_REQUIRED');
      const activeFamily = await client.query(
        `SELECT 1 FROM public.pzd_guest_families
         WHERE player_id=$1 AND revoked_at IS NULL
         LIMIT 1 FOR UPDATE`,
        [input.guestPlayerId],
      );
      if (activeFamily.rowCount !== 1) throw new ProviderAuthError('GUEST_PROOF_REQUIRED');
      await consumeProviderChallenge(client, scope, input.nonce);
      const occupied = await client.query<{ player_id: string }>(
        `SELECT player_id FROM public.pzd_identity_links
         WHERE provider=$1 AND provider_subject=$2 FOR UPDATE`,
        [identity.provider, identity.subject],
      );
      if (occupied.rowCount === 1 && occupied.rows[0]!.player_id !== input.guestPlayerId) {
        throw new ProviderAuthError('ACCOUNT_CONFLICT');
      }
      if (occupied.rowCount === 0) {
        try {
          await client.query(
            `INSERT INTO public.pzd_identity_links (provider, provider_subject, player_id)
             VALUES ($1, $2, $3)`,
            [identity.provider, identity.subject, input.guestPlayerId],
          );
        } catch (error) {
          if (isUniqueViolation(error)) throw new ProviderAuthError('ACCOUNT_CONFLICT');
          throw error;
        }
      }
      await client.query(
        `UPDATE public.pzd_guest_accounts SET account_class='verified' WHERE player_id=$1`,
        [input.guestPlayerId],
      );
      // Revoke prior guest credential families so old guest tokens cannot
      // inherit verified privileges merely because the player_id is linked.
      await client.query(
        `UPDATE public.pzd_guest_families SET revoked_at=$2
         WHERE player_id=$1 AND revoked_at IS NULL`,
        [input.guestPlayerId, now],
      );
      const bundle = await this.#issueVerifiedFamily(client, input.guestPlayerId, now);
      await client.query('COMMIT');
      return bundle;
    } catch (error) {
      await client.query('ROLLBACK');
      throw mapError(error);
    } finally {
      client.release();
    }
  }

  #verify(input: {
    provider: Provider;
    idToken: string;
    nonce: string;
    audiences: readonly string[];
    keys: readonly ProviderKey[];
    nowSeconds: number;
  }) {
    try {
      return verifyProviderAssertion({
        provider: input.provider,
        token: input.idToken,
        audiences: input.audiences,
        keys: input.keys,
        expectedNonce: input.nonce,
        nowSeconds: input.nowSeconds,
      });
    } catch {
      throw new ProviderAuthError('INVALID_PROVIDER_ASSERTION');
    }
  }

  async #issueVerifiedFamily(
    client: pg.PoolClient,
    playerId: string,
    now: Date,
  ): Promise<ProviderCredentialBundle> {
    const familyId = randomUUID();
    const refreshToken = opaqueToken();
    await client.query(
      `INSERT INTO public.pzd_guest_families (family_id, player_id) VALUES ($1, $2)`,
      [familyId, playerId],
    );
    await client.query(
      `INSERT INTO public.pzd_guest_refresh (family_id, player_id, token_digest, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [familyId, playerId, digest(refreshToken), new Date(now.getTime() + REFRESH_DAYS * 86400000)],
    );
    const linked = await client.query<{ provider: Provider }>(
      `SELECT provider FROM public.pzd_identity_links WHERE player_id=$1 ORDER BY provider`,
      [playerId],
    );
    return {
      playerId,
      accountType: 'verified',
      accessToken: accessJwt(this.privateKey, this.keyId, playerId, 'verified', now),
      refreshToken,
      expiresAt: new Date(now.getTime() + ACCESS_SECONDS * 1000).toISOString(),
      linkedProviders: linked.rows.map((row) => row.provider),
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && (error as { code?: string }).code === '23505';
}

function mapError(error: unknown): Error {
  if (error instanceof ProviderAuthError) return error;
  if (error instanceof Error && error.message === 'INVALID_PROVIDER_CHALLENGE') {
    return new ProviderAuthError('INVALID_PROVIDER_CHALLENGE');
  }
  return new ProviderAuthError('AUTH_UNAVAILABLE');
}

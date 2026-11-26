/**
 * PZD-26 provider login/link against staging guest credential tables.
 * Firebase Auth is intentionally not used. Email is never an identity key.
 *
 * Identity rows are INSERT-only for the runtime role (no UPDATE grant).
 * Concurrency uses transaction advisory locks, not SELECT FOR UPDATE.
 */
import { createHash, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import type pg from 'pg';
import { consumeProviderChallenge, type ChallengeScope } from './provider-challenge.mts';
import {
  continueChallengeBinding,
  linkChallengeBinding,
  lockGuestFamily,
  lockIdentitySubject,
  mintStagingAccessJwt,
} from './staging-access-token.mts';
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
    | 'AUTH_UNAVAILABLE'
    /** Provider subject is not linked; recovery must never create a player. */
    | 'RECOVERY_NOT_LINKED'
    | 'ACCOUNT_SWITCH_CONFIRMATION_REQUIRED'
    | 'INVALID_CONTINUATION';
  readonly continuationToken?: string;
  readonly expiresAt?: string;
  constructor(
    code:
      | 'INVALID_PROVIDER_ASSERTION'
      | 'INVALID_PROVIDER_CHALLENGE'
      | 'ACCOUNT_CONFLICT'
      | 'GUEST_PROOF_REQUIRED'
      | 'AUTH_UNAVAILABLE'
      | 'RECOVERY_NOT_LINKED'
      | 'ACCOUNT_SWITCH_CONFIRMATION_REQUIRED'
      | 'INVALID_CONTINUATION',
    extras?: { continuationToken?: string; expiresAt?: string },
  ) {
    super(code);
    this.code = code;
    this.continuationToken = extras?.continuationToken;
    this.expiresAt = extras?.expiresAt;
  }
}

export type ProviderContinueResolution =
  | 'link_guest'
  | 'existing_account'
  | 'created_account'
  | 'same_account';

export type ProviderContinueBundle = ProviderCredentialBundle & {
  resolution: ProviderContinueResolution;
};

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
function opaqueToken(): string {
  return randomBytes(48).toString('base64url');
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
      await lockIdentitySubject(client, identity.provider, identity.subject);
      const existing = await client.query<{ player_id: string }>(
        `SELECT player_id FROM public.pzd_identity_links
         WHERE provider=$1 AND provider_subject=$2`,
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

  /**
   * Identity-preserving recovery after uncertain guest→verified link.
   * Never creates a player, identity link, or session family until the
   * verified provider subject already maps to [expectedPlayerId].
   * expectedPlayerId is a filter only — never proof of ownership.
   * Uses the same login challenge purpose/binding (no schema migration).
   */
  async recover(input: {
    provider: Provider;
    idToken: string;
    nonce: string;
    binding: string;
    expectedPlayerId: string;
    audiences: readonly string[];
    keys: readonly ProviderKey[];
    nowSeconds: number;
    now?: Date;
  }): Promise<ProviderCredentialBundle> {
    if (!/^[0-9a-f-]{36}$/i.test(input.expectedPlayerId)) {
      throw new ProviderAuthError('INVALID_PROVIDER_CHALLENGE');
    }
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
      await lockIdentitySubject(client, identity.provider, identity.subject);
      const existing = await client.query<{ player_id: string }>(
        `SELECT player_id FROM public.pzd_identity_links
         WHERE provider=$1 AND provider_subject=$2`,
        [identity.provider, identity.subject],
      );
      if (existing.rowCount !== 1) {
        throw new ProviderAuthError('RECOVERY_NOT_LINKED');
      }
      const playerId = existing.rows[0]!.player_id;
      if (playerId !== input.expectedPlayerId) {
        throw new ProviderAuthError('ACCOUNT_CONFLICT');
      }
      await client.query(
        `UPDATE public.pzd_guest_accounts
         SET account_class='verified'
         WHERE player_id=$1 AND account_class='guest'`,
        [playerId],
      );
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
    guestFamilyId: string;
    audiences: readonly string[];
    keys: readonly ProviderKey[];
    nowSeconds: number;
    now?: Date;
  }): Promise<ProviderCredentialBundle> {
    if (!/^[0-9a-f-]{36}$/i.test(input.guestPlayerId) ||
        !/^[0-9a-f-]{36}$/i.test(input.guestFamilyId)) {
      throw new ProviderAuthError('GUEST_PROOF_REQUIRED');
    }
    const identity = this.#verify(input);
    const scope: ChallengeScope = {
      provider: input.provider,
      purpose: 'link',
      binding: linkChallengeBinding(input.guestPlayerId, input.guestFamilyId),
    };
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Exact authenticated guest family first — stale/revoked/upgraded/expired proof fails closed.
      await lockGuestFamily(client, input.guestFamilyId);
      const guest = await client.query<{
        player_id: string;
        account_class: string;
        active_refresh: boolean;
      }>(
        `SELECT a.player_id, a.account_class,
            EXISTS (
              SELECT 1 FROM public.pzd_guest_refresh r
              WHERE r.family_id = f.family_id
                AND r.used_at IS NULL
                AND r.expires_at > clock_timestamp()
            ) AS active_refresh
         FROM public.pzd_guest_accounts a
         JOIN public.pzd_guest_families f ON f.player_id = a.player_id
         WHERE a.player_id=$1 AND f.family_id=$2 AND f.revoked_at IS NULL`,
        [input.guestPlayerId, input.guestFamilyId],
      );
      if (guest.rowCount !== 1) throw new ProviderAuthError('GUEST_PROOF_REQUIRED');
      if (guest.rows[0]!.account_class !== 'guest' || !guest.rows[0]!.active_refresh) {
        throw new ProviderAuthError('GUEST_PROOF_REQUIRED');
      }
      await consumeProviderChallenge(client, scope, input.nonce);
      await lockIdentitySubject(client, identity.provider, identity.subject);
      const occupied = await client.query<{ player_id: string }>(
        `SELECT player_id FROM public.pzd_identity_links
         WHERE provider=$1 AND provider_subject=$2`,
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

  /**
   * Unified Apple/Google continue. Backend resolves link vs existing account.
   * Progressed guests with a foreign provider identity require confirmation
   * (ACCOUNT_SWITCH_CONFIRMATION_REQUIRED) — no silent merge or credential replace.
   */
  async continue(input: {
    provider: Provider;
    idToken: string;
    nonce: string;
    binding: string;
    guestPlayerId?: string;
    guestFamilyId?: string;
    /** Client-asserted local Practice progression; never trust alone for empty. */
    localProgressProtected?: boolean;
    audiences: readonly string[];
    keys: readonly ProviderKey[];
    nowSeconds: number;
    now?: Date;
  }): Promise<ProviderContinueBundle> {
    const hasGuest = Boolean(input.guestPlayerId && input.guestFamilyId);
    if (hasGuest) {
      if (!/^[0-9a-f-]{36}$/i.test(input.guestPlayerId!) ||
          !/^[0-9a-f-]{36}$/i.test(input.guestFamilyId!)) {
        throw new ProviderAuthError('GUEST_PROOF_REQUIRED');
      }
      if (input.binding !== continueChallengeBinding(
        input.guestPlayerId!,
        input.guestFamilyId!,
      )) {
        throw new ProviderAuthError('INVALID_PROVIDER_CHALLENGE');
      }
    } else if (!input.binding || input.binding.length > 1024) {
      throw new ProviderAuthError('INVALID_PROVIDER_CHALLENGE');
    }
    const identity = this.#verify(input);
    const scope: ChallengeScope = {
      provider: input.provider,
      purpose: 'continue',
      binding: input.binding,
    };
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (hasGuest) {
        await lockGuestFamily(client, input.guestFamilyId!);
        const guest = await this.#requireActiveGuest(
          client,
          input.guestPlayerId!,
          input.guestFamilyId!,
        );
        if (!guest) throw new ProviderAuthError('GUEST_PROOF_REQUIRED');
      }
      await consumeProviderChallenge(client, scope, input.nonce);
      await lockIdentitySubject(client, identity.provider, identity.subject);
      const occupied = await client.query<{ player_id: string }>(
        `SELECT player_id FROM public.pzd_identity_links
         WHERE provider=$1 AND provider_subject=$2`,
        [identity.provider, identity.subject],
      );

      // Scenario A / E / F — no foreign link.
      if (occupied.rowCount !== 1) {
        if (hasGuest) {
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
          await client.query(
            `UPDATE public.pzd_guest_accounts SET account_class='verified' WHERE player_id=$1`,
            [input.guestPlayerId],
          );
          await client.query(
            `UPDATE public.pzd_guest_families SET revoked_at=$2
             WHERE player_id=$1 AND revoked_at IS NULL`,
            [input.guestPlayerId, now],
          );
          const bundle = await this.#issueVerifiedFamily(client, input.guestPlayerId!, now);
          await client.query('COMMIT');
          return { ...bundle, resolution: 'link_guest' };
        }
        const playerId = randomUUID();
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
        const bundle = await this.#issueVerifiedFamily(client, playerId, now);
        await client.query('COMMIT');
        return { ...bundle, resolution: 'created_account' };
      }

      const targetPlayerId = occupied.rows[0]!.player_id;
      // Scenario F — same player already linked.
      if (hasGuest && targetPlayerId === input.guestPlayerId) {
        await client.query(
          `UPDATE public.pzd_guest_accounts
           SET account_class='verified'
           WHERE player_id=$1 AND account_class='guest'`,
          [targetPlayerId],
        );
        await client.query(
          `UPDATE public.pzd_guest_families SET revoked_at=$2
           WHERE player_id=$1 AND revoked_at IS NULL`,
          [targetPlayerId, now],
        );
        const bundle = await this.#issueVerifiedFamily(client, targetPlayerId, now);
        await client.query('COMMIT');
        return { ...bundle, resolution: 'same_account' };
      }

      // Scenario B / C — foreign verified identity.
      if (hasGuest) {
        const serverProgress = await this.#guestHasServerProgression(
          client,
          input.guestPlayerId!,
        );
        const requireConfirm = serverProgress || input.localProgressProtected === true;
        if (requireConfirm) {
          const continuation = opaqueToken();
          const expiresAt = new Date(now.getTime() + 5 * 60_000);
          await client.query(
            `INSERT INTO public.pzd_provider_continuations (
               continuation_digest, provider, provider_subject, target_player_id,
               source_guest_player_id, source_family_id, expires_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              digest(continuation),
              identity.provider,
              identity.subject,
              targetPlayerId,
              input.guestPlayerId,
              input.guestFamilyId,
              expiresAt,
            ],
          );
          await client.query('COMMIT');
          throw new ProviderAuthError('ACCOUNT_SWITCH_CONFIRMATION_REQUIRED', {
            continuationToken: continuation,
            expiresAt: expiresAt.toISOString(),
          });
        }
      }

      // Scenario B (empty guest) or D (no guest) — authenticate existing.
      await client.query(
        `UPDATE public.pzd_guest_accounts
         SET account_class='verified'
         WHERE player_id=$1 AND account_class='guest'`,
        [targetPlayerId],
      );
      const bundle = await this.#issueVerifiedFamily(client, targetPlayerId, now);
      await client.query('COMMIT');
      return { ...bundle, resolution: 'existing_account' };
    } catch (error) {
      if (error instanceof ProviderAuthError &&
          error.code === 'ACCOUNT_SWITCH_CONFIRMATION_REQUIRED') {
        throw error;
      }
      await client.query('ROLLBACK');
      throw mapError(error);
    } finally {
      client.release();
    }
  }

  /**
   * Commit a previously issued account-switch continuation.
   * Does not transfer guest progression. Does not re-consume provider nonce.
   */
  async confirmContinue(input: {
    continuationToken: string;
    now?: Date;
  }): Promise<ProviderContinueBundle> {
    if (!input.continuationToken || input.continuationToken.length > 256) {
      throw new ProviderAuthError('INVALID_CONTINUATION');
    }
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const consumed = await client.query<{
        provider: Provider;
        provider_subject: string;
        target_player_id: string;
        source_guest_player_id: string | null;
        source_family_id: string | null;
      }>(
        `UPDATE public.pzd_provider_continuations
         SET consumed_at=clock_timestamp()
         WHERE continuation_digest=$1
           AND consumed_at IS NULL
           AND expires_at > clock_timestamp()
         RETURNING provider, provider_subject, target_player_id,
                   source_guest_player_id, source_family_id`,
        [digest(input.continuationToken)],
      );
      if (consumed.rowCount !== 1) {
        throw new ProviderAuthError('INVALID_CONTINUATION');
      }
      const row = consumed.rows[0]!;
      if (row.source_family_id) {
        await lockGuestFamily(client, row.source_family_id);
      }
      await lockIdentitySubject(client, row.provider, row.provider_subject);
      const link = await client.query<{ player_id: string }>(
        `SELECT player_id FROM public.pzd_identity_links
         WHERE provider=$1 AND provider_subject=$2`,
        [row.provider, row.provider_subject],
      );
      const targetPlayerId = row.target_player_id;
      if (link.rowCount !== 1 || link.rows[0]!.player_id !== targetPlayerId) {
        throw new ProviderAuthError('ACCOUNT_CONFLICT');
      }
      await client.query(
        `UPDATE public.pzd_guest_accounts
         SET account_class='verified'
         WHERE player_id=$1 AND account_class='guest'`,
        [targetPlayerId],
      );
      const bundle = await this.#issueVerifiedFamily(client, targetPlayerId, now);
      await client.query('COMMIT');
      return { ...bundle, resolution: 'existing_account' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw mapError(error);
    } finally {
      client.release();
    }
  }

  async #requireActiveGuest(
    client: pg.PoolClient,
    guestPlayerId: string,
    guestFamilyId: string,
  ): Promise<boolean> {
    const guest = await client.query<{
      account_class: string;
      active_refresh: boolean;
    }>(
      `SELECT a.account_class,
          EXISTS (
            SELECT 1 FROM public.pzd_guest_refresh r
            WHERE r.family_id = f.family_id
              AND r.used_at IS NULL
              AND r.expires_at > clock_timestamp()
          ) AS active_refresh
       FROM public.pzd_guest_accounts a
       JOIN public.pzd_guest_families f ON f.player_id = a.player_id
       WHERE a.player_id=$1 AND f.family_id=$2 AND f.revoked_at IS NULL`,
      [guestPlayerId, guestFamilyId],
    );
    return guest.rowCount === 1
      && guest.rows[0]!.account_class === 'guest'
      && guest.rows[0]!.active_refresh;
  }

  /**
   * Server-owned progression for the guest player.
   * Practice is client-local — never treat absence of these rows as proof
   * that the guest is empty when localProgressProtected is true.
   */
  async #guestHasServerProgression(
    client: pg.PoolClient,
    playerId: string,
  ): Promise<boolean> {
    const result = await client.query<{ meaningful: boolean }>(
      `SELECT (
         CASE WHEN to_regclass('public.tournament_daily_claim') IS NOT NULL THEN
           EXISTS (
             SELECT 1 FROM public.tournament_daily_claim WHERE player_id=$1 LIMIT 1
           )
         ELSE false END
         OR CASE WHEN to_regclass('public.tournament_on_time_badge') IS NOT NULL THEN
           EXISTS (
             SELECT 1 FROM public.tournament_on_time_badge WHERE player_id=$1 LIMIT 1
           )
         ELSE false END
         OR CASE WHEN to_regclass('public.tournament_daily_series_completion') IS NOT NULL THEN
           EXISTS (
             SELECT 1 FROM public.tournament_daily_series_completion
             WHERE player_id=$1 LIMIT 1
           )
         ELSE false END
       ) AS meaningful`,
      [playerId],
    );
    return result.rows[0]?.meaningful === true;
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
      accessToken: mintStagingAccessJwt({
        privateKey: this.privateKey,
        keyId: this.keyId,
        playerId,
        familyId,
        accountType: 'verified',
        now,
      }),
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

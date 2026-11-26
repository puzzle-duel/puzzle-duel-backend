/**
 * Staging access JWT claims shared by guest and verified credential minting.
 * Access tokens bind to an exact refresh family (`fid`), never "any family".
 *
 * Family mutations (link / refresh / logout) share `lockGuestFamily` advisory
 * locks so they mutually serialize across transactions.
 */
import { createHash, sign, type KeyObject } from 'node:crypto';
import type pg from 'pg';

export const GUEST_ISSUER = 'https://staging.puzzle-duel.app';
export const GUEST_AUDIENCE = 'puzzle-duel-api';

const ACCESS_SECONDS = 15 * 60;
const FAMILY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isFamilyId(value: string): boolean {
  return FAMILY_ID.test(value);
}

export async function detectAccountClassColumn(pool: pg.Pool): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='pzd_guest_accounts'
         AND column_name='account_class'
     ) AS present`,
  );
  return result.rows[0]?.present === true;
}

/**
 * Provider routes require 0007 identity immutability triggers.
 * Uses only `to_regclass` — never `'…'::regclass` — so pre-0006 schemas
 * return false without raising undefined_table (42P01).
 */
export async function detectIdentityImmutabilityReady(pool: pg.Pool): Promise<boolean> {
  const result = await pool.query<{ ready: boolean }>(
    `SELECT (
       to_regclass('public.pzd_identity_links') IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM pg_trigger t
         WHERE t.tgrelid = to_regclass('public.pzd_identity_links')
           AND t.tgname = 'pzd_identity_links_immutable_upd'
           AND NOT t.tgisinternal
           AND t.tgenabled <> 'D'
       )
       AND EXISTS (
         SELECT 1 FROM pg_trigger t
         WHERE t.tgrelid = to_regclass('public.pzd_identity_links')
           AND t.tgname = 'pzd_identity_links_immutable_del'
           AND NOT t.tgisinternal
           AND t.tgenabled <> 'D'
       )
     ) AS ready`,
  );
  return result.rows[0]?.ready === true;
}

/** Base provider tables + account_class without requiring 0007 triggers. */
export async function detectProviderSchemaReady(pool: pg.Pool): Promise<boolean> {
  const result = await pool.query<{ ready: boolean }>(
    `SELECT (
       to_regclass('public.pzd_provider_challenges') IS NOT NULL
       AND to_regclass('public.pzd_identity_links') IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='pzd_guest_accounts'
           AND column_name='account_class')
     ) AS ready`,
  );
  return result.rows[0]?.ready === true;
}

export function mintStagingAccessJwt(input: {
  privateKey: KeyObject;
  keyId: string;
  playerId: string;
  familyId: string;
  accountType: 'guest' | 'verified';
  now: Date;
}): string {
  if (!isFamilyId(input.familyId) || !/^[0-9a-f-]{36}$/i.test(input.playerId)) {
    throw new Error('INVALID_STAGING_ACCESS_CLAIMS');
  }
  const iat = Math.floor(input.now.getTime() / 1000);
  const header = Buffer.from(JSON.stringify({
    alg: 'RS256', typ: 'JWT', kid: input.keyId,
  })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: GUEST_ISSUER,
    aud: GUEST_AUDIENCE,
    sub: input.playerId,
    fid: input.familyId,
    account_type: input.accountType,
    iat,
    exp: iat + ACCESS_SECONDS,
  })).toString('base64url');
  const message = `${header}.${payload}`;
  return `${message}.${sign('RSA-SHA256', Buffer.from(message), input.privateKey).toString('base64url')}`;
}

/** Schema readiness must be detected outside the txn; never catch 42703 mid-txn. */
export async function accountClassForPlayer(
  client: { query: pg.Pool['query'] },
  playerId: string,
  accountClassEnabled: boolean,
): Promise<'guest' | 'verified'> {
  if (!accountClassEnabled) return 'guest';
  const result = await client.query<{ account_class?: string }>(
    `SELECT account_class FROM public.pzd_guest_accounts WHERE player_id=$1`,
    [playerId],
  );
  return result.rows[0]?.account_class === 'verified' ? 'verified' : 'guest';
}

/**
 * Authorize the exact family named by the access JWT.
 * Requires: ownership, not revoked, matching account class (when enabled),
 * and at least one non-expired unused refresh credential for that family.
 */
export async function assertExactActiveFamily(input: {
  pool: pg.Pool;
  playerId: string;
  familyId: string;
  /** JWT account_type must match DB account_class when the column exists. */
  expectedAccountType: 'guest' | 'verified';
  accountClassEnabled: boolean;
  now?: Date;
}): Promise<void> {
  if (!isFamilyId(input.familyId) || !/^[0-9a-f-]{36}$/i.test(input.playerId)) {
    throw new Error('UNAUTHENTICATED');
  }
  const now = input.now ?? new Date();
  const result = await input.pool.query<{
    revoked_at: Date | null;
    account_class: string | null;
    active_refresh: boolean;
  }>(
    input.accountClassEnabled
      ? `SELECT f.revoked_at, a.account_class,
            EXISTS (
              SELECT 1 FROM public.pzd_guest_refresh r
              WHERE r.family_id = f.family_id
                AND r.used_at IS NULL
                AND r.expires_at > $3
            ) AS active_refresh
         FROM public.pzd_guest_families f
         JOIN public.pzd_guest_accounts a ON a.player_id = f.player_id
         WHERE f.family_id=$1 AND f.player_id=$2`
      : `SELECT f.revoked_at, NULL::text AS account_class,
            EXISTS (
              SELECT 1 FROM public.pzd_guest_refresh r
              WHERE r.family_id = f.family_id
                AND r.used_at IS NULL
                AND r.expires_at > $3
            ) AS active_refresh
         FROM public.pzd_guest_families f
         WHERE f.family_id=$1 AND f.player_id=$2`,
    [input.familyId, input.playerId, now],
  );
  const row = result.rows[0];
  if (!row || row.revoked_at || !row.active_refresh) throw new Error('UNAUTHENTICATED');
  if (input.accountClassEnabled) {
    const actual = row.account_class === 'verified' ? 'verified' : 'guest';
    if (actual !== input.expectedAccountType) throw new Error('UNAUTHENTICATED');
  } else if (input.expectedAccountType !== 'guest') {
    // Pre-0006 schema is guest-only.
    throw new Error('UNAUTHENTICATED');
  }
}

export function linkChallengeBinding(playerId: string, familyId: string): string {
  return `link:${playerId}:${familyId}`;
}

/** Unified continue challenge bound to exact guest family when a guest is present. */
export function continueChallengeBinding(playerId: string, familyId: string): string {
  return `continue:${playerId}:${familyId}`;
}

/** 0008 continue/continuation tables ready. */
export async function detectProviderContinueSchemaReady(pool: pg.Pool): Promise<boolean> {
  const result = await pool.query<{ ready: boolean }>(
    `SELECT (to_regclass('public.pzd_provider_continuations') IS NOT NULL) AS ready`,
  );
  return result.rows[0]?.ready === true;
}

export function identityAdvisoryKey(provider: string, subject: string): string {
  return `pzd-id:${provider}:${subject}`;
}

/** Two int4 keys for pg_advisory_xact_lock — works without UPDATE privilege. */
export function identityAdvisoryKeys(provider: string, subject: string): [number, number] {
  const digest = createHash('sha256').update(identityAdvisoryKey(provider, subject), 'utf8').digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export function familyAdvisoryKeys(familyId: string): [number, number] {
  const digest = createHash('sha256').update(`pzd-family:${familyId}`, 'utf8').digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export async function lockIdentitySubject(
  client: pg.PoolClient,
  provider: string,
  subject: string,
): Promise<void> {
  const keys = identityAdvisoryKeys(provider, subject);
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [keys[0], keys[1]]);
}

/** Shared family lock for link, refresh, and logout. */
export async function lockGuestFamily(
  client: pg.PoolClient,
  familyId: string,
): Promise<void> {
  const keys = familyAdvisoryKeys(familyId);
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [keys[0], keys[1]]);
}

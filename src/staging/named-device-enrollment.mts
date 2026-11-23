/** Staging-only, one-time named-player device enrollment.
 * A pairing code is an authorization secret: never log or put it in CI artifacts.
 * Codes are stored only as SHA-256 digests, expire in fifteen minutes, and can
 * create one independent refresh family for an EXISTING named player.
 */
import { createHash, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type pg from 'pg';
import { GUEST_AUDIENCE, GUEST_ISSUER } from './guest-auth-service.mts';

const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const TTL_MS = 15 * 60 * 1000;
const REFRESH_MS = 30 * 86400 * 1000;
const ACCESS_MS = 15 * 60 * 1000;
export type NamedPlayer = 'gokhan' | 'serap';

/** Operator-only. Deliver the returned code through an authenticated private
 * channel, never via public GitHub Actions output or workflow artifacts. */
export async function issueEnrollmentCode(pool: pg.Pool, slug: NamedPlayer, suppliedDigest: string, now = new Date()):
    Promise<{ expiresAt: string; playerId: string }> {
  if (slug !== 'gokhan' && slug !== 'serap') throw new Error('INVALID_PLAYER');
  if (!/^[a-f0-9]{64}$/.test(suppliedDigest)) throw new Error('INVALID_CODE_DIGEST');
  const expiresAt = new Date(now.getTime() + TTL_MS);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<{ player_id: string }>(
      'SELECT player_id FROM public.pzd_staging_test_players WHERE slug=$1 FOR UPDATE', [slug]);
    if (found.rowCount !== 1) throw new Error('PLAYER_NOT_PROVISIONED');
    const playerId = found.rows[0]!.player_id;
    // Invalidate previously issued, unused codes for the same named identity.
    await client.query('DELETE FROM public.pzd_staging_device_enrollment WHERE player_id=$1', [playerId]);
    await client.query(
      'INSERT INTO public.pzd_staging_device_enrollment(code_digest,player_id,expires_at) VALUES($1,$2,$3)',
      [suppliedDigest, playerId, expiresAt]);
    await client.query('COMMIT');
    return { expiresAt: expiresAt.toISOString(), playerId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export class EnrollmentRejected extends Error {
  constructor() { super('ENROLLMENT_REJECTED'); }
}

/** Atomic, single-use exchange. Never rotates the operator's existing token,
 * never creates a new player, and never shares a refresh family between devices.
 */
export async function redeemEnrollmentCode(
  pool: pg.Pool, signingKey: KeyObject, kid: string, code: string,
  now = new Date(),
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string; playerId: string }> {
  if (!CODE_PATTERN.test(code)) throw new EnrollmentRejected();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(kid)) throw new Error('INVALID_SIGNER');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<{ player_id: string }>(
      `SELECT player_id FROM public.pzd_staging_device_enrollment
       WHERE code_digest=$1 AND consumed_at IS NULL AND expires_at>$2 FOR UPDATE`,
      [digest(code), now]);
    if (found.rowCount !== 1) throw new EnrollmentRejected();
    const playerId = found.rows[0]!.player_id;
    const active = await client.query(
      `SELECT 1 FROM public.pzd_staging_test_players WHERE player_id=$1
       AND slug IN ('gokhan','serap') LIMIT 1`, [playerId]);
    if (active.rowCount !== 1) throw new EnrollmentRejected();
    const familyId = randomUUID();
    const refreshToken = randomBytes(48).toString('base64url');
    await client.query('INSERT INTO public.pzd_guest_families(family_id,player_id) VALUES($1,$2)',
      [familyId, playerId]);
    await client.query(
      'INSERT INTO public.pzd_guest_refresh(family_id,player_id,token_digest,expires_at) VALUES($1,$2,$3,$4)',
      [familyId, playerId, digest(refreshToken), new Date(now.getTime() + REFRESH_MS)]);
    await client.query(
      'UPDATE public.pzd_staging_device_enrollment SET consumed_at=$2 WHERE code_digest=$1',
      [digest(code), now]);
    await client.query('COMMIT');
    const iat = Math.floor(now.getTime() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: GUEST_ISSUER, aud: GUEST_AUDIENCE, sub: playerId,
      account_type: 'guest', iat, exp: iat + ACCESS_MS / 1000,
    })).toString('base64url');
    const message = `${header}.${payload}`;
    return {
      accessToken: `${message}.${sign('RSA-SHA256', Buffer.from(message), signingKey).toString('base64url')}`,
      refreshToken, expiresAt: new Date(now.getTime() + ACCESS_MS).toISOString(), playerId,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

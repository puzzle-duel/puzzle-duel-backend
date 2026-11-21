/**
 * PZD-49 staging guest credentials. Not mounted on public HTTP until the
 * migration, TLS reverse proxy, rate limits and tournament verifier are ready.
 */
import { createHash, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type pg from 'pg';

export const GUEST_ISSUER = 'https://staging.puzzle-duel.app';
export const GUEST_AUDIENCE = 'puzzle-duel-api';
const ACCESS_SECONDS = 15 * 60;
const REFRESH_DAYS = 30;

export class GuestCredentialError extends Error {
  constructor(readonly code: 'INVALID_REFRESH' | 'REFRESH_REPLAY' | 'REFRESH_EXPIRED') {
    super(code);
  }
}

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
function opaqueToken(): string {
  return randomBytes(48).toString('base64url');
}
function accessJwt(privateKey: KeyObject, kid: string, playerId: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  // The tournament verifier must explicitly opt in to this issuer's guest claims.
  const payload = Buffer.from(JSON.stringify({
    iss: GUEST_ISSUER, aud: GUEST_AUDIENCE, sub: playerId,
    account_type: 'guest', iat, exp: iat + ACCESS_SECONDS,
  })).toString('base64url');
  const message = `${header}.${payload}`;
  return `${message}.${sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64url')}`;
}

export class PostgresStagingGuestAuth {
  constructor(
    private readonly pool: pg.Pool,
    private readonly privateKey: KeyObject,
    private readonly keyId: string,
  ) {
    if (!keyId || keyId.length > 128) throw new Error('Invalid signing key ID');
  }

  async create(now = new Date()) {
    const playerId = randomUUID();
    const familyId = randomUUID();
    const refreshToken = opaqueToken();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO pzd_guest_accounts (player_id) VALUES ($1)', [playerId]);
      await client.query(
        `INSERT INTO pzd_guest_refresh (family_id, player_id, token_digest, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [familyId, playerId, digest(refreshToken), new Date(now.getTime() + REFRESH_DAYS * 86400000)],
      );
      await client.query('COMMIT');
      return {
        accessToken: accessJwt(this.privateKey, this.keyId, playerId, now),
        refreshToken, expiresAt: new Date(now.getTime() + ACCESS_SECONDS * 1000).toISOString(),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async refresh(refreshToken: string, now = new Date()) {
    if (!/^[A-Za-z0-9_-]{64}$/.test(refreshToken)) throw new GuestCredentialError('INVALID_REFRESH');
    const tokenDigest = digest(refreshToken);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize every rotation within a family, including concurrent replay.
      const found = await client.query<{ family_id: string }>(
        'SELECT family_id FROM pzd_guest_refresh WHERE token_digest = $1', [tokenDigest],
      );
      const familyId = found.rows[0]?.family_id;
      if (!familyId) throw new GuestCredentialError('INVALID_REFRESH');
      await client.query('SELECT family_id FROM pzd_guest_families WHERE family_id = $1 FOR UPDATE', [familyId]);
      const current = await client.query<{
        player_id: string; used_at: Date | null; revoked_at: Date | null; expires_at: Date;
      }>(
        `SELECT r.player_id, r.used_at, f.revoked_at, r.expires_at
         FROM pzd_guest_refresh r JOIN pzd_guest_families f USING (family_id)
         WHERE r.token_digest = $1 FOR UPDATE OF r`, [tokenDigest],
      );
      const row = current.rows[0];
      if (!row || row.revoked_at) throw new GuestCredentialError('INVALID_REFRESH');
      if (row.used_at) {
        await client.query('UPDATE pzd_guest_families SET revoked_at = $2 WHERE family_id = $1', [familyId, now]);
        await client.query('COMMIT');
        throw new GuestCredentialError('REFRESH_REPLAY');
      }
      if (new Date(row.expires_at).getTime() <= now.getTime()) throw new GuestCredentialError('REFRESH_EXPIRED');
      const nextToken = opaqueToken();
      await client.query('UPDATE pzd_guest_refresh SET used_at = $2 WHERE token_digest = $1', [tokenDigest, now]);
      await client.query(
        `INSERT INTO pzd_guest_refresh (family_id, player_id, token_digest, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [familyId, row.player_id, digest(nextToken), new Date(now.getTime() + REFRESH_DAYS * 86400000)],
      );
      await client.query('COMMIT');
      return {
        accessToken: accessJwt(this.privateKey, this.keyId, row.player_id, now),
        refreshToken: nextToken, expiresAt: new Date(now.getTime() + ACCESS_SECONDS * 1000).toISOString(),
      };
    } catch (error) {
      // Replay revocation was already committed; do not undo it.
      if (!(error instanceof GuestCredentialError && error.code === 'REFRESH_REPLAY')) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

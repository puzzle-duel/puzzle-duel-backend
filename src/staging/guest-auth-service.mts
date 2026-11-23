/**
 * PZD-49 staging guest credentials. Not mounted on public HTTP until the
 * migration, TLS reverse proxy, rate limits and tournament verifier are ready.
 */
import { createHash, createHmac, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type pg from 'pg';

export const GUEST_ISSUER = 'https://staging.puzzle-duel.app';
export const GUEST_AUDIENCE = 'puzzle-duel-api';
const ACCESS_SECONDS = 15 * 60;
const REFRESH_DAYS = 30;
const ROTATION_RETRY_MS = 10 * 60 * 1000;
const ROTATION_ID = /^[0-9a-f]{32}$/;

/** Unique successor recoverable only with BOTH the previous secret and its
 * client-persisted 128-bit rotation ID. No plaintext successor is stored. */
function retryableSuccessor(previous: string, rotationId: string): string {
  return createHmac('sha512', Buffer.from(previous, 'utf8'))
    .update('PZD-GUEST-ROTATION-V1\n' + rotationId, 'utf8')
    .digest().subarray(0, 48).toString('base64url');
}


export class GuestCredentialError extends Error {
  readonly code: 'INVALID_REFRESH' | 'REFRESH_REPLAY' | 'REFRESH_EXPIRED';
  readonly diagnosticReason?: 'TOKEN_FORMAT_INVALID' | 'TOKEN_NOT_FOUND' | 'FAMILY_REVOKED' | 'FAMILY_MISSING';
  constructor(code: 'INVALID_REFRESH' | 'REFRESH_REPLAY' | 'REFRESH_EXPIRED',
    diagnosticReason?: 'TOKEN_FORMAT_INVALID' | 'TOKEN_NOT_FOUND' | 'FAMILY_REVOKED' | 'FAMILY_MISSING') {
    super(code);
    this.code = code;
    this.diagnosticReason = diagnosticReason;
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
  private readonly pool: pg.Pool;
  private readonly privateKey: KeyObject;
  private readonly keyId: string;
  private readonly retryableRotation: boolean;
  constructor(pool: pg.Pool, privateKey: KeyObject, keyId: string, retryableRotation = false) {
    if (!keyId || keyId.length > 128) throw new Error('Invalid signing key ID');
    this.pool = pool;
    this.privateKey = privateKey;
    this.keyId = keyId;
    this.retryableRotation = retryableRotation;
  }

  async create(now = new Date(), beforeCommit?: (credentials: { accessToken: string; refreshToken: string; expiresAt: string }, context: { client: pg.PoolClient; playerId: string }) => Promise<void>) {
    const playerId = randomUUID();
    const familyId = randomUUID();
    const refreshToken = opaqueToken();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO pzd_guest_accounts (player_id) VALUES ($1)', [playerId]);
      await client.query('INSERT INTO pzd_guest_families (family_id, player_id) VALUES ($1, $2)', [familyId, playerId]);
      await client.query(
        `INSERT INTO pzd_guest_refresh (family_id, player_id, token_digest, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [familyId, playerId, digest(refreshToken), new Date(now.getTime() + REFRESH_DAYS * 86400000)],
      );
      const credentials = {
        accessToken: accessJwt(this.privateKey, this.keyId, playerId, now),
        refreshToken, expiresAt: new Date(now.getTime() + ACCESS_SECONDS * 1000).toISOString(),
      };
      // Operator-only hook: persist credentials before committing identity.
      // If persistence fails, rollback prevents an orphaned account.
      if (beforeCommit) await beforeCommit(credentials, { client, playerId });
      await client.query('COMMIT');
      return credentials;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async logout(refreshToken: string, now = new Date()): Promise<void> {
    if (!/^[A-Za-z0-9_-]{64}$/.test(refreshToken)) {
      throw new GuestCredentialError('INVALID_REFRESH');
    }
    const result = await this.pool.query(
      `UPDATE pzd_guest_families SET revoked_at = $2
       WHERE family_id = (
         SELECT family_id FROM pzd_guest_refresh WHERE token_digest = $1
       ) AND revoked_at IS NULL`,
      [digest(refreshToken), now],
    );
    if (result.rowCount !== 1) throw new GuestCredentialError('INVALID_REFRESH');
  }

  async refresh(refreshToken: string, rotationId?: string, now = new Date()) {
    // Prevent enabled clients from silently rotating without retry guarantees.
    if (rotationId !== undefined && !this.retryableRotation) throw new Error('GUEST_RETRY_NOT_READY');
    if (rotationId !== undefined && !ROTATION_ID.test(rotationId)) {
      throw new GuestCredentialError('INVALID_REFRESH', 'TOKEN_FORMAT_INVALID');
    }
    if (!/^[A-Za-z0-9_-]{64}$/.test(refreshToken)) throw new GuestCredentialError('INVALID_REFRESH', 'TOKEN_FORMAT_INVALID');
    const tokenDigest = digest(refreshToken);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize every rotation within a family, including concurrent replay.
      const found = await client.query<{ family_id: string }>(
        'SELECT family_id FROM pzd_guest_refresh WHERE token_digest = $1', [tokenDigest],
      );
      const familyId = found.rows[0]?.family_id;
      if (!familyId) throw new GuestCredentialError('INVALID_REFRESH', 'TOKEN_NOT_FOUND');
      const familyLock = await client.query('SELECT family_id FROM pzd_guest_families WHERE family_id = $1 FOR UPDATE', [familyId]);
      if (familyLock.rowCount !== 1) throw new GuestCredentialError('INVALID_REFRESH', 'FAMILY_MISSING');
      const current = await client.query<{
        player_id: string; used_at: Date | null; revoked_at: Date | null; expires_at: Date;
        rotation_id_digest?: string | null;
      }>(
        `SELECT r.player_id, r.used_at, f.revoked_at, r.expires_at${this.retryableRotation ? ', r.rotation_id_digest' : ''}
         FROM pzd_guest_refresh r JOIN pzd_guest_families f USING (family_id)
         WHERE r.token_digest = $1 FOR UPDATE OF r`, [tokenDigest],
      );
      const row = current.rows[0];
      if (!row) throw new GuestCredentialError('INVALID_REFRESH', 'TOKEN_NOT_FOUND');
      if (row.revoked_at) throw new GuestCredentialError('INVALID_REFRESH', 'FAMILY_REVOKED');
      if (row.used_at) {
        if (this.retryableRotation && rotationId && row.rotation_id_digest === digest(rotationId) &&
            now.getTime() >= new Date(row.used_at).getTime() &&
            now.getTime() - new Date(row.used_at).getTime() <= ROTATION_RETRY_MS) {
          const sameNextToken = retryableSuccessor(refreshToken, rotationId);
          const successor = await client.query<{ used_at: Date | null }>(
            'SELECT used_at FROM pzd_guest_refresh WHERE family_id=$1 AND token_digest=$2',
            [familyId, digest(sameNextToken)],
          );
          if (successor.rowCount === 1 && successor.rows[0]?.used_at === null) {
            await client.query('COMMIT');
            return {
              accessToken: accessJwt(this.privateKey, this.keyId, row.player_id, now),
              refreshToken: sameNextToken,
              expiresAt: new Date(now.getTime() + ACCESS_SECONDS * 1000).toISOString(),
            };
          }
          // The exact previous request already succeeded, but its successor
          // has since been spent. A delayed duplicate is stale, not new proof
          // of theft. Reject without revealing successor or revoking family.
          if (successor.rowCount === 1 && successor.rows[0]?.used_at !== null) {
            throw new GuestCredentialError('INVALID_REFRESH');
          }
        }
        await client.query('UPDATE pzd_guest_families SET revoked_at = $2 WHERE family_id = $1', [familyId, now]);
        await client.query('COMMIT');
        throw new GuestCredentialError('REFRESH_REPLAY');
      }
      if (new Date(row.expires_at).getTime() <= now.getTime()) throw new GuestCredentialError('REFRESH_EXPIRED');
      const nextToken = this.retryableRotation && rotationId
        ? retryableSuccessor(refreshToken, rotationId) : opaqueToken();
      if (this.retryableRotation) {
        await client.query(
          'UPDATE pzd_guest_refresh SET used_at=$2, rotation_id_digest=$3 WHERE token_digest=$1',
          [tokenDigest, now, rotationId ? digest(rotationId) : null],
        );
      } else {
        await client.query('UPDATE pzd_guest_refresh SET used_at=$2 WHERE token_digest=$1', [tokenDigest, now]);
      }
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

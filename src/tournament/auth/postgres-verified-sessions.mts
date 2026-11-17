/**
 * PZD-40 identity & session persistence. Does not verify tokens itself:
 * the transport MUST call PinnedRs256JwtVerifier first and supply its result.
 * Provider subject is never the internal player_id; session secret is never
 * stored in plaintext. A session alone does not grant ranked series access.
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type pg from 'pg';
import type { VerifiedJwtIdentity } from './pinned-jwt-verifier.mts';

export const VERIFIED_IDENTITY_DDL = [
  'CREATE TABLE IF NOT EXISTS tournament_verified_identity (',
  'player_id UUID PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,',
  'UNIQUE (issuer, subject));',
  'CREATE TABLE IF NOT EXISTS tournament_auth_session (',
  'session_id UUID PRIMARY KEY,',
  'player_id UUID NOT NULL REFERENCES tournament_verified_identity(player_id),',
  'issuer TEXT NOT NULL, subject TEXT NOT NULL,',
  'device_id UUID NOT NULL, secret_digest TEXT NOT NULL UNIQUE,',
  'expires_at_ms BIGINT NOT NULL, revoked_at_ms BIGINT NULL);',
].join(' ');

export interface OpenedVerifiedSession {
  readonly playerId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  /** Return in TLS response once; never log or persist plaintext. */
  readonly sessionSecret: string;
  readonly expiresAtMs: number;
}
export interface VerifiedSession {
  readonly playerId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly expiresAtMs: number;
}
const digest = (secret: string): string => createHash('sha256').update(secret).digest('hex');
function isTrustedJwtObject(value: VerifiedJwtIdentity): boolean {
  return typeof value?.issuer === 'string' && value.issuer.startsWith('https://') &&
         typeof value.subject === 'string' && value.subject.length > 0 &&
         typeof value.expiresAt === 'number' && Number.isSafeInteger(value.expiresAt);
}

/** Open only after successful signature/issuer/audience verification. */
export class PostgresVerifiedIdentitySessionStore {
  readonly #pool: pg.Pool;
  constructor(pool: pg.Pool) { this.#pool = pool; }
  async migrate(): Promise<void> { await this.#pool.query(VERIFIED_IDENTITY_DDL); }

  async openAfterVerifiedJwt(identity: VerifiedJwtIdentity): Promise<OpenedVerifiedSession> {
    if (!isTrustedJwtObject(identity)) throw new Error('UNAUTHENTICATED');
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const time = await client.query("SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS ms");
      const nowMs = Number(time.rows[0].ms);
      const expiresAtMs = Math.min(identity.expiresAt * 1000, nowMs + 1_800_000);
      if (expiresAtMs <= nowMs) { await client.query('ROLLBACK'); throw new Error('UNAUTHENTICATED'); }
      const candidate = randomUUID();
      const inserted = await client.query(
        'INSERT INTO tournament_verified_identity (player_id, issuer, subject) VALUES ($1, $2, $3) ON CONFLICT (issuer,subject) DO NOTHING RETURNING player_id',
        [candidate, identity.issuer, identity.subject],
      );
      let playerId: string;
      if (inserted.rowCount) playerId = String(inserted.rows[0].player_id);
      else {
        const found = await client.query('SELECT player_id FROM tournament_verified_identity WHERE issuer=$1 AND subject=$2',
          [identity.issuer, identity.subject]);
        if (!found.rowCount) throw new Error('IDENTITY_CONFLICT');
        playerId = String(found.rows[0].player_id);
      }
      const sessionId = randomUUID();
      const deviceId = randomUUID();
      const sessionSecret = randomBytes(32).toString('base64url');
      await client.query(
        'INSERT INTO tournament_auth_session (session_id, player_id, issuer, subject, device_id, secret_digest, expires_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [sessionId, playerId, identity.issuer, identity.subject, deviceId, digest(sessionSecret), expiresAtMs],
      );
      await client.query('COMMIT');
      return Object.freeze({ playerId, sessionId, deviceId, sessionSecret, expiresAtMs });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    } finally { client.release(); }
  }

  async authenticateVerifiedSession(identity: VerifiedJwtIdentity, sessionSecret: string): Promise<VerifiedSession | null> {
    if (!isTrustedJwtObject(identity) || typeof sessionSecret !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(sessionSecret)) return null;
    const res = await this.#pool.query(
      `SELECT s.session_id, s.player_id, s.device_id, s.expires_at_ms
       FROM tournament_auth_session s
       WHERE s.secret_digest=$1 AND s.issuer=$2 AND s.subject=$3
         AND s.revoked_at_ms IS NULL
         AND s.expires_at_ms > floor(extract(epoch from clock_timestamp()) * 1000)::bigint`,
      [digest(sessionSecret), identity.issuer, identity.subject],
    );
    if (!res.rowCount) return null;
    const row = res.rows[0];
    return Object.freeze({
      sessionId: String(row.session_id),
      playerId: String(row.player_id),
      deviceId: String(row.device_id),
      expiresAtMs: Number(row.expires_at_ms),
    });
  }

  async revokeSession(identity: VerifiedJwtIdentity, sessionSecret: string): Promise<boolean> {
    if (!isTrustedJwtObject(identity) || typeof sessionSecret !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(sessionSecret)) return false;
    const res = await this.#pool.query(
      `UPDATE tournament_auth_session
       SET revoked_at_ms=floor(extract(epoch from clock_timestamp()) * 1000)::bigint
       WHERE secret_digest=$1 AND issuer=$2 AND subject=$3 AND revoked_at_ms IS NULL`,
      [digest(sessionSecret), identity.issuer, identity.subject],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

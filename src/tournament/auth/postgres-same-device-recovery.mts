/**
 * PZD-40 candidate: proof-of-possession same-device writer recovery.
 *
 * Never called by the existing device_handoff path. Ranked feature gating
 * and verified JWT + session authorization MUST precede these operations.
 * The original writer's registered key is pinned on first claim, never backfilled.
 */
import {
  createHash, createPublicKey, randomBytes, randomUUID, verify,
} from 'node:crypto';
import type pg from 'pg';
import type { VerifiedSession } from './postgres-verified-sessions.mts';
import { seriesAdvisoryKeys } from '../ingress/series-fence.mts';
import {
  canonicalDeviceRecoveryProof, verifyDeviceRecoveryProof,
  type DeviceRecoveryProofInput,
} from './device-recovery-proof.mts';

export const DEVICE_RECOVERY_DDL = [
  `CREATE TABLE IF NOT EXISTS tournament_device_credential (
    credential_id UUID PRIMARY KEY, player_id UUID NOT NULL
      REFERENCES tournament_verified_identity(player_id),
    key_sha256 TEXT NOT NULL, public_key_spki BYTEA NOT NULL,
    created_at_ms BIGINT NOT NULL, revoked_at_ms BIGINT NULL,
    UNIQUE (player_id, key_sha256)
  )`,
  `ALTER TABLE tournament_auth_session
    ADD COLUMN IF NOT EXISTS device_credential_id UUID NULL
      REFERENCES tournament_device_credential(credential_id)`,
  `ALTER TABLE tournament_series_writer
    ADD COLUMN IF NOT EXISTS original_device_credential_id UUID NULL
      REFERENCES tournament_device_credential(credential_id)`,
  `CREATE TABLE IF NOT EXISTS tournament_writer_recovery_challenge (
    challenge_id UUID PRIMARY KEY,
    series_key TEXT NOT NULL, player_id UUID NOT NULL,
    new_session_id UUID NOT NULL, credential_id UUID NOT NULL,
    nonce TEXT NOT NULL, expected_generation BIGINT NOT NULL,
    expires_at_ms BIGINT NOT NULL,
    consumed_at_ms BIGINT NULL, request_sha256 TEXT NULL, result_json JSONB NULL
  )`,
].join(';\n') + ';';

type RecoveryStatus =
  | 'SERIES_NOT_OWNED' | 'RECOVERY_NOT_ELIGIBLE'
  | 'RECOVERY_PROOF_INVALID' | 'WRITER_STILL_ACTIVE'
  | 'STALE_WRITER' | 'SERIES_TERMINAL' | 'IDLE_EXPIRED'
  | 'HARD_CUTOFF_EXPIRED' | 'SERIES_STATE_INCONSISTENT';

export type RecoveryResult<T> = { ok: true; data: T } |
  { ok: false; reason: RecoveryStatus };
export interface RecoveryChallenge {
  challengeId: string;
  deviceCredentialId: string;
  nonce: string;
  expectedWriterGeneration: number;
  expiresAtMs: number;
}
export interface RecoveryReceipt {
  writerGeneration: number;
  boardRevision: number;
  seriesId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const fail = <T>(reason: RecoveryStatus): RecoveryResult<T> => ({ ok: false, reason });

function validKey(key: Buffer): boolean {
  if (key.length < 80 || key.length > 128) return false;
  try {
    const parsed = createPublicKey({ key, format: 'der', type: 'spki' });
    return parsed.asymmetricKeyType === 'ec' &&
      parsed.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch { return false; }
}
function asStrictBase64Url(value: string, min: number, max: number): Buffer | null {
  if (typeof value !== 'string' || value.length < min || value.length > max ||
      !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const buf = Buffer.from(value, 'base64url');
    return buf.toString('base64url') === value ? buf : null;
  } catch { return null; }
}
function safeTime(ms: unknown): number {
  const n = Number(ms);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('RECOVERY_CLOCK_INVALID');
  return n;
}
async function dbNow(client: pg.PoolClient): Promise<number> {
  const q = await client.query(
    'SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS ms',
  );
  return safeTime(q.rows[0]?.ms);
}

/**
 * Register an account-scoped device key with proof bound to the current
 * authenticated session. New registrations NEVER authorize an old series.
 */
export class PostgresSameDeviceRecovery {
  readonly #pool: pg.Pool;
  constructor(pool: pg.Pool) { this.#pool = pool; }
  async migrate(): Promise<void> { await this.#pool.query(DEVICE_RECOVERY_DDL); }

  async registerKey(args: {
    session: VerifiedSession;
    spkiBase64Url: string;
    signatureBase64Url: string;
  }): Promise<RecoveryResult<{ deviceCredentialId: string }>> {
    const spki = asStrictBase64Url(args.spkiBase64Url, 100, 180);
    const signature = asStrictBase64Url(args.signatureBase64Url, 88, 100);
    if (!spki || !signature || !validKey(spki) || signature.length < 68 ||
        signature.length > 73) return fail('RECOVERY_PROOF_INVALID');
    const keyHash = HASH(spki);
    const message = Buffer.from(
      ['PZD-REGISTER-DEVICE-V1', args.session.playerId.toLowerCase(),
        args.session.sessionId.toLowerCase(), keyHash].join('\n'),
    );
    try {
      const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
      if (!verify('sha256', message, key, signature)) return fail('RECOVERY_PROOF_INVALID');
    } catch { return fail('RECOVERY_PROOF_INVALID'); }
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT device_credential_id FROM tournament_auth_session
         WHERE session_id=$1 AND player_id=$2 AND
         revoked_at_ms IS NULL AND
         expires_at_ms > floor(extract(epoch from clock_timestamp()) * 1000)::bigint
         FOR UPDATE`,
        [args.session.sessionId, args.session.playerId],
      );
      if (current.rowCount !== 1) {
        await client.query('ROLLBACK');
        return fail('RECOVERY_NOT_ELIGIBLE');
      }
      if (current.rows[0]?.device_credential_id) {
        const registered = await client.query(
          `SELECT credential_id FROM tournament_device_credential
           WHERE credential_id=$1 AND player_id=$2 AND
           key_sha256=$3 AND revoked_at_ms IS NULL`,
          [current.rows[0].device_credential_id, args.session.playerId, keyHash],
        );
        await client.query('COMMIT');
        return registered.rowCount === 1
          ? { ok: true, data: { deviceCredentialId: String(registered.rows[0].credential_id) } }
          : fail('RECOVERY_NOT_ELIGIBLE');
      }
      const now = await dbNow(client);
      const id = randomUUID();
      const row = await client.query(
        `INSERT INTO tournament_device_credential
         (credential_id,player_id,key_sha256,public_key_spki,created_at_ms)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (player_id,key_sha256) DO UPDATE
         SET key_sha256=EXCLUDED.key_sha256
         RETURNING credential_id,revoked_at_ms`,
        [id, args.session.playerId, keyHash, spki, now],
      );
      if (row.rowCount !== 1 || row.rows[0].revoked_at_ms !== null) {
        await client.query('ROLLBACK');
        return fail('RECOVERY_NOT_ELIGIBLE');
      }
      const credentialId = String(row.rows[0].credential_id);
      const updated = await client.query(
        `UPDATE tournament_auth_session SET device_credential_id=$3
         WHERE session_id=$1 AND player_id=$2 AND device_credential_id IS NULL`,
        [args.session.sessionId, args.session.playerId, credentialId],
      );
      if (updated.rowCount !== 1) throw new Error('REGISTRATION_INTEGRITY');
      await client.query('COMMIT');
      return { ok: true, data: { deviceCredentialId: credentialId } };
    } catch {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      return fail('RECOVERY_NOT_ELIGIBLE');
    } finally { client.release(); }
  }

  /**
   * Issue challenge for original writer's pinned credential only.
   * This does not change the writer, deadlines or scores.
   */
  async issueChallenge(args: {
    session: VerifiedSession; seriesId: string;
  }): Promise<RecoveryResult<RecoveryChallenge>> {
    if (!UUID.test(args.seriesId)) return fail('SERIES_NOT_OWNED');
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const writer = await client.query(
        `SELECT w.writer_generation,w.session_id,w.original_device_credential_id,
                s.expires_at_ms,s.revoked_at_ms,c.player_id,
                d.revoked_at_ms AS credential_revoked,
                snew.device_credential_id AS new_credential_id
         FROM tournament_series_writer w
         JOIN tournament_daily_claim c ON c.series_id::text=w.series_key
         JOIN tournament_auth_session s ON s.session_id=w.session_id
         LEFT JOIN tournament_device_credential d ON
           d.credential_id=w.original_device_credential_id
         JOIN tournament_auth_session snew ON snew.session_id=$3
         WHERE w.series_key=$1 AND w.player_id=$2 AND c.player_id=$2
           AND snew.player_id=$2`,
        [args.seriesId, args.session.playerId, args.session.sessionId],
      );
      if (writer.rowCount !== 1) {
        await client.query('ROLLBACK');
        return fail('SERIES_NOT_OWNED');
      }
      const w = writer.rows[0];
      const now = await dbNow(client);
      if (!w.original_device_credential_id ||
          w.credential_revoked !== null ||
          w.new_credential_id !== w.original_device_credential_id) {
        await client.query('ROLLBACK');
        return fail('RECOVERY_NOT_ELIGIBLE');
      }
      if (w.session_id === args.session.sessionId ||
          (w.revoked_at_ms === null && safeTime(w.expires_at_ms) > now)) {
        await client.query('ROLLBACK');
        return fail('WRITER_STILL_ACTIVE');
      }
      const fence = await client.query(
        `SELECT status,idle_deadline_at_ms,hard_cutoff_at_ms,writer_generation
         FROM series_fence_state WHERE series_key=$1`, [args.seriesId],
      );
      if (fence.rowCount !== 1) {
        await client.query('ROLLBACK');
        return fail('SERIES_STATE_INCONSISTENT');
      }
      const f = fence.rows[0];
      if (f.status === 'COMPLETED' || f.status === 'FORFEITED') {
        await client.query('ROLLBACK');
        return fail('SERIES_TERMINAL');
      }
      if (safeTime(f.idle_deadline_at_ms) < now) {
        await client.query('ROLLBACK');
        return fail('IDLE_EXPIRED');
      }
      if (f.hard_cutoff_at_ms === null || safeTime(f.hard_cutoff_at_ms) < now) {
        await client.query('ROLLBACK');
        return fail('HARD_CUTOFF_EXPIRED');
      }
      if (Number(f.writer_generation) !== Number(w.writer_generation)) {
        await client.query('ROLLBACK');
        return fail('SERIES_STATE_INCONSISTENT');
      }
      const challengeId = randomUUID();
      const nonce = randomBytes(32).toString('base64url');
      const expiresAtMs = Math.min(now + 60_000,
        safeTime(f.idle_deadline_at_ms), safeTime(f.hard_cutoff_at_ms));
      const expectedWriterGeneration = Number(w.writer_generation);
      await client.query(
        `INSERT INTO tournament_writer_recovery_challenge
         (challenge_id,series_key,player_id,new_session_id,credential_id,
          nonce,expected_generation,expires_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [challengeId, args.seriesId, args.session.playerId,
          args.session.sessionId, w.original_device_credential_id, nonce,
          expectedWriterGeneration, expiresAtMs],
      );
      await client.query('COMMIT');
      return { ok: true, data: {
        challengeId, deviceCredentialId: String(w.original_device_credential_id),
        nonce, expectedWriterGeneration, expiresAtMs,
      } };
    } catch {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      return fail('RECOVERY_NOT_ELIGIBLE');
    } finally { client.release(); }
  }

  async recover(args: {
    session: VerifiedSession; seriesId: string;
    proof: DeviceRecoveryProofInput; signatureBase64Url: string;
  }): Promise<RecoveryResult<RecoveryReceipt>> {
    const { session, seriesId, proof } = args;
    if (!UUID.test(seriesId) ||
        proof.seriesId !== seriesId || proof.playerId !== session.playerId ||
        proof.newSessionId !== session.sessionId) return fail('RECOVERY_PROOF_INVALID');
    let requestHash: string;
    try {
      requestHash = HASH(canonicalDeviceRecoveryProof(proof) + '\n' +
        args.signatureBase64Url);
    } catch { return fail('RECOVERY_PROOF_INVALID'); }
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const [k1,k2] = seriesAdvisoryKeys(seriesId);
      await client.query('SELECT pg_advisory_xact_lock($1,$2)', [k1,k2]);
      const now = await dbNow(client);
      const challenge = await client.query(
        `SELECT * FROM tournament_writer_recovery_challenge
         WHERE challenge_id=$1 FOR UPDATE`, [proof.challengeId],
      );
      if (challenge.rowCount !== 1) {
        await client.query('ROLLBACK');
        return fail('RECOVERY_PROOF_INVALID');
      }
      const c = challenge.rows[0];
      if (c.series_key !== seriesId || c.player_id !== session.playerId ||
          c.new_session_id !== session.sessionId ||
          c.credential_id !== proof.deviceCredentialId ||
          c.nonce !== proof.nonce ||
          Number(c.expected_generation) !== proof.expectedWriterGeneration ||
          Number(c.expires_at_ms) !== proof.expiresAtMs) {
        await client.query('ROLLBACK');
        return fail('RECOVERY_PROOF_INVALID');
      }
      // Immutable retry of exactly the same signed request.
      if (c.consumed_at_ms !== null) {
        await client.query('COMMIT');
        return c.request_sha256 === requestHash && c.result_json
          ? { ok: true, data: c.result_json as RecoveryReceipt }
          : fail('RECOVERY_PROOF_INVALID');
      }
      if (now >= safeTime(c.expires_at_ms)) {
        await client.query('ROLLBACK');
        return fail('RECOVERY_PROOF_INVALID');
      }
      const writer = await client.query(
        `SELECT * FROM tournament_series_writer
         WHERE series_key=$1 FOR UPDATE`, [seriesId],
      );
      if (writer.rowCount !== 1 || writer.rows[0].player_id !== session.playerId) {
        await client.query('ROLLBACK');
        return fail('SERIES_NOT_OWNED');
      }
      const w = writer.rows[0];
      if (!w.original_device_credential_id ||
          w.original_device_credential_id !== proof.deviceCredentialId) {
        await client.query('ROLLBACK');
        return fail('RECOVERY_NOT_ELIGIBLE');
      }
      if (Number(w.writer_generation) !== proof.expectedWriterGeneration) {
        await client.query('ROLLBACK');
        return fail('STALE_WRITER');
      }
      const cred = await client.query(
        `SELECT public_key_spki FROM tournament_device_credential
         WHERE credential_id=$1 AND player_id=$2 AND revoked_at_ms IS NULL`,
        [proof.deviceCredentialId, session.playerId],
      );
      if (cred.rowCount !== 1 ||
          !verifyDeviceRecoveryProof({
            input: proof,
            registeredPublicKeySpkiDer: cred.rows[0].public_key_spki as Buffer,
            signatureBase64Url: args.signatureBase64Url, serverNowMs: now,
          })) {
        await client.query('ROLLBACK');
        return fail('RECOVERY_PROOF_INVALID');
      }
      const oldSession = await client.query(
        `SELECT expires_at_ms,revoked_at_ms FROM tournament_auth_session
         WHERE session_id=$1 AND player_id=$2`,
        [w.session_id,session.playerId],
      );
      if (oldSession.rowCount !== 1 ||
          (oldSession.rows[0].revoked_at_ms === null &&
           safeTime(oldSession.rows[0].expires_at_ms) > now)) {
        await client.query('ROLLBACK');
        return fail('WRITER_STILL_ACTIVE');
      }
      const activeSession = await client.query(
        `SELECT device_id,device_credential_id FROM tournament_auth_session
         WHERE session_id=$1 AND player_id=$2 AND revoked_at_ms IS NULL
         AND expires_at_ms > $3`,
        [session.sessionId, session.playerId, now],
      );
      if (activeSession.rowCount !== 1 ||
          activeSession.rows[0].device_credential_id !== proof.deviceCredentialId) {
        await client.query('ROLLBACK');
        return fail('RECOVERY_NOT_ELIGIBLE');
      }
      const claim = await client.query(
        `SELECT status FROM tournament_daily_claim
         WHERE series_id=$1 AND player_id=$2`, [seriesId,session.playerId],
      );
      if (claim.rowCount !== 1 || claim.rows[0].status === 'COMPLETED') {
        await client.query('ROLLBACK');
        return fail('SERIES_NOT_OWNED');
      }
      const fence = await client.query(
        `SELECT * FROM series_fence_state WHERE series_key=$1 FOR UPDATE`,
        [seriesId],
      );
      if (fence.rowCount !== 1) {
        await client.query('ROLLBACK');
        return fail('SERIES_STATE_INCONSISTENT');
      }
      const f = fence.rows[0];
      if (f.status === 'COMPLETED' || f.status === 'FORFEITED') {
        await client.query('ROLLBACK');
        return fail('SERIES_TERMINAL');
      }
      if (now > safeTime(f.idle_deadline_at_ms)) {
        await client.query('ROLLBACK');
        return fail('IDLE_EXPIRED');
      }
      if (f.hard_cutoff_at_ms === null || now > safeTime(f.hard_cutoff_at_ms)) {
        await client.query('ROLLBACK');
        return fail('HARD_CUTOFF_EXPIRED');
      }
      if (Number(f.writer_generation) !== proof.expectedWriterGeneration) {
        await client.query('ROLLBACK');
        return fail('STALE_WRITER');
      }
      const snapshots = await client.query(
        `SELECT subgame_ordinal FROM authoritative_game_snapshot
         WHERE series_key=$1 AND player_id=$2 ORDER BY subgame_ordinal DESC`,
        [seriesId,session.playerId],
      );
      if (!snapshots.rowCount || snapshots.rowCount > 6) {
        await client.query('ROLLBACK');
        return fail('SERIES_STATE_INCONSISTENT');
      }
      const ordinal = Number(snapshots.rows[0].subgame_ordinal);
      if (snapshots.rows.some((row: Record<string, unknown>, i: number) =>
        Number(row.subgame_ordinal) !== ordinal - i)) {
        await client.query('ROLLBACK');
        return fail('SERIES_STATE_INCONSISTENT');
      }
      const generation = proof.expectedWriterGeneration + 1;
      const updatedWriter = await client.query(
        `UPDATE tournament_series_writer SET session_id=$2,device_id=$3,
         writer_generation=$4,updated_at_ms=$5 WHERE series_key=$1
         AND writer_generation=$6`,
        [seriesId,session.sessionId,activeSession.rows[0].device_id,
          generation,now,proof.expectedWriterGeneration],
      );
      const updatedFence = await client.query(
        `UPDATE series_fence_state SET writer_generation=$2
         WHERE series_key=$1 AND writer_generation=$3`,
        [seriesId,generation,proof.expectedWriterGeneration],
      );
      const updatedSnapshot = await client.query(
        `UPDATE authoritative_game_snapshot SET writer_generation=$4
         WHERE series_key=$1 AND player_id=$2 AND subgame_ordinal=$3
         AND writer_generation=$5`,
        [seriesId,session.playerId,ordinal,generation,proof.expectedWriterGeneration],
      );
      if (updatedWriter.rowCount !== 1 || updatedFence.rowCount !== 1 ||
          updatedSnapshot.rowCount !== 1) throw new Error('RECOVERY_INTEGRITY');
      const receipt: RecoveryReceipt = {
        seriesId, writerGeneration: generation, boardRevision: Number(f.board_revision),
      };
      const consumed = await client.query(
        `UPDATE tournament_writer_recovery_challenge SET
         consumed_at_ms=$2,request_sha256=$3,result_json=$4::jsonb
         WHERE challenge_id=$1 AND consumed_at_ms IS NULL`,
        [proof.challengeId,now,requestHash,JSON.stringify(receipt)],
      );
      if (consumed.rowCount !== 1) throw new Error('RECOVERY_CHALLENGE_INTEGRITY');
      await client.query('COMMIT');
      return { ok: true, data: receipt };
    } catch {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      return fail('RECOVERY_NOT_ELIGIBLE');
    } finally { client.release(); }
  }
}

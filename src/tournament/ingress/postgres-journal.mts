import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { IngressClock } from './clock.mts';
import type { AdmissionJournal } from './journal.mts';
import type {
  AdmitCommandInput,
  AdmitResult,
  AdmittedCommand,
} from './types.mts';

export const ADMISSION_JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS command_admission_journal (
  admission_id UUID PRIMARY KEY,
  series_key TEXT NOT NULL,
  player_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  -- Epoch milliseconds: preserves exclusive deadline-1ms proofs (no timestamptz truncation).
  trusted_received_at_ms BIGINT NOT NULL,
  admission_seq BIGINT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (series_key, player_id, idempotency_key),
  UNIQUE (series_key, admission_seq)
);

CREATE INDEX IF NOT EXISTS command_admission_journal_pending_idx
  ON command_admission_journal (series_key, trusted_received_at_ms)
  WHERE outcome = 'pending';
`;

/**
 * PostgreSQL-backed durable ingress journal.
 * trusted_received_at is supplied by the ingress clock at admit time and stored
 * immutably — never rewritten on retry or late adjudication.
 */
export class PostgresAdmissionJournal implements AdmissionJournal {
  readonly #pool: pg.Pool;
  readonly #clock: IngressClock;

  constructor(pool: pg.Pool, clock: IngressClock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async migrate(): Promise<void> {
    await this.#pool.query(ADMISSION_JOURNAL_DDL);
  }

  async admit(input: AdmitCommandInput): Promise<AdmitResult> {
    const trustedReceivedAt = this.#clock.now();
    const admissionId = randomUUID();

    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query(
        `SELECT * FROM command_admission_journal
         WHERE series_key = $1 AND player_id = $2 AND idempotency_key = $3
         FOR UPDATE`,
        [input.seriesKey, input.playerId, input.idempotencyKey],
      );

      if (existing.rowCount && existing.rows[0]) {
        await client.query('COMMIT');
        const row = this.#map(existing.rows[0]);
        if (row.payloadHash !== input.payloadHash) {
          return {
            ok: false,
            reason: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
            existing: row,
          };
        }
        return { ok: true, command: { ...row, status: 'duplicate' } };
      }

      const seqRes = await client.query(
        `SELECT COALESCE(MAX(admission_seq), 0) + 1 AS next_seq
         FROM command_admission_journal WHERE series_key = $1`,
        [input.seriesKey],
      );
      const admissionSeq = Number(seqRes.rows[0].next_seq);

      await client.query(
        `INSERT INTO command_admission_journal (
           admission_id, series_key, player_id, command_type,
           idempotency_key, payload_hash, trusted_received_at_ms,
           admission_seq, outcome
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
        [
          admissionId,
          input.seriesKey,
          input.playerId,
          input.commandType,
          input.idempotencyKey,
          input.payloadHash,
          trustedReceivedAt.getTime(),
          admissionSeq,
        ],
      );

      await client.query('COMMIT');
      return {
        ok: true,
        command: {
          admissionId,
          seriesKey: input.seriesKey,
          playerId: input.playerId,
          commandType: input.commandType,
          idempotencyKey: input.idempotencyKey,
          payloadHash: input.payloadHash,
          trustedReceivedAt,
          admissionSeq,
          status: 'admitted',
        },
      };
    } catch {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      // Fail closed: no fabricated admission (X-01 A).
      return { ok: false, reason: 'INGRESS_UNAVAILABLE' };
    } finally {
      client.release();
    }
  }

  async getByIdempotency(
    seriesKey: string,
    playerId: string,
    idempotencyKey: string,
  ): Promise<AdmittedCommand | null> {
    const res = await this.#pool.query(
      `SELECT * FROM command_admission_journal
       WHERE series_key = $1 AND player_id = $2 AND idempotency_key = $3`,
      [seriesKey, playerId, idempotencyKey],
    );
    if (!res.rowCount) return null;
    return this.#map(res.rows[0]);
  }

  async maxAdmissionSeq(seriesKey: string): Promise<number> {
    const res = await this.#pool.query(
      `SELECT COALESCE(MAX(admission_seq), 0) AS m
       FROM command_admission_journal WHERE series_key = $1`,
      [seriesKey],
    );
    return Number(res.rows[0].m);
  }

  async listEligiblePending(
    seriesKey: string,
    cutoffExclusive: Date,
  ): Promise<AdmittedCommand[]> {
    const res = await this.#pool.query(
      `SELECT * FROM command_admission_journal
       WHERE series_key = $1
         AND outcome = 'pending'
         AND trusted_received_at_ms < $2
       ORDER BY admission_seq ASC`,
      [seriesKey, cutoffExclusive.getTime()],
    );
    return res.rows.map((row) => this.#map(row));
  }

  async markOutcome(
    admissionId: string,
    outcome: 'applied' | 'rejected' | 'pending',
  ): Promise<void> {
    await this.#pool.query(
      `UPDATE command_admission_journal SET outcome = $2 WHERE admission_id = $1`,
      [admissionId, outcome],
    );
  }

  #map(row: Record<string, unknown>): AdmittedCommand {
    return {
      admissionId: String(row.admission_id),
      seriesKey: String(row.series_key),
      playerId: String(row.player_id),
      commandType: row.command_type as AdmittedCommand['commandType'],
      idempotencyKey: String(row.idempotency_key),
      payloadHash: String(row.payload_hash),
      trustedReceivedAt: new Date(Number(row.trusted_received_at_ms)),
      admissionSeq: Number(row.admission_seq),
      status: 'admitted',
    };
  }
}

import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { IngressClock } from './clock.mts';
import type { AdmissionJournal } from './journal.mts';
import type {
  AdmitCommandInput,
  AdmitResult,
  AdmittedCommand,
  CommandOutcomeStatus,
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
  expected_board_revision BIGINT NULL,
  writer_generation BIGINT NULL,
  score_delta BIGINT NULL,
  completes_series BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (series_key, player_id, idempotency_key),
  UNIQUE (series_key, admission_seq)
);

CREATE INDEX IF NOT EXISTS command_admission_journal_pending_idx
  ON command_admission_journal (series_key, trusted_received_at_ms)
  WHERE outcome = 'pending';
`;

function seriesAdvisoryKeys(seriesKey: string): [number, number] {
  const digest = createHash('sha256').update(seriesKey).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * PostgreSQL-backed durable ingress journal.
 * trusted_received_at_ms is captured under a per-series advisory lock inside the
 * admission transaction — never replaced by lock/commit time at adjudication.
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
    const admissionId = randomUUID();
    let client: pg.PoolClient | null = null;
    try {
      client = await this.#pool.connect();
      await client.query('BEGIN');
      const [k1, k2] = seriesAdvisoryKeys(input.seriesKey);
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);

      const existing = await client.query(
        `SELECT * FROM command_admission_journal
         WHERE series_key = $1 AND player_id = $2 AND idempotency_key = $3`,
        [input.seriesKey, input.playerId, input.idempotencyKey],
      );

      if (existing.rowCount && existing.rows[0]) {
        await client.query('COMMIT');
        const row = this.#map(existing.rows[0]);
        const outcome = String(existing.rows[0].outcome) as CommandOutcomeStatus;
        if (row.payloadHash !== input.payloadHash) {
          return {
            ok: false,
            reason: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
            existing: row,
            outcome,
          };
        }
        return {
          ok: true,
          command: { ...row, status: 'duplicate' },
          outcome,
        };
      }

      // Trusted receipt AFTER series admission lock, BEFORE insert commit.
      const trustedReceivedAt = this.#clock.now();

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
           admission_seq, outcome, expected_board_revision, writer_generation,
           score_delta, completes_series
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12)`,
        [
          admissionId,
          input.seriesKey,
          input.playerId,
          input.commandType,
          input.idempotencyKey,
          input.payloadHash,
          trustedReceivedAt.getTime(),
          admissionSeq,
          input.expectedBoardRevision ?? null,
          input.writerGeneration ?? null,
          input.scoreDelta ?? null,
          input.completesSeries ?? false,
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
          expectedBoardRevision: input.expectedBoardRevision,
          writerGeneration: input.writerGeneration,
          scoreDelta: input.scoreDelta,
          completesSeries: input.completesSeries,
        },
        outcome: 'pending',
      };
    } catch {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore
        }
      }
      // Fail closed: no fabricated admission (X-01 A).
      return { ok: false, reason: 'INGRESS_UNAVAILABLE' };
    } finally {
      client?.release();
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

  async getOutcome(admissionId: string): Promise<CommandOutcomeStatus> {
    const res = await this.#pool.query(
      `SELECT outcome FROM command_admission_journal WHERE admission_id = $1`,
      [admissionId],
    );
    if (!res.rowCount) return 'unknown';
    return String(res.rows[0].outcome) as CommandOutcomeStatus;
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

  async listEligiblePendingForSeries(
    seriesKeys: string[],
    cutoffExclusive: Date,
  ): Promise<AdmittedCommand[]> {
    if (seriesKeys.length === 0) return [];
    const res = await this.#pool.query(
      `SELECT * FROM command_admission_journal
       WHERE series_key = ANY($1::text[])
         AND outcome = 'pending'
         AND trusted_received_at_ms < $2
       ORDER BY series_key ASC, admission_seq ASC`,
      [seriesKeys, cutoffExclusive.getTime()],
    );
    return res.rows.map((row) => this.#map(row));
  }

  async markOutcome(
    admissionId: string,
    outcome: 'applied' | 'rejected' | 'pending',
  ): Promise<boolean> {
    if (outcome === 'pending') {
      const res = await this.#pool.query(
        `UPDATE command_admission_journal SET outcome = 'pending' WHERE admission_id = $1`,
        [admissionId],
      );
      return (res.rowCount ?? 0) > 0;
    }
    const res = await this.#pool.query(
      `UPDATE command_admission_journal
       SET outcome = $2
       WHERE admission_id = $1 AND outcome = 'pending'`,
      [admissionId, outcome],
    );
    return (res.rowCount ?? 0) > 0;
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
      expectedBoardRevision:
        row.expected_board_revision == null
          ? undefined
          : Number(row.expected_board_revision),
      writerGeneration:
        row.writer_generation == null
          ? undefined
          : Number(row.writer_generation),
      scoreDelta: row.score_delta == null ? undefined : Number(row.score_delta),
      completesSeries: Boolean(row.completes_series),
    };
  }
}

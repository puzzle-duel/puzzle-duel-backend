import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { SeriesFenceState, SeriesTerminalStatus } from './types.mts';

export const SERIES_FENCE_DDL = `
CREATE TABLE IF NOT EXISTS series_fence_state (
  series_key TEXT PRIMARY KEY,
  board_revision BIGINT NOT NULL,
  writer_generation BIGINT NOT NULL,
  status TEXT NOT NULL,
  idle_deadline_at_ms BIGINT NOT NULL,
  hard_cutoff_at_ms BIGINT NULL,
  score BIGINT NOT NULL DEFAULT 0,
  results_published BOOLEAN NOT NULL DEFAULT FALSE,
  last_applied_admission_id UUID NULL,
  thinking_extension_consumed BOOLEAN NOT NULL DEFAULT FALSE
);
`;

export function seriesAdvisoryKeys(seriesKey: string): [number, number] {
  const digest = createHash('sha256').update(seriesKey).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export interface SeriesFenceStore {
  get(seriesKey: string): Promise<SeriesFenceState | null>;
  put(state: SeriesFenceState): Promise<void>;
  /**
   * Atomically apply a CAS mutation under exclusive series lock.
   * Returns updated state or conflict reason without mutating on failure.
   */
  mutate(
    seriesKey: string,
    fn: (
      current: SeriesFenceState,
    ) =>
      | { ok: true; next: SeriesFenceState }
      | { ok: false; reason: string; current: SeriesFenceState },
  ): Promise<
    | { ok: true; state: SeriesFenceState }
    | { ok: false; reason: string; state: SeriesFenceState }
  >;
}

function mapFence(row: Record<string, unknown>): SeriesFenceState {
  return {
    seriesKey: String(row.series_key),
    boardRevision: Number(row.board_revision),
    writerGeneration: Number(row.writer_generation),
    status: String(row.status) as SeriesTerminalStatus,
    idleDeadlineAt: new Date(Number(row.idle_deadline_at_ms)),
    hardCutoffAt:
      row.hard_cutoff_at_ms == null
        ? null
        : new Date(Number(row.hard_cutoff_at_ms)),
    score: Number(row.score),
    resultsPublished: Boolean(row.results_published),
    lastAppliedAdmissionId:
      row.last_applied_admission_id == null
        ? null
        : String(row.last_applied_admission_id),
    thinkingExtensionConsumed: Boolean(row.thinking_extension_consumed),
  };
}

async function writeFence(
  client: pg.Pool | pg.PoolClient,
  state: SeriesFenceState,
): Promise<void> {
  await client.query(
    `INSERT INTO series_fence_state (
       series_key, board_revision, writer_generation, status,
       idle_deadline_at_ms, hard_cutoff_at_ms, score, results_published,
       last_applied_admission_id, thinking_extension_consumed
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (series_key) DO UPDATE SET
       board_revision = EXCLUDED.board_revision,
       writer_generation = EXCLUDED.writer_generation,
       status = EXCLUDED.status,
       idle_deadline_at_ms = EXCLUDED.idle_deadline_at_ms,
       hard_cutoff_at_ms = EXCLUDED.hard_cutoff_at_ms,
       score = EXCLUDED.score,
       results_published = EXCLUDED.results_published,
       last_applied_admission_id = EXCLUDED.last_applied_admission_id,
       thinking_extension_consumed = EXCLUDED.thinking_extension_consumed`,
    [
      state.seriesKey,
      state.boardRevision,
      state.writerGeneration,
      state.status,
      state.idleDeadlineAt.getTime(),
      state.hardCutoffAt ? state.hardCutoffAt.getTime() : null,
      state.score,
      state.resultsPublished,
      state.lastAppliedAdmissionId,
      state.thinkingExtensionConsumed,
    ],
  );
}

export class MemorySeriesFenceStore implements SeriesFenceStore {
  #rows = new Map<string, SeriesFenceState>();
  #locks = new Map<string, Promise<void>>();

  async get(seriesKey: string): Promise<SeriesFenceState | null> {
    const row = this.#rows.get(seriesKey);
    return row ? { ...row } : null;
  }

  async put(state: SeriesFenceState): Promise<void> {
    this.#rows.set(state.seriesKey, { ...state });
  }

  async mutate(
    seriesKey: string,
    fn: (
      current: SeriesFenceState,
    ) =>
      | { ok: true; next: SeriesFenceState }
      | { ok: false; reason: string; current: SeriesFenceState },
  ) {
    return this.#withLock(seriesKey, async () => {
      const current = this.#rows.get(seriesKey);
      if (!current) {
        throw new Error(`series fence missing: ${seriesKey}`);
      }
      const result = fn({ ...current });
      if (!result.ok) {
        return { ok: false as const, reason: result.reason, state: { ...current } };
      }
      this.#rows.set(seriesKey, { ...result.next });
      return { ok: true as const, state: { ...result.next } };
    });
  }

  /** Run fn under the same exclusive series lock used by mutate. */
  async withSeriesLock<T>(seriesKey: string, fn: () => Promise<T>): Promise<T> {
    return this.#withLock(seriesKey, fn);
  }

  async #withLock<T>(seriesKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(seriesKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(
      seriesKey,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class PostgresSeriesFenceStore implements SeriesFenceStore {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async migrate(): Promise<void> {
    await this.#pool.query(SERIES_FENCE_DDL);
    await this.#pool.query(
      `ALTER TABLE series_fence_state
       ADD COLUMN IF NOT EXISTS thinking_extension_consumed BOOLEAN NOT NULL DEFAULT FALSE`,
    );
  }

  async get(seriesKey: string): Promise<SeriesFenceState | null> {
    const res = await this.#pool.query(
      `SELECT * FROM series_fence_state WHERE series_key = $1`,
      [seriesKey],
    );
    if (!res.rowCount) return null;
    return mapFence(res.rows[0]);
  }

  async put(state: SeriesFenceState): Promise<void> {
    await writeFence(this.#pool, state);
  }

  async mutate(
    seriesKey: string,
    fn: (
      current: SeriesFenceState,
    ) =>
      | { ok: true; next: SeriesFenceState }
      | { ok: false; reason: string; current: SeriesFenceState },
  ) {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // Same advisory key ordering as PostgresAdmissionJournal.admit (P1-03).
      const [k1, k2] = seriesAdvisoryKeys(seriesKey);
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);
      const res = await client.query(
        `SELECT * FROM series_fence_state WHERE series_key = $1 FOR UPDATE`,
        [seriesKey],
      );
      if (!res.rowCount) {
        await client.query('ROLLBACK');
        throw new Error(`series fence missing: ${seriesKey}`);
      }
      const current = mapFence(res.rows[0]);
      const result = fn({ ...current });
      if (!result.ok) {
        await client.query('ROLLBACK');
        return { ok: false as const, reason: result.reason, state: current };
      }
      await writeFence(client, result.next);
      await client.query('COMMIT');
      return { ok: true as const, state: result.next };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Atomic inactivity forfeit under the same advisory+row lock ordering as admit.
   *
   * Optional `beforeLockedBarrier` runs BEFORE acquiring locks so tests can
   * interleave a concurrent predeadline admission (TOCTOU reproduction), then
   * the locked section re-checks pending and only forfeits if still empty.
   */
  async tryForfeitAtomically(
    seriesKey: string,
    listEligiblePending: (
      client: pg.PoolClient | pg.Pool,
      idleDeadlineAt: Date,
    ) => Promise<number>,
    options?: { beforeLockedBarrier?: () => Promise<void> },
  ): Promise<
    | { ok: true; state: SeriesFenceState }
    | {
        ok: false;
        reason: 'BLOCKED_PENDING' | 'ALREADY_TERMINAL';
        pendingCount?: number;
        state?: SeriesFenceState;
      }
  > {
    const pre = await this.get(seriesKey);
    if (!pre) throw new Error(`series fence missing: ${seriesKey}`);
    if (pre.status === 'COMPLETED' || pre.status === 'FORFEITED') {
      return { ok: false, reason: 'ALREADY_TERMINAL', state: pre };
    }
    if (options?.beforeLockedBarrier) {
      await options.beforeLockedBarrier();
    }

    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const [k1, k2] = seriesAdvisoryKeys(seriesKey);
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);
      const res = await client.query(
        `SELECT * FROM series_fence_state WHERE series_key = $1 FOR UPDATE`,
        [seriesKey],
      );
      if (!res.rowCount) {
        await client.query('ROLLBACK');
        throw new Error(`series fence missing: ${seriesKey}`);
      }
      const current = mapFence(res.rows[0]);
      if (current.status === 'COMPLETED' || current.status === 'FORFEITED') {
        await client.query('COMMIT');
        return { ok: false, reason: 'ALREADY_TERMINAL', state: current };
      }
      const pendingCount = await listEligiblePending(
        client,
        current.idleDeadlineAt,
      );
      if (pendingCount > 0) {
        await client.query('COMMIT');
        return {
          ok: false,
          reason: 'BLOCKED_PENDING',
          pendingCount,
          state: current,
        };
      }
      const next: SeriesFenceState = {
        ...current,
        status: 'FORFEITED',
        resultsPublished: false,
      };
      await writeFence(client, next);
      await client.query('COMMIT');
      return { ok: true, state: next };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

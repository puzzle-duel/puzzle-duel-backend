/**
 * PZD-40 server-owned active writer binding per series.
 * Bearer possession alone does not grant writer entitlement.
 */
import type pg from 'pg';

export const SERIES_WRITER_DDL = [
  'CREATE TABLE IF NOT EXISTS tournament_series_writer (',
  'series_key TEXT PRIMARY KEY,',
  'player_id UUID NOT NULL,',
  'session_id UUID NOT NULL,',
  'device_id UUID NOT NULL,',
  'writer_generation BIGINT NOT NULL,',
  'updated_at_ms BIGINT NOT NULL',
  ');',
].join(' ');

export interface SeriesWriterBinding {
  readonly seriesKey: string;
  readonly playerId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly writerGeneration: number;
  readonly updatedAtMs: number;
}

export class PostgresSeriesWriterStore {
  readonly #pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async migrate(): Promise<void> {
    await this.#pool.query(SERIES_WRITER_DDL);
  }

  async get(seriesKey: string): Promise<SeriesWriterBinding | null> {
    const res = await this.#pool.query(
      `SELECT * FROM tournament_series_writer WHERE series_key = $1`,
      [seriesKey],
    );
    if (!res.rowCount) return null;
    return mapWriter(res.rows[0]);
  }

  /** Initial bind for a newly claimed series (generation = 1). */
  async bindInitial(
    client: pg.PoolClient,
    args: {
      seriesKey: string;
      playerId: string;
      sessionId: string;
      deviceId: string;
      nowMs: number;
    },
  ): Promise<SeriesWriterBinding> {
    const res = await client.query(
      `INSERT INTO tournament_series_writer
         (series_key, player_id, session_id, device_id, writer_generation, updated_at_ms)
       VALUES ($1,$2,$3,$4,1,$5)
       ON CONFLICT (series_key) DO NOTHING
       RETURNING *`,
      [
        args.seriesKey,
        args.playerId,
        args.sessionId,
        args.deviceId,
        args.nowMs,
      ],
    );
    if (res.rowCount) return mapWriter(res.rows[0]);
    const existing = await client.query(
      `SELECT * FROM tournament_series_writer WHERE series_key = $1`,
      [args.seriesKey],
    );
    if (!existing.rowCount) throw new Error('WRITER_BIND_MISSING');
    return mapWriter(existing.rows[0]);
  }

  /**
   * Explicit handoff under advisory-compatible row lock.
   * Old writer generation becomes invalid immediately.
   */
  async handoff(
    args: {
      seriesKey: string;
      playerId: string;
      expectedGeneration: number;
      nextSessionId: string;
      nextDeviceId: string;
    },
  ): Promise<
    | { ok: true; binding: SeriesWriterBinding }
    | { ok: false; reason: 'NOT_FOUND' | 'PLAYER_MISMATCH' | 'STALE_WRITER' }
  > {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `SELECT * FROM tournament_series_writer WHERE series_key = $1 FOR UPDATE`,
        [args.seriesKey],
      );
      if (!res.rowCount) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'NOT_FOUND' };
      }
      const current = mapWriter(res.rows[0]);
      if (current.playerId !== args.playerId) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'PLAYER_MISMATCH' };
      }
      if (current.writerGeneration !== args.expectedGeneration) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'STALE_WRITER' };
      }
      const time = await client.query(
        `SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS ms`,
      );
      const nowMs = Number(time.rows[0].ms);
      const nextGen = current.writerGeneration + 1;
      const updated = await client.query(
        `UPDATE tournament_series_writer
         SET session_id = $2, device_id = $3, writer_generation = $4, updated_at_ms = $5
         WHERE series_key = $1
         RETURNING *`,
        [
          args.seriesKey,
          args.nextSessionId,
          args.nextDeviceId,
          nextGen,
          nowMs,
        ],
      );
      await client.query('COMMIT');
      return { ok: true, binding: mapWriter(updated.rows[0]) };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

function mapWriter(row: Record<string, unknown>): SeriesWriterBinding {
  return Object.freeze({
    seriesKey: String(row.series_key),
    playerId: String(row.player_id),
    sessionId: String(row.session_id),
    deviceId: String(row.device_id),
    writerGeneration: Number(row.writer_generation),
    updatedAtMs: Number(row.updated_at_ms),
  });
}

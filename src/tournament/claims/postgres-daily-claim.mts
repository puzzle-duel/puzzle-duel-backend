/** PZD-40 Stage F1: immutable PostgreSQL daily claim foundation.
 * NOT an HTTP authentication gateway. Call only with verified internal player
 * identity and server-pinned manifest, never directly with request JSON.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export const DAILY_CLAIM_DDL = [
  'CREATE TABLE IF NOT EXISTS tournament_daily_claim (',
  'series_id UUID PRIMARY KEY,',
  'player_id TEXT NOT NULL,',
  'original_utc_date DATE NOT NULL,',
  'started_at_ms BIGINT NOT NULL,',
  'manifest_digest TEXT NOT NULL,',
  "status TEXT NOT NULL DEFAULT 'ACTIVE',",
  'UNIQUE (player_id, original_utc_date),',
  "CHECK (status IN ('ACTIVE','AWAIT_ADVANCE','COMPLETED','FORFEITED'))",
  ');',
].join(' ');

export interface ImmutableDailyClaim {
  readonly seriesId: string;
  readonly playerId: string;
  readonly originalUtcDate: string;
  readonly startedAtMs: number;
  readonly manifestDigest: string;
  readonly status: 'ACTIVE' | 'AWAIT_ADVANCE' | 'COMPLETED' | 'FORFEITED';
}
export type ClaimDecision =
  | { ok: true; original: boolean; claim: ImmutableDailyClaim }
  | { ok: false; reason: 'INVALID_DATE' | 'CLAIM_WINDOW_CLOSED' | 'UNVERIFIED_INPUT' };
export interface VerifiedClaimInput {
  readonly playerId: string;
  readonly originalUtcDate: string;
  readonly manifestDigest: string;
}
function dateMs(s: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const n = Date.parse(s + 'T00:00:00.000Z');
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === s ? n : null;
}
function utcWeekStart(dayMs: number): number {
  return dayMs - ((new Date(dayMs).getUTCDay() + 6) % 7) * 86400000;
}
function mapClaim(row: Record<string, unknown>): ImmutableDailyClaim {
  // PostgreSQL DATE must be serialized as UTC calendar text, not JS-local midnight.
  const d = String(row.original_utc_date_text);
  return {
    seriesId: String(row.series_id),
    playerId: String(row.player_id),
    originalUtcDate: d,
    startedAtMs: Number(row.started_at_ms),
    manifestDigest: String(row.manifest_digest),
    status: String(row.status) as ImmutableDailyClaim['status'],
  };
}
export class PostgresDailyClaimStore {
  private readonly pool: pg.Pool;
  constructor(pool: pg.Pool) { this.pool = pool; }
  async migrate(): Promise<void> { await this.pool.query(DAILY_CLAIM_DDL); }
  async claimForVerifiedPrincipal(input: VerifiedClaimInput): Promise<ClaimDecision> {
    const requested = dateMs(input.originalUtcDate);
    if (requested === null) return { ok: false, reason: 'INVALID_DATE' };
    if (typeof input.playerId !== 'string' || !input.playerId.trim() ||
        typeof input.manifestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.manifestDigest)) {
      return { ok: false, reason: 'UNVERIFIED_INPUT' };
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const time = await client.query("SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS ms");
      const now = Number(time.rows[0].ms);
      const today = Math.floor(now / 86400000) * 86400000;
      if (requested < utcWeekStart(today) || requested > today) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'CLAIM_WINDOW_CLOSED' };
      }
      const inserted = await client.query(
        'INSERT INTO tournament_daily_claim (series_id, player_id, original_utc_date, started_at_ms, manifest_digest) VALUES ($1, $2, $3::date, $4, $5) ON CONFLICT (player_id, original_utc_date) DO NOTHING RETURNING *, to_char(original_utc_date, \'YYYY-MM-DD\') AS original_utc_date_text',
        [randomUUID(), input.playerId, input.originalUtcDate, now, input.manifestDigest],
      );
      if (inserted.rowCount) {
        await client.query('COMMIT');
        return { ok: true, original: true, claim: mapClaim(inserted.rows[0]) };
      }
      const existing = await client.query(
        'SELECT *, to_char(original_utc_date, \'YYYY-MM-DD\') AS original_utc_date_text FROM tournament_daily_claim WHERE player_id = $1 AND original_utc_date = $2::date',
        [input.playerId, input.originalUtcDate],
      );
      if (!existing.rowCount) throw new Error('claim unique conflict with missing row');
      await client.query('COMMIT');
      return { ok: true, original: false, claim: mapClaim(existing.rows[0]) };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignored */ }
      throw e;
    } finally {
      client.release();
    }
  }
}

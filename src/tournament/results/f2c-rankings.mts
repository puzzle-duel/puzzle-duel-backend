/**
 * PZD-41 Stage F2-C — daily/weekly competition ranks and immutable weekly FINAL.
 *
 * Reads include a series only after evaluateLeaderboardReadEligibility
 * recomputes the F2-B HMAC from durable replay. results_published, a category
 * row, a provenance string, or a TypeScript object is not authorization.
 *
 * TD-15 page size 50 and maximum 100 remain Proposed. This module does not
 * apply them. Callers pass an explicit page size up to F2C_PAGE_SIZE_LIMIT,
 * which is a request-size bound, not an owner-approved page policy.
 *
 * Lock order for FINAL:
 *   1. weekly settlement advisory lock
 *   2. per-series advisory locks, ascending series id
 *   3. fence / writer / claim row locks already defined for those series
 * F2-B publication takes only the series lock, so it cannot deadlock with FINAL.
 * Daily claim takes the settlement lock before it samples PostgreSQL time.
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { parseUtcDateMs, utcWeekMondayMs } from '../claims/hard-cutoff.mts';
import { lockSeriesForTransaction, lockWeeklySettlement } from '../ingress/series-fence.mts';
import { evaluateLeaderboardReadEligibility } from './f2a-publication-schema.mts';

export const F2C_CATEGORIES = ['EASY', 'MEDIUM', 'HARD', 'ALL'] as const;
export type F2CCategory = (typeof F2C_CATEGORIES)[number];
export type F2CBoard = 'daily' | 'weekly';

/** Current UTC week plus five previous weeks. Retention beyond this window stays Proposed. */
export const F2C_VISIBLE_WEEK_COUNT = 6;

/**
 * Upper bound on a requested page so a cursor cannot ask for an unbounded read.
 * Not the Proposed TD-15 maximum of 100, and not an accepted product default.
 */
export const F2C_PAGE_SIZE_LIMIT = 1000;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

type Queryable = {
  query(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};

export const F2C_RANKING_DDL = `
CREATE TABLE IF NOT EXISTS tournament_f2c_settlement (
  week_start DATE PRIMARY KEY,
  settlement_id UUID NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state = 'FINAL'),
  cutoff_ms BIGINT NOT NULL,
  observed_at_ms BIGINT NOT NULL,
  watermark_max_admission_seq BIGINT NOT NULL CHECK (watermark_max_admission_seq >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS tournament_f2c_board_header (
  settlement_id UUID NOT NULL
    REFERENCES tournament_f2c_settlement (settlement_id),
  board TEXT NOT NULL CHECK (board IN ('daily', 'weekly')),
  period_start DATE NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('EASY', 'MEDIUM', 'HARD', 'ALL')),
  revision TEXT NOT NULL,
  row_count INT NOT NULL CHECK (row_count >= 0),
  PRIMARY KEY (settlement_id, board, period_start, category)
);

CREATE TABLE IF NOT EXISTS tournament_f2c_rank_snapshot (
  settlement_id UUID NOT NULL
    REFERENCES tournament_f2c_settlement (settlement_id),
  board TEXT NOT NULL CHECK (board IN ('daily', 'weekly')),
  period_start DATE NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('EASY', 'MEDIUM', 'HARD', 'ALL')),
  player_id TEXT NOT NULL,
  score BIGINT NOT NULL CHECK (score >= 0 AND score <= 9007199254740991),
  rank INT NOT NULL CHECK (rank >= 1),
  display_position INT NOT NULL CHECK (display_position >= 1),
  on_time_awarded BOOLEAN,
  PRIMARY KEY (settlement_id, board, period_start, category, player_id),
  UNIQUE (settlement_id, board, period_start, category, display_position),
  FOREIGN KEY (settlement_id, board, period_start, category)
    REFERENCES tournament_f2c_board_header (settlement_id, board, period_start, category)
);

CREATE OR REPLACE FUNCTION tournament_f2c_reject_final_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'F2C_FINAL_IMMUTABLE'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'tournament_f2c_settlement',
    'tournament_f2c_board_header',
    'tournament_f2c_rank_snapshot'
  ]
  LOOP
    IF to_regclass('public.' || tbl) IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'trg_f2c_immutable_' || tbl
        AND tgrelid = tbl::regclass
        AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_f2c_immutable_%I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION tournament_f2c_reject_final_mutation()',
        tbl,
        tbl
      );
    END IF;
  END LOOP;
END $$;
`;

export const F2C_RANKING_DROP_DDL = `
DROP TABLE IF EXISTS tournament_f2c_rank_snapshot;
DROP TABLE IF EXISTS tournament_f2c_board_header;
DROP TABLE IF EXISTS tournament_f2c_settlement;
DROP FUNCTION IF EXISTS tournament_f2c_reject_final_mutation();
`;

export type F2CProvisionalReason =
  | 'CUTOFF_NOT_REACHED'
  | 'PENDING_ADMISSION'
  | 'UNKNOWN_OUTCOME'
  | 'WATERMARK_UNAVAILABLE'
  | 'AUTHORIZATION_FAILED'
  | 'ELIGIBLE_SESSION_OPEN'
  | 'UNCERTAIN_SERIES'
  | 'UNCERTAIN_TIMESTAMP'
  | 'INVALID_PERIOD'
  | 'LOCK_NOT_ACQUIRED'
  | 'WEEKLY_SCORE_OVERFLOW'
  | 'DUPLICATE_DAILY_CREDIT'
  | 'INCOMPLETE_SNAPSHOT'
  | 'PUBLICATION_UNSETTLED';

export type F2CSettlementResult =
  | {
      outcome: 'final';
      alreadyFinal: boolean;
      settlementId: string;
      weekStart: string;
      cutoffMs: number;
      observedAtMs: number;
      watermarkMaxAdmissionSeq: number;
    }
  | { outcome: 'provisional'; reason: F2CProvisionalReason };

export type F2CRankRow = {
  readonly playerId: string;
  readonly score: number;
  readonly rank: number;
  readonly displayPosition: number;
  readonly onTimeAwarded: boolean | null;
};

export type F2CReadResult =
  | {
      ok: true;
      board: F2CBoard;
      period: string;
      category: F2CCategory;
      state: 'PROVISIONAL' | 'FINAL';
      revision: string;
      settlementId: string | null;
      pageSize: number;
      offset: number;
      rows: readonly F2CRankRow[];
      cursor: string;
      nextCursor: string | null;
    }
  | {
      ok: false;
      reason:
        | 'SNAPSHOT_CHANGED'
        | 'INVALID_CURSOR'
        | 'INVALID_PAGE_SIZE'
        | 'INVALID_PERIOD'
        | 'PERIOD_NOT_VISIBLE'
        | 'DUPLICATE_DAILY_CREDIT'
        | 'WEEKLY_SCORE_OVERFLOW'
        | 'INCOMPLETE_SNAPSHOT';
    };

type AuthorizedDaily = {
  readonly seriesId: string;
  readonly playerId: string;
  readonly originalUtcDate: string;
  readonly easy: number;
  readonly medium: number;
  readonly hard: number;
  readonly all: number;
  readonly onTimeAwarded: boolean;
};

type CursorBody = {
  readonly v: 1;
  readonly board: F2CBoard;
  readonly period: string;
  readonly category: F2CCategory;
  readonly revision: string;
  readonly offset: number;
  readonly pageSize: number;
  readonly anchorPlayerId: string | null;
  readonly anchorScore: number | null;
};

class SettlementClosed extends Error {
  readonly reason: F2CProvisionalReason;
  constructor(reason: F2CProvisionalReason) {
    super(reason);
    this.reason = reason;
  }
}

export function addSafeScore(total: number, delta: number): number {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(delta) || total < 0 || delta < 0) {
    throw new RangeError('WEEKLY_SCORE_OVERFLOW');
  }
  const sum = total + delta;
  if (!Number.isSafeInteger(sum)) throw new RangeError('WEEKLY_SCORE_OVERFLOW');
  return sum;
}

export function formatUtcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function weekDates(weekStart: string): readonly string[] {
  const start = requireMonday(weekStart);
  return Array.from({ length: 7 }, (_, index) => formatUtcDate(start + index * DAY_MS));
}

/** Monday 01:00 UTC after the week. Eligibility is trusted time strictly before this instant. */
export function weeklyFinalCutoffMs(weekStart: string): number {
  return requireMonday(weekStart) + 7 * DAY_MS + HOUR_MS;
}

export function visibleWeekStarts(nowMs: number): readonly string[] {
  if (!Number.isSafeInteger(nowMs)) throw new RangeError('UNCERTAIN_TIMESTAMP');
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const current = utcWeekMondayMs(today);
  return Array.from({ length: F2C_VISIBLE_WEEK_COUNT }, (_, index) =>
    formatUtcDate(current - index * 7 * DAY_MS),
  );
}

export function f2cSnapshotLabels(weekStart: string): readonly string[] {
  const labels: string[] = [];
  for (const date of weekDates(weekStart)) {
    for (const category of F2C_CATEGORIES) labels.push(`daily:${date}:${category}`);
  }
  for (const category of F2C_CATEGORIES) labels.push(`weekly:${weekStart}:${category}`);
  labels.push('before_commit');
  return labels;
}

export function competitionRanks<T extends { playerId: string; score: number }>(
  rows: readonly T[],
): Array<T & { rank: number; displayPosition: number }> {
  const sorted = [...rows].sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.playerId < right.playerId) return -1;
    if (left.playerId > right.playerId) return 1;
    return 0;
  });
  let greater = 0;
  return sorted.map((row, index) => {
    const previous = sorted[index - 1];
    if (previous && row.score < previous.score) greater = index;
    return { ...row, rank: greater + 1, displayPosition: index + 1 };
  });
}

function requireMonday(weekStart: string): number {
  const start = parseUtcDateMs(weekStart);
  if (start === null || utcWeekMondayMs(start) !== start) {
    throw new SettlementClosed('INVALID_PERIOD');
  }
  return start;
}

function isCategory(value: string): value is F2CCategory {
  return (F2C_CATEGORIES as readonly string[]).includes(value);
}

function categoryScore(row: AuthorizedDaily, category: F2CCategory): number {
  if (category === 'EASY') return row.easy;
  if (category === 'MEDIUM') return row.medium;
  if (category === 'HARD') return row.hard;
  return row.all;
}

function revisionOf(
  state: 'PROVISIONAL' | 'FINAL',
  settlementId: string | null,
  rows: readonly F2CRankRow[],
): string {
  const body = rows
    .map((row) => `${row.displayPosition}|${row.playerId}|${row.score}|${row.rank}|${row.onTimeAwarded === null ? '' : row.onTimeAwarded ? 1 : 0}`)
    .join('\n');
  const hash = createHash('sha256').update(body).digest('hex');
  return state === 'FINAL' ? `final.${settlementId}.${hash}` : `provisional.${hash}`;
}

function encodeCursor(body: CursorBody): string {
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

function decodeCursor(token: string): CursorBody | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.v !== 1) return null;
    if (parsed.board !== 'daily' && parsed.board !== 'weekly') return null;
    if (typeof parsed.period !== 'string' || parseUtcDateMs(parsed.period) === null) return null;
    if (typeof parsed.category !== 'string' || !isCategory(parsed.category)) return null;
    if (typeof parsed.revision !== 'string' || parsed.revision.length < 16 || parsed.revision.length > 200) {
      return null;
    }
    if (!Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) return null;
    if (
      !Number.isSafeInteger(parsed.pageSize) ||
      Number(parsed.pageSize) < 1 ||
      Number(parsed.pageSize) > F2C_PAGE_SIZE_LIMIT
    ) {
      return null;
    }
    const anchorPlayerId = parsed.anchorPlayerId;
    const anchorScore = parsed.anchorScore;
    if (anchorPlayerId !== null && typeof anchorPlayerId !== 'string') return null;
    if (anchorScore !== null && (!Number.isSafeInteger(anchorScore) || Number(anchorScore) < 0)) return null;
    if ((anchorPlayerId === null) !== (anchorScore === null)) return null;
    if (Number(parsed.offset) === 0 && anchorPlayerId !== null) return null;
    return {
      v: 1,
      board: parsed.board,
      period: parsed.period,
      category: parsed.category,
      revision: parsed.revision,
      offset: Number(parsed.offset),
      pageSize: Number(parsed.pageSize),
      anchorPlayerId: anchorPlayerId === null ? null : String(anchorPlayerId),
      anchorScore: anchorScore === null ? null : Number(anchorScore),
    };
  } catch {
    return null;
  }
}

function pageSizeError(pageSize: number): boolean {
  return !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > F2C_PAGE_SIZE_LIMIT;
}

async function dbNowMs(db: Queryable): Promise<number> {
  const result = await db.query(
    `SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS ms`,
  );
  const ms = Number(result.rows[0]?.ms);
  if (!Number.isSafeInteger(ms)) throw new SettlementClosed('UNCERTAIN_TIMESTAMP');
  return ms;
}

function intOf(value: unknown, reason: F2CProvisionalReason): number {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    if (!Number.isSafeInteger(asNumber)) throw new SettlementClosed(reason);
    return asNumber;
  }
  const asNumber = typeof value === 'string' ? Number(value) : value;
  if (typeof asNumber !== 'number' || !Number.isSafeInteger(asNumber)) {
    throw new SettlementClosed(reason);
  }
  return asNumber;
}

export class F2CRankingService {
  readonly #pool: pg.Pool;
  readonly #key: string;

  constructor(pool: pg.Pool, options: { readonly provenanceKey: string }) {
    if (typeof options.provenanceKey !== 'string' || options.provenanceKey.length < 32) {
      throw new Error('F2B_PROVENANCE_KEY_UNCONFIGURED');
    }
    this.#pool = pool;
    this.#key = options.provenanceKey;
  }

  async migrate(): Promise<void> {
    await this.#pool.query(F2C_RANKING_DDL);
  }

  async readDaily(args: {
    date: string;
    category: F2CCategory;
    pageSize: number;
    cursor?: string;
  }): Promise<F2CReadResult> {
    return this.#read({
      board: 'daily',
      period: args.date,
      category: args.category,
      pageSize: args.pageSize,
      cursor: args.cursor,
    });
  }

  async readWeekly(args: {
    weekStart: string;
    category: F2CCategory;
    pageSize: number;
    cursor?: string;
  }): Promise<F2CReadResult> {
    return this.#read({
      board: 'weekly',
      period: args.weekStart,
      category: args.category,
      pageSize: args.pageSize,
      cursor: args.cursor,
    });
  }

  async finalizeWeek(
    weekStart: string,
    options?: { readonly lockTimeoutMs?: number; readonly inject?: (label: string) => Promise<void> | void },
  ): Promise<F2CSettlementResult> {
    let cutoffMs: number;
    try {
      cutoffMs = weeklyFinalCutoffMs(weekStart);
    } catch (err) {
      if (err instanceof SettlementClosed) return { outcome: 'provisional', reason: err.reason };
      throw err;
    }
    const client = await this.#pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      if (options?.lockTimeoutMs !== undefined) {
        if (!Number.isSafeInteger(options.lockTimeoutMs) || options.lockTimeoutMs < 1) {
          throw new SettlementClosed('UNCERTAIN_TIMESTAMP');
        }
        await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${options.lockTimeoutMs}ms`]);
      }
      await lockWeeklySettlement(client);
      const existing = await client.query(
        `SELECT settlement_id::text AS settlement_id, cutoff_ms, observed_at_ms, watermark_max_admission_seq
         FROM tournament_f2c_settlement WHERE week_start = $1::date`,
        [weekStart],
      );
      if (existing.rows.length === 1) {
        const row = existing.rows[0]!;
        await client.query('COMMIT');
        committed = true;
        return {
          outcome: 'final',
          alreadyFinal: true,
          settlementId: String(row.settlement_id),
          weekStart,
          cutoffMs: intOf(row.cutoff_ms, 'UNCERTAIN_TIMESTAMP'),
          observedAtMs: intOf(row.observed_at_ms, 'UNCERTAIN_TIMESTAMP'),
          watermarkMaxAdmissionSeq: intOf(row.watermark_max_admission_seq, 'WATERMARK_UNAVAILABLE'),
        };
      }
      const now = await dbNowMs(client);
      if (now < cutoffMs) throw new SettlementClosed('CUTOFF_NOT_REACHED');
      const dates = weekDates(weekStart);
      const claims = await this.#loadClaims(client, dates);
      const seriesIds = claims.map((claim) => claim.seriesId).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      for (const seriesId of seriesIds) await lockSeriesForTransaction(client, seriesId);
      const lockedClaims = await this.#loadClaims(client, dates);
      await this.#assertSessionsSettled(client, lockedClaims, now);
      const watermark = await this.#pendingBarrier(client, lockedClaims.map((claim) => claim.seriesId), cutoffMs);
      const authorized = await this.#authorizeCompleted(client, lockedClaims, true);
      const settlementId = randomUUID();
      await client.query(
        `INSERT INTO tournament_f2c_settlement (
           week_start, settlement_id, state, cutoff_ms, observed_at_ms, watermark_max_admission_seq
         ) VALUES ($1::date, $2, 'FINAL', $3, $4, $5)`,
        [weekStart, settlementId, cutoffMs, now, watermark],
      );
      for (const date of dates) {
        for (const category of F2C_CATEGORIES) {
          const rows = rankDaily(authorized, date, category);
          await this.#writeBoard(client, settlementId, 'daily', date, category, rows);
          if (options?.inject) await options.inject(`daily:${date}:${category}`);
        }
      }
      for (const category of F2C_CATEGORIES) {
        const rows = rankWeekly(authorized, dates, category);
        await this.#writeBoard(client, settlementId, 'weekly', weekStart, category, rows);
        if (options?.inject) await options.inject(`weekly:${weekStart}:${category}`);
      }
      const written = await client.query(
        `SELECT count(*)::int AS n FROM tournament_f2c_board_header WHERE settlement_id = $1`,
        [settlementId],
      );
      if (Number(written.rows[0]?.n) !== dates.length * F2C_CATEGORIES.length + F2C_CATEGORIES.length) {
        throw new SettlementClosed('INCOMPLETE_SNAPSHOT');
      }
      if (options?.inject) await options.inject('before_commit');
      await client.query('COMMIT');
      committed = true;
      return {
        outcome: 'final',
        alreadyFinal: false,
        settlementId,
        weekStart,
        cutoffMs,
        observedAtMs: now,
        watermarkMaxAdmissionSeq: watermark,
      };
    } catch (err) {
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The transaction may already be aborted.
        }
      }
      const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : '';
      if (code === '55P03') return { outcome: 'provisional', reason: 'LOCK_NOT_ACQUIRED' };
      if (code === '42P01') return { outcome: 'provisional', reason: 'WATERMARK_UNAVAILABLE' };
      if (err instanceof SettlementClosed) return { outcome: 'provisional', reason: err.reason };
      if (err instanceof RangeError && err.message === 'WEEKLY_SCORE_OVERFLOW') {
        return { outcome: 'provisional', reason: 'WEEKLY_SCORE_OVERFLOW' };
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async #read(args: {
    board: F2CBoard;
    period: string;
    category: F2CCategory;
    pageSize: number;
    cursor?: string;
  }): Promise<F2CReadResult> {
    if (!isCategory(args.category)) return { ok: false, reason: 'INVALID_PERIOD' };
    if (pageSizeError(args.pageSize)) return { ok: false, reason: 'INVALID_PAGE_SIZE' };
    const periodMs = parseUtcDateMs(args.period);
    if (periodMs === null) return { ok: false, reason: 'INVALID_PERIOD' };
    let weekStart: string;
    try {
      weekStart = args.board === 'weekly' ? formatUtcDate(requireMonday(args.period)) : formatUtcDate(utcWeekMondayMs(periodMs));
    } catch (err) {
      if (err instanceof SettlementClosed) return { ok: false, reason: 'INVALID_PERIOD' };
      throw err;
    }
    const cursor = args.cursor === undefined ? null : decodeCursor(args.cursor);
    if (args.cursor !== undefined && cursor === null) return { ok: false, reason: 'INVALID_CURSOR' };
    if (
      cursor &&
      (cursor.board !== args.board ||
        cursor.period !== args.period ||
        cursor.category !== args.category ||
        cursor.pageSize !== args.pageSize)
    ) {
      return { ok: false, reason: 'INVALID_CURSOR' };
    }
    let frozen: { ok: true; settlementId: string; rows: F2CRankRow[] } | F2CReadResult | null;
    try {
      const now = await dbNowMs(this.#pool);
      const visible = new Set(visibleWeekStarts(now));
      if (!visible.has(weekStart)) return { ok: false, reason: 'PERIOD_NOT_VISIBLE' };
      frozen = await this.#frozenBoard(args.board, args.period, weekStart, args.category);
    } catch (err) {
      if (err instanceof SettlementClosed) return { ok: false, reason: 'INCOMPLETE_SNAPSHOT' };
      throw err;
    }
    if (frozen && !frozen.ok) return frozen;
    let state: 'PROVISIONAL' | 'FINAL';
    let settlementId: string | null;
    let ranked: readonly F2CRankRow[];
    if (frozen && frozen.ok) {
      state = 'FINAL';
      settlementId = frozen.settlementId;
      ranked = frozen.rows;
    } else {
      const dates = args.board === 'daily' ? [args.period] : weekDates(weekStart);
      let authorized: readonly AuthorizedDaily[];
      try {
        const claims = await this.#loadClaims(this.#pool, dates);
        authorized = await this.#authorizeCompleted(this.#pool, claims, false);
      } catch (err) {
        if (err instanceof SettlementClosed && err.reason === 'DUPLICATE_DAILY_CREDIT') {
          return { ok: false, reason: 'DUPLICATE_DAILY_CREDIT' };
        }
        throw err;
      }
      try {
        ranked = args.board === 'daily'
          ? rankDaily(authorized, args.period, args.category)
          : rankWeekly(authorized, dates, args.category);
      } catch (err) {
        if (err instanceof RangeError && err.message === 'WEEKLY_SCORE_OVERFLOW') {
          return { ok: false, reason: 'WEEKLY_SCORE_OVERFLOW' };
        }
        if (err instanceof SettlementClosed && err.reason === 'DUPLICATE_DAILY_CREDIT') {
          return { ok: false, reason: 'DUPLICATE_DAILY_CREDIT' };
        }
        throw err;
      }
      state = 'PROVISIONAL';
      settlementId = null;
    }
    const revision = revisionOf(state, settlementId, ranked);
    if (cursor && cursor.revision !== revision) return { ok: false, reason: 'SNAPSHOT_CHANGED' };
    const offset = cursor?.offset ?? 0;
    if (offset > ranked.length) return { ok: false, reason: 'SNAPSHOT_CHANGED' };
    if (offset > 0) {
      const anchor = ranked[offset - 1];
      if (
        !anchor ||
        cursor?.anchorPlayerId !== anchor.playerId ||
        cursor.anchorScore !== anchor.score
      ) {
        return { ok: false, reason: 'SNAPSHOT_CHANGED' };
      }
    }
    const rows = ranked.slice(offset, offset + args.pageSize);
    const nextOffset = offset + rows.length;
    const pageCursor = (next: number): string =>
      encodeCursor({
        v: 1,
        board: args.board,
        period: args.period,
        category: args.category,
        revision,
        offset: next,
        pageSize: args.pageSize,
        anchorPlayerId: next === 0 ? null : ranked[next - 1]?.playerId ?? null,
        anchorScore: next === 0 ? null : ranked[next - 1]?.score ?? null,
      });
    return {
      ok: true,
      board: args.board,
      period: args.period,
      category: args.category,
      state,
      revision,
      settlementId,
      pageSize: args.pageSize,
      offset,
      rows,
      cursor: pageCursor(offset),
      nextCursor: nextOffset < ranked.length ? pageCursor(nextOffset) : null,
    };
  }

  async #frozenBoard(
    board: F2CBoard,
    period: string,
    weekStart: string,
    category: F2CCategory,
  ): Promise<{ ok: true; settlementId: string; rows: F2CRankRow[] } | F2CReadResult | null> {
    const settlement = await this.#pool.query(
      `SELECT settlement_id::text AS settlement_id
       FROM tournament_f2c_settlement WHERE week_start = $1::date`,
      [weekStart],
    );
    if (settlement.rows.length !== 1) return null;
    const settlementId = String(settlement.rows[0]!.settlement_id);
    const header = await this.#pool.query(
      `SELECT row_count FROM tournament_f2c_board_header
       WHERE settlement_id = $1 AND board = $2 AND period_start = $3::date AND category = $4`,
      [settlementId, board, period, category],
    );
    if (header.rows.length !== 1) return { ok: false, reason: 'INCOMPLETE_SNAPSHOT' };
    const stored = await this.#pool.query(
      `SELECT player_id, score, rank, display_position, on_time_awarded
       FROM tournament_f2c_rank_snapshot
       WHERE settlement_id = $1 AND board = $2 AND period_start = $3::date AND category = $4
       ORDER BY display_position`,
      [settlementId, board, period, category],
    );
    if (stored.rows.length !== Number(header.rows[0]!.row_count)) {
      return { ok: false, reason: 'INCOMPLETE_SNAPSHOT' };
    }
    const rows = stored.rows.map((row) => ({
      playerId: String(row.player_id),
      score: intOf(row.score, 'UNCERTAIN_TIMESTAMP'),
      rank: intOf(row.rank, 'UNCERTAIN_TIMESTAMP'),
      displayPosition: intOf(row.display_position, 'UNCERTAIN_TIMESTAMP'),
      onTimeAwarded: row.on_time_awarded === null ? null : Boolean(row.on_time_awarded),
    }));
    return { ok: true, settlementId, rows };
  }

  async #loadClaims(db: Queryable, dates: readonly string[]): Promise<
    { seriesId: string; playerId: string; originalUtcDate: string; status: string }[]
  > {
    const result = await db.query(
      `SELECT series_id::text AS series_id, player_id, to_char(original_utc_date, 'YYYY-MM-DD') AS original_utc_date, status
       FROM tournament_daily_claim
       WHERE original_utc_date = ANY($1::date[])
       ORDER BY series_id`,
      [dates],
    );
    return result.rows.map((row) => ({
      seriesId: String(row.series_id),
      playerId: String(row.player_id),
      originalUtcDate: String(row.original_utc_date),
      status: String(row.status),
    }));
  }

  async #authorizeCompleted(
    db: Queryable,
    claims: readonly { seriesId: string; playerId: string; originalUtcDate: string; status: string }[],
    failClosed: boolean,
  ): Promise<AuthorizedDaily[]> {
    const authorized: AuthorizedDaily[] = [];
    const seen = new Set<string>();
    for (const claim of claims) {
      if (claim.status !== 'COMPLETED') continue;
      const eligibility = await evaluateLeaderboardReadEligibility(db, claim.seriesId, {
        provenanceKey: this.#key,
      });
      if (!eligibility.authorized) {
        if (failClosed) throw new SettlementClosed('AUTHORIZATION_FAILED');
        continue;
      }
      if (eligibility.playerId !== claim.playerId || eligibility.originalUtcDate !== claim.originalUtcDate) {
        if (failClosed) throw new SettlementClosed('AUTHORIZATION_FAILED');
        continue;
      }
      const key = `${claim.playerId}|${claim.originalUtcDate}`;
      if (seen.has(key)) throw new SettlementClosed('DUPLICATE_DAILY_CREDIT');
      seen.add(key);
      authorized.push({
        seriesId: eligibility.seriesId,
        playerId: eligibility.playerId,
        originalUtcDate: eligibility.originalUtcDate,
        easy: eligibility.easy,
        medium: eligibility.medium,
        hard: eligibility.hard,
        all: eligibility.all,
        onTimeAwarded: eligibility.onTimeAwarded,
      });
    }
    return authorized;
  }

  async #assertSessionsSettled(
    client: Queryable,
    claims: readonly { seriesId: string; status: string }[],
    now: number,
  ): Promise<void> {
    for (const claim of claims) {
      const fence = await client.query(
        `SELECT status, hard_cutoff_at_ms FROM series_fence_state WHERE series_key = $1`,
        [claim.seriesId],
      );
      if (fence.rows.length !== 1) throw new SettlementClosed('UNCERTAIN_SERIES');
      const fenceStatus = String(fence.rows[0]!.status);
      if (
        (claim.status === 'COMPLETED' || claim.status === 'FORFEITED' || fenceStatus === 'COMPLETED' || fenceStatus === 'FORFEITED') &&
        claim.status !== fenceStatus
      ) {
        throw new SettlementClosed('UNCERTAIN_SERIES');
      }
      const published = await client.query(
        `SELECT 1 FROM tournament_daily_series_completion WHERE series_id = $1`,
        [claim.seriesId],
      );
      if (claim.status !== 'COMPLETED' && published.rows.length > 0) {
        throw new SettlementClosed('UNCERTAIN_SERIES');
      }
      if (claim.status !== 'COMPLETED' && claim.status !== 'FORFEITED') {
        const endedH1 = await client.query(
          `SELECT 1 FROM authoritative_game_snapshot
           WHERE series_key = $1 AND subgame_ordinal = 6 AND status = 'ended'`,
          [claim.seriesId],
        );
        if (endedH1.rows.length > 0) throw new SettlementClosed('PUBLICATION_UNSETTLED');
      }
      if (claim.status === 'COMPLETED' || claim.status === 'FORFEITED') continue;
      const rawCutoff = fence.rows[0]!.hard_cutoff_at_ms;
      if (rawCutoff === null || rawCutoff === undefined) throw new SettlementClosed('UNCERTAIN_SERIES');
      const hardCutoff = intOf(rawCutoff, 'UNCERTAIN_SERIES');
      if (hardCutoff > now) throw new SettlementClosed('ELIGIBLE_SESSION_OPEN');
    }
  }

  async #pendingBarrier(client: Queryable, seriesIds: readonly string[], cutoffMs: number): Promise<number> {
    const present = await client.query(`SELECT to_regclass('public.command_admission_journal') AS rel`);
    if (!present.rows[0]?.rel) throw new SettlementClosed('WATERMARK_UNAVAILABLE');
    const watermark = await client.query(
      `SELECT COALESCE(MAX(admission_seq), 0)::bigint AS seq
       FROM command_admission_journal
       WHERE cardinality($1::text[]) > 0 AND series_key = ANY($1::text[])`,
      [seriesIds],
    );
    const seq = intOf(watermark.rows[0]?.seq, 'WATERMARK_UNAVAILABLE');
    if (seq < 0) throw new SettlementClosed('WATERMARK_UNAVAILABLE');
    if (seriesIds.length === 0) return seq;
    const blocking = await client.query(
      `SELECT outcome
       FROM command_admission_journal
       WHERE series_key = ANY($1::text[])
         AND outcome <> 'applied'
         AND outcome <> 'rejected'
         AND (
           db_trusted_received_at_ms IS NULL
           OR db_trusted_received_at_ms < $2
           OR trusted_received_at_ms < $2
         )
       ORDER BY admission_seq
       LIMIT 1`,
      [seriesIds, cutoffMs],
    );
    if (blocking.rows.length === 1) {
      const outcome = String(blocking.rows[0]!.outcome);
      throw new SettlementClosed(outcome === 'pending' ? 'PENDING_ADMISSION' : 'UNKNOWN_OUTCOME');
    }
    return seq;
  }

  async #writeBoard(
    client: Queryable,
    settlementId: string,
    board: F2CBoard,
    period: string,
    category: F2CCategory,
    rows: readonly F2CRankRow[],
  ): Promise<void> {
    const revision = revisionOf('FINAL', settlementId, rows);
    await client.query(
      `INSERT INTO tournament_f2c_board_header (
         settlement_id, board, period_start, category, revision, row_count
       ) VALUES ($1, $2, $3::date, $4, $5, $6)`,
      [settlementId, board, period, category, revision, rows.length],
    );
    for (const row of rows) {
      await client.query(
        `INSERT INTO tournament_f2c_rank_snapshot (
           settlement_id, board, period_start, category, player_id, score, rank,
           display_position, on_time_awarded
         ) VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9)`,
        [
          settlementId,
          board,
          period,
          category,
          row.playerId,
          row.score,
          row.rank,
          row.displayPosition,
          row.onTimeAwarded,
        ],
      );
    }
  }
}

function rankDaily(rows: readonly AuthorizedDaily[], date: string, category: F2CCategory): F2CRankRow[] {
  const seen = new Set<string>();
  const scored = [];
  for (const row of rows) {
    if (row.originalUtcDate !== date) continue;
    if (seen.has(row.playerId)) throw new SettlementClosed('DUPLICATE_DAILY_CREDIT');
    seen.add(row.playerId);
    scored.push({
      playerId: row.playerId,
      score: categoryScore(row, category),
      onTimeAwarded: row.onTimeAwarded,
    });
  }
  return competitionRanks(scored).map((row) => ({
    playerId: row.playerId,
    score: row.score,
    rank: row.rank,
    displayPosition: row.displayPosition,
    onTimeAwarded: row.onTimeAwarded,
  }));
}

function rankWeekly(rows: readonly AuthorizedDaily[], dates: readonly string[], category: F2CCategory): F2CRankRow[] {
  const byPlayer = new Map<string, { score: number; days: Set<string> }>();
  for (const row of rows) {
    if (!dates.includes(row.originalUtcDate)) continue;
    const current = byPlayer.get(row.playerId) ?? { score: 0, days: new Set<string>() };
    if (current.days.has(row.originalUtcDate)) throw new SettlementClosed('DUPLICATE_DAILY_CREDIT');
    current.days.add(row.originalUtcDate);
    current.score = addSafeScore(current.score, categoryScore(row, category));
    byPlayer.set(row.playerId, current);
  }
  return competitionRanks(
    [...byPlayer.entries()].map(([playerId, value]) => ({ playerId, score: value.score })),
  ).map((row) => ({
    playerId: row.playerId,
    score: row.score,
    rank: row.rank,
    displayPosition: row.displayPosition,
    onTimeAwarded: null,
  }));
}

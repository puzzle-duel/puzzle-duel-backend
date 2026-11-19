/**
 * PZD-43 candidate read model for the authenticated player's badge collection.
 *
 * Read-only. Does not grant badges, mutate publication rows, or accept client
 * counts. Counts are derived from immutable F2-B `tournament_on_time_badge`
 * rows joined to the caller's `tournament_daily_series_completion` identity.
 *
 * Trust model: F2-B write-time HMAC + immutability triggers. This summary does
 * not re-run per-series HMAC replay (unlike GET .../results) so a large history
 * stays affordable. Owner freeze still required before production enablement.
 */
import type pg from 'pg';

export const ON_TIME_BADGE_ID = 'on_time' as const;

export interface PlayerBadgeGrant {
  readonly seriesId: string;
  readonly originalUtcDate: string;
  readonly awarded: true;
  readonly claimStartedAtMs: number;
}

export interface PlayerBadgeSummary {
  readonly badgeId: typeof ON_TIME_BADGE_ID;
  readonly earnedCount: number;
  readonly lastEarnedAt: string | null;
  readonly repeatable: true;
  readonly provenance: 'f2b_publication';
  readonly grants: readonly PlayerBadgeGrant[];
}

export interface PlayerBadgesResponse {
  readonly playerScoped: true;
  readonly catalogVersion: 1;
  readonly badges: readonly PlayerBadgeSummary[];
}

const DEFAULT_GRANT_LIMIT = 50;
const MAX_GRANT_LIMIT = 100;

export function clampBadgeGrantLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_GRANT_LIMIT;
  if (!Number.isSafeInteger(raw) || raw < 1) return DEFAULT_GRANT_LIMIT;
  return Math.min(raw, MAX_GRANT_LIMIT);
}

/**
 * Load On-Time grants for [playerId] only. Never accept a client-supplied
 * player id for authorization — callers must pass the verified session id.
 */
export async function loadPlayerBadgeCollection(
  pool: pg.Pool,
  playerId: string,
  options?: { grantLimit?: number },
): Promise<PlayerBadgesResponse> {
  if (typeof playerId !== 'string' || playerId.length === 0) {
    throw new Error('PLAYER_ID_REQUIRED');
  }
  const grantLimit = clampBadgeGrantLimit(options?.grantLimit);

  const countResult = await pool.query<{ earned_count: string | number }>(
    `SELECT count(*)::int AS earned_count
     FROM tournament_daily_series_completion AS completion
     INNER JOIN tournament_on_time_badge AS badge
       ON badge.series_id = completion.series_id
      AND badge.claim_started_at_ms = completion.claim_started_at_ms
      AND badge.original_utc_date = completion.original_utc_date
     WHERE completion.player_id = $1
       AND badge.awarded = true`,
    [playerId],
  );
  const earnedCount = Number(countResult.rows[0]?.earned_count ?? 0);

  const grantsResult = await pool.query<{
    series_id: string;
    original_utc_date: string;
    claim_started_at_ms: string | number;
  }>(
    `SELECT completion.series_id,
            to_char(completion.original_utc_date, 'YYYY-MM-DD') AS original_utc_date,
            completion.claim_started_at_ms
     FROM tournament_daily_series_completion AS completion
     INNER JOIN tournament_on_time_badge AS badge
       ON badge.series_id = completion.series_id
      AND badge.claim_started_at_ms = completion.claim_started_at_ms
      AND badge.original_utc_date = completion.original_utc_date
     WHERE completion.player_id = $1
       AND badge.awarded = true
     ORDER BY completion.original_utc_date DESC, completion.claim_started_at_ms DESC
     LIMIT $2`,
    [playerId, grantLimit],
  );

  const grants: PlayerBadgeGrant[] = grantsResult.rows.map((row) => ({
    seriesId: String(row.series_id),
    originalUtcDate: String(row.original_utc_date),
    awarded: true as const,
    claimStartedAtMs: Number(row.claim_started_at_ms),
  }));

  const onTime: PlayerBadgeSummary = {
    badgeId: ON_TIME_BADGE_ID,
    earnedCount,
    lastEarnedAt: grants[0]?.originalUtcDate ?? null,
    repeatable: true,
    provenance: 'f2b_publication',
    grants,
  };

  return {
    playerScoped: true,
    catalogVersion: 1,
    badges: [onTime],
  };
}

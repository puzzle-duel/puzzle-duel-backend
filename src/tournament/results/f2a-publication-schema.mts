/**
 * PZD-41 Stage F2-A — additive PostgreSQL publication schema (candidate).
 *
 * FOUNDATION ONLY: DDL + constraint surface for exactly-once four-category
 * publication and On-Time badge. Does NOT implement F2-B atomic publish UoW,
 * leaderboard reads, weekly FINAL, or HTTP.
 *
 * Binds to existing F1 / Stage E tables:
 *   - tournament_daily_claim (immutable claim + original UTC date + started_at)
 *   - authoritative_game_snapshot / accepted_move_ledger (terminal provenance)
 *   - series_fence_state.results_published (fence flag; category rows are authority)
 *
 * Table names and column shapes are implementation candidates pending independent
 * F2-A review. They are NOT an Accepted OpenAPI or frozen production migration ID.
 *
 * Security:
 *   - Never store client-submitted scores/dates/ordinals/completion flags as authority.
 *   - No leaderboard projection without a completion receipt + all four categories.
 *   - Exactly-once publication via unique (series_id) completion + unique categories.
 */

/** Additive F2-A DDL. Apply after F1 claim + Stage E gameplay DDL. */
export const F2A_PUBLICATION_DDL = `
CREATE TABLE IF NOT EXISTS tournament_daily_series_completion (
  series_id UUID PRIMARY KEY
    REFERENCES tournament_daily_claim (series_id),
  player_id TEXT NOT NULL,
  original_utc_date DATE NOT NULL,
  claim_started_at_ms BIGINT NOT NULL,
  completed_at_ms BIGINT NOT NULL,
  manifest_digest TEXT NOT NULL
    CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  publication_idempotency_key TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1
    CHECK (revision >= 1),
  UNIQUE (publication_idempotency_key),
  UNIQUE (player_id, original_utc_date),
  CHECK (completed_at_ms >= claim_started_at_ms)
);

CREATE TABLE IF NOT EXISTS tournament_verified_subgame_score (
  series_id UUID NOT NULL
    REFERENCES tournament_daily_series_completion (series_id) ON DELETE CASCADE,
  subgame_ordinal INT NOT NULL
    CHECK (subgame_ordinal BETWEEN 1 AND 6),
  challenge_id TEXT NOT NULL,
  state_hash TEXT NOT NULL
    CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  score BIGINT NOT NULL
    CHECK (score >= 0 AND score <= 9007199254740991),
  ledger_admission_seq BIGINT NOT NULL
    CHECK (ledger_admission_seq >= 0),
  produced_by_admission_id UUID NULL,
  PRIMARY KEY (series_id, subgame_ordinal)
);

CREATE TABLE IF NOT EXISTS tournament_daily_result_category (
  series_id UUID NOT NULL
    REFERENCES tournament_daily_series_completion (series_id) ON DELETE CASCADE,
  category TEXT NOT NULL
    CHECK (category IN ('EASY', 'MEDIUM', 'HARD', 'ALL')),
  score BIGINT NOT NULL
    CHECK (score >= 0 AND score <= 9007199254740991),
  PRIMARY KEY (series_id, category)
);

CREATE TABLE IF NOT EXISTS tournament_on_time_badge (
  series_id UUID PRIMARY KEY
    REFERENCES tournament_daily_series_completion (series_id) ON DELETE CASCADE,
  awarded BOOLEAN NOT NULL,
  claim_started_at_ms BIGINT NOT NULL,
  original_utc_date DATE NOT NULL
);
`;

/**
 * Drop order for disposable test databases (children first).
 * Never use against production without an approved rollback plan.
 */
export const F2A_PUBLICATION_DROP_DDL = `
DROP TABLE IF EXISTS tournament_on_time_badge;
DROP TABLE IF EXISTS tournament_daily_result_category;
DROP TABLE IF EXISTS tournament_verified_subgame_score;
DROP TABLE IF EXISTS tournament_daily_series_completion;
`;

export const F2A_CATEGORIES = ['EASY', 'MEDIUM', 'HARD', 'ALL'] as const;
export type F2ACategory = (typeof F2A_CATEGORIES)[number];

/**
 * Canonical publication idempotency key for a series completion attempt.
 * Retries with the same key must reconcile to the original receipt (F2-B).
 */
export function publicationIdempotencyKey(seriesId: string): string {
  if (
    typeof seriesId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      seriesId,
    )
  ) {
    throw new Error('INVALID_SERIES_ID');
  }
  return `f2-publish:${seriesId.toLowerCase()}`;
}

/**
 * On-Time eligibility from immutable claim fields only (ADR-T02 / product T-03).
 * Compares server claim start instant to the original UTC calendar date.
 * Never uses finish/completion time.
 */
export function onTimeBadgeFromClaim(args: {
  originalUtcDate: string;
  claimStartedAtMs: number;
}): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.originalUtcDate)) {
    throw new Error('INVALID_ORIGINAL_UTC_DATE');
  }
  if (
    !Number.isSafeInteger(args.claimStartedAtMs) ||
    args.claimStartedAtMs < 0
  ) {
    throw new Error('INVALID_CLAIM_STARTED_AT');
  }
  const dayStart = Date.parse(`${args.originalUtcDate}T00:00:00.000Z`);
  if (!Number.isFinite(dayStart)) throw new Error('INVALID_ORIGINAL_UTC_DATE');
  const dayEnd = dayStart + 86_400_000;
  return (
    args.claimStartedAtMs >= dayStart && args.claimStartedAtMs < dayEnd
  );
}

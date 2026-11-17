/**
 * PZD-41 Stage F2-A — additive PostgreSQL publication schema (hardened).
 *
 * FOUNDATION ONLY: DDL + constraint surface + fail-closed readiness predicate.
 * Does NOT implement F2-B atomic publish UoW, leaderboard HTTP, or weekly FINAL.
 *
 * Trust boundary:
 *   - Structural readiness (this module) proves rows are complete and
 *     referentially consistent with the F1 claim.
 *   - Trusted gameplay authorization (Stage E replay + F2-B) is a separate
 *     gate; a synthetic fixture is NOT evidence of replay verification.
 *
 * Claim integrity (P0):
 *   Completion (series_id, player_id, original_utc_date, claim_started_at_ms,
 *   manifest_digest) is a composite FK to an additive UNIQUE on
 *   tournament_daily_claim. Mismatched identity is rejected at the PG boundary.
 */

/** Additive UNIQUE on F1 claim so completion can composite-FK identity fields. */
export const F2A_CLAIM_IDENTITY_DDL = `
ALTER TABLE tournament_daily_claim
  DROP CONSTRAINT IF EXISTS tournament_daily_claim_f2a_identity_uq;
ALTER TABLE tournament_daily_claim
  ADD CONSTRAINT tournament_daily_claim_f2a_identity_uq
  UNIQUE (series_id, player_id, original_utc_date, started_at_ms, manifest_digest);

CREATE OR REPLACE FUNCTION tournament_daily_claim_reject_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.player_id IS DISTINCT FROM OLD.player_id
     OR NEW.original_utc_date IS DISTINCT FROM OLD.original_utc_date
     OR NEW.started_at_ms IS DISTINCT FROM OLD.started_at_ms
     OR NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest THEN
    RAISE EXCEPTION 'TOURNAMENT_DAILY_CLAIM_IDENTITY_IMMUTABLE'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tournament_daily_claim_identity_immutable
  ON tournament_daily_claim;
CREATE TRIGGER trg_tournament_daily_claim_identity_immutable
  BEFORE UPDATE ON tournament_daily_claim
  FOR EACH ROW
  EXECUTE FUNCTION tournament_daily_claim_reject_identity_mutation();
`;

/** Fresh F2-A publication tables with composite claim FK. */
export const F2A_PUBLICATION_DDL = `
CREATE TABLE IF NOT EXISTS tournament_daily_series_completion (
  series_id UUID NOT NULL,
  player_id TEXT NOT NULL,
  original_utc_date DATE NOT NULL,
  claim_started_at_ms BIGINT NOT NULL,
  completed_at_ms BIGINT NOT NULL,
  manifest_digest TEXT NOT NULL
    CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  publication_idempotency_key TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1
    CHECK (revision >= 1),
  PRIMARY KEY (series_id),
  UNIQUE (publication_idempotency_key),
  UNIQUE (player_id, original_utc_date),
  UNIQUE (series_id, claim_started_at_ms, original_utc_date),
  UNIQUE (series_id, player_id, original_utc_date, claim_started_at_ms, manifest_digest),
  CHECK (completed_at_ms >= claim_started_at_ms),
  CONSTRAINT tournament_daily_series_completion_claim_identity_fkey
    FOREIGN KEY (series_id, player_id, original_utc_date, claim_started_at_ms, manifest_digest)
    REFERENCES tournament_daily_claim (series_id, player_id, original_utc_date, started_at_ms, manifest_digest)
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
  series_id UUID NOT NULL,
  awarded BOOLEAN NOT NULL,
  claim_started_at_ms BIGINT NOT NULL,
  original_utc_date DATE NOT NULL,
  PRIMARY KEY (series_id),
  CONSTRAINT tournament_on_time_badge_completion_identity_fkey
    FOREIGN KEY (series_id, claim_started_at_ms, original_utc_date)
    REFERENCES tournament_daily_series_completion (series_id, claim_started_at_ms, original_utc_date)
    ON DELETE CASCADE
);
`;

/**
 * Upgrade path when an older F2-A completion table exists with series_id-only FK.
 * Fail-closed: refuses to proceed if rows already contradict the claim identity.
 */
export const F2A_PUBLICATION_UPGRADE_DDL = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM tournament_daily_series_completion c
    JOIN tournament_daily_claim cl ON cl.series_id = c.series_id
    WHERE c.player_id IS DISTINCT FROM cl.player_id
       OR c.original_utc_date IS DISTINCT FROM cl.original_utc_date
       OR c.claim_started_at_ms IS DISTINCT FROM cl.started_at_ms
       OR c.manifest_digest IS DISTINCT FROM cl.manifest_digest
  ) THEN
    RAISE EXCEPTION 'F2A_UPGRADE_BLOCKED_CLAIM_IDENTITY_MISMATCH';
  END IF;
END $$;

ALTER TABLE tournament_daily_series_completion
  DROP CONSTRAINT IF EXISTS tournament_daily_series_completion_series_id_fkey;
ALTER TABLE tournament_daily_series_completion
  DROP CONSTRAINT IF EXISTS tournament_daily_series_completion_claim_identity_fkey;

ALTER TABLE tournament_daily_series_completion
  ADD CONSTRAINT tournament_daily_series_completion_claim_identity_fkey
  FOREIGN KEY (series_id, player_id, original_utc_date, claim_started_at_ms, manifest_digest)
  REFERENCES tournament_daily_claim (series_id, player_id, original_utc_date, started_at_ms, manifest_digest);

ALTER TABLE tournament_daily_series_completion
  DROP CONSTRAINT IF EXISTS tournament_daily_series_completion_series_id_claim_started_at_ms_original_utc_date_key;
ALTER TABLE tournament_daily_series_completion
  ADD CONSTRAINT tournament_daily_series_completion_series_id_claim_started_at_ms_original_utc_date_key
  UNIQUE (series_id, claim_started_at_ms, original_utc_date);

ALTER TABLE tournament_on_time_badge
  DROP CONSTRAINT IF EXISTS tournament_on_time_badge_series_id_fkey;
ALTER TABLE tournament_on_time_badge
  DROP CONSTRAINT IF EXISTS tournament_on_time_badge_completion_identity_fkey;
ALTER TABLE tournament_on_time_badge
  ADD CONSTRAINT tournament_on_time_badge_completion_identity_fkey
  FOREIGN KEY (series_id, claim_started_at_ms, original_utc_date)
  REFERENCES tournament_daily_series_completion (series_id, claim_started_at_ms, original_utc_date)
  ON DELETE CASCADE;
`;

/**
 * Fail-closed publication readiness view.
 * Absence from this view == NOT_VISIBLE (never a partial leaderboard row).
 * This is a structural contract for F2-C reads — not a production HTTP endpoint.
 */
export const F2A_PUBLICATION_READY_VIEW_DDL = `
CREATE OR REPLACE VIEW tournament_f2a_publication_ready AS
SELECT
  c.series_id,
  c.player_id,
  to_char(c.original_utc_date, 'YYYY-MM-DD') AS original_utc_date,
  c.claim_started_at_ms,
  c.completed_at_ms,
  c.manifest_digest,
  c.revision,
  c.publication_idempotency_key,
  easy.score AS easy_score,
  medium.score AS medium_score,
  hard.score AS hard_score,
  allcat.score AS all_score,
  badge.awarded AS on_time_awarded
FROM tournament_daily_series_completion c
JOIN tournament_daily_claim cl
  ON cl.series_id = c.series_id
 AND cl.player_id = c.player_id
 AND cl.original_utc_date = c.original_utc_date
 AND cl.started_at_ms = c.claim_started_at_ms
 AND cl.manifest_digest = c.manifest_digest
JOIN tournament_daily_result_category easy
  ON easy.series_id = c.series_id AND easy.category = 'EASY'
JOIN tournament_daily_result_category medium
  ON medium.series_id = c.series_id AND medium.category = 'MEDIUM'
JOIN tournament_daily_result_category hard
  ON hard.series_id = c.series_id AND hard.category = 'HARD'
JOIN tournament_daily_result_category allcat
  ON allcat.series_id = c.series_id AND allcat.category = 'ALL'
JOIN tournament_on_time_badge badge
  ON badge.series_id = c.series_id
 AND badge.claim_started_at_ms = c.claim_started_at_ms
 AND badge.original_utc_date = c.original_utc_date
WHERE c.revision >= 1
  AND (
    SELECT COUNT(*) FROM tournament_verified_subgame_score s WHERE s.series_id = c.series_id
  ) = 6
  AND (
    SELECT COUNT(DISTINCT s.subgame_ordinal)
    FROM tournament_verified_subgame_score s
    WHERE s.series_id = c.series_id AND s.subgame_ordinal BETWEEN 1 AND 6
  ) = 6
  AND easy.score = (
    SELECT COALESCE(SUM(s.score), -1)
    FROM tournament_verified_subgame_score s
    WHERE s.series_id = c.series_id AND s.subgame_ordinal IN (1, 2, 3)
  )
  AND medium.score = (
    SELECT COALESCE(SUM(s.score), -1)
    FROM tournament_verified_subgame_score s
    WHERE s.series_id = c.series_id AND s.subgame_ordinal IN (4, 5)
  )
  AND hard.score = (
    SELECT COALESCE(SUM(s.score), -1)
    FROM tournament_verified_subgame_score s
    WHERE s.series_id = c.series_id AND s.subgame_ordinal = 6
  )
  AND allcat.score = easy.score + medium.score + hard.score
  AND badge.awarded IS NOT DISTINCT FROM (
    c.claim_started_at_ms >= (EXTRACT(EPOCH FROM (c.original_utc_date::timestamp AT TIME ZONE 'UTC')) * 1000)::bigint
    AND c.claim_started_at_ms < (EXTRACT(EPOCH FROM ((c.original_utc_date::timestamp AT TIME ZONE 'UTC') + INTERVAL '1 day')) * 1000)::bigint
  );
`;

export const F2A_PUBLICATION_DROP_DDL = `
DROP VIEW IF EXISTS tournament_f2a_publication_ready;
DROP TABLE IF EXISTS tournament_on_time_badge;
DROP TABLE IF EXISTS tournament_daily_result_category;
DROP TABLE IF EXISTS tournament_verified_subgame_score;
DROP TABLE IF EXISTS tournament_daily_series_completion;
DROP TRIGGER IF EXISTS trg_tournament_daily_claim_identity_immutable ON tournament_daily_claim;
DROP FUNCTION IF EXISTS tournament_daily_claim_reject_identity_mutation();
ALTER TABLE tournament_daily_claim
  DROP CONSTRAINT IF EXISTS tournament_daily_claim_f2a_identity_uq;
`;

export const F2A_CATEGORIES = ['EASY', 'MEDIUM', 'HARD', 'ALL'] as const;
export type F2ACategory = (typeof F2A_CATEGORIES)[number];

export type PublicationReadiness =
  | {
      visible: true;
      seriesId: string;
      playerId: string;
      originalUtcDate: string;
      revision: number;
      easy: number;
      medium: number;
      hard: number;
      all: number;
      onTimeAwarded: boolean;
    }
  | { visible: false; reason: 'NOT_VISIBLE' };

type Queryable = {
  query: (
    text: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};

/** Apply claim identity + publication DDL + readiness view (disposable / review DBs). */
export async function migrateF2APublicationSchema(db: Queryable): Promise<void> {
  await db.query(F2A_CLAIM_IDENTITY_DDL);
  await db.query(F2A_PUBLICATION_DDL);
  await db.query(F2A_PUBLICATION_READY_VIEW_DDL);
}

/**
 * Canonical publication-readiness predicate for F2-C.
 * Incomplete/malformed/inconsistent publications return NOT_VISIBLE — never partial rows.
 */
export async function evaluatePublicationReadiness(
  db: Queryable,
  seriesId: string,
): Promise<PublicationReadiness> {
  const result = await db.query(
    `SELECT series_id, player_id, original_utc_date, revision,
            easy_score, medium_score, hard_score, all_score, on_time_awarded
     FROM tournament_f2a_publication_ready
     WHERE series_id = $1`,
    [seriesId],
  );
  if (result.rows.length !== 1) {
    return { visible: false, reason: 'NOT_VISIBLE' };
  }
  const row = result.rows[0]!;
  return {
    visible: true,
    seriesId: String(row.series_id),
    playerId: String(row.player_id),
    originalUtcDate: String(row.original_utc_date),
    revision: Number(row.revision),
    easy: Number(row.easy_score),
    medium: Number(row.medium_score),
    hard: Number(row.hard_score),
    all: Number(row.all_score),
    onTimeAwarded: Boolean(row.on_time_awarded),
  };
}

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

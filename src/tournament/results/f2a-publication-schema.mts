/**
 * PZD-41 Stage F2-A — additive PostgreSQL publication schema (hardened).
 *
 * FOUNDATION ONLY: DDL + structural completeness + migration safety.
 * Does NOT implement F2-B atomic publish UoW, leaderboard HTTP, or weekly FINAL.
 *
 * ============================================================================ BOUNDARY (binding):
 *   - `tournament_f2a_structural_readiness` / `evaluateStructuralReadiness`
 *     prove only that publication *rows* are complete and claim-referential.
 *   - Structural completeness is NEVER Stage E replay verification and NEVER
 *     leaderboard publication authorization.
 *   - F2-B must mint a trusted-provenance attestation after verifying six
 *     terminal snapshots + ledgers under server replay.
 *   - F2-C leaderboard reads MUST call `evaluateLeaderboardReadEligibility`
 *     with an F2-B attestation; structural readiness alone is prohibited.
 *   - Synthetic fixtures can be structurally complete and still unauthorized.
 *
 * Claim integrity (P0):
 *   Completion identity columns composite-FK to an additive UNIQUE on
 *   tournament_daily_claim. Mismatched identity is rejected at the PG boundary.
 */

/** Idempotent additive UNIQUE + identity-immutability trigger on F1 claim. */
export const F2A_CLAIM_IDENTITY_DDL = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tournament_daily_claim_f2a_identity_uq'
      AND conrelid = 'tournament_daily_claim'::regclass
  ) THEN
    ALTER TABLE tournament_daily_claim
      ADD CONSTRAINT tournament_daily_claim_f2a_identity_uq
      UNIQUE (series_id, player_id, original_utc_date, started_at_ms, manifest_digest);
  END IF;
END $$;

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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_tournament_daily_claim_identity_immutable'
      AND tgrelid = 'tournament_daily_claim'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_tournament_daily_claim_identity_immutable
      BEFORE UPDATE ON tournament_daily_claim
      FOR EACH ROW
      EXECUTE FUNCTION tournament_daily_claim_reject_identity_mutation();
  END IF;
END $$;
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

-- F2-B trusted-provenance proof boundary (table exists; writer NOT implemented).
-- F2-B must INSERT in the same TX as completion after Stage E six-terminal replay.
-- F2-A exports no insert helper; row presence alone does not authorize.
CREATE TABLE IF NOT EXISTS tournament_f2b_trusted_provenance (
  series_id UUID PRIMARY KEY
    REFERENCES tournament_daily_series_completion (series_id) ON DELETE CASCADE,
  revision BIGINT NOT NULL
    CHECK (revision >= 1),
  verified_at_ms BIGINT NOT NULL
    CHECK (verified_at_ms >= 0),
  provenance_seal TEXT NOT NULL
    CHECK (provenance_seal ~ '^[0-9a-f]{64}$'),
  UNIQUE (series_id, revision)
);
`;

/**
 * Idempotent upgrade from series_id-only FK schema.
 * Does not DROP/ADD constraints that already match the hardened shape.
 * Fail-closed if existing rows contradict claim identity.
 */
export const F2A_PUBLICATION_UPGRADE_DDL = `
DO $$
BEGIN
  IF to_regclass('public.tournament_daily_series_completion') IS NULL THEN
    RETURN;
  END IF;

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

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tournament_daily_series_completion_series_id_fkey'
      AND conrelid = 'tournament_daily_series_completion'::regclass
  ) THEN
    ALTER TABLE tournament_daily_series_completion
      DROP CONSTRAINT tournament_daily_series_completion_series_id_fkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tournament_daily_series_completion_claim_identity_fkey'
      AND conrelid = 'tournament_daily_series_completion'::regclass
  ) THEN
    ALTER TABLE tournament_daily_series_completion
      ADD CONSTRAINT tournament_daily_series_completion_claim_identity_fkey
      FOREIGN KEY (series_id, player_id, original_utc_date, claim_started_at_ms, manifest_digest)
      REFERENCES tournament_daily_claim (series_id, player_id, original_utc_date, started_at_ms, manifest_digest);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tournament_daily_series_completion_series_id_claim_started_at_ms_original_utc_date_key'
      AND conrelid = 'tournament_daily_series_completion'::regclass
  ) THEN
    ALTER TABLE tournament_daily_series_completion
      ADD CONSTRAINT tournament_daily_series_completion_series_id_claim_started_at_ms_original_utc_date_key
      UNIQUE (series_id, claim_started_at_ms, original_utc_date);
  END IF;

  IF to_regclass('public.tournament_on_time_badge') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'tournament_on_time_badge_series_id_fkey'
        AND conrelid = 'tournament_on_time_badge'::regclass
    ) THEN
      ALTER TABLE tournament_on_time_badge
        DROP CONSTRAINT tournament_on_time_badge_series_id_fkey;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'tournament_on_time_badge_completion_identity_fkey'
        AND conrelid = 'tournament_on_time_badge'::regclass
    ) THEN
      ALTER TABLE tournament_on_time_badge
        ADD CONSTRAINT tournament_on_time_badge_completion_identity_fkey
        FOREIGN KEY (series_id, claim_started_at_ms, original_utc_date)
        REFERENCES tournament_daily_series_completion (series_id, claim_started_at_ms, original_utc_date)
        ON DELETE CASCADE;
    END IF;
  END IF;
END $$;
`;

/**
 * STRUCTURAL readiness only — NOT publication authorization.
 * Absence == structurally incomplete. Presence does NOT authorize leaderboard reads.
 * Former name tournament_f2a_publication_ready is dropped; do not recreate it.
 */
export const F2A_STRUCTURAL_READINESS_VIEW_DDL = `
DROP VIEW IF EXISTS tournament_f2a_publication_ready;
CREATE OR REPLACE VIEW tournament_f2a_structural_readiness AS
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
  badge.awarded AS on_time_awarded,
  FALSE AS replay_verified,
  FALSE AS publication_authorized
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


/**
 * Rollback for disposable/review DBs.
 * Drops F2-A objects only; restores F1 claim table to pre-F2-A constraints
 * without deleting claim rows (constraint/trigger removal only).
 */
export const F2A_PUBLICATION_DROP_DDL = `
DROP VIEW IF EXISTS tournament_f2a_structural_readiness;
DROP VIEW IF EXISTS tournament_f2a_publication_ready;
DROP TABLE IF EXISTS tournament_f2b_trusted_provenance;
DROP TABLE IF EXISTS tournament_on_time_badge;
DROP TABLE IF EXISTS tournament_daily_result_category;
DROP TABLE IF EXISTS tournament_verified_subgame_score;
DROP TABLE IF EXISTS tournament_daily_series_completion;
DO $$
BEGIN
  IF to_regclass('public.tournament_daily_claim') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_tournament_daily_claim_identity_immutable
      ON tournament_daily_claim;
    ALTER TABLE tournament_daily_claim
      DROP CONSTRAINT IF EXISTS tournament_daily_claim_f2a_identity_uq;
  END IF;
END $$;
DROP FUNCTION IF EXISTS tournament_daily_claim_reject_identity_mutation();
`;

export const F2A_CATEGORIES = ['EASY', 'MEDIUM', 'HARD', 'ALL'] as const;
export type F2ACategory = (typeof F2A_CATEGORIES)[number];

/** Structural completeness only — NOT leaderboard authorization. */
export type StructuralReadiness =
  | {
      structurallyComplete: true;
      /** Always false at F2-A — Stage E/F2-B replay verification is separate. */
      replayVerified: false;
      /** Always false at F2-A — publication requires F2-B attestation. */
      publicationAuthorized: false;
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
  | { structurallyComplete: false; reason: 'STRUCTURAL_NOT_READY' };

/**
 * F2-B DB-backed provenance contract (documentation + table shape only).
 * Authorization is NEVER derived from TypeScript object brands or request JSON.
 * F2-B must INSERT into tournament_f2b_trusted_provenance inside the publish TX.
 * F2-A provides no mint/insert helper and never returns authorized:true.
 */
export type F2BTrustedProvenanceDbRow = {
  readonly seriesId: string;
  readonly revision: number;
  readonly verifiedAtMs: number;
  readonly provenanceSeal: string;
};

export type LeaderboardReadEligibility =
  | {
      authorized: true;
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
  | {
      authorized: false;
      reason:
        | 'STRUCTURAL_NOT_READY'
        | 'TRUSTED_PROVENANCE_REQUIRED'
        | 'F2B_PROVENANCE_SEAL_UNVERIFIED';
    };

type Queryable = {
  query: (
    text: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};

/** Apply claim identity + publication DDL + structural readiness view (idempotent). */
export async function migrateF2APublicationSchema(db: Queryable): Promise<void> {
  await db.query(F2A_CLAIM_IDENTITY_DDL);
  await db.query(F2A_PUBLICATION_DDL);
  await db.query(F2A_PUBLICATION_UPGRADE_DDL);
  await db.query(F2A_STRUCTURAL_READINESS_VIEW_DDL);
}

/**
 * Structural completeness predicate for F2-A proofs / F2-B preconditions.
 * MUST NOT be used alone for F2-C leaderboard reads.
 */
export async function evaluateStructuralReadiness(
  db: Queryable,
  seriesId: string,
): Promise<StructuralReadiness> {
  const result = await db.query(
    `SELECT series_id, player_id, original_utc_date, revision,
            easy_score, medium_score, hard_score, all_score, on_time_awarded,
            replay_verified, publication_authorized
     FROM tournament_f2a_structural_readiness
     WHERE series_id = $1`,
    [seriesId],
  );
  if (result.rows.length !== 1) {
    return { structurallyComplete: false, reason: 'STRUCTURAL_NOT_READY' };
  }
  const row = result.rows[0]!;
  return {
    structurallyComplete: true,
    replayVerified: false,
    publicationAuthorized: false,
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

/**
 * Mandatory F2-C leaderboard read gate (DB-only).
 *
 * - Ignores any in-memory/request object — no provenance parameter is accepted.
 * - Structural completeness alone → TRUSTED_PROVENANCE_REQUIRED.
 * - A DB provenance row without F2-B seal verification → F2B_PROVENANCE_SEAL_UNVERIFIED.
 * - authorized:true is unreachable in F2-A (F2-B not implemented).
 */
export async function evaluateLeaderboardReadEligibility(
  db: Queryable,
  seriesId: string,
): Promise<LeaderboardReadEligibility> {
  const structural = await evaluateStructuralReadiness(db, seriesId);
  if (!structural.structurallyComplete) {
    return { authorized: false, reason: 'STRUCTURAL_NOT_READY' };
  }
  const provenance = await db.query(
    `SELECT series_id, revision, verified_at_ms, provenance_seal
     FROM tournament_f2b_trusted_provenance
     WHERE series_id = $1 AND revision = $2`,
    [seriesId, structural.revision],
  );
  if (provenance.rows.length !== 1) {
    return { authorized: false, reason: 'TRUSTED_PROVENANCE_REQUIRED' };
  }
  // Row existence is not authority: F2-B seal verification is not implemented.
  void provenance.rows[0];
  return { authorized: false, reason: 'F2B_PROVENANCE_SEAL_UNVERIFIED' };
}

/**
 * Explicit rejection of in-memory/forged attestation objects.
 * Any call that attempts to pass a JS object as provenance must fail closed.
 */
export function rejectInMemoryProvenanceAttestation(_forged: unknown): never {
  throw new Error('IN_MEMORY_PROVENANCE_FORBIDDEN');
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

-- pzd-migration: 0004_f2a_publication
-- pzd-requires: 0003_f2a_claim_identity
-- pzd-transactional: true
-- pzd-reversible: false
-- pzd-expands: completion, six scores, four categories, on-time badge, provenance table
-- pzd-contracts: none

DO $$
BEGIN
  IF to_regclass('public.tournament_daily_series_completion') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'tournament_daily_series_completion'
         AND column_name = 'manifest_digest'
     ) THEN
    RAISE EXCEPTION 'MIGRATION_SCHEMA_INCOMPATIBLE';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.tournament_daily_series_completion (
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
    REFERENCES public.tournament_daily_claim (series_id, player_id, original_utc_date, started_at_ms, manifest_digest)
);

CREATE TABLE IF NOT EXISTS public.tournament_verified_subgame_score (
  series_id UUID NOT NULL
    REFERENCES public.tournament_daily_series_completion (series_id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS public.tournament_daily_result_category (
  series_id UUID NOT NULL
    REFERENCES public.tournament_daily_series_completion (series_id) ON DELETE CASCADE,
  category TEXT NOT NULL
    CHECK (category IN ('EASY', 'MEDIUM', 'HARD', 'ALL')),
  score BIGINT NOT NULL
    CHECK (score >= 0 AND score <= 9007199254740991),
  PRIMARY KEY (series_id, category)
);

CREATE TABLE IF NOT EXISTS public.tournament_on_time_badge (
  series_id UUID NOT NULL,
  awarded BOOLEAN NOT NULL,
  claim_started_at_ms BIGINT NOT NULL,
  original_utc_date DATE NOT NULL,
  PRIMARY KEY (series_id),
  CONSTRAINT tournament_on_time_badge_completion_identity_fkey
    FOREIGN KEY (series_id, claim_started_at_ms, original_utc_date)
    REFERENCES public.tournament_daily_series_completion (series_id, claim_started_at_ms, original_utc_date)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.tournament_f2b_trusted_provenance (
  series_id UUID PRIMARY KEY
    REFERENCES public.tournament_daily_series_completion (series_id) ON DELETE CASCADE,
  revision BIGINT NOT NULL
    CHECK (revision >= 1),
  verified_at_ms BIGINT NOT NULL
    CHECK (verified_at_ms >= 0),
  provenance_seal TEXT NOT NULL
    CHECK (provenance_seal ~ '^[0-9a-f]{64}$'),
  UNIQUE (series_id, revision)
);

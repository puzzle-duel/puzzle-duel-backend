-- pzd-migration: 0005_f2a_publication_upgrade
-- pzd-requires: 0004_f2a_publication
-- pzd-transactional: true
-- pzd-reversible: false
-- pzd-expands: composite claim foreign key for older publication tables
-- pzd-contracts: drops only a superseded series-id foreign key when the identity key replaces it

DO $$
BEGIN
  IF to_regclass('public.tournament_daily_series_completion') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_SCHEMA_INCOMPATIBLE';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.tournament_daily_series_completion c
    JOIN public.tournament_daily_claim cl ON cl.series_id = c.series_id
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
      AND conrelid = 'public.tournament_daily_series_completion'::regclass
  ) THEN
    ALTER TABLE public.tournament_daily_series_completion
      DROP CONSTRAINT tournament_daily_series_completion_series_id_fkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tournament_daily_series_completion_claim_identity_fkey'
      AND conrelid = 'public.tournament_daily_series_completion'::regclass
  ) THEN
    ALTER TABLE public.tournament_daily_series_completion
      ADD CONSTRAINT tournament_daily_series_completion_claim_identity_fkey
      FOREIGN KEY (series_id, player_id, original_utc_date, claim_started_at_ms, manifest_digest)
      REFERENCES public.tournament_daily_claim (series_id, player_id, original_utc_date, started_at_ms, manifest_digest);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tournament_daily_series_completion_series_id_claim_started_at_ms_original_utc_date_key'
      AND conrelid = 'public.tournament_daily_series_completion'::regclass
  ) THEN
    ALTER TABLE public.tournament_daily_series_completion
      ADD CONSTRAINT tournament_daily_series_completion_series_id_claim_started_at_ms_original_utc_date_key
      UNIQUE (series_id, claim_started_at_ms, original_utc_date);
  END IF;

  IF to_regclass('public.tournament_on_time_badge') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'tournament_on_time_badge_series_id_fkey'
        AND conrelid = 'public.tournament_on_time_badge'::regclass
    ) THEN
      ALTER TABLE public.tournament_on_time_badge
        DROP CONSTRAINT tournament_on_time_badge_series_id_fkey;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'tournament_on_time_badge_completion_identity_fkey'
        AND conrelid = 'public.tournament_on_time_badge'::regclass
    ) THEN
      ALTER TABLE public.tournament_on_time_badge
        ADD CONSTRAINT tournament_on_time_badge_completion_identity_fkey
        FOREIGN KEY (series_id, claim_started_at_ms, original_utc_date)
        REFERENCES public.tournament_daily_series_completion (series_id, claim_started_at_ms, original_utc_date)
        ON DELETE CASCADE;
    END IF;
  END IF;
END $$;

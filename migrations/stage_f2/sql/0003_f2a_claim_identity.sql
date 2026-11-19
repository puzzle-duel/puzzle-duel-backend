-- pzd-migration: 0003_f2a_claim_identity
-- pzd-requires: 0002_stage_f1_claim
-- pzd-transactional: true
-- pzd-reversible: false
-- pzd-expands: claim identity uniqueness and immutability
-- pzd-contracts: none

DO $$
BEGIN
  IF to_regclass('public.tournament_daily_claim') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_SCHEMA_INCOMPATIBLE';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tournament_daily_claim_f2a_identity_uq'
      AND conrelid = 'public.tournament_daily_claim'::regclass
  ) THEN
    ALTER TABLE public.tournament_daily_claim
      ADD CONSTRAINT tournament_daily_claim_f2a_identity_uq
      UNIQUE (series_id, player_id, original_utc_date, started_at_ms, manifest_digest);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.tournament_daily_claim_reject_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
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
      AND tgrelid = 'public.tournament_daily_claim'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_tournament_daily_claim_identity_immutable
      BEFORE UPDATE ON public.tournament_daily_claim
      FOR EACH ROW
      EXECUTE FUNCTION public.tournament_daily_claim_reject_identity_mutation();
  END IF;
END $$;

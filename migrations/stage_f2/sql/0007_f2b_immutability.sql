-- pzd-migration: 0007_f2b_immutability
-- pzd-requires: 0006_f2a_structural_view
-- pzd-transactional: true
-- pzd-reversible: false
-- pzd-expands: nullable publication provenance columns and immutability triggers
-- pzd-contracts: none

ALTER TABLE public.tournament_daily_series_completion
  ADD COLUMN IF NOT EXISTS source_command_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS h1_admission_id UUID;

CREATE OR REPLACE FUNCTION public.tournament_f2b_reject_publication_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'F2B_PUBLICATION_IMMUTABLE'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'tournament_daily_series_completion',
    'tournament_verified_subgame_score',
    'tournament_daily_result_category',
    'tournament_on_time_badge',
    'tournament_f2b_trusted_provenance'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'trg_f2b_immutable_' || tbl
        AND tgrelid = ('public.' || tbl)::regclass
        AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.tournament_f2b_reject_publication_mutation()',
        'trg_f2b_immutable_' || tbl,
        tbl
      );
    END IF;
  END LOOP;
END $$;

-- pzd-migration: 0009_f2c_final
-- pzd-requires: 0008_journal_db_receipt
-- pzd-transactional: true
-- pzd-reversible: false
-- pzd-expands: weekly FINAL settlement, board headers, rank rows, period closure
-- pzd-contracts: none
-- This migration inserts no settlement row and does not enable ranked HTTP.

DO $$
BEGIN
  IF to_regclass('public.tournament_f2c_settlement') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'tournament_f2c_settlement'
         AND column_name = 'state'
     ) THEN
    RAISE EXCEPTION 'MIGRATION_SCHEMA_INCOMPATIBLE';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.tournament_f2c_settlement (
  week_start DATE PRIMARY KEY,
  settlement_id UUID NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state = 'FINAL'),
  cutoff_ms BIGINT NOT NULL,
  observed_at_ms BIGINT NOT NULL,
  watermark_max_admission_seq BIGINT NOT NULL CHECK (watermark_max_admission_seq >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS public.tournament_f2c_board_header (
  settlement_id UUID NOT NULL
    REFERENCES public.tournament_f2c_settlement (settlement_id),
  board TEXT NOT NULL CHECK (board IN ('daily', 'weekly')),
  period_start DATE NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('EASY', 'MEDIUM', 'HARD', 'ALL')),
  revision TEXT NOT NULL,
  row_count INT NOT NULL CHECK (row_count >= 0),
  PRIMARY KEY (settlement_id, board, period_start, category)
);

CREATE TABLE IF NOT EXISTS public.tournament_f2c_rank_snapshot (
  settlement_id UUID NOT NULL
    REFERENCES public.tournament_f2c_settlement (settlement_id),
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
    REFERENCES public.tournament_f2c_board_header (settlement_id, board, period_start, category)
);

CREATE OR REPLACE FUNCTION public.tournament_f2c_reject_final_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
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
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'trg_f2c_immutable_' || tbl
        AND tgrelid = ('public.' || tbl)::regclass
        AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.tournament_f2c_reject_final_mutation()',
        'trg_f2c_immutable_' || tbl,
        tbl
      );
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.tournament_f2c_reject_closed_period_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  closed_week date;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(1973609813, 1888871555);
  closed_week := NEW.original_utc_date
    - ((EXTRACT(ISODOW FROM NEW.original_utc_date)::int + 6) % 7);
  IF EXISTS (
    SELECT 1 FROM public.tournament_f2c_settlement s
    WHERE s.week_start = closed_week AND s.state = 'FINAL'
  ) THEN
    RAISE EXCEPTION 'F2C_PERIOD_CLOSED'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.tournament_daily_claim') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgname = 'trg_f2c_claim_period_closed'
         AND tgrelid = 'public.tournament_daily_claim'::regclass
         AND NOT tgisinternal
     ) THEN
    CREATE TRIGGER trg_f2c_claim_period_closed
      BEFORE INSERT ON public.tournament_daily_claim
      FOR EACH ROW EXECUTE FUNCTION public.tournament_f2c_reject_closed_period_write();
  END IF;
  IF to_regclass('public.tournament_daily_series_completion') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgname = 'trg_f2c_publication_period_closed'
         AND tgrelid = 'public.tournament_daily_series_completion'::regclass
         AND NOT tgisinternal
     ) THEN
    CREATE TRIGGER trg_f2c_publication_period_closed
      BEFORE INSERT ON public.tournament_daily_series_completion
      FOR EACH ROW EXECUTE FUNCTION public.tournament_f2c_reject_closed_period_write();
  END IF;
END $$;

-- PZD-49 staging-only least-privilege grant; execute as migration owner on pzd_staging.
-- PostgreSQL SELECT ... FOR SHARE requires UPDATE privilege on the locked table.
-- No production database or role is targeted.
DO $$ BEGIN
  IF current_database() <> 'pzd_staging' THEN
    RAISE EXCEPTION 'Refusing staging grants outside pzd_staging';
  END IF;
  IF to_regclass('public.tournament_utc_daily_manifest') IS NULL THEN
    RAISE EXCEPTION 'Daily manifest table missing: apply schema migration 0012 first';
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE ON TABLE public.tournament_utc_daily_manifest TO pzd_staging_app;
GRANT SELECT ON TABLE public.pzd_schema_migration TO pzd_staging_app;

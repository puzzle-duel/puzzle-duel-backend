-- pzd-migration: 0010_f2_privileges
-- pzd-requires: 0009_f2c_final
-- pzd-transactional: false
-- pzd-reversible: false
-- pzd-expands: least-privilege roles
-- pzd-contracts: none
-- Roles are NOLOGIN. An operator grants them to a passworded login outside this file.
-- Ordinary triggers do not stop a superuser or the table owner. Ownership is the
-- migration role, and the runtime roles are not members of it.

CREATE ROLE pzd_migration_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
CREATE ROLE pzd_app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
CREATE ROLE pzd_leaderboard_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
CREATE ROLE pzd_settlement_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
CREATE ROLE pzd_audit_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;

ALTER ROLE pzd_migration_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE pzd_app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE pzd_leaderboard_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE pzd_settlement_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE pzd_audit_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;

CREATE OR REPLACE FUNCTION public.pzd_schema_migration_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'MIGRATION_HISTORY_IMMUTABLE'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DO $$
DECLARE
  rel text;
  fn text;
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO pzd_app_runtime, pzd_leaderboard_reader, pzd_settlement_worker, pzd_audit_admin, pzd_migration_owner',
    current_database()
  );
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  GRANT USAGE ON SCHEMA public TO pzd_app_runtime, pzd_leaderboard_reader, pzd_settlement_worker, pzd_audit_admin, pzd_migration_owner;
  GRANT CREATE ON SCHEMA public TO pzd_migration_owner;

  FOREACH rel IN ARRAY ARRAY[
    'pzd_schema_migration',
    'command_admission_journal',
    'series_fence_state',
    'trusted_challenge_binding',
    'accepted_move_ledger',
    'authoritative_game_snapshot',
    'tournament_series_writer',
    'tournament_daily_claim',
    'tournament_daily_series_completion',
    'tournament_verified_subgame_score',
    'tournament_daily_result_category',
    'tournament_on_time_badge',
    'tournament_f2b_trusted_provenance',
    'tournament_f2c_settlement',
    'tournament_f2c_board_header',
    'tournament_f2c_rank_snapshot'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO pzd_migration_owner', rel);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', rel);
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE public.%I FROM pzd_app_runtime, pzd_leaderboard_reader, pzd_settlement_worker, pzd_audit_admin',
      rel
    );
  END LOOP;

  EXECUTE 'ALTER VIEW public.tournament_f2a_structural_readiness OWNER TO pzd_migration_owner';
  EXECUTE 'REVOKE ALL ON TABLE public.tournament_f2a_structural_readiness FROM PUBLIC';

  FOREACH fn IN ARRAY ARRAY[
    'tournament_daily_claim_reject_identity_mutation()',
    'tournament_f2b_reject_publication_mutation()',
    'tournament_f2c_reject_final_mutation()',
    'tournament_f2c_reject_closed_period_write()',
    'pzd_schema_migration_reject_mutation()'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION public.%s OWNER TO pzd_migration_owner', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_pzd_schema_migration_immutable'
      AND tgrelid = 'public.pzd_schema_migration'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_pzd_schema_migration_immutable
      BEFORE UPDATE OR DELETE ON public.pzd_schema_migration
      FOR EACH ROW EXECUTE FUNCTION public.pzd_schema_migration_reject_mutation();
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.tournament_daily_claim TO pzd_app_runtime;
GRANT SELECT, INSERT, UPDATE ON public.command_admission_journal TO pzd_app_runtime;
GRANT SELECT, INSERT, UPDATE ON public.series_fence_state TO pzd_app_runtime;
GRANT SELECT, INSERT, UPDATE ON public.tournament_series_writer TO pzd_app_runtime;
GRANT SELECT, INSERT, UPDATE ON public.trusted_challenge_binding TO pzd_app_runtime;
GRANT SELECT, INSERT, UPDATE ON public.authoritative_game_snapshot TO pzd_app_runtime;
GRANT SELECT, INSERT ON public.accepted_move_ledger TO pzd_app_runtime;
GRANT SELECT, INSERT ON public.tournament_daily_series_completion TO pzd_app_runtime;
GRANT SELECT, INSERT ON public.tournament_verified_subgame_score TO pzd_app_runtime;
GRANT SELECT, INSERT ON public.tournament_daily_result_category TO pzd_app_runtime;
GRANT SELECT, INSERT ON public.tournament_on_time_badge TO pzd_app_runtime;
GRANT SELECT, INSERT ON public.tournament_f2b_trusted_provenance TO pzd_app_runtime;
GRANT SELECT ON public.tournament_f2c_settlement TO pzd_app_runtime;
GRANT SELECT ON public.tournament_f2a_structural_readiness TO pzd_app_runtime;

GRANT SELECT ON public.tournament_daily_claim TO pzd_leaderboard_reader;
GRANT SELECT ON public.tournament_daily_series_completion TO pzd_leaderboard_reader;
GRANT SELECT ON public.tournament_verified_subgame_score TO pzd_leaderboard_reader;
GRANT SELECT ON public.tournament_daily_result_category TO pzd_leaderboard_reader;
GRANT SELECT ON public.tournament_on_time_badge TO pzd_leaderboard_reader;
GRANT SELECT ON public.tournament_f2b_trusted_provenance TO pzd_leaderboard_reader;
GRANT SELECT ON public.tournament_f2a_structural_readiness TO pzd_leaderboard_reader;
GRANT SELECT ON public.tournament_f2c_settlement TO pzd_leaderboard_reader;
GRANT SELECT ON public.tournament_f2c_board_header TO pzd_leaderboard_reader;
GRANT SELECT ON public.tournament_f2c_rank_snapshot TO pzd_leaderboard_reader;

GRANT SELECT ON public.tournament_daily_claim TO pzd_settlement_worker;
GRANT SELECT ON public.command_admission_journal TO pzd_settlement_worker;
GRANT SELECT ON public.series_fence_state TO pzd_settlement_worker;
GRANT SELECT ON public.tournament_series_writer TO pzd_settlement_worker;
GRANT SELECT ON public.tournament_daily_series_completion TO pzd_settlement_worker;
GRANT SELECT ON public.tournament_verified_subgame_score TO pzd_settlement_worker;
GRANT SELECT ON public.tournament_daily_result_category TO pzd_settlement_worker;
GRANT SELECT ON public.tournament_on_time_badge TO pzd_settlement_worker;
GRANT SELECT ON public.tournament_f2b_trusted_provenance TO pzd_settlement_worker;
GRANT SELECT, INSERT ON public.tournament_f2c_settlement TO pzd_settlement_worker;
GRANT SELECT, INSERT ON public.tournament_f2c_board_header TO pzd_settlement_worker;
GRANT SELECT, INSERT ON public.tournament_f2c_rank_snapshot TO pzd_settlement_worker;

GRANT SELECT ON public.pzd_schema_migration TO pzd_audit_admin;
GRANT SELECT ON public.command_admission_journal TO pzd_audit_admin;
GRANT SELECT ON public.series_fence_state TO pzd_audit_admin;
GRANT SELECT ON public.trusted_challenge_binding TO pzd_audit_admin;
GRANT SELECT ON public.accepted_move_ledger TO pzd_audit_admin;
GRANT SELECT ON public.authoritative_game_snapshot TO pzd_audit_admin;
GRANT SELECT ON public.tournament_series_writer TO pzd_audit_admin;
GRANT SELECT ON public.tournament_daily_claim TO pzd_audit_admin;
GRANT SELECT ON public.tournament_daily_series_completion TO pzd_audit_admin;
GRANT SELECT ON public.tournament_verified_subgame_score TO pzd_audit_admin;
GRANT SELECT ON public.tournament_daily_result_category TO pzd_audit_admin;
GRANT SELECT ON public.tournament_on_time_badge TO pzd_audit_admin;
GRANT SELECT ON public.tournament_f2b_trusted_provenance TO pzd_audit_admin;
GRANT SELECT ON public.tournament_f2a_structural_readiness TO pzd_audit_admin;
GRANT SELECT ON public.tournament_f2c_settlement TO pzd_audit_admin;
GRANT SELECT ON public.tournament_f2c_board_header TO pzd_audit_admin;
GRANT SELECT ON public.tournament_f2c_rank_snapshot TO pzd_audit_admin;

GRANT EXECUTE ON FUNCTION public.tournament_daily_claim_reject_identity_mutation() TO pzd_app_runtime;
GRANT EXECUTE ON FUNCTION public.tournament_f2b_reject_publication_mutation() TO pzd_app_runtime;
GRANT EXECUTE ON FUNCTION public.tournament_f2c_reject_closed_period_write() TO pzd_app_runtime, pzd_settlement_worker;
GRANT EXECUTE ON FUNCTION public.tournament_f2c_reject_final_mutation() TO pzd_settlement_worker;
GRANT EXECUTE ON FUNCTION public.pzd_schema_migration_reject_mutation() TO pzd_migration_owner;

-- pzd-migration: 0011_journal_receipt_immutable
-- pzd-requires: 0010_f2_privileges
-- pzd-transactional: true
-- pzd-reversible: false
-- pzd-expands: immutability of admission identity and receipt timestamps
-- pzd-contracts: none
-- outcome and result_json remain updatable. Receipt stamps do not.

CREATE OR REPLACE FUNCTION public.command_admission_journal_reject_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.admission_id IS DISTINCT FROM OLD.admission_id
     OR NEW.series_key IS DISTINCT FROM OLD.series_key
     OR NEW.player_id IS DISTINCT FROM OLD.player_id
     OR NEW.command_type IS DISTINCT FROM OLD.command_type
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.trusted_received_at_ms IS DISTINCT FROM OLD.trusted_received_at_ms
     OR NEW.db_trusted_received_at_ms IS DISTINCT FROM OLD.db_trusted_received_at_ms
     OR NEW.admission_seq IS DISTINCT FROM OLD.admission_seq
     OR NEW.expected_board_revision IS DISTINCT FROM OLD.expected_board_revision
     OR NEW.writer_generation IS DISTINCT FROM OLD.writer_generation
     OR NEW.score_delta IS DISTINCT FROM OLD.score_delta
     OR NEW.completes_series IS DISTINCT FROM OLD.completes_series
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ADMISSION_RECEIPT_IMMUTABLE'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_admission_receipt_immutable'
      AND tgrelid = 'public.command_admission_journal'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_admission_receipt_immutable
      BEFORE UPDATE ON public.command_admission_journal
      FOR EACH ROW
      EXECUTE FUNCTION public.command_admission_journal_reject_receipt_mutation();
  END IF;
END $$;

ALTER FUNCTION public.command_admission_journal_reject_receipt_mutation() OWNER TO pzd_migration_owner;
REVOKE ALL ON FUNCTION public.command_admission_journal_reject_receipt_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.command_admission_journal_reject_receipt_mutation() TO pzd_app_runtime;

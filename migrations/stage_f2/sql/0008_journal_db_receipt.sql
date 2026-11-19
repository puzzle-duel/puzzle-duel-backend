-- pzd-migration: 0008_journal_db_receipt
-- pzd-requires: 0007_f2b_immutability
-- pzd-transactional: true
-- pzd-reversible: false
-- pzd-expands: durable database receipt column for databases created before it existed
-- pzd-contracts: none

DO $$
BEGIN
  IF to_regclass('public.command_admission_journal') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_SCHEMA_INCOMPATIBLE';
  END IF;
END $$;

ALTER TABLE public.command_admission_journal
  ADD COLUMN IF NOT EXISTS db_trusted_received_at_ms BIGINT NULL;

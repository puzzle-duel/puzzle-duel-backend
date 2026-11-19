-- pzd-migration: 0000_schema_history
-- pzd-requires: none
-- pzd-transactional: true
-- pzd-reversible: false
-- pzd-expands: migration history
-- pzd-contracts: none
-- Schema installation does not open a ranked route.

CREATE TABLE IF NOT EXISTS public.pzd_schema_migration (
  migration_id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  reversible BOOLEAN NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

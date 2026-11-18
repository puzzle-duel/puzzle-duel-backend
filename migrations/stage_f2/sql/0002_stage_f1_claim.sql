-- pzd-migration: 0002_stage_f1_claim
-- pzd-requires: 0001_stage_e_gameplay
-- pzd-transactional: true
-- pzd-reversible: false
-- pzd-expands: daily claim and series writer
-- pzd-contracts: none

CREATE TABLE IF NOT EXISTS public.tournament_series_writer (
  series_key TEXT PRIMARY KEY,
  player_id UUID NOT NULL,
  session_id UUID NOT NULL,
  device_id UUID NOT NULL,
  writer_generation BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.tournament_daily_claim (
  series_id UUID PRIMARY KEY,
  player_id TEXT NOT NULL,
  original_utc_date DATE NOT NULL,
  started_at_ms BIGINT NOT NULL,
  manifest_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (player_id, original_utc_date),
  CHECK (status IN ('ACTIVE', 'AWAIT_ADVANCE', 'COMPLETED', 'FORFEITED'))
);

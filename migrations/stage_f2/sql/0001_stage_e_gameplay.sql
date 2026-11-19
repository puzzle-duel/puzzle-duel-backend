-- pzd-migration: 0001_stage_e_gameplay
-- pzd-requires: 0000_schema_history
-- pzd-transactional: true
-- pzd-reversible: false
-- pzd-expands: stage E ingress and trusted gameplay tables
-- pzd-contracts: none

CREATE TABLE IF NOT EXISTS public.command_admission_journal (
  admission_id UUID PRIMARY KEY,
  series_key TEXT NOT NULL,
  player_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  trusted_received_at_ms BIGINT NOT NULL,
  db_trusted_received_at_ms BIGINT NULL,
  admission_seq BIGINT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending',
  expected_board_revision BIGINT NULL,
  writer_generation BIGINT NULL,
  score_delta BIGINT NULL,
  completes_series BOOLEAN NOT NULL DEFAULT FALSE,
  result_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (series_key, player_id, idempotency_key),
  UNIQUE (series_key, admission_seq)
);

CREATE INDEX IF NOT EXISTS command_admission_journal_pending_idx
  ON public.command_admission_journal (series_key, trusted_received_at_ms)
  WHERE outcome = 'pending';

ALTER TABLE public.command_admission_journal
  ADD COLUMN IF NOT EXISTS result_json JSONB NULL,
  ADD COLUMN IF NOT EXISTS db_trusted_received_at_ms BIGINT NULL;

CREATE TABLE IF NOT EXISTS public.series_fence_state (
  series_key TEXT PRIMARY KEY,
  board_revision BIGINT NOT NULL,
  writer_generation BIGINT NOT NULL,
  status TEXT NOT NULL,
  idle_deadline_at_ms BIGINT NOT NULL,
  hard_cutoff_at_ms BIGINT NULL,
  score BIGINT NOT NULL DEFAULT 0,
  results_published BOOLEAN NOT NULL DEFAULT FALSE,
  last_applied_admission_id UUID NULL,
  thinking_extension_consumed BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS public.trusted_challenge_binding (
  series_key TEXT NOT NULL,
  player_id TEXT NOT NULL,
  subgame_ordinal INT NOT NULL,
  challenge_id TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  generator_version TEXT NOT NULL,
  content_version TEXT NOT NULL,
  initial_state_digest TEXT NOT NULL,
  initial_state_json JSONB NOT NULL,
  assigned_at_ms BIGINT NOT NULL,
  PRIMARY KEY (series_key, player_id, subgame_ordinal)
);

CREATE TABLE IF NOT EXISTS public.accepted_move_ledger (
  series_key TEXT NOT NULL,
  player_id TEXT NOT NULL,
  subgame_ordinal INT NOT NULL,
  challenge_id TEXT NOT NULL,
  admission_id UUID NOT NULL,
  admission_seq BIGINT NOT NULL,
  board_revision_after BIGINT NOT NULL,
  move_json JSONB NOT NULL,
  score_delta BIGINT NOT NULL,
  score_after BIGINT NOT NULL,
  state_hash_before TEXT NOT NULL,
  state_hash_after TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  trusted_received_at_ms BIGINT NOT NULL,
  terminal_after BOOLEAN NOT NULL,
  terminal_reason TEXT NULL,
  PRIMARY KEY (series_key, player_id, subgame_ordinal, board_revision_after),
  UNIQUE (series_key, player_id, subgame_ordinal, admission_id)
);

CREATE TABLE IF NOT EXISTS public.authoritative_game_snapshot (
  series_key TEXT NOT NULL,
  player_id TEXT NOT NULL,
  subgame_ordinal INT NOT NULL,
  challenge_id TEXT NOT NULL,
  board_revision BIGINT NOT NULL,
  move_cursor INT NOT NULL,
  state_hash TEXT NOT NULL,
  score BIGINT NOT NULL,
  status TEXT NOT NULL,
  terminal_reason TEXT NULL,
  state_json JSONB NOT NULL,
  ledger_admission_seq BIGINT NOT NULL,
  writer_generation BIGINT NOT NULL,
  produced_by_admission_id UUID NULL,
  PRIMARY KEY (series_key, player_id, subgame_ordinal)
);

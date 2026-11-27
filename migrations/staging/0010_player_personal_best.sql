-- PZD-53: account-scoped personal best records (practice sync + tournament projection).
-- Additive only. Never stores provider subjects, emails, or tokens.
DO $guard$
BEGIN
  IF current_database() <> 'pzd_staging' THEN
    RAISE EXCEPTION 'PERSONAL_BEST_STAGING_ONLY';
  END IF;
END;
$guard$;

CREATE TABLE IF NOT EXISTS public.player_personal_best (
  player_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('practice', 'tournament')),
  difficulty text NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  rules_version text NOT NULL,
  generator_version text NOT NULL,
  score bigint NOT NULL
    CHECK (score >= 0 AND score <= 9007199254740991),
  achieved_at_ms bigint NOT NULL
    CHECK (achieved_at_ms >= 0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  provenance text NOT NULL CHECK (provenance IN (
    'client_reported_practice',
    'tournament_f2b_verified_subgame'
  )),
  completion_id text,
  series_id uuid,
  subgame_ordinal integer
    CHECK (subgame_ordinal IS NULL OR (subgame_ordinal BETWEEN 1 AND 6)),
  PRIMARY KEY (player_id, source, difficulty, rules_version, generator_version),
  CHECK (
    (
      source = 'practice'
      AND provenance = 'client_reported_practice'
      AND series_id IS NULL
      AND subgame_ordinal IS NULL
    )
    OR (
      source = 'tournament'
      AND provenance = 'tournament_f2b_verified_subgame'
    )
  )
);

CREATE INDEX IF NOT EXISTS player_personal_best_player_idx
  ON public.player_personal_best (player_id);

CREATE INDEX IF NOT EXISTS player_personal_best_player_source_idx
  ON public.player_personal_best (player_id, source);

REVOKE ALL ON public.player_personal_best FROM PUBLIC;
REVOKE ALL ON public.player_personal_best FROM pzd_app_runtime;
GRANT SELECT ON public.player_personal_best TO pzd_app_runtime;
GRANT INSERT (
  player_id,
  source,
  difficulty,
  rules_version,
  generator_version,
  score,
  achieved_at_ms,
  recorded_at,
  provenance,
  completion_id,
  series_id,
  subgame_ordinal
) ON public.player_personal_best TO pzd_app_runtime;
GRANT UPDATE (
  score,
  achieved_at_ms,
  recorded_at,
  provenance,
  completion_id,
  series_id,
  subgame_ordinal
) ON public.player_personal_best TO pzd_app_runtime;
-- No DELETE: historical personal bests are retained across scoring-version changes.

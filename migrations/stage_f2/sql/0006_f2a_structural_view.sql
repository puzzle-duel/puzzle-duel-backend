-- pzd-migration: 0006_f2a_structural_view
-- pzd-requires: 0005_f2a_publication_upgrade
-- pzd-transactional: true
-- pzd-reversible: false
-- pzd-expands: structural completeness view
-- pzd-contracts: drops the unused tournament_f2a_publication_ready view name
-- The view forces replay_verified and publication_authorized to false.

DROP VIEW IF EXISTS public.tournament_f2a_publication_ready;
CREATE OR REPLACE VIEW public.tournament_f2a_structural_readiness AS
SELECT
  c.series_id,
  c.player_id,
  to_char(c.original_utc_date, 'YYYY-MM-DD') AS original_utc_date,
  c.claim_started_at_ms,
  c.completed_at_ms,
  c.manifest_digest,
  c.revision,
  c.publication_idempotency_key,
  easy.score AS easy_score,
  medium.score AS medium_score,
  hard.score AS hard_score,
  allcat.score AS all_score,
  badge.awarded AS on_time_awarded,
  FALSE AS replay_verified,
  FALSE AS publication_authorized
FROM public.tournament_daily_series_completion c
JOIN public.tournament_daily_claim cl
  ON cl.series_id = c.series_id
 AND cl.player_id = c.player_id
 AND cl.original_utc_date = c.original_utc_date
 AND cl.started_at_ms = c.claim_started_at_ms
 AND cl.manifest_digest = c.manifest_digest
JOIN public.tournament_daily_result_category easy
  ON easy.series_id = c.series_id AND easy.category = 'EASY'
JOIN public.tournament_daily_result_category medium
  ON medium.series_id = c.series_id AND medium.category = 'MEDIUM'
JOIN public.tournament_daily_result_category hard
  ON hard.series_id = c.series_id AND hard.category = 'HARD'
JOIN public.tournament_daily_result_category allcat
  ON allcat.series_id = c.series_id AND allcat.category = 'ALL'
JOIN public.tournament_on_time_badge badge
  ON badge.series_id = c.series_id
 AND badge.claim_started_at_ms = c.claim_started_at_ms
 AND badge.original_utc_date = c.original_utc_date
WHERE c.revision >= 1
  AND (
    SELECT COUNT(*) FROM public.tournament_verified_subgame_score s WHERE s.series_id = c.series_id
  ) = 6
  AND (
    SELECT COUNT(DISTINCT s.subgame_ordinal)
    FROM public.tournament_verified_subgame_score s
    WHERE s.series_id = c.series_id AND s.subgame_ordinal BETWEEN 1 AND 6
  ) = 6
  AND easy.score = (
    SELECT COALESCE(SUM(s.score), -1)
    FROM public.tournament_verified_subgame_score s
    WHERE s.series_id = c.series_id AND s.subgame_ordinal IN (1, 2, 3)
  )
  AND medium.score = (
    SELECT COALESCE(SUM(s.score), -1)
    FROM public.tournament_verified_subgame_score s
    WHERE s.series_id = c.series_id AND s.subgame_ordinal IN (4, 5)
  )
  AND hard.score = (
    SELECT COALESCE(SUM(s.score), -1)
    FROM public.tournament_verified_subgame_score s
    WHERE s.series_id = c.series_id AND s.subgame_ordinal = 6
  )
  AND allcat.score = easy.score + medium.score + hard.score
  AND badge.awarded IS NOT DISTINCT FROM (
    c.claim_started_at_ms >= (EXTRACT(EPOCH FROM (c.original_utc_date::timestamp AT TIME ZONE 'UTC')) * 1000)::bigint
    AND c.claim_started_at_ms < (EXTRACT(EPOCH FROM ((c.original_utc_date::timestamp AT TIME ZONE 'UTC') + INTERVAL '1 day')) * 1000)::bigint
  );

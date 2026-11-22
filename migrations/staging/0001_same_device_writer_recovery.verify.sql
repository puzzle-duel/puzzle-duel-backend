-- Read-only verification for 0001_same_device_writer_recovery.
-- Return exactly PASS or BLOCKED. No player data or identifiers leave DB.
BEGIN READ ONLY;
SELECT CASE WHEN
  current_database() = 'pzd_staging'
  AND current_setting('server_version_num')::int >= 180000
  AND current_setting('server_version_num')::int < 190000
  AND to_regclass('public.tournament_device_credential') IS NOT NULL
  AND to_regclass('public.tournament_writer_recovery_challenge') IS NOT NULL
  AND EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tournament_auth_session'
      AND column_name='device_credential_id')
  AND EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tournament_series_writer'
      AND column_name='original_device_credential_id')
  THEN 'PASS' ELSE 'BLOCKED' END;
COMMIT;

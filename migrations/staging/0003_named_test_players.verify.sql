SELECT CASE WHEN
  to_regclass('public.pzd_staging_test_players') IS NOT NULL
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pzd_staging_test_players' AND column_name='display_name')
  AND has_table_privilege('pzd_app_runtime', 'public.pzd_staging_test_players', 'SELECT,INSERT')
THEN 'PASS' ELSE 'BLOCKED' END;

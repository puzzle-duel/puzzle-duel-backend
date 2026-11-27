BEGIN READ ONLY;
SELECT CASE
  WHEN current_database() = 'pzd_staging'
   AND to_regclass('public.player_personal_best') IS NOT NULL
   AND has_table_privilege('pzd_app_runtime', 'public.player_personal_best', 'SELECT')
   AND has_column_privilege('pzd_app_runtime', 'public.player_personal_best', 'player_id', 'INSERT')
   AND has_column_privilege('pzd_app_runtime', 'public.player_personal_best', 'score', 'INSERT')
   AND has_column_privilege('pzd_app_runtime', 'public.player_personal_best', 'score', 'UPDATE')
   AND has_column_privilege('pzd_app_runtime', 'public.player_personal_best', 'achieved_at_ms', 'UPDATE')
   AND NOT has_table_privilege('pzd_app_runtime', 'public.player_personal_best', 'DELETE')
  THEN 'PASS'
  ELSE 'BLOCKED'
END AS personal_best_privileges;
ROLLBACK;

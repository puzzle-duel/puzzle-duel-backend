BEGIN READ ONLY;
SELECT CASE WHEN to_regclass('public.pzd_provider_continuations') IS NOT NULL
 AND EXISTS (
   SELECT 1 FROM pg_constraint c
   JOIN pg_class t ON t.oid = c.conrelid
   JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'pzd_provider_challenges'
     AND c.conname = 'pzd_provider_challenges_purpose_check'
     AND pg_get_constraintdef(c.oid) LIKE '%continue%'
 )
 AND has_table_privilege('pzd_app_runtime','public.pzd_provider_continuations','SELECT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_continuations','continuation_digest','INSERT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_continuations','provider','INSERT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_continuations','provider_subject','INSERT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_continuations','target_player_id','INSERT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_continuations','source_guest_player_id','INSERT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_continuations','source_family_id','INSERT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_continuations','expires_at','INSERT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_continuations','consumed_at','UPDATE')
 AND NOT has_table_privilege('pzd_app_runtime','public.pzd_provider_continuations','DELETE')
THEN 'PASS' ELSE 'BLOCKED' END;
ROLLBACK;

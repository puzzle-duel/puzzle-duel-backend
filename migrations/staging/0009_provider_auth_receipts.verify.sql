BEGIN READ ONLY;
SELECT CASE WHEN to_regclass('public.pzd_provider_auth_receipts') IS NOT NULL
 AND has_table_privilege('pzd_app_runtime','public.pzd_provider_auth_receipts','SELECT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_auth_receipts','operation_id','INSERT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_auth_receipts','provider','INSERT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_auth_receipts','provider_subject','INSERT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_auth_receipts','player_id','INSERT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_auth_receipts','source_guest_player_id','INSERT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_auth_receipts','source_family_id','INSERT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_auth_receipts','resolution','INSERT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_auth_receipts','committed_at','INSERT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_continuations','operation_id','INSERT')
 AND NOT has_table_privilege('pzd_app_runtime','public.pzd_provider_auth_receipts','UPDATE')
 AND NOT has_table_privilege('pzd_app_runtime','public.pzd_provider_auth_receipts','DELETE')
THEN 'PASS' ELSE 'BLOCKED' END;
ROLLBACK;

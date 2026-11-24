BEGIN READ ONLY;
SELECT CASE WHEN current_database()='pzd_staging'
 AND to_regclass('public.pzd_provider_challenges') IS NOT NULL
 AND to_regclass('public.pzd_provider_challenges_expiry') IS NOT NULL
 AND (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='pzd_provider_challenges'
      AND ((column_name IN ('nonce_digest','binding_digest') AND data_type='character' AND character_maximum_length=64 AND is_nullable='NO')
        OR (column_name IN ('provider','purpose') AND data_type='text' AND is_nullable='NO')
        OR (column_name='expires_at' AND data_type='timestamp with time zone' AND is_nullable='NO')
        OR (column_name='consumed_at' AND data_type='timestamp with time zone' AND is_nullable='YES')))=6
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('public.pzd_provider_challenges') AND contype='p' AND convalidated)=1
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('public.pzd_provider_challenges') AND contype='c' AND convalidated)>=2
 AND has_table_privilege('pzd_app_runtime','public.pzd_provider_challenges','SELECT')
 AND has_column_privilege('pzd_app_runtime','public.pzd_provider_challenges','consumed_at','UPDATE')
 AND NOT has_table_privilege('pzd_app_runtime','public.pzd_provider_challenges','DELETE,TRUNCATE,UPDATE,TRIGGER')
 AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['nonce_digest','binding_digest','provider','purpose','expires_at']) AS c(name)
   WHERE has_column_privilege('pzd_app_runtime','public.pzd_provider_challenges',c.name,'UPDATE')
      OR NOT has_column_privilege('pzd_app_runtime','public.pzd_provider_challenges',c.name,'INSERT'))
 AND NOT has_column_privilege('pzd_app_runtime','public.pzd_provider_challenges','consumed_at','INSERT')
THEN 'PASS' ELSE 'BLOCKED' END;
ROLLBACK;

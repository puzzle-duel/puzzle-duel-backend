BEGIN READ ONLY;
SELECT CASE WHEN current_database()='pzd_staging'
 AND to_regclass('public.pzd_identity_links') IS NOT NULL
 AND EXISTS (
   SELECT 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='pzd_guest_accounts'
     AND column_name='account_class' AND is_nullable='NO')
 AND EXISTS (
   SELECT 1 FROM pg_constraint
   WHERE conrelid='public.pzd_guest_accounts'::regclass
     AND conname='pzd_guest_accounts_account_class_check' AND convalidated)
 AND (SELECT count(*) FROM pg_constraint
      WHERE conrelid='public.pzd_identity_links'::regclass AND contype='p' AND convalidated)=1
 AND has_table_privilege('pzd_app_runtime','public.pzd_identity_links','SELECT')
 AND NOT has_table_privilege('pzd_app_runtime','public.pzd_identity_links','DELETE,TRUNCATE,UPDATE,TRIGGER')
 AND NOT EXISTS (
   SELECT 1 FROM unnest(ARRAY['provider','provider_subject','player_id','linked_at']) AS c(name)
   WHERE NOT has_column_privilege('pzd_app_runtime','public.pzd_identity_links',c.name,'INSERT'))
 AND EXISTS (
   SELECT 1 FROM pg_trigger
   WHERE tgrelid='public.pzd_provider_challenges'::regclass
     AND tgname='pzd_provider_challenge_immutable_trg' AND tgenabled='O')
THEN 'PASS' ELSE 'BLOCKED' END;
ROLLBACK;

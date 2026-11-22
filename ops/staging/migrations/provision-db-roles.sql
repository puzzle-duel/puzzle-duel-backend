-- PZD-50: ONE-TIME ADMINISTRATOR-EXECUTED staging role bootstrap.
-- Run interactively on Oracle with sudo -u postgres psql -d pzd_staging.
-- No credentials in this file. Never run on production or pzd_ingress.
BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'pzd_staging'
     OR current_setting('server_version_num')::integer NOT BETWEEN 180000 AND 189999
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pzd_migration_owner') THEN
    RAISE EXCEPTION 'STAGING_ADMIN_BOOTSTRAP_REFUSED';
  END IF;
END
$guard$;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pzd_staging_migrator') THEN
    CREATE ROLE pzd_staging_migrator LOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pzd_staging_backup') THEN
    CREATE ROLE pzd_staging_backup LOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$roles$;

-- Reassert intended privileges, even for existing roles of those names.
ALTER ROLE pzd_staging_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE pzd_staging_backup NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT CONNECT ON DATABASE pzd_staging TO pzd_staging_migrator, pzd_staging_backup;
GRANT USAGE ON SCHEMA public TO pzd_staging_migrator, pzd_staging_backup;
GRANT pzd_migration_owner TO pzd_staging_migrator
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT pg_read_all_data TO pzd_staging_backup
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;

-- No membership is given to the application's pzd_app_runtime role.
-- No passwords are assigned by SQL; set them interactively with \password.
COMMIT;

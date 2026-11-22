#!/usr/bin/env bash
# PZD Staging DB migrations: host-side, manual, fail-closed. No service restart.
# Run only on the isolated Oracle staging VM under the dedicated staging user.
set -euo pipefail
umask 077

mode="${1:-}"
migration="${2:-}"
expected_sha="${3:-}"
run_id="${4:-}"
[[ "$mode" == plan || "$mode" == apply ]] || { echo "BLOCKED: invalid mode"; exit 2; }
[[ "$migration" =~ ^[0-9]{4}_[a-z0-9_]+$ ]] || { echo "BLOCKED: invalid migration ID"; exit 2; }
[[ "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || { echo "BLOCKED: invalid checksum"; exit 2; }
[[ "$run_id" =~ ^[0-9]+-[0-9]+$ ]] || { echo "BLOCKED: invalid run ID"; exit 2; }

base=/home/pzd-staging/pzd-staging
incoming="$base/migration-runs/$run_id"
backup_dir="$base/backups/db"
services="$base/migration-services.conf"
migration_file="$incoming/$migration.sql"
verify_file="$incoming/$migration.verify.sql"
private_log="$incoming/private-run.log"

fail() { echo "BLOCKED: $1 (details remain on Oracle)"; exit 1; }
[[ -d "$incoming" && ! -L "$incoming" && -f "$migration_file" && -f "$verify_file" ]] ||
  fail "missing staged migration artifacts"
[[ ! -L "$migration_file" && ! -L "$verify_file" ]] || fail "symlink migration rejected"
[[ -f "$services" && ! -L "$services" ]] || fail "dedicated migration service config not provisioned"
[[ "$(stat -c '%a' "$services")" == 600 ]] ||
  fail "migration service config must be mode 0600"
[[ "$(stat -c '%u' "$services")" == "$(id -u)" ]] ||
  fail "migration service config owner mismatch"
command -v psql >/dev/null || fail "psql unavailable"
command -v pg_dump >/dev/null || fail "pg_dump unavailable"
command -v pg_restore >/dev/null || fail "pg_restore unavailable"
command -v flock >/dev/null || fail "flock unavailable"
command -v sha256sum >/dev/null || fail "sha256sum unavailable"
actual_sha="$(sha256sum "$migration_file" | cut -d' ' -f1)"
[[ "$actual_sha" == "$expected_sha" ]] || fail "source checksum mismatch"
chmod 600 "$migration_file" "$verify_file"
touch "$private_log"
chmod 600 "$private_log"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

# Host lock is shared by all invocations, including different workflow runs.
exec 9>"$base/staging-db-migrations.lock"
flock -x -w 10 9 || fail "another staging migration is running"

export PGSERVICEFILE="$services"
export PGCONNECT_TIMEOUT=5 PGAPPNAME=pzd_staging_migration_runner
export PGOPTIONS='-c statement_timeout=120000 -c lock_timeout=5000'

dbcheck="SELECT CASE WHEN current_database()='pzd_staging'
 AND current_setting('server_version_num')::integer BETWEEN 180000 AND 189999
 AND (inet_server_addr() IS NULL OR inet_server_addr() IN
  ('127.0.0.1'::inet,'::1'::inet)) THEN 'PASS' ELSE 'BLOCKED' END"
migrate_check="SELECT CASE WHEN NOT r.rolsuper
 AND pg_has_role(session_user,'pzd_migration_owner','SET')
 AND session_user <> 'pzd_app_runtime' THEN 'PASS' ELSE 'BLOCKED' END
 FROM pg_roles r WHERE r.rolname=session_user"

# Service definitions/credentials are pre-provisioned on Oracle by a DB operator,
# not supplied by workflow inputs or reused from the app runtime DSN.
db_read() { PGSERVICE="$1" psql -X -w -qAt -v ON_ERROR_STOP=1 -c "$2"; }
# The login may SET ROLE but intentionally does not INHERIT owner privileges.
# History and verification must use an explicit, connection-local SET ROLE.
db_read_owner() {
  PGSERVICE=pzd_staging_migrate psql -X -w -qAt -v ON_ERROR_STOP=1 \
    -c 'SET ROLE pzd_migration_owner' -c "$1"
}
[[ "$(db_read pzd_staging_migrate "$dbcheck" 2>>"$private_log")" == PASS ]] ||
  fail "migration DB identity check failed"
[[ "$(db_read pzd_staging_backup "$dbcheck" 2>>"$private_log")" == PASS ]] ||
  fail "backup DB identity check failed"
[[ "$(db_read pzd_staging_migrate "$migrate_check" 2>>"$private_log")" == PASS ]] ||
  fail "migration login must be able to SET the separate owner role"

history_exists="$(db_read pzd_staging_migrate   "SELECT to_regclass('public.pzd_staging_migration_history') IS NOT NULL" 2>>"$private_log")" ||
  fail "unable to check migration history"
previous=""
if [[ "$history_exists" == t ]]; then
  previous="$(db_read_owner     "SELECT sha256 FROM public.pzd_staging_migration_history WHERE migration_id='$migration'"     2>>"$private_log")" || fail "unable to read migration history"
fi
if [[ -n "$previous" ]]; then
  [[ "$previous" == "$expected_sha" ]] ||
    fail "migration ID already applied with a different checksum"
  echo "Migration $migration: ALREADY APPLIED (checksum matches)"
  [[ "$mode" == plan ]] || fail "repeat apply not permitted"
  exit 0
fi

echo "Staging PostgreSQL 18 and separate migration/backup roles: PASS"
echo "Migration: $migration"
echo "Source SHA-256: ${expected_sha:0:12}..."
echo "History: NOT APPLIED"
if [[ "$mode" == plan ]]; then
  echo "PLAN ONLY — no backup, SQL execution, or schema mutation"
  exit 0
fi

# Full, consistent custom-format backup; stays on Oracle, never Actions artifacts.
# A list/size/hash check does NOT replace a tested restore drill.
tag="$(date -u +%Y%m%dT%H%M%SZ)-$run_id"
backup="$backup_dir/before-$migration-$tag.dump"
PGSERVICE=pzd_staging_backup pg_dump -w -Fc -f "$backup" >"$private_log" 2>&1 ||
  fail "full staging backup failed; SQL was not executed"
[[ -s "$backup" ]] || fail "backup file empty; SQL was not executed"
pg_restore --list "$backup" >/dev/null 2>>"$private_log" ||
  fail "backup archive validation failed; SQL was not executed"
sha256sum "$backup" > "$backup.sha256"
chmod 600 "$backup" "$backup.sha256"
echo "On-host backup archive and checksum: CREATED and ARCHIVE LIST VALID"
echo "Backup restore rehearsal: NOT_RUN (separate operator recovery gate)"

# Transactions cover migration DDL AND checksum ledger together.
# Migration SQL MUST NOT contain BEGIN/COMMIT or psql backslash commands.
if grep -Eiq '^[[:space:]]*(BEGIN|COMMIT|ROLLBACK|\\)' "$migration_file"; then
  fail "migration controls its own transaction or contains psql meta-commands"
fi
transaction="$incoming/transaction.sql"
{
  echo 'BEGIN;'
  echo 'SET LOCAL lock_timeout = '\''5s'\'';'
  echo 'SET LOCAL statement_timeout = '\''120s'\'';'
  echo 'SET ROLE pzd_migration_owner;'
  echo "CREATE TABLE IF NOT EXISTS public.pzd_staging_migration_history (
    migration_id TEXT PRIMARY KEY,
    sha256 CHAR(64) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  );"
  echo 'ALTER TABLE public.pzd_staging_migration_history OWNER TO pzd_migration_owner;'
  echo 'REVOKE ALL ON public.pzd_staging_migration_history FROM PUBLIC;'
  echo "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM public.pzd_staging_migration_history
    WHERE migration_id='$migration') THEN
    RAISE EXCEPTION 'STAGING_MIGRATION_ALREADY_APPLIED'; END IF; END \$\$;"
  printf '\\i %s\n' "$migration_file"
  echo "INSERT INTO public.pzd_staging_migration_history(migration_id,sha256)
    VALUES ('$migration','$expected_sha');"
  echo 'COMMIT;'
} >"$transaction"
chmod 600 "$transaction"

if ! PGSERVICE=pzd_staging_migrate psql -X -w -q -v ON_ERROR_STOP=1   -f "$transaction" >"$private_log" 2>&1; then
  fail "transaction failed; no automatic retry or destructive rollback"
fi
echo "Migration transaction: COMMITTED"
verify_result="$(PGSERVICE=pzd_staging_migrate psql -X -w -qAt -v ON_ERROR_STOP=1 \
  -c 'SET ROLE pzd_migration_owner' -f "$verify_file" 2>>"$private_log")" ||
  fail "post-migration verification execution failed; migration may be committed"
[[ "$verify_result" == PASS ]] ||
  fail "post-migration verification failed; migration may be committed"
echo "Post-migration verification: PASS"
echo "Recovery feature activation: NOT PERFORMED"

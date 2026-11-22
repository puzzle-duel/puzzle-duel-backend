# PZD — Reusable Staging Database Migrations

This is a **manual, reusable migration workflow**, not an automatic deployment hook.

- Workflow: `.github/workflows/staging-db-migrations.yml`
- Runner: `ops/staging/migrations/run.sh`
- SQL: `migrations/staging/NNNN_description.sql` with paired `NNNN_description.verify.sql`
- Environment: **pzd-staging-migrations** (separate from `pzd-staging`)
- Branch: **version/0.0.2** only. Production and `main` are refused.
- Target: **local PostgreSQL 18 database `pzd_staging` only**.

## Initial protected-environment provisioning — operator/admin action

The GitHub environment **pzd-staging-migrations** MUST be created and restricted to
`version/0.0.2`, with required reviewers / no self-approval where available.
Do not use `pzd-staging` (which may deploy without individual review), and do
not grant pull requests access. The following **new** environment secrets are
required: `PZD_MIGRATION_HOST`, `PZD_MIGRATION_USER`,
`PZD_MIGRATION_SSH_PRIVATE_KEY`, `PZD_MIGRATION_SSH_KNOWN_HOSTS`.
Use a dedicated SSH key provisioned for this environment, not the deployment key.
The remote account must be able to write only the isolated staging workspace,
not invoke sudo or access Forest Dash.

An authorized Oracle/PostgreSQL administrator must pre-provision
`/home/pzd-staging/pzd-staging/migration-services.conf` as a regular file,
**owned by the staging Unix account, mode 0600**. It must contain two libpq
service entries:

```ini
[pzd_staging_migrate]
host=127.0.0.1
port=5432
dbname=pzd_staging
user=<dedicated-migration-login>
password=<secret>

[pzd_staging_backup]
host=127.0.0.1
port=5432
dbname=pzd_staging
user=<dedicated-backup-login>
password=<secret>
```

These are placeholders, **not actual credentials**. Never paste actual values
into GitHub source, PRs, workflow inputs, screenshots or logs.
The migration login must be a non-superuser and authorized to **SET ROLE
`pzd_migration_owner`** (a NOLOGIN role). The owner role has schema DDL
privileges. The backup login needs enough read access for a **complete**,
consistent `pg_dump -Fc`; it must not be the application runtime login
unless separately reviewed. Do not grant the app's `pzd_app_runtime` DDL or
migration-owner membership.

Provisioned service credentials must remain private on Oracle. This action
does not create DB roles or retrieve their passwords. The existing normal
staging deployment SSH environment is **not** an authorization substitute.

## Repeatable release procedure

1. Add a reviewed `migrations/staging/NNNN_description.sql` and matching
   `.verify.sql` on a PR against the release branch. Migration SQL must not
   include its own transaction control or psql meta-commands. The runner owns
   the atomic transaction and records ID + SHA-256 in the same transaction.
   Keep an existing migration file byte-for-byte immutable once applied.
2. Confirm a backup/restore plan and run a restore rehearsal separately on
   an isolated disposable PostgreSQL database if the migration risk requires it.
   This Action creates a complete archive and validates that the archive
   **can be listed**; it cannot claim it was restore-tested.
3. Open the [Staging DB Migration Action](https://github.com/puzzle-duel/puzzle-duel-backend/actions/workflows/staging-db-migrations.yml)
   and select `version/0.0.2`, the reviewed migration ID, `plan`,
   and leave the confirmation empty. A plan performs **no DB mutation**.
4. Check the plan and approve a separate run with `apply`, confirmation
   exactly `APPLY pzd_staging NNNN_description`, and required GitHub
   environment reviewers. The host runner rejects incorrect DB name,
   remote DB host, PG version, login role, checksum, duplicate migration ID,
   missing backup config or incomplete archive.
5. The host creates a full custom-format backup in
   `/home/pzd-staging/pzd-staging/backups/db/` with an adjacent checksum,
   mode 0600, **never uploaded to the public GitHub repo or artifacts**.
   It then executes DDL and the checksum ledger in **one DB transaction**.
   A migration failure aborts the transaction; post-commit verification failure
   is explicitly reported and **does not attempt a destructive rollback**.
6. Independently run the [read-only Recovery Preflight](https://github.com/puzzle-duel/puzzle-duel-backend/actions/workflows/staging-recovery-preflight.yml)
   for migration 0001, check client/server parity, and only then consider
   separately enabling recovery in `staging.env` with operator approval.
   This migration workflow never restarts the app or turns a feature flag on.

## Safety and recovery limitations

- GitHub repo/job logs are public: output includes only migration ID,
  truncated SQL checksum, coarse PASS/BLOCKED status, and archive presence.
  Query output, DB passwords, backup contents, actual IDs and player data stay
  on Oracle. For a failure, an authorized operator inspects the private
  `migration-runs/<run>-<attempt>/private-run.log` on Oracle.
- Manual `plan` is non-mutating. The `apply` action is **mutating** but
  requires protected environment authorization and exact confirmation.
- Public repo Actions cannot approve or bypass environment checks.
- Backups accumulate on the Oracle disk. An operator must set secure retention,
  check disk capacity, and regularly test restores. Do not purge automatically.
- Historical unanchored claims are **never backfilled** and remain ineligible
  for cryptographic writer recovery; no forced takeover or DB reset.
- The migration history table is staging-only and restricted from public
  database roles; checksum mismatch is fatal.
- If the isolated migration environment/service entries or role grants do not
  yet exist, **no migration has been performed**. First run a safe plan to
  demonstrate readiness. Do not silently fall back to runtime credentials.

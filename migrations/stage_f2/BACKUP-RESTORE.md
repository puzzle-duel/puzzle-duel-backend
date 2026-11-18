# PZD-41 backup and restore

Take the backup before applying a migration. The forward files do not delete claims, journal rows, or FINAL snapshots, and the runner will not drop them afterward.

## Backup

Run these against the Puzzle Duel database only. Do not point them at another service.

```bash
pg_dump --format=custom --no-owner --file=pzd-f2.dump "$PZD_INGRESS_DATABASE_URL"
pg_dump --schema-only --no-owner --file=pzd-f2.schema.sql "$PZD_INGRESS_DATABASE_URL"
sha256sum pzd-f2.dump pzd-f2.schema.sql
```

Record `server_version_num`, the rows in `pzd_schema_migration`, and the `settlement_id` values in `tournament_f2c_settlement`.

`CREATE DATABASE ... TEMPLATE` is a file-level clone. It is not a `pg_dump` / `pg_restore` pass. The migration test records `pg_dump_restore=NOT_RUN` when neither host `pg_dump` and `pg_restore` nor a Docker daemon that can run `postgres:18` is available. It does not relabel the template clone as that pass. When either tool can run, the test dumps `pzd_f2_migration_gate` in custom format with `--no-owner` and restores it with `pg_restore --exit-on-error --no-owner` into the empty database `pzd_f2_migration_dump`.

The local run printed `pg_dump_restore=postgres-18-image`. Host `pg_dump` was not on `PATH`. The `postgres:18` image supplied `pg_dump` and `pg_restore`. The restored database kept the source settlement id, `verifyMigrations` and `assertMigrationStartupReady` passed, and `DELETE` from settlement raised `F2C_FINAL_IMMUTABLE`. That is a disposable-database result, not a production backup sign-off. GitHub Actions for this job has no Docker daemon, so the same test records `NOT_RUN` there.

## Restore

1. Stop the application and the settlement worker so they cannot write during the restore.
2. Restore into an empty database with `pg_restore --exit-on-error --no-owner`.
3. Compare `pzd_schema_migration.checksum` with the SHA-256 of the SQL files in this directory. Refuse startup on a mismatch.
4. Compare every `settlement_id` with the backup record. Do not rerun settlement for a week that already has a FINAL row.
5. Confirm the immutability triggers are enabled. An owner or superuser can disable them, so a restore that omitted the triggers is not acceptable.

A failed migration that is still inside its transaction rolls back with the history insert. `0010_f2_privileges` is the exception. `CREATE ROLE` and the privilege `DO` block commit on their own. If the process stops after that block revokes write privileges and before the later grants, the history row is absent and a retry restores the grants. It does not delete leaderboard rows.

Do not use `DROP TABLE` as a rollback once a publication or FINAL row exists.

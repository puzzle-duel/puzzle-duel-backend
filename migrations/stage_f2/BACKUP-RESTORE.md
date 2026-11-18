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

`pg_dump` was not installed on the machine that ran this gate. The executed restore proof is PostgreSQL's `CREATE DATABASE ... TEMPLATE` copy of the disposable database `pzd_f2_migration_gate` into `pzd_f2_migration_restore`. The copy kept the same settlement id and claim count. `DELETE` from settlement raised `F2C_FINAL_IMMUTABLE`. `UPDATE` of a completion raised `F2B_PUBLICATION_IMMUTABLE`.

## Restore

1. Stop the application and the settlement worker so they cannot write during the restore.
2. Restore into an empty database with `pg_restore --exit-on-error --no-owner`.
3. Compare `pzd_schema_migration.checksum` with the SHA-256 of the SQL files in this directory. Refuse startup on a mismatch.
4. Compare every `settlement_id` with the backup record. Do not rerun settlement for a week that already has a FINAL row.
5. Confirm the immutability triggers are enabled. An owner or superuser can disable them, so a restore that omitted the triggers is not acceptable.

A failed migration that is still inside its transaction rolls back with the history insert. `0010_f2_privileges` is the exception: a failure can leave a role behind, and running it again is safe. It does not delete leaderboard rows.

Do not use `DROP TABLE` as a rollback once a publication or FINAL row exists.

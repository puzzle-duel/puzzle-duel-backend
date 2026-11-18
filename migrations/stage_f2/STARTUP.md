# PZD-41 migration startup contract

This repository has no production process entrypoint. The only HTTP servers are test servers. Do not add a ranked listener in order to call this guard.

`assertMigrationStartupReady` in `src/tournament/migrations/f2-migrator.mts` is the mandatory startup guard. Every future ranked writer and the settlement worker must call it on their PostgreSQL pool and abort before the first write when it throws. A process that skips the call is outside this contract.

The guard refuses startup when any of these are true:

- `server_version_num` is outside PostgreSQL 18 (`MIGRATION_SCHEMA_INCOMPATIBLE`).
- `public.pzd_schema_migration` is absent, a row is malformed, or the same id appears twice (`MIGRATION_SCHEMA_INCOMPATIBLE`).
- An applied migration id is not in this build's versioned SQL manifest (`MIGRATION_VERSION_AHEAD`).
- A manifest id is missing, or a file's `pzd-requires` predecessor is missing (`MIGRATION_DEPENDENCY_MISSING`).
- A stored checksum is not the SHA-256 of the SQL file in this build (`MIGRATION_CHECKSUM_CONFLICT`).
- A required security trigger is missing, disabled, or replica-only. `tgenabled` must be `O` or `A` (`SECURITY_TRIGGER_DISABLED`).

The required triggers are the claim identity trigger, the five F2-B immutability triggers, the three F2-C immutability triggers, both period-closure triggers, the migration-history trigger, and `trg_admission_receipt_immutable`.

`0010_f2_privileges` is nontransactional because `CREATE ROLE` cannot run inside a transaction. Its `DO` block revokes write privileges and changes ownership before the later `GRANT` statements. If the process stops after that block and before the history row, a retry runs the file again. `CREATE ROLE` ignores the duplicate-role error, the `DO` block is idempotent, and the grants are applied before the history insert. Do not record `0010` as applied until those grants have run.

Calling the guard does not authorize a production migration, a ranked route, or a production failover sign-off.

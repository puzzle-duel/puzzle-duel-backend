# PZD-41 F2 migration acceptance

Status: versioned SQL is implemented and exercised on disposable PostgreSQL 18. Applying it to a production database is not authorized. Ranked HTTP stays disabled. PZD-41 is not Done.

## Order

| ID | Expands | Contracts | Rollback |
| --- | --- | --- | --- |
| `0000_schema_history` | `pzd_schema_migration` | none | restore a backup |
| `0001_stage_e_gameplay` | journal, fence, ledger, snapshot, challenge binding | none | restore a backup |
| `0002_stage_f1_claim` | daily claim and series writer | none | restore a backup |
| `0003_f2a_claim_identity` | identity unique key and trigger | none | restore a backup |
| `0004_f2a_publication` | completion, six scores, four categories, badge, provenance table | none | restore a backup |
| `0005_f2a_publication_upgrade` | composite claim foreign key | drops only a superseded series-id foreign key when present | restore a backup |
| `0006_f2a_structural_view` | structural view | drops the unused `tournament_f2a_publication_ready` view name | restore a backup |
| `0007_f2b_immutability` | nullable publication columns and immutability triggers | none | restore a backup |
| `0008_journal_db_receipt` | `db_trusted_received_at_ms` when an older journal lacks it | none | restore a backup |
| `0009_f2c_final` | settlement, 32-board headers, rank rows, period closure | none | restore a backup |
| `0010_f2_privileges` | NOLOGIN roles and grants | none | restore a backup |
| `0011_journal_receipt_immutable` | admission identity and receipt timestamps cannot be updated | none | restore a backup |

`0009` inserts no settlement row. None of the files enable a ranked route.

The runner stores the SHA-256 of each file. A second run with the same bytes is a no-op. A changed file, a missing predecessor, an applied id this build does not contain, or a server whose `server_version_num` is outside PostgreSQL 18 is refused. An existing FINAL table without `state` is refused and left unchanged.

Transactional migrations commit their schema change and history row together. `0010` cannot, because `CREATE ROLE` cannot run inside a transaction. Its statements are idempotent and the history row is written only after they succeed.

## What was executed

Disposable databases on the local PostgreSQL 18 used by `PZD_INGRESS_DATABASE_URL`. No production database was changed.

`npm run test:stage-f2-migrations`: 8 pass, 0 fail, 0 skip. That covers a fresh install, an upgrade from a pre-F2 journal and claim, a publication that already existed before the immutability trigger, a re-run, a checksum mismatch, a failed statement before the history insert, a retry that does not duplicate the probe row, an incompatible FINAL table, role separation, and a `CREATE DATABASE ... TEMPLATE` restore.

The runner refuses every down migration with `MIGRATION_ROLLBACK_REQUIRES_BACKUP`. Dropping publication or FINAL tables is not a rollback.

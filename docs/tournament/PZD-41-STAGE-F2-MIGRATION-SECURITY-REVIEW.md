# PZD-41 migration privilege review

Review of the migration and privilege changes, reviewer id `0d556d89-6833-4d5a-ae34-3729733ffe80`.

Ranked HTTP stays disabled. Closed F2-B findings were not reopened. A superuser or the table owner can disable a trigger. The runtime roles cannot. That boundary is in `migrations/stage_f2/PRIVILEGES.md`.

| Severity | Finding | Disposition |
| --- | --- | --- |
| P1 | `pzd_app_runtime` could `UPDATE` `trusted_received_at_ms` and `db_trusted_received_at_ms`, which the FINAL barrier treats as the cutoff decision | Fixed by `0011_journal_receipt_immutable`. The trigger allows `outcome` and `result_json` and rejects receipt and identity changes with `ADMISSION_RECEIPT_IMMUTABLE`. The privilege test updates a stamp as the app role and expects that exception. |
| P2 | Two migrators could apply at the same time | The runner now holds session advisory lock `(-1499745247, 424404725)` for the whole apply. |
| P2 | `verifyMigrations` is not called from an application startup path | Still true. There is no production process entrypoint in this repository yet. A deployment must call it before serving writes. |
| P2 | A backward PostgreSQL clock can still create a new pre-cutoff receipt for a week that is not the one being tested | The disposable container clock step rejected a claim in an already FINAL week. It does not prove an NTP step on a production host. New receipts for a week that is not FINAL remain possible if the database clock moves backward before FINAL. |

No P0 was found. Production apply, ranked HTTP, and a production failover sign-off remain unauthorized.

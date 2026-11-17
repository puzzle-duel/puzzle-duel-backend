# Stage E schema notes

Phase A DDL remains embedded in TypeScript (`ADMISSION_JOURNAL_DDL`, `SERIES_FENCE_DDL`) for disposable ingress proofs.

Stage E **does not** claim production migration acceptance. ADR-T02 still requires versioned SQL migrations with rollback guidance before production.

Added Stage E tables (memory-first; Postgres DDL planned):

| Concept | Memory store | Notes |
| --- | --- | --- |
| Trusted challenge binding | `MemoryTrustedChallengeStore` | Server-owned initial state + digest |
| Accepted move ledger | `MemoryAcceptedMoveLedger` | Distinct from admission journal |
| Authoritative snapshot | `MemoryAuthoritativeSnapshotStore` | Server-written only; V3-48 rejects client overwrite |

Rollback: drop Stage E memory/process state; Phase A tables unchanged in semantics except `score_delta`/`completes_series` columns are no longer written from client input (always NULL/FALSE on insert).

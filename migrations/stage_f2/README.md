# Stage F2-A schema notes

Status: **candidate / Proposed for independent F2-A review**. Not a frozen production migration pack.

## What this stage adds

Additive PostgreSQL 18 tables for exactly-once daily series completion publication:

| Table | Purpose |
| --- | --- |
| `tournament_daily_series_completion` | Single completion receipt per F1 `tournament_daily_claim.series_id` |
| `tournament_verified_subgame_score` | Six replay-derived terminal scores with snapshot/ledger provenance |
| `tournament_daily_result_category` | Exactly four rows (`EASY`/`MEDIUM`/`HARD`/`ALL`) per completion |
| `tournament_on_time_badge` | Exactly one badge decision per completion (awarded true/false) |

DDL source of truth for disposable proofs: `src/tournament/results/f2a-publication-schema.mts` (`F2A_PUBLICATION_DDL`).

## Prerequisites

Must already exist (F1 / Stage E):

- `tournament_daily_claim`
- `authoritative_game_snapshot`, `accepted_move_ledger`, `trusted_challenge_binding`
- `series_fence_state`, `tournament_series_writer`

F2-A **reuses** F1 `tournament_daily_claim`; it does **not** invent a parallel claim table.

## Rollback (disposable / review environments)

```sql
DROP TABLE IF EXISTS tournament_on_time_badge;
DROP TABLE IF EXISTS tournament_daily_result_category;
DROP TABLE IF EXISTS tournament_verified_subgame_score;
DROP TABLE IF EXISTS tournament_daily_series_completion;
```

Production versioned migration IDs, expand/contract rollout, and backup/restore remain **NOT_RUN** until owner-approved migration acceptance (ADR-T02 still requires versioned SQL + rollback before production).

## Explicitly deferred (Proposed / F2-B/C)

- Atomic publish unit-of-work that writes these rows
- Weekly aggregates / period revision / immutable FINAL snapshots
- Leaderboard read APIs and pagination defaults (TD-15 remains Proposed)
- HTTP/OpenAPI publication surfaces

## Hardening notes

- Apply `F2A_CLAIM_IDENTITY_DDL` before publication tables (adds claim UNIQUE + immutability trigger).
- Completion uses composite FK to claim identity; upgrade path is `F2A_PUBLICATION_UPGRADE_DDL`.
- Readiness view `tournament_f2a_publication_ready` is the sole F2-A visibility contract for F2-C.

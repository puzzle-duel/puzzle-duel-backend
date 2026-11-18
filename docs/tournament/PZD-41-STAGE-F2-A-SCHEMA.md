# PZD-41 Stage F2-A — Publication schema & contract (candidate)

Status: **READY FOR INDEPENDENT F2-A REVIEW** (schema/contract foundation).  
**NOT** F2-B atomic publish, F2-C weekly FINAL, or PZD-41 Done.

Jira: https://puzzle-duel-app.atlassian.net/browse/PZD-41  
PR: https://github.com/puzzle-duel/puzzle-duel-backend/pull/18  
Depends on: PZD-39 Stage E + PZD-40 F1 merged to `main` (production-disabled ranked HTTP preserved).

## Hardening — claim identity FK + fail-closed readiness (2026-11-17)

### Database-enforced claim integrity
- Additive UNIQUE on F1 claim: `(series_id, player_id, original_utc_date, started_at_ms, manifest_digest)`.
- Completion composite FK to that UNIQUE — mismatched player/date/start/manifest rejected at PostgreSQL boundary.
- BEFORE UPDATE trigger rejects mutation of claim identity columns; status updates remain allowed.
- DELETE of claim while completion exists is RESTRICTED by FK.
- On-Time badge composite FK to completion `(series_id, claim_started_at_ms, original_utc_date)`.

### Fail-closed structural readiness (NOT publication authorization)
- Canonical view: `tournament_f2a_structural_readiness` (always `replay_verified=false`, `publication_authorized=false`).
- TS: `evaluateStructuralReadiness` — row completeness only. **No** `evaluatePublicationReadiness` / `visible` helper.
- F2-C MUST use `evaluateLeaderboardReadEligibility(db, seriesId)` which reads **only DB state**.
- DB proof boundary table: `tournament_f2b_trusted_provenance` (F2-B writer not implemented). In-memory/TS brands are rejected via `rejectInMemoryProvenanceAttestation`.
- Forged provenance rows still yield `F2B_PROVENANCE_SEAL_UNVERIFIED`. `authorized:true` is unreachable in F2-A.
- Former view name `tournament_f2a_publication_ready` is dropped and must not be used.

### Upgrade / rollback
- `F2A_CLAIM_IDENTITY_DDL` is idempotent: adds UNIQUE/trigger only when missing (no DROP/ADD churn).
- `F2A_PUBLICATION_UPGRADE_DDL` fails closed on identity mismatch; adds composite FKs only when missing; drops legacy series_id-only FK only if present.
- Rollback: `F2A_PUBLICATION_DROP_DDL` removes F2-A objects/trigger/unique without deleting F1 claim rows or weakening `UNIQUE(player_id, original_utc_date)`.

## Binding inputs (already on main)

| Artifact | Role |
| --- | --- |
| `tournament_daily_claim` | Immutable player+UTC-date entitlement; `started_at_ms` is On-Time authority |
| `trusted_challenge_binding` | Pinned per-ordinal challenge + initial digest |
| `accepted_move_ledger` | Replay-admitted move provenance + score deltas |
| `authoritative_game_snapshot` | Terminal per-ordinal score/state_hash authority |
| `series_fence_state` | Writer/board CAS; `results_published` flag (not category authority) |
| `four-category-scores.mts` | Pure calculator only — never a publish boundary |

## Additive tables (implementation candidate)

### `tournament_daily_series_completion`

- **PK** `series_id` → FK `tournament_daily_claim.series_id`
- **UNIQUE** `(player_id, original_utc_date)` — mirrors claim uniqueness; prevents duplicate publish
- **UNIQUE** `publication_idempotency_key` — retry-safe (`f2-publish:<series_id>`)
- Stores claim start + completion timestamps, manifest digest, revision
- **CHECK** `completed_at_ms >= claim_started_at_ms`

### `tournament_verified_subgame_score`

- **PK** `(series_id, subgame_ordinal)` with ordinal `1..6`
- Stores challenge_id, state_hash, score, ledger_admission_seq, optional admission UUID
- Scores must be copied from **server** snapshot/ledger in F2-B — never from client

### `tournament_daily_result_category`

- **PK** `(series_id, category)` with category ∈ `{EASY,MEDIUM,HARD,ALL}`
- Exactly four rows must be inserted in the **same** transaction as completion (F2-B)
- Partial category sets are schema-possible but **forbidden** by F2-B transaction contract; leaderboard reads must require completion + count(categories)=4

### `tournament_on_time_badge`

- **PK** `series_id`
- Always written with `awarded` boolean in the publish transaction (no separate best-effort path)
- Eligibility helper: `onTimeBadgeFromClaim({ originalUtcDate, claimStartedAtMs })` — **finish time ignored**

## Transaction boundaries (F2-B contract)

Implemented by [`PZD-41-STAGE-F2-B-IMPLEMENTATION.md`](./PZD-41-STAGE-F2-B-IMPLEMENTATION.md). This schema document does not itself perform the writes.

Single PostgreSQL transaction under the existing per-series advisory lock / UoW:

1. Authenticate writer + load immutable claim
2. Verify six terminal snapshots + ledgers (ordinals 1..6, digests, scores)
3. Insert completion receipt with idempotency key (conflict → return original)
4. Insert six verified subgame scores
5. Compute four categories via pure calculator; insert four category rows
6. Insert On-Time badge decision from claim fields
7. Flip claim/fence to COMPLETED / `results_published=true` only if product rules agree
8. COMMIT once; any failure rolls back all publication rows

**No** leaderboard-visible category rows without a committed completion receipt.

## Revision ownership

- `tournament_daily_series_completion.revision` starts at 1 for the first durable publish
- Daily leaderboard cursors (F2-C) must pin this revision; TD-15 page size remains **Proposed**
- Weekly `period_revision` / FINAL snapshots are **out of scope** for F2-A

## Rollback

Disposable: drop the four F2-A tables (see `migrations/stage_f2/README.md`).  
Production expand/contract migration IDs: **NOT_RUN / Proposed**.

## Unresolved decisions (stop — do not invent approval)

| ID | Topic | Status |
| --- | --- | --- |
| U-F2A-01 | Production versioned migration filename/ID + expand/contract order vs embedded DDL proofs | SQL ids `0000`–`0010` are in `migrations/stage_f2/sql/`. Production apply remains unauthorized |
| U-F2A-02 | Whether fence `results_published` alone may gate reads, or reads must join completion+4 categories | **Proposed** (recommend join; fence flag insufficient) |
| U-F2A-03 | Exact H1-terminal vs Advance timing for marking claim `COMPLETED` | **Resolved for F2-B** by owner Q13/Q07 and accepted TD-06/TD-12. Publication and `COMPLETED` occur on the verified terminal H1 move. Between-game Advance is only the transition to a next ordinal. Ordinal 6 returns `NO_NEXT_ORDINAL` and does not mark the fence `COMPLETED`. |
| U-F2A-04 | Weekly aggregate / period snapshot table shapes | F2-C test DDL in `f2c-rankings.mts`. Production migration IDs remain **NOT_RUN** |
| U-F2A-05 | TD-15 pagination defaults 50/100 | Remains **Proposed** in ADR-T02 |
| U-F2A-06 | Retention / PII redaction for publication rows | **Proposed** |

## Explicit non-claims

- F2-B publish, fault injection, and concurrent H1 proof live in `f2b-publication.mts` and its PostgreSQL tests, not in this schema note
- No ranked HTTP enablement; F1 production-disabled gate remains binding
- No client score/date/ordinal/completion authority
- No merge/deploy/Jira Done

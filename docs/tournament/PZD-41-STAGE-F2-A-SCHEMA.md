# PZD-41 Stage F2-A — Publication schema & contract (candidate)

Status: **READY FOR INDEPENDENT F2-A REVIEW** (schema/contract foundation).  
**NOT** F2-B atomic publish, F2-C weekly FINAL, or PZD-41 Done.

Jira: https://puzzle-duel-app.atlassian.net/browse/PZD-41  
PR: https://github.com/puzzle-duel/puzzle-duel-backend/pull/18  
Depends on: PZD-39 Stage E + PZD-40 F1 merged to `main` (production-disabled ranked HTTP preserved).

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

## Transaction boundaries (F2-B contract — not implemented here)

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
| U-F2A-01 | Production versioned migration filename/ID + expand/contract order vs embedded DDL proofs | **Proposed** |
| U-F2A-02 | Whether fence `results_published` alone may gate reads, or reads must join completion+4 categories | **Proposed** (recommend join; fence flag insufficient) |
| U-F2A-03 | Exact H1-terminal vs Advance timing for marking claim `COMPLETED` (ADR-T02 + product T-02 alignment) | **Proposed** — F2-B must not invent |
| U-F2A-04 | Weekly aggregate / period_snapshot table shapes | **Deferred to F2-C** |
| U-F2A-05 | TD-15 pagination defaults 50/100 | Remains **Proposed** in ADR-T02 |
| U-F2A-06 | Retention / PII redaction for publication rows | **Proposed** |

## Explicit non-claims

- No F2-B publish service, fault injection, or concurrent H1 proof in this phase
- No ranked HTTP enablement; F1 production-disabled gate remains binding
- No client score/date/ordinal/completion authority
- No merge/deploy/Jira Done

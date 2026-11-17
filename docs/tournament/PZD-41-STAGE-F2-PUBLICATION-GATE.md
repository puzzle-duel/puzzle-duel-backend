# PZD-41 Stage F2 — Atomic tournament result publication

Status: **F2 CALCULATOR + F2-A SCHEMA + F2-B ATOMIC PUBLICATION IMPLEMENTED**. This document is an implementation gate, not acceptance of new HTTP endpoint names, frozen production migrations, ADR-T01, F2-C weekly FINAL, or production release. Ranked HTTP stays disabled.

Jira: https://puzzle-duel-app.atlassian.net/browse/PZD-41
Dependencies: PZD-40 Stage F1 and PZD-39 Stage E are **merged to `main`**. Ranked HTTP remains production-disabled.
Branch: `feature/PZD-41-stage-f2-result-publication` retargeted to **`main`** (clean rebase; obsolete Stage E stack removed from PR diff).
F2-A schema contract: [`PZD-41-STAGE-F2-A-SCHEMA.md`](./PZD-41-STAGE-F2-A-SCHEMA.md).

## Immutable approved product invariants

1. One player/date official claim covers all six E1→E2→E3→M1→M2→H1. Never grant second claim on lost response, provider link or forfeit.
2. Before six legal, replay-verified terminal subgames: **no ranked daily/weekly score rows**.
3. All four daily scores publish together, once: Easy = E1+E2+E3; Medium = M1+M2; Hard = H1; All = Easy+Medium+Hard. No zero placeholder rows for incomplete/forfeited series. No client-submitted score or complete flag.
4. Non-scoring On-Time badge only if **server-verified first E1 claim** occurred during the original UTC date. Badge awards with all four results, not after a separate best-effort operation.
5. Competition ranking `1 + count(eligible rows strictly greater score)`; tie 500/500/450 yields 1/1/3. Deterministic player ID sort is display ordering only, never ranking tie-break.
6. Current-week historical daily claims remain allowed. Last-week new claims close Monday 00:00 UTC, already-running prior-week series can finish until Monday 01:00 UTC, then immutable FINAL only after trusted ingress/settlement watermark drains. Ordinary previous-day inflight expiry 00:15 UTC, not a blanket old-day claim ban.
7. Real ranked HTTP auth/session and immutable daily claim are hard dependencies; F2 cannot infer `original_utc_date` or `started_at` from a mutable fence or client payload.

## Implemented in this branch

`src/tournament/results/four-category-scores.mts` is a **pure calculator**, not an authority boundary or persistence service. Given **six** already authenticated/replay-verified per-subgame terminal scores supplied by trusted code, it rejects missing/duplicate/invalid ordinals, unsafe/negative/noninteger values and safe-integer overflow; returns readonly Easy/Medium/Hard/All. It has **no** DB write, `resultsPublished` mutation, badge creation, weekly aggregate or HTTP response.

`test/tournament/results/four-category-scores.test.mts` validates category composition, order independence, incomplete/duplicate/invalid inputs, overflow and zero score. CI runs `npm run test:stage-f2` alongside existing Stage E PostgreSQL and v3 gates.

## Implementation sequence

### F2-A: verified claim + manifest + migration — candidate delivered for review

Reuses F1 `tournament_daily_claim` (no parallel claim table). Additive candidate tables + constraint tests:
- `tournament_daily_series_completion` (FK claim; unique player+date; unique publication idempotency key)
- `tournament_verified_subgame_score` (six ordinals; snapshot/ledger provenance columns)
- `tournament_daily_result_category` (unique series+category ∈ EASY/MEDIUM/HARD/ALL)
- `tournament_on_time_badge` (one decision per series; claim-start eligibility helper)
- Docs: `PZD-41-STAGE-F2-A-SCHEMA.md`, `migrations/stage_f2/README.md`
- Production migration IDs, weekly shapes, TD-15 pagination, and retention remain unresolved. H1-versus-Advance publication timing is resolved for F2-B in `PZD-41-STAGE-F2-B-IMPLEMENTATION.md`.

Never store a false `COMPLETED` or create rank rows from an incomplete series. The F2-B writer is the section below.

### F2-B: single transaction completion — implemented

`F2BPublicationService` (`src/tournament/results/f2b-publication.mts`) is the publication writer. It uses `lockSeriesForTransaction`, the same per-series advisory lock as ingress, the fence, and `PostgresTrustedUnitOfWork`. Lock order after that advisory lock is fence, writer, then claim.

Inside one PostgreSQL transaction it:

1. Holds that series lock and checks the authenticated player, writer generation, and claim.
2. Replays all six pinned subgames from `trusted_challenge_binding` plus `accepted_move_ledger`. Snapshot state hash, ledger hash, and engine replay must match. Individual scores are the replayed per-ordinal totals, not six copies of `series_fence_state.score`.
3. Rejects a nonterminal H1 and rejects `event: 'between_game_advance'`. The gameplay writer also rejects ordinal-6 Advance with `NO_NEXT_ORDINAL` before any fence write.
4. Inserts one completion, six subgame scores, four categories from `computeFourCategoryScores`, one On-Time badge from the immutable claim start, and one HMAC provenance row.
5. Sets the claim and fence to `COMPLETED` and `results_published=true` only on that H1-terminal publication.
6. Commits once. A fault before commit rolls every publication row back. A retry after commit returns the original revision, scores, badge, and seal.

Completion timing is recorded in [`PZD-41-STAGE-F2-B-IMPLEMENTATION.md`](./PZD-41-STAGE-F2-B-IMPLEMENTATION.md). Q13 and TD-12 publish on the verified terminal H1 move. Q07 Advance applies only when a next ordinal exists, so Advance is not the publication event.

Weekly ranking and FINAL settlement are not part of this transaction.

### F2-C: weekly ranks and FINAL

Implement all four daily/weekly competition ranks, revision-pinned page cursors (TD-15 proposed 50/100), no personal metadata leak, and transactional Monday 01:00 UTC settlement with pre-cutoff eligible pending-admission barrier. Freeze daily+weekly together, forbid later silent mutation; explicit incident path only.

### F2-D: proof

- Real PG18 2-connection concurrent H1; two devices/same player; retry after lost reply; failure injection after each insert and before/after COMMIT; ALL-or-NOTHING 4 rows.
- Six snapshots but forged ordinal/manifest/score and incomplete/forfeited must not publish; verified 0 score may publish **only for fully completed claim**.
- Claim date before/equal/after UTC midnight, On-Time no rank tie effect, same-week backfill, Monday 00:00/01:00, expired idle, pending admitted H1 finishes after cutoff.
- Rank 500/500/450→1/1/3; pagination provisional snapshot change, immutable FINAL, retention, rollback migration.
- Authenticated HTTP E2E and client/backend OpenAPI after F1 contract freeze. Multihost/NTP + DB failover remain separate release gates.

## Current non-claims

**NOT_RUN:** production versioned migration acceptance, weekly snapshots/FINAL, four-category ranked read API, multi-host failover, ranked HTTP enablement, and production deployment. F2-B is implemented and covered by PostgreSQL 18 tests. It does not authorize merge, deploy, or PZD-41 Done.

The module and tests alone must NOT be interpreted as Stage F complete, PZD-41 Done, ranked rollout authorized or ADR-T01 Accepted.

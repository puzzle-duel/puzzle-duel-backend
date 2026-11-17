# PZD-41 Stage F2 — Atomic tournament result publication

Status: **F2 CALCULATOR + F2-A SCHEMA CANDIDATE / ATOMIC PUBLISH NOT IMPLEMENTED**. This document is an implementation gate, not acceptance of new HTTP endpoint names, frozen production migrations, ADR-T01 or production release.

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

## Next implementation sequence (not yet delivered)

### F2-A: verified claim + manifest + migration — candidate delivered for review

Reuses F1 `tournament_daily_claim` (no parallel claim table). Additive candidate tables + constraint tests:
- `tournament_daily_series_completion` (FK claim; unique player+date; unique publication idempotency key)
- `tournament_verified_subgame_score` (six ordinals; snapshot/ledger provenance columns)
- `tournament_daily_result_category` (unique series+category ∈ EASY/MEDIUM/HARD/ALL)
- `tournament_on_time_badge` (one decision per series; claim-start eligibility helper)
- Docs: `PZD-41-STAGE-F2-A-SCHEMA.md`, `migrations/stage_f2/README.md`
- Unresolved production migration IDs / weekly shapes / H1-vs-Advance COMPLETED timing remain **Proposed** (see U-F2A-*).

Never store a false `COMPLETED` or create rank rows from incomplete series. F2-B publish UoW is **not** implemented here.

### F2-B: single transaction completion

Inside existing `PostgresTrustedUnitOfWork` or equivalently fenced single database transaction:
1. Hold same per-series advisory lock, active writer/board/version CAS, immutable original H1 admission and authenticated player + claim.
2. Independently verify all six pinned subgame terminal snapshots and accepted ledgers (order, digest, scorer, challenge/version).
3. Compute **individual** per-subgame scores from trusted ledger/snapshots (do not reuse series-aggregate `fence.score` six times).
4. Compute four scores with the pure calculator.
5. Atomically transition once to `COMPLETED`, record all four category results, authoritative claim-based On-Time badge (if eligible), any materialized scoreboard revisions, and immutable admitted H1/advance outcome.
6. Commit once; only after durable commit advertise published results. On any error rollback all updates; admission stays recoverable and frozen same-key result prevents double publication.
7. Reconcile accepted H1 final-move versus explicit between-game Advance semantics: no premature complete on H1; final terminal completion must match ADR-T02 and T-02 product event.

### F2-C: weekly ranks and FINAL

Implement all four daily/weekly competition ranks, revision-pinned page cursors (TD-15 proposed 50/100), no personal metadata leak, and transactional Monday 01:00 UTC settlement with pre-cutoff eligible pending-admission barrier. Freeze daily+weekly together, forbid later silent mutation; explicit incident path only.

### F2-D: proof

- Real PG18 2-connection concurrent H1; two devices/same player; retry after lost reply; failure injection after each insert and before/after COMMIT; ALL-or-NOTHING 4 rows.
- Six snapshots but forged ordinal/manifest/score and incomplete/forfeited must not publish; verified 0 score may publish **only for fully completed claim**.
- Claim date before/equal/after UTC midnight, On-Time no rank tie effect, same-week backfill, Monday 00:00/01:00, expired idle, pending admitted H1 finishes after cutoff.
- Rank 500/500/450→1/1/3; pagination provisional snapshot change, immutable FINAL, retention, rollback migration.
- Authenticated HTTP E2E and client/backend OpenAPI after F1 contract freeze. Multihost/NTP + DB failover remain separate release gates.

## Current non-claims

**NOT_RUN:** F2-B atomic DB publication UoW, production versioned migration acceptance, weekly snapshots/FINAL, four-category ranked read API, multi-host failover, end-to-end verification and production deployment. F2-A delivers candidate DDL + constraint proofs only.

The module and tests alone must NOT be interpreted as Stage F complete, PZD-41 Done, ranked rollout authorized or ADR-T01 Accepted.

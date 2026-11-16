# Tournament V1 — Product / Architecture Blueprint Change Proposal

Status: **PROPOSED FOR REVIEW** (owner-approved product behaviors recorded below; architecture and contract decisions not yet Accepted)
Date: 2026-11-16
Scope: `puzzle-duel-client` + `puzzle-duel-backend`; no code/deploy.
Source-of-truth precedence: owner statements > Accepted ADRs; existing cross-repo `BLUEPRINT.md` is still DRAFT. This document proposes a **change to prior draft MVP exclusions** (tournament previously post-MVP), not a silent replacement of the existing draft, PD-01/02/03, or historical ranking.

## 1. Owner-confirmed product contract

### Practice
- Offline, unlimited Easy 5x5/15 moves/1 block; Medium 6x6/12/2; Hard 7x7/10/4.
- Every newly started practice round draws a fresh versioned generator seed; board, blocked positions, initial pieces and finite ordered supply vary. Avoid immediate identical challenges where possible; do **not** promise unique boards mathematically.
- Practice points never enter any competitive leaderboard. Store three best practice scores (Easy/Medium/Hard) in the player profile, with local guest-safe persistence and future account linking per PD-04.
- Preserve existing pure Dart gameplay, `core-001.v2`, `gen-001.v1` and versioned historical replay.

### Tournament daily series
- Online and authenticated/server-identified, ranked-only; no offline start or offline submission.
- Each tournament UTC date has the same **six versioned fixed challenges for all players**, executed in order: E1,E2,E3,M1,M2,H1. Identical challenge inputs and generator/rules versions, not identical downstream boards after different player moves.
- One official completion of each daily series per player; no replay to improve rank. Resume *the same* claimed series where allowed, not a new attempt. Official claim occurs at server-authorized series start; each subgame is also individually immutable once started. Atomic uniqueness and idempotent retries mandatory.
- Daily score groups: Easy=E1+E2+E3; Medium=M1+M2; Hard=H1; All=Easy+Medium+Hard. A completed daily series contributes those four totals; no points from practice. A partially completed series is NOT yet a completed daily leaderboard score (**recommendation requiring owner approval**, see Open Decisions).
- Players may start previously unplayed daily series from any date of the **currently open UTC week** until that week's cutoff. Series still unfinished may be resumed per authorized lifecycle. A series completed after its date carries the score to its original date.
- Playing a series during its own calendar date can earn an 'On-Time' badge; badge must **never add ranking points or affect tie-breaking by default**. Exact issue criterion remains a decision gate (start vs complete on date).
- A server receives authoritative validated move events; client scores are never trusted. Each move is checked by deterministic server replay under the challenge's pinned rules/generator versions.

### UTC day/week boundaries (confirmed)
- One global UTC calendar; day changes at 00:00:00 UTC (Türkiye 03:00). Week is Monday 00:00 UTC inclusive through next Monday 00:00 UTC exclusive.
- At week rollover: **no new daily series belonging to the old week can be started.** Already started daily series of the old week is allowed to finish **all six subgames** after rollover while server session remains valid; not merely the currently active subgame.
- Example (calendar corrected): days 1 Mon…7 Sun of a week; player starts day-1 Monday series on **day 8 Mon 02:58 Türkiye** (=day 7 Sun 23:58 UTC), finishes **day 8 Mon 03:03 Türkiye** (=day 8 Mon 00:03 UTC). Only day-1 series gets a completed score on old week's board; days 2–7 never become newly playable in the closed week. The date assigned to score is **day 1**, not completion date.
- **Five-minute inactivity rule (T-01A, owner-approved 2026-11-16):** if no valid activity reaches the server for 300 seconds, the **active session** terminates, but the server-verified move cursor, completed subgames and the same official daily-series entitlement remain preserved. The player may resume that **same claimed series** later, subject to a separately approved post-week-cutoff resume limit. Do not create an additional attempt, reset earned progress, silently forfeit the daily series, or award unverified/partial leaderboard points. The timer is rolling from last accepted server activity, not a fixed five-minute grace period after midnight. A client heartbeat that is not credible player activity must not keep a series alive indefinitely (T-06). Server receipt time is authoritative; client clock is untrusted.
- Old-week ranking remains provisional while valid old-week sessions are in flight; finalize when they end and validated results are applied. Archive immutable finalized weekly results thereafter.

### Leaderboards
- Today: filters All, Easy, Medium, Hard over the matching UTC date.
- This week: filters All/Easy/Medium/Hard using **the sum of each player's completed daily series scores across the seven UTC dates** (days not played contribute 0).
- Archived week selector: last week, 2, 3, 4 and 5 weeks ago, each with same four category filters. **No monthly aggregate and no all-time aggregate.** Archive stable after settlement.
- Day attribution never moves due to a later completion or backfill. Historical leaderboards display original UTC dates. Rank/identity/avatar privacy must be handled in a separate approved UX/security spec.
- On-time badge visible as a non-scoring indicator. Display logic must be derivable from server-verified timestamps.

## 2. Architecture and trust boundaries

`Flutter practice` → pure Dart rules/generator → local profile personal best (never ranked)
`Flutter tournament` → authenticated server-issued daily manifest/claim → server-owned series/subgame/move ledger → replay verifier → immutable completed daily score → daily and weekly leaderboard projections.
No Flame/Flutter rendering in rules. No local guest practice promotion to ranked status.
Cross-repo TypeScript/Dart generation and resolution parity on `gen-001.v1` / `core-001.v2` must PASS before any ranked deployment. Do not claim parity merely because JSON fixtures exist.

### Suggested entities (schema is PROPOSED)
- `tournament_weeks`: utc_week_start PK, utc_week_end, status (open/settling/final), archive_at.
- `tournament_days`: utc_date PK, week FK, immutable published manifest hash.
- `tournament_challenges`: (utc_date, ordinal 1..6) unique; difficulty; seed u32; generator_version; rules_version; config/version; full canonical initial-state hash and finite supply hash.
- `daily_series`: series_id UUID; player_id; utc_date; week_id; claim_timestamp; last_valid_activity_at; lifecycle; unique (player_id,utc_date) for official claim; idempotency key.
- `series_games`: (series_id, ordinal) unique; attempt state; move cursor; authoritative score; pinned challenge ID; terminal proof; immutable completed outcome.
- `move_events`: unique (series_game_id, monotonically increasing sequence); canonical input, validation/replay result, idempotency key/digest; never allow two different commands for one sequence.
- `daily_scores`: unique (player_id,utc_date); 3 category aggregates + all, posted only when series completion is authorized and replay verified.
- `weekly_scores`: unique (player_id,week_start); transactional projection (or reliable derived query), category totals, version/updated_at.
- `weekly_archive`: finalized snapshot with stable ordering and tie-break contract.
- `practice_bests`: player/local-profile origin, difficulty, score, update/version; not shared into ranked ledger.

### Suggested transport outline (not endpoint approval)
- GET tournament calendar/manifest with available, in-progress, completed, locked and settling status.
- POST claim/resume daily series: authenticated, idempotent, server-clock cutoff checked **transactionally**; past-in-week permitted, prior-week new claim forbidden.
- POST move with attempt/game ID, monotonic sequence and idempotency token; server replay, dedupe, reject tampering.
- POST finish/resume: idempotent replay verification; automatically advance to next fixed ordinal; allow post-cutoff advancement only for pre-cutoff already-claimed valid daily series.
- GET daily rankings by date and category; GET weekly rankings by weekStart and category; GET on-time badge/profile practice best.
- Never accept client-provided score, dates or version as ranking truth. UTC times from server; bounded payloads/auth/rate limits.
- Error taxonomy: unauthorized, forbidden, offline, series_already_claimed/completed, week_closed, series_expired, invalid_move, stale_sequence, incompatible_rules_version, idempotency_conflict, server_unavailable. Exact HTTP statuses/payloads require separate contract approval.

## 3. Week closing state machine / concurrency

- At UTC Monday 00:00, mark old week **settling**, disallow new claims of any of its dates, allow only established valid series to continue.
- Every active old-week series has a server-maintained last_valid_activity_at. If 300 seconds elapse without valid activity, terminate **only the active session**; preserve the already-claimed official daily series and verified progress (owner-approved T-01A). Resuming is allowed on the same series, but **post-week-cutoff resume eligibility/deadline is UNRESOLVED**, so a closing week cannot be considered fully settled until a bounded policy is approved. Never silently award partial completed-day leaderboard points.
- A completion request racing cutoff is adjudicated from a securely recorded server-side **series claim start time**, plus current authenticated session validity and replay history, under a transactional lock. Device timestamp cannot backdate start.
- Claim at exactly 00:00 UTC falls in new week; earlier than cutoff belongs to previous UTC week. Use half-open UTC intervals. Concurrent claim calls resolve into at most one official series; retries return same series.
- Old week becomes **final** only after all eligible started series are completed or expired and all transactionally accepted score updates are reflected. Archive last five finalized weeks for browsing; retention beyond UI is an independent policy.
- No wall-clock-only background unlock that permits previous week new claims; no local clock bypass.

## 4. Ranking math and test vectors (proposed proof cases)

Example player completes day 1 with E1=100,E2=200,E3=300,M1=400,M2=500,H1=600: Easy=600, Medium=900, Hard=600, All=2100. Week aggregate is per-day category sum; unplayed days = 0. Completing day 1 at next week's 00:03 UTC still updates old week while it is settling.
Compare separate player who completed same challenge on its day; equal gameplay scores produce equal ranking points irrespective of on-time badge.

Mandatory regression cases:
1. Two players same UTC day → identical six manifest hashes; all seeds/configs/version pinned.
2. Practice offline and repeated → varied generator seeds, best score updates, no ranked writes.
3. One-series uniqueness for player/day, concurrent starts, repeated finishes and retries, multiple devices.
4. Start Sunday 23:59:59.999 UTC → continue all six subgames after Monday 00:00, score old week's requested daily slot.
5. Start exactly Monday 00:00 UTC for a prior-week date → denied.
6. After rollover, cannot open any other old-week date, even if old-week series remains in progress.
7. 299 seconds since last *valid* server event → active; 300 seconds without → **session** timed out while same daily-series entitlement and replay-verified progress remain durable; no new attempt. Post-cutoff resumption requires T-01B.
8. Owner example: Sunday 23:58 UTC begins prior Monday series; Monday 00:03 UTC completes; only that Monday scored; Tuesday–Sunday missed.
9. Backfill on Sunday updates original day's daily category ranks and same-week aggregate only.
10. Move replay malformed/fraudulent/client scoreboard mismatch, account-link spoof, stale/duplicate/parallel commands → fail closed.
11. Week settling → final only after no eligible in-flight series; archived rank stable after final.
12. Dates near leap year/month/year crossover, five archived weeks, DST irrelevant under UTC.
13. Rank filters category All/Easy/Medium/Hard mutually consistent, no practice contamination.
14. Sound/animation/network loss never changes canonical rule outcome.

## 5. Implementation order (proposed Jira epic and scoped tickets)

Phase A Product gate: owner review tournament scope vs existing DRAFT blueprint, ADRs, explicit unresolved decisions.
Phase B Engine/backend parity and deterministic challenge-publishing manifests; seed, hashes, constraints.
Phase C Identity/player security, server-side claim/attempt ledger, concurrency/idempotency, move replay, timeout.
Phase D Scores, daily + seven-day weekly aggregates, weekly settling/archives and on-time badge.
Phase E Flutter practice randomized seeds + durable three best scores; tournament UX, online gating, resume, status and error flows.
Phase F Cross-device E2E, adversarial/clock-boundary tests, load/security, accessibility, physical-device performance and rollout.
All work feature branches + PRs, CI, no merge or deploy without new authorization.

## 6. Decision gate — NOT YET APPROVED

**T-01A — OWNER-APPROVED (2026-11-16):** 300 seconds of inactivity terminates the current session **without forfeiting** the same claimed daily series or verified progress; the player may resume that same series, not claim a fresh attempt. **T-01B — OPEN:** explicit maximum time/conditions for resuming the old-week series after weekly cutoff, and the resulting finite settling/archive rule.
**T-02** Partial score visibility during six-game series: leaderboard only complete series (recommended) vs per-finished-subgame partial rows.
**T-03** On-Time badge defined by series **start** within own UTC date vs completion within own date; user approved badge concept, not exact timestamp gate.
**T-04** Exact user identity requirement for official tournament (Apple/Google login vs secure anonymous server account + later linking).
**T-05** Ranks ties (equal rank vs deterministic server tie-break), page size, archived-week immutable snapshot and late data reconciliation.
**T-06** Valid activity rule for 5-minute liveness (authenticated move vs server-approved limited heartbeat), session concurrency, disconnected device and resume policy.
**T-07** Weekly archive display while settling; historic period retention beyond five visible weeks.
**T-08** Daily-series six-round atomic claim vs subgame claims, resume after crash, and whether old-week series may legitimately remain active indefinitely while moving.
**T-09** Existing DRAFT daily-only MVP/PD-03 changes to Tournament V1 scope, exact delivery milestone and coexistence with legacy daily challenge.
**T-10** Terminal edge cases not accepted under core-001.v2 early-board-full empty piece stream; block competitive publication until replay-safe policy approved.
Do not turn any recommended choice into Accepted without explicit owner approval.

## T-01A owner decision (recorded 2026-11-16)

Owner explicitly selected option A: after 5 minutes of inactivity, close the active connection/session but preserve the daily-series entitlement and all server-verified progress for continuation of the **same** daily series. Do not translate timeout into an automatic forfeit; do not reset the six-game sequence or permit a second official claim. The limit for resuming after UTC week closure remains **T-01B PROPOSED/OPEN**. No automatic infinite settlement or permission for completed-but-unverified scores.

## 7. Acceptance state

Owner-confirmed behaviors in §1 are accepted as **product input** in this conversation. This *proposal document*, API fields, schema, ADRs, endpoint URLs, auth, tie-break, timeout recovery and rollout are **not Accepted**. Existing BLUEPRINT remains DRAFT and is unchanged. This branch is docs-only and must not be merged until decision review.

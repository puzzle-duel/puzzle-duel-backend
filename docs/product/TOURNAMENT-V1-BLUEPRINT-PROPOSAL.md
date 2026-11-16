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
- **T-04 OWNER-APPROVED (2026-11-16):** Tournament is online-only and **requires successful verified social login with at least one supported provider**; anonymous/guest players cannot claim/start official tournament series or appear in leaderboards. The requested provider set is Apple, Google, Instagram, Facebook, TikTok, **X (formerly Twitter)**. Practice remains guest-accessible and offline. Provider-specific regulatory/technical feasibility remains a launch gate; never offer a login button that is not configured and approved. Identity is one server-owned player_id, provider login does not itself confer extra tournament attempts.
- Each tournament UTC date has the same **six versioned fixed challenges for all players**, executed in order: E1,E2,E3,M1,M2,H1. Identical challenge inputs and generator/rules versions, not identical downstream boards after different player moves.
- One official completion of each daily series per player; no replay to improve rank. Resume *the same* claimed series where allowed, not a new attempt. Official claim occurs at server-authorized series start; each subgame is also individually immutable once started. Atomic uniqueness and idempotent retries mandatory.
- Daily score groups: Easy=E1+E2+E3; Medium=M1+M2; Hard=H1; All=Easy+Medium+Hard. A completed daily series contributes those four totals; no points from practice. **T-02 OWNER-APPROVED:** scores from an incomplete daily six-game series must **never appear in the daily or weekly competitive leaderboards**. The player may see verified partial/subgame scores only in their own progress screen. A daily score for Easy, Medium, Hard and All is published atomically only after E1,E2,E3,M1,M2,H1 are all finished and independently verified. Timeout forfeit contributes no daily category score.
- Players may start previously unplayed daily series from any date of the **currently open UTC week** until that week's cutoff. Series still unfinished may be resumed per authorized lifecycle. A series completed after its date carries the score to its original date.
- **T-03 OWNER-APPROVED (2026-11-16):** award the non-scoring **On-Time** badge only after the full daily series of six games is successfully completed and independently verified, provided its authoritative **server-side series claim/start timestamp** was within that series' own UTC calendar date ([date 00:00 UTC, following date 00:00 UTC)). Completing after that date does **not** disqualify it. Starting a past date's series later within the same UTC week does **not** qualify. Timeout-forfeited or incomplete series never earn this badge. Badge never adds points or affects rank/tie-breaking.
- A server receives authoritative validated move events; client scores are never trusted. Each move is checked by deterministic server replay under the challenge's pinned rules/generator versions.

### UTC day/week boundaries (confirmed)
- One global UTC calendar; day changes at 00:00:00 UTC (Türkiye 03:00). Week is Monday 00:00 UTC inclusive through next Monday 00:00 UTC exclusive.
- At week rollover: **no new daily series belonging to the old week can be started.** Already started daily series of the old week is allowed to finish **all six subgames** after rollover while server session remains valid; not merely the currently active subgame.
- Example (calendar corrected): days 1 Mon…7 Sun of a week; player starts day-1 Monday series on **day 8 Mon 02:58 Türkiye** (=day 7 Sun 23:58 UTC), finishes **day 8 Mon 03:03 Türkiye** (=day 8 Mon 00:03 UTC). Only day-1 series gets a completed score on old week's board; days 2–7 never become newly playable in the closed week. The date assigned to score is **day 1**, not completion date.
- **Five-minute inactivity rule (T-01 option B, latest owner decision 2026-11-16; supersedes prior A):** if no valid activity reaches the server for 300 seconds, the **daily series is forfeited**, not merely paused. Its official claim remains consumed: the player cannot resume or restart that day's series, even if the week is still open. Any recorded subgame/verified move progress is retained only for audit, not leaderboard scoring. No completed-day score is posted. **T-06A OWNER-APPROVED (2026-11-16):** reset the timer only on authenticated, server-accepted **genuine player interactions** (including valid moves and legitimate player-initiated UI actions subject to abuse validation). Automatic/background heartbeat, connection presence, passive screen-on state, and app-foreground signals alone **must not** reset it. Server receipt time governs; client clock cannot extend it. Exact event allowlist, anti-spam thresholds and race resolution remain technical gates T-06B.
- Old-week ranking remains provisional while valid old-week sessions are in flight; finalize when they end and validated results are applied. Archive immutable finalized weekly results thereafter.

### Leaderboards
- Today: filters All, Easy, Medium, Hard over the matching UTC date.
- This week: filters All/Easy/Medium/Hard using **the sum of each player's completed daily series scores across the seven UTC dates** (days not played contribute 0).
- Archived week selector: last week, 2, 3, 4 and 5 weeks ago, each with same four category filters. **No monthly aggregate and no all-time aggregate.** Archive stable after settlement.
- Day attribution never moves due to a later completion or backfill. Historical leaderboards display original UTC dates. Rank/identity/avatar privacy must be handled in a separate approved UX/security spec.
- On-time badge visible as a non-scoring indicator. Display logic must be derivable from server-verified timestamps.
- **T-05A OWNER-APPROVED (2026-11-16):** apply **competition ranking** independently to each leaderboard filter (daily/weekly/archived × All/Easy/Medium/Hard). Players with identical verified aggregate points share the same rank; the next rank skips the number of tied positions (e.g. scores 500,500,450 → ranks 1,1,3). On-Time badge, finish/start timestamps and completion order **do not** break ties. UI may use a deterministic non-ranking secondary order for stable display/pagination; the precise order and pagination contract remain open.

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
- `weekly_archive`: finalized snapshot retains each player's verified score and **competition rank** (ties share rank; following positions skipped). Stable row display ordering/pagination to be specified separately; never alter rank using a secondary sort.
- `practice_bests`: player/local-profile origin, difficulty, score, update/version; not shared into ranked ledger.

### Suggested transport outline (not endpoint approval)
- GET tournament calendar/manifest with available, in-progress, completed, locked and settling status.
- POST claim/inspect daily series: authenticated, idempotent, server-clock cutoff checked **transactionally**; past-in-week permitted, prior-week new claim forbidden. After inactivity forfeiture, retries must return the same terminal forfeited result, never a new entitlement.
- POST move with attempt/game ID, monotonic sequence and idempotency token; server replay, dedupe, reject tampering.
- POST complete/advance: idempotent replay verification; automatically advance to next fixed ordinal only while the claimed daily series remains active. After weekly cutoff, advancement allowed solely for pre-cutoff claims that have **not** forfeited due to inactivity.
- GET daily rankings by date and category; GET weekly rankings by weekStart and category; GET on-time badge/profile practice best.
- Never accept client-provided score, dates or version as ranking truth. UTC times from server; bounded payloads/auth/rate limits.
- Error taxonomy: unauthorized, forbidden, offline, series_already_claimed/completed, week_closed, series_expired, invalid_move, stale_sequence, incompatible_rules_version, idempotency_conflict, server_unavailable. Exact HTTP statuses/payloads require separate contract approval.

## 3. Week closing state machine / concurrency

- At UTC Monday 00:00, mark old week **settling**, disallow new claims of any of its dates, allow only established valid series to continue.
- Every active old-week series has a server-maintained last_valid_activity_at. At 300 seconds without valid server-received activity, atomically mark the **entire incomplete daily series forfeited**, consume its one official claim permanently, and award **zero completed-day leaderboard score**. Already completed daily scores remain valid. There is **no resumption after forfeiture** and hence no separate post-cutoff resume grace window. Active series with activity continue through all six games even after rollover; old week settles only after these series complete or forfeit.
- A completion request racing cutoff is adjudicated from a securely recorded server-side **series claim start time**, plus current authenticated session validity and replay history, under a transactional lock. Device timestamp cannot backdate start.
- Claim at exactly 00:00 UTC falls in new week; earlier than cutoff belongs to previous UTC week. Use half-open UTC intervals. Concurrent claim calls resolve into at most one official series; retries return same series.
- Old week becomes **final** only after all eligible started series are completed or expired and all transactionally accepted score updates are reflected. Archive last five finalized weeks for browsing; retention beyond UI is an independent policy.
- No wall-clock-only background unlock that permits previous week new claims; no local clock bypass.

## 4. Ranking math and test vectors (proposed proof cases)

Example player completes day 1 with E1=100,E2=200,E3=300,M1=400,M2=500,H1=600: Easy=600, Medium=900, Hard=600, All=2100. Week aggregate is per-day category sum; unplayed days = 0. Completing day 1 at next week's 00:03 UTC still updates old week while it is settling.
Compare separate player who completed same challenge on its day; equal gameplay scores produce **the same competition rank** irrespective of On-Time badge, start/finish order, or completion timestamp. Example 500,500,450 yields ranks **1,1,3**, not 1,2,3 or 1,1,2.

Mandatory regression cases:
1. Two players same UTC day → identical six manifest hashes; all seeds/configs/version pinned.
2. Practice offline and repeated → varied generator seeds, best score updates, no ranked writes.
3. One-series uniqueness for player/day, concurrent starts, repeated finishes and retries, multiple devices.
4. Start Sunday 23:59:59.999 UTC → continue all six subgames after Monday 00:00, score old week's requested daily slot.
5. Start exactly Monday 00:00 UTC for a prior-week date → denied.
6. After rollover, cannot open any other old-week date, even if old-week series remains in progress.
7. 299 seconds since last *valid* server event → still active; at 300 seconds without valid activity → daily series forfeited, claim stays spent, no completed-day leaderboard points, cannot resume. Boundary must be enforced transactionally against finish/move races.
8. Owner example: Sunday 23:58 UTC begins prior Monday series; Monday 00:03 UTC completes; only that Monday scored; Tuesday–Sunday missed.
9. Backfill on Sunday updates original day's daily category ranks and same-week aggregate only.
10. Move replay malformed/fraudulent/client scoreboard mismatch, account-link spoof, stale/duplicate/parallel commands → fail closed.
11. Week settling → final only after no eligible in-flight series; archived rank stable after final.
12. Dates near leap year/month/year crossover, five archived weeks, DST irrelevant under UTC.
13. Rank filters category All/Easy/Medium/Hard mutually consistent, no practice contamination.
14. Sound/animation/network loss never changes canonical rule outcome.
15. Same verified scores in daily/weekly/archived and every category result in shared competition rank (500/500/450 => 1/1/3); On-Time badge and submit time never alter rank. Deterministic display order may be used only within tied rows.

## 5. Implementation order (proposed Jira epic and scoped tickets)

Phase A Product gate: owner review tournament scope vs existing DRAFT blueprint, ADRs, explicit unresolved decisions.
Phase B Engine/backend parity and deterministic challenge-publishing manifests; seed, hashes, constraints.
Phase C Identity/player security, server-side claim/attempt ledger, concurrency/idempotency, move replay, timeout.
Phase D Scores, daily + seven-day weekly aggregates, weekly settling/archives and on-time badge.
Phase E Flutter practice randomized seeds + durable three best scores; tournament UX, online gating, resume, status and error flows.
Phase F Cross-device E2E, adversarial/clock-boundary tests, load/security, accessibility, physical-device performance and rollout.
All work feature branches + PRs, CI, no merge or deploy without new authorization.

## 6. Decision gate — NOT YET APPROVED

**T-01 — OWNER-APPROVED OPTION B (LATEST, 2026-11-16; SUPERSEDES A):** after 300 seconds without valid server activity, **forfeit the entire incomplete daily series**, permanently consume that day's official entry, deny any resume/retry, and award no completed-day leaderboard score. Prior option A (preserve-and-resume) is explicitly superseded. **T-01B — NOT APPLICABLE:** no post-week-cutoff resume grace exists after forfeiture; a series that stays actively played without a 300-second inactivity gap may still finish after rollover. Valid-activity definition and atomic race outcomes remain T-06.
**T-02 — OWNER-APPROVED (2026-11-16):** leaderboard displays **only fully completed and verified six-game daily series**; subgame/partial scores are visible only to their player inside tournament progress and are excluded from **all four** daily and weekly ranking category filters. Publish all four category totals atomically on completed-series finalization; failed/forfeited series cannot enter leaderboards.
**T-03 — OWNER-APPROVED (2026-11-16):** On-Time badge eligibility uses the server-authoritative **daily-series start/claim timestamp**, which must fall within the series' own UTC date. Award only after all six subgames are completed and verified; late finish is allowed. A series started retrospectively on a different UTC date or forfeited on timeout receives no badge. The badge is non-scoring and cannot break leaderboard ties.
**T-04 — OWNER-APPROVED PRODUCT RULE (2026-11-16):** **a verified social login is mandatory for tournament**, while practice remains usable anonymously/offline. Requested login provider set: **Apple, Google, Instagram, Facebook, TikTok and X (Twitter)**. All verified identities map to one server-owned Puzzle Duel `player_id`; linked providers cannot yield extra attempts. **Feasibility/launch approval remains OPEN per provider**, particularly Instagram personal consumer accounts (Meta's documented Instagram Login is professional-account oriented) and X developer OAuth app/access/pricing. TikTok Login Kit officially supports iOS/Android. No fallback to unauthenticated ranked claims if a provider is unavailable; show only usable, reviewed buttons. Server-side code/token verification, provider-subject uniqueness, OAuth state/PKCE/nonce where applicable, privacy-minimal scopes, Apple store review/sign-in requirements, account link/unlink, deletion and recovery need detailed design. The platform's separate providers are login methods, not a blanket guarantee they can merge unverified accounts; linking requires explicit secure proof of both identities.
**T-05A — OWNER-APPROVED (2026-11-16):** all daily, current weekly and archived weekly leaderboards, across All/Easy/Medium/Hard, use **competition ranking**: equal verified score = equal rank, next rank skips tied positions (1,1,3). On-Time badge, timing and completion order do not affect ranking. **T-05B — OPEN technical detail:** stable display ordering of tied rows, pagination/page size, and archived-week immutable snapshots/late data reconciliation; these cannot change competition ranks.
**T-06A — OWNER-APPROVED (2026-11-16):** inactivity resets only with genuine player interaction that the server authenticates/accepts; an automatically sent heartbeat or merely keeping the app open/connection alive does not reset the 300-second timer. Examples of candidate interactions: actual legal move or deliberate on-screen user action; exact allowable event vocabulary and anti-abuse checks are pending. **T-06B — OPEN engineering gate:** authenticated event allowlist, throttling/spam defenses, invalid-tap handling, server timing and concurrency/races, disconnected-device reporting, and whether a valid UI action can extend the timer while the player is thinking; no unlimited automatic keepalive.
**T-07** Weekly archive display while settling; historic period retention beyond five visible weeks.
**T-08** Daily-series six-round atomic claim vs subgame claims, resume after crash, and whether old-week series may legitimately remain active indefinitely while moving.
**T-09** Existing DRAFT daily-only MVP/PD-03 changes to Tournament V1 scope, exact delivery milestone and coexistence with legacy daily challenge.
**T-10** Terminal edge cases not accepted under core-001.v2 early-board-full empty piece stream; block competitive publication until replay-safe policy approved.
Do not turn any recommended choice into Accepted without explicit owner approval.

## T-01 decision history — latest owner selection is B (2026-11-16)

Owner initially chose A (timeout closes session, same-series resume), then **explicitly changed to B**: after five minutes of inactivity, the incomplete **daily series right is forfeited**; no completed-day leaderboard score is added. Option A is superseded and must not govern implementation. This does **not** change the existing weekly rollover exception for a pre-cutoff daily series actively playing all six subgames after cutoff without timing out. The old T-01B question about a post-timeout old-week resume limit is no longer applicable. T-06A now approves genuine user interaction (not automatic heartbeat) as the liveness source. T-06B remains open for event allowlisting, anti-spam and cutoff/timeout/finish race adjudication.

## T-02 owner decision (recorded 2026-11-16)

Owner explicitly approved the recommendation: a six-game daily tournament series is **all-or-nothing for ranking eligibility**. No partial Easy/Medium/Hard or All entries appear on leaderboards before all six games have been independently validated and completed. During play, verified subgame scores can be shown privately to the player as progress; on completion, the four aggregates are inserted/updated atomically. Idempotent finalization and no leaderboard leakage from forfeited series are required tests.

## T-03 owner decision (recorded 2026-11-16)

Owner explicitly selected option A: a daily tournament series **started within its corresponding UTC date** qualifies for On-Time if and only if the entire six-game series is subsequently validated and completed, even if completion happens on a later UTC day. Use server claim/start timestamp rather than device clock, award badge idempotently at successful series finalization, never on claim alone or for a forfeited series. Example: own-day 23:58 UTC claim + next-day 00:03 UTC valid completion = On-Time; prior-day backfill claim on a later day = no On-Time. Badge must not change ranking scores or equal-score ordering.

## T-04 provider scope request (recorded 2026-11-16; feasibility pending)

Owner explicitly confirmed **at least one verified social login is required for tournament**, adding **X (Twitter)** to requested providers: **Apple, Google, Instagram, Facebook, TikTok, X**. Practice remains offline/guest-capable. These are six login routes to one internal player account, not six attempts. The **product requirement is approved**; implementation feasibility and provider launch go/no-go remain subject to documentation/app review, especially Instagram consumer account limitations and X developer app requirements/costs.

Official external references reviewed 2026-11-16:
- TikTok Login Kit: https://developers.tiktok.com/docs/en/login-kit-overview (iOS/Android/Web OAuth)
- Meta Facebook Login: https://developers.facebook.com/docs/graph-api/get-started/
- Meta Instagram IG User: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/v21.0/ (professional Creator/Business)
- X OAuth developer integration: https://docs.x.com/ ; provider/app access, approval and current pricing must be checked before enabling X Sign In.
- Apple App Review §4.8 and account deletion obligations: https://developer.apple.com/app-store/review/guidelines/

## T-05A owner decision (recorded 2026-11-16)

Owner selected option A for ranking ties. Use **competition ranking** (`rank = 1 + count(players with strictly greater verified score)`), with equal score producing equal rank and subsequent numbers skipped. Example A=500, B=500, C=450 → A=#1, B=#1, C=#3. This applies independently to each daily/weekly/archived time period and difficulty category. No On-Time, timestamp or first-to-score advantage, including when archived. A stable deterministic sort of equally ranked rows may aid pagination but is **not a ranking tie-break**. Exact stable sort, pagination and archived-finalization conflict semantics remain T-05B open.

## T-06A owner decision (recorded 2026-11-16)

Owner selected **A**: five-minute inactivity is based on **real player interactions**, not application uptime, an automatically emitted heartbeat or an otherwise live network connection. The server must validate the interaction and use trusted receipt timestamps. At >=300 seconds since the last qualifying genuine interaction, T-01 B forfeits the entire incomplete daily series; a fake/automated heartbeat never postpones expiry. Anti-spam/deliberate-UI-action qualification, exact allowed events and event/timeout transactional race tests remain T-06B OPEN, not silently approved.

## 7. Acceptance state

Owner-confirmed behaviors in §1 are accepted as **product input** in this conversation. This *proposal document*, API fields, schema, ADRs, endpoint URLs, auth, tie-break, timeout recovery and rollout are **not Accepted**. Existing BLUEPRINT remains DRAFT and is unchanged. This branch is docs-only and must not be merged until decision review.

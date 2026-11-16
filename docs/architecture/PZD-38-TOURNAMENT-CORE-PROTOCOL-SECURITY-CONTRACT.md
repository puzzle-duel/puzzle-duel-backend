# PZD-38 — Tournament V1 Core Protocol & Security Contract

Status: **PROPOSED technical architecture — NOT ACCEPTED**  
Date: 2026-11-16  
Tracker: https://puzzle-duel-app.atlassian.net/browse/PZD-38  
Source precedence: owner-approved T-01B/T-02–T-10A, R-01, Q01–Q31; then existing proposed Tournament architecture and ADR-T01. Accepted PZD-21 generator decisions and existing core-001.v1/v2 must not be silently changed.

This is a **consolidated decision/review artifact**, not running implementation, test evidence, accepted ADR, merge or deploy. Q01 is recorded in Jira PZD-38 description; Q02–Q31 are recorded in Jira comments 10265–10294.

## 1. Binding owner-approved product behavior

| Question | Approved contract |
| --- | --- |
| Q01 | Only server-accepted legal moves reset 300s inactivity; one explicit +60s request per full series |
| Q02 | No offline ranked moves; authoritative clock continues; resume original verified series before expiry |
| Q03 | Lost move response => canonical refetch; accepted move not repeated; never double-score |
| Q04 | One active writer device; explicit atomic handoff; old writer fenced, same claim/timer |
| Q05 | Trusted server-arrival strictly before deadline; equality rejected; processing lock delay alone does not invalidate timely command |
| Q06 | One intentional +60s extension only when 0 < remaining idle <= 60s; add to current idle expiry; cannot override UTC cutoff |
| Q07 | First verified Continue from completed game to immediate next ordinal renews idle deadline to accepted event time + 300s; duplicate does not |
| Q08 | Home/background/quit never immediately forfeits and does not pause/refresh timer |
| Q09 | Logout terminates auth, not series; same authenticated player_id may resume; other player forbidden |
| Q10 | Explicit confirmation for irreversible player abandon => FORFEITED, no partial ranking |
| Q11 | On cold launch check active series, offer Turnuvaya Devam Et; navigation-only action never refreshes idle |
| Q12 | On timeout show terminal explanatory result, spent right, no partial ranking, Home action |
| Q13 | Timely server-received valid H1 final move may commit after deadline; COMPLETED and four categories together |
| Q14 | Verified widespread backend outage: auditable centralized remedy; no auto-pause or leaderboard rewrite |
| Q15 | Separate equal-fixture compensation event; never post into ordinary daily/weekly ranks |
| Q16 | Only evidence-proven outage-caused timeout FORFEITED of active ordinary series eligible; completed/independent abandons excluded |
| Q17 | One compensation entry per eligible player; new entry window 72h from activation |
| Q18 | Existing compensation entries can finish until 73h from activation, subject to 300s idle and single +60s |
| Q19 | Fully verified six-game event finish => one commemorative badge plus separate All/Easy/Medium/Hard rankings |
| Q20 | Verified outage incident + two distinct authorized staff members to propose/approve event; full audit |
| Q21 | Evidence-based eligibility appeal; distinct two-person approval to correct before cutoff |
| Q22 | Upheld appeal after 72h entry closure => audit only, no additional entry or reopened event |
| Q23 | Concurrent starts per (player_id, original UTC date) => exactly one claim; second device reads only until handoff |
| Q24 | Same move idempotency key+payload returns first persisted result, no second state/timer update; different payload rejected |
| Q25 | Every move carries expected board_revision; only one competing move commits; others STATE_CONFLICT + current canonical board |
| Q26 | STATE_CONFLICT => canonical board/score/revision and brief notice; no automatic replay |
| Q27 | Lost first-start response => query original day claim, recover same series if committed; otherwise allow explicit eligible new start |
| Q28 | Transient backend error => unknown outcome until same-key/canonical reconciliation; no distinct move meanwhile |
| Q29 | Client preview is temporary; score/revision/ordinal confirmed only on server approval; no other move while pending |
| Q30 | At 5s without response, show pending-reconciliation UI; do not declare failure or refresh server clock |
| Q31 | Unknown move wait screen allows Home without cancellation, immediate forfeit or timer change; same-key reconcile on return |

**Crucial distinct actions:** Q11 Turnuvaya Devam Et only navigates; Q07 verified between-subgame Devam Et is a server mutation that resets idle ONCE. Extension and verified advancement are never anonymous heartbeat events.

### Baseline tournament and weekly boundary

Verified linked player_id, one daily six-game claim for each original UTC date, fixed immutable E1→E2→E3→M1→M2→H1 manifest; rank score published for Easy/Medium/Hard/All only after all six replay-verified complete. On-Time badge only if initial E1 claim is within its own UTC date and series later completes; badge never changes rank.

R-01 permits unplayed earlier days in *current open UTC week* to be claimed retrospectively. A previous-day claim already active at its own midnight must finish by 00:15 UTC; **this does not invalidate a new same-week backfilled claim begun after that midnight**. At next Monday 00:00, no more new old-week claims; already-started old-week claims may finish by Monday 01:00 UTC, still constrained by inactivity. All encompassing week daily and weekly ranks remain provisional until all eligible old-week commands drain and week finalizes.

## 2. Proposed canonical persistence and invariants

PostgreSQL 18 on backend Accepted ADR-005 subject to mandatory unrun executable smoke:

1. **daily_series**: canonical series_id, immutable player_id, original_utc_date, pinned manifest hash, started_at, current ordinal, status ACTIVE/AWAIT_ADVANCE/COMPLETED/FORFEITED, last_valid_activity_at, idle_deadline_at, optional thinking_extension_used_at, active_writer_binding, writer_generation, series_revision and terminal reason. Unique(player_id, original_utc_date); preserve terminal tombstones.
2. **series_games**: series_id+ordinal, pinned rules/version/seed/supply hash, verified board state/hash, board_revision, canonical move cursor, verified score and natural/normal terminal reason.
3. **command_inbox**: unique authenticated/scoped command idempotency key, type, canonical request payload hash, *trusted durable received_at and admission sequence*, expected revision, writer_generation, PENDING/APPLIED/REJECTED status, original replayable result envelope. No cross-player result lookup.
4. **move_ledger**: immutable accepted event per series+ordinal+sequence, source command, state-before/after hashes, verified score delta and rules-version proof; one authoritative state transition per board_revision.
5. **daily_results / weekly_results / period_snapshot**: idempotent completion transaction with all four scores, On-Time badge, revisioned provisional state, one terminal completion, week-settlement watermark and immutable archived FINAL snapshot.
6. **compensation entities** are a separate module: verified incidents, distinct proposer+approver staff audit, proposed/activated events and deadlines, evidenced eligibility, appeal cases, unique event/player claims, event-only four-category results and badges.

**No client authority** for score, clock, finished flag, replay seed mutation, manifest version or active writer generation. Provider email alone cannot prove that two OAuth identities are the same player. Only backend verified state may publish rankings.

## 3. Suggested HTTP contract (PROPOSED, not owner-approved endpoint names)

| Verb | Candidate endpoint | Main purpose |
| --- | --- | --- |
| GET | /v1/tournament/calendar?week=... | UTC original-date availability and backfill states, read-only |
| POST | /v1/tournament/days/{date}/start | Unique canonical E1 claim, server-authoritative initial time |
| GET | /v1/tournament/series/{id} | Board, move cursor, verified score, six-step progress, revision, deadlines and terminal state |
| GET | /v1/tournament/series/{id}/commands/{key} | Same-player authorized idempotent reconciliation, original outcome or pending |
| POST | /v1/tournament/series/{id}/moves | Legal ranked move, expected board_revision, ordinal, writer fencing, scoped idempotency key |
| POST | /v1/tournament/series/{id}/advance | First verified immediate ordinal transition, once-only 300s refresh |
| POST | /v1/tournament/series/{id}/thinking-extension | One +60s explicit request, only within final 60s |
| POST | /v1/tournament/series/{id}/handoff | Explicit authenticated atomic active-writer transfer |
| POST | /v1/tournament/series/{id}/abandon | Explicitly confirmed irreversible abandon |
| GET | /v1/tournament/leaderboard/days/{date} | Provisional/final category, revision and as_of |
| GET | /v1/tournament/leaderboard/weeks/{weekStart} | Current/archived categories, ranks and settling status |

Candidate error envelope: UNAUTHENTICATED, NOT_OWNER (404-style masking), NOT_ACTIVE_WRITER, STATE_CONFLICT with authorized canonical state, IDEMPOTENCY_PAYLOAD_CONFLICT, COMMAND_PENDING, ILLEGAL_MOVE, EXTENSION_UNAVAILABLE/USED, CLAIM_WINDOW_CLOSED and terminal FORFEITED/COMPLETED statuses. HTTP code mapping and OpenAPI schema require review. Response carries authoritative ordinal, revision, verified score, move cursor, idle/hard deadlines, server_now (display only), writer generation and pinned game version.

## 4. Hardest risk: trusted arrival timestamp versus durable ordering — release blocker

Owner Q05/Q13 require **received before deadline** to be eligible even when DB locking or processing finishes after deadline. A naive transaction that locks daily_series and then calls database NOW() at lock acquisition *violates* this guarantee. Conversely, trusting an in-memory ingress timestamp after server crash also violates it; unauthenticated client clocks are forgeable.

**Proposed design for approval:** durable authenticated command-admission journal with trusted timestamp and monotonically ordered per-series command sequence, registered at the platform front door before any adjudication. A request counts as reliably admitted only when its server-side receipt evidence survives crash/retry. Per-series arbiter applies commands deterministically using serializable DB operations, unique constraints, expected board_revision, active-writer fencing and idempotency ledger. Expiration worker MUST use an admission barrier/watermark so it cannot mark FORFEITED while eligible earlier-admitted commands remain unsettled. Final weekly snapshot similarly awaits all eligible pre-cutoff requests.

**Unresolved explicit trade-off:** During total durable ingress outage, HTTP bytes may reach a gateway but cannot be durably recorded. The exact definition of 'server received' under this failure must be determined and load/fault tested. Proposed fail-closed admission/error and verified incident remediation may leave unavoidable cases where unpersisted receipt cannot be proven. This MUST be surfaced at review and must never be silently redefined as post-lock commit time.

Other race oracles:
- deadline−1ms admission eligible; deadline or later rejected.
- identical key+payload N calls => first persisted outcome, no extra timer/points; same key+different payload => conflict.
- two different keys expected board revision r => one acceptance r→r+1, other STATE_CONFLICT, canonical refresh and no auto-retry.
- writer handoff versus old writer move => fenced sequential outcome; request accepted before handoff remains one committed event, later old-writer moves rejected.
- final H1 timely admission + delayed DB commit => COMPLETED once and atomic publication of four categories; no partial row visibility.
- timeout worker, handoff, abandon, extension, advance and finalization cannot produce contradictory terminal transitions.
- read-only GET, re-login, background, polling, reconciliation and duplicate transitions never reset idle.
- extension exactly 60s remaining is eligible, at 61s/0s ineligible; +60s cannot cross the independent hard cutoff.

## 5. Mobile recovery and transaction policy

- Show temporary piece placement preview but **never unverified score**, confirmed progress or revision.
- One pending distinct move per writer; at 5s transition to visibly verifying state, check same command key and canonical series; don't infer success/failure from 503/no reply.
- Let player navigate Home while pending; never cancel an unknown command, auto-abandon or pause clock. After app restart or reauth same player, query canonical series and unresolved command ledger, show recover prompt. No other move until a definitive resolution.
- Following true STATE_CONFLICT, show current verified board/revision/score and a brief notice; require *new deliberate player move* and new key. Unlike an already-committed lost-response move, do not automatically retry rejected action.
- On timeout show terminal reason and no partial-ranking message. Logout must revoke active auth credentials (precise in-flight token revocation ordering is engineering gate). Different player IDs cannot see prior series.
- Server resource controls: per-player/device command rate limiting, duplicate result retention at least long enough for all legally supported retries and settlement, immutable audit, privacy-safe logs, payload hash canonicalization/versioning, defense against request flooding. Exact TTL/per-minute thresholds pending benchmark.

## 6. Compensation event — separate delivery boundary

Q14–Q22 are **approved product rules** but operational implementation should be planned separately from the ordinary Tournament P0 hot path:
- Incident evidence centrally verified; prove specific active claim's outage-caused timeout FORFEITED. No automatic pause or arbitrary per-user extension.
- Event activates after two *different canonical staff identities* propose and approve; log all actions, reject impersonation/self-approval.
- Entry window [activation, +72h), finish cutoff +73h strictly; one compensated claim per event/player; normal inactivity and one +60s still apply.
- Identical immutable six-game fixture and separate All/Easy/Medium/Hard ranks; commemorative badge only on verified six-game completion; no normal ranking or archive changes.
- Appeals require evidence and two separate approvals. If upheld **after +72h entry closure**, record the outcome but issue *no* participation right, no reopening, no new event, per Q22 A.
- Staff operations, eligible cohort causation proofs, appeals/privacy and reward persistence require separate threat model, test and release approval. Do not advertise as shipped until implemented.

## 7. Leaderboard, engine and Blueprint dependency gates

Competition rank is rank = 1 + number of strictly greater verified scores (tie 1,1,3). Proposed stable row display score DESC then internal player_id ASC is NOT a ranking tiebreak. Revision-bound pagination, initial 50/hard max 100 and immutable snapshot settle design are technical proposals, not previously approved.

Successful natural exhaustion without legal moves requires newly versioned core-001.v3 exact tray and terminal-state semantics, frozen Dart/TypeScript golden vectors, no reinterpretation of core-001.v1/v2 and confirmed parity before backend ranked deployment. Existing PZD-21 generator acceptance does not prove game-engine parity. Both root Blueprint DRAFT v1.0 files need versioned v1.1 update reflecting Practice/Tournament/Leaderboard and superseding old single-board Daily Challenge without destroying history. Authentication provider support (particularly Instagram personal login/X feasibility) and backend stack executable smoke are independent release blockers.

## 8. New acceptance matrix (all NOT_RUN)

| ID | Oracle |
| --- | --- |
| P38-01 | Concurrent start across providers/devices => one claim, one initial start time, second device read-only |
| P38-02 | Start response lost, commit vs no commit, across UTC midnight => correct original date and no second claim |
| P38-03 | 300s strict ingress t−1ms eligible, t exactly expired; device timestamp spoof rejected |
| P38-04 | Move predeadline ingress but postdeadline DB processing => eligible if legal and correctly admitted |
| P38-05 | Crash or DB outage before journal durability => explicit unknown/error, no fabricated acceptance |
| P38-06 | Expiration worker versus queued timely H1 => one COMPLETED and four atomic ranks, not premature forfeit |
| P38-07 | Identical move key/payload N parallel retries => first persisted result only; changed payload conflict |
| P38-08 | Different keys same board_revision => one applied, one STATE_CONFLICT; no loser liveness refresh |
| P38-09 | Handoff versus old device write, extension, advance => no post-transfer old writer mutation |
| P38-10 | Valid advance resets deadline once; duplicate/skipped ordinal/unfinished game never resets |
| P38-11 | +60s at 61/60/0s boundaries, N parallel requests, cutoff enforcement |
| P38-12 | Invalid moves/GET/reconnect/poll/foreground/background/logout/home => no refresh |
| P38-13 | Explicit abandonment confirmation versus cancel; independent timeout; terminal no resurrection |
| P38-14 | Lost response, pending for >5s, Home and crash => canonical one-effect reconciliation |
| P38-15 | 00:15 cross-midnight in-flight, same-week retroactive backfill, Monday 00:00 / 01:00 boundaries |
| P38-16 | Six-game completion only: Easy/Medium/Hard/All atomic; forfeited never partial scoreboard |
| P38-17 | Compensation evidence, distinct staff approval, event 72h entry/73h finish, one event claim |
| P38-18 | Compensation separate ranks/badge and appeal post-72h audit-only, normal archives unchanged |
| P38-19 | Cross-player/private command lookup denied; idempotency payload tamper, provider-link attack and token revocation tested |
| P38-20 | Snapshot finalization barrier waits for all durable eligible pre-cutoff events; ranks frozen after FINAL |
| P38-21 | TS/Dart v3 immutable golden parity and historical v1/v2 regression |
| P38-22 | API OpenAPI/client contract and server/mobile error-state UAT with actual network faults |

**Execution status: NOT_RUN.** These are test specifications only. Do not interpret docs-only CI as runtime correctness.

## 9. Consolidated engineering decisions for a single future review

**Gate A (blocking):** Trusted, crash-durable ingress + sequencing and expiry/finalization barriers; Q05/Q13 correctness under DB failover and lock contention. This is the highest architectural risk.

**Gate B (blocking):** Atomic command inbox, idempotency and retry outcome policy, revision CAS, multi-device fencing, verified gameplay state machine, result transaction and OpenAPI contract.

**Gate C (cross-repo):** Ruleset core-001.v3 exact terminal predicate/tray JSON; runnable Dart/TypeScript parity; two Blueprint v1.1 plans; provider feasibility and ADR-005 smoke.

**Gate D (separate release planning):** Compensation operational/incident causation, dual approval, claim and appeal workflow, independent event ranks/badge. Not permission to ship incomplete compensation claims.

No further serial micro-questionnaire needed. Recommend presenting these four gates together for owner review; document states that all technical gates are PROPOSED until explicitly accepted. No implementation, merge or deployment is included here.

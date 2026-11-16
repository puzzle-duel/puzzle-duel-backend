# PZD-38 — Technical Gate Review: Protocol Decisions, Proof Obligations, Implementation Boundary

Status: **REVIEW COMPLETE AS A DESIGN PROPOSAL — TECHNICAL ACCEPTANCE PENDING PROOF AND OWNER SIGN-OFF**
Date: 2026-11-16
PR: https://github.com/puzzle-duel/puzzle-duel-backend/pull/12
Source of truth for approved behavior: [PZD-38 core contract](PZD-38-TOURNAMENT-CORE-PROTOCOL-SECURITY-CONTRACT.md), Jira PZD-38 Q01–Q31, Tournament V1 architecture, ADR-T01, R-01.
Scope: four earlier promised technical gates A–D. This document **selects a recommended design** for each gate, highlights failure modes and supplies executable test oracles; it does **not** pretend that code, hardware failure tests or third-party feasibility has been verified. Do not mark ADR Accepted until gates pass and review approval is explicit.

## Decision summary

| Gate | Recommended technical selection | Review verdict |
|---|---|---|
| A — arrival/clock/ordering | Crash-durable per-series authenticated ingress journal, strict deadline comparisons against **trusted ingress timestamp**, single deterministic arbiter, expiry/finalization barriers | **DESIGNED / BLOCKED** by durability+latency proof under DB outage |
| B — command/API/DB | Atomic unique claim; inbox idempotency and canonical replay; board_revision CAS; monotonically fenced active device; recovery GET and terminal transaction; atomic all-four rank-visible result | **DESIGNED / BLOCKED** by integration test and OpenAPI parity |
| C — cross-repo release | Freeze current core-001.v1/v2, approve new core-001.v3 independently, dual TS/Dart golden proof; two Blueprint v1.1 changes; compliant provider gates and stack smoke | **DEPENDENCIES OPEN** outside PZD-38 |
| D — outages/compensation | Independent incident/evidence-backed event module with dual-operator approvals and fixed 72h+1h cutoffs; no effect on standard boards | **APPROVED PRODUCT / ENGINEERING DEFERRED**; requires explicit launch milestone |

The product owner has already approved Q01–Q31. None of the SQL, endpoint names, queue technology or deferred feature ordering receives implicit owner acceptance through this analysis.

## A. Server ingress and deadline adjudication

### A.1 Define the authority boundary carefully

A user move is legally *timely* only if authenticated and accepted into a trusted, crash-recoverable server ingress domain with authoritative ingress time **strictly before** both its 300-second inactivity deadline and any applicable UTC hard completion deadline. A client timestamp or local timer never proves timeliness.

**Potential contradiction needing explicit review:** an HTTP gateway may receive raw bytes at 12:04:59.999 while all durable intake storage is unavailable until 12:05:00.010. The user-approved wording is “reached the server before expiry.” Any redefinition of “received” as “durably admitted” in this failure mode is a product-impacting refinement, **not** automatically approved. There is no crash-proof way to substantiate a raw arrival that was never durably recorded. The implementation must either (a) provide a trusted high-availability ingress capture with evidence of original arrival, or (b) acknowledge the impossibility, fail closed, and route eligible, independently evidenced widespread infrastructure failures to the separate Q14–Q22 remediation process. Do not silently equate HTTP response/DB lock time with original receipt time. Mark this as **owner review required** before technical acceptance.

**Recommended admission architecture:** a trusted edge/gateway and independently durable journal that capture verified ingress timestamp and globally unique intake identity, then perform authenticated player binding before treating the request as accepted gameplay. Edge admission must use trusted NTP-monitored UTC clocks and deterministic order IDs; it must not trust a timestamp from an unverified client. A two-stage intake with durable evidence and server authentication should record untrusted ingress metadata only as *candidate*, then allow game adjudication after auth; never permit an unauthenticated candidate to block series finalization indefinitely. Compare clock skew bounds across ingress nodes; choose one authoritative time domain or bounded monotonic ordering design and prove it under multi-node load.

**Scope caveat:** an event queue is not a magic solution. If a write to the journal is unavailable or non-durable, admission cannot be asserted. If incoming HTTP traffic at two replicas can be ordered differently than journal commits, an explicit stable ordering rule is essential. Operational observability and fencing for journal consumer lease failover are required.

### A.2 Formal state transition function (proposal)

For each independently durable command c:

1. Verify idempotency scope and authenticated identity; resolve same-key+same-canonical-payload to its persisted outcome, regardless of duplicate's newer arrival, without renewing liveness. Same key+different payload => conflict.
2. Resolve initial claim by atomic unique(player_id, target_utc_date), and return existing series without resetting its original E1 started_at, idle deadline, On-Time eligibility or writer ownership.
3. For a new command, examine the canonical series, the **trusted original ingress timestamp t**, current expiry rules and the per-series command order. If the command is at/after applicable deadline, reject (and persist final FORFEITED when eligible). Do not rely on wall clock at later row-lock acquisition for original eligibility.
4. Verify current authenticated player, active-writer fencing generation, ordinal, board_revision and engine legality against pinned immutable version. A stale generation or revision cannot mutate. Server-side accepted legal move updates board/score/revision/cursor and last_valid_activity to accepted event time exactly once.
5. First verified Advance from completed ordinal k to k+1 resets inactivity deadline to accepted transition event time +300s; a repeated Advance has no time effect. Single deliberate extension command only when original idle time remaining >0 and <=60s, extends current idle deadline +60s exactly once, never beyond UTC hard cutoff.
6. Successfully verified H1 final move transitions to COMPLETED, prepares four category result rows and badge within one atomic visibility/commit boundary; no partial result is published. Terminal status monotonically persists.
7. Unknown/pending command status is distinct from definitively rejected or uncommitted; block further different moves until resolved. A 503 is not a gameplay rejection.

**Temporal precedence must be explicit.** Take an ordinary chronological sequence: a legal move accepted at t1 can advance the next idle deadline; a legal command at t2 may then be eligible even if t2 exceeds the *old* deadline, provided t1 happened first and updated it. This is why comparing every queued command to the final stored deadline without replaying prior commands is invalid.

**Advance/extension/handoff/abandon races:** derive a total order of *new* accepted commands from journal admission sequence and apply that order. A logically later handoff must fence later old-device mutations; earlier eligible accepted old-device moves can remain valid. An abandonment command ordered before an otherwise eligible last H1 move terminates the series; if the H1 completion was ordered first, later abandonment cannot erase completed rankings.

### A.3 Expiry worker and publication barriers

Forfeit worker may transition an incomplete series to FORFEITED only when (i) authoritative deadline has elapsed, (ii) a durable **admission watermark** proves that no outstanding eligible command with a timestamp before cutoff can still change its state, and (iii) replay/transaction arbitration is settled. A delayed event must not resurrect a genuinely finalized forfeiture; instead avoid premature finalization through the barrier. Must prove that poisoned or stuck queue items cannot postpone forfeiture forever (bounded dead-letter handling, accountable operator incident state, explicit remediation—not silently skipping eligible final moves).

The week snapshot finalization requires a stronger barrier: Monday 00:00 closes old-week claims, Monday 01:00 closes eligible old-week series (with previous legal event arrival strictly before 01:00), and **only after all earlier eligible admitted commands are conclusively APPLIED or REJECTED** can all previous week's daily and weekly snapshots become FINAL atomically. Monday 00:15 is never a weekly daily-board finalization cutoff under R-01.

### A.4 Required executable evidence (NOT_RUN)

Concurrent gateway arrivals on two hosts; journal producer timeout/ack-loss; crash immediately before/after durable journal write; consumer crash between replay and DB commit; row-lock queue >deadline; expiry worker racing predeadline H1; queue partition and stalled consumer; clock skew test; old writer handoff versus pending command; repeated key with changed payload; outage with no durable ingress at all; finalization after 01:00 with eligible pending event. Use fault-injection and authoritative test clock, with reproducible UTC millisecond assertions. **No PASS claim until these run.**

## B. Canonical DB, API and client recovery

### B.1 Transactional uniqueness and replay

- unique(player_id,original_utc_date) in daily_series; cannot allocate a new attempt after COMPLETED or FORFEITED; a same-day competing start returns existing canonical state read-only unless explicit writer handoff.
- unique(player_id,series_id,command_type,idempotency_key) in command_inbox, with canonical payload digest. Retain original result or conflict indefinitely for the period in which an idempotent retry can legally arrive; retention/archival policy must not permit reexecution of an old logical move after deletion.
- unique(series_id,ordinal,move_cursor) and source_command_id in move_ledger. All legal moves under pinned server replay; result contains verified state hash and updated board_revision. Invalid/stale/auth-conflicting moves do not reset idle.
- per-series monotonically increasing writer_generation plus authenticated writer binding. A client-generated device label is not proof of writer ownership; server binds takeover to verified same-player session, validates explicit transfer and fences stale tokens.
- completion transaction: compare expected final H1 game and series revision/status, aggregate previously replay-verified six scores; insert daily_results exactly once and reflect those results across weekly materialization atomically; derive all four categories from the **same committed final version**. If asynchronous reads are used, do not expose partial categories; use a committed result pointer or uniform snapshot revision.

### B.2 Pending request UX and reconciliation

A move request contains scoped key, expected ordinal/board_revision, current writer_generation, and a move under pinned game schema. Client may show ephemeral preview but **never** speculative ranked score/advance. Pending after 5s prompts same-key result query; do not send a different move. Home navigation while pending is permitted; app relaunch fetches canonical series and pending command identity from server. If original accepted, render once; if definitely rejected/not committed, revert to canonical board and allow deliberate new action; if unknown, keep blocking new moves while ordinary timer and UTC cutoff continue.

A server GET, login, reconnection, app foreground, screen render, duplicate Move or duplicate Advance cannot refresh the 300s deadline. Read-only Home 'Resume Tournament' CTA differs from the authorized completed-game Advance.

Recommend independent command ledger and series status endpoint with explicit PENDING, APPLIED and REJECTED outcomes. Key lookup is restricted to verified player_id and series_id; do not expose arbitrary ids or cross-player scoreboard/command access. HTTP 202 for unresolved command, 409 for actual conflicting revision or idempotency payload and 422 for illegal move are **proposed**, subject to OpenAPI review.

### B.3 Resolved transaction design questions and remaining gates

Recommendation: serializable or explicit locked series aggregate transaction and DB constraints as defense in depth; the durable journal arbiter determines logical order, while optimistic expected board_revision detects stale independent commands. A serializable retry MUST preserve the original trusted ingress/admission identity, not issue a fresh authoritative timestamp or accidentally reset the deadline.

Data contracts and error codes to freeze in OpenAPI before client implementation: start semantics, command receipt ack, accepted response with canonical revision, exact pending status and canonical recovery, writer handoff conflict, extension eligibility, abandonment terminal reason, resume query, provisional/final leaderboard revisions, week-stable paging, deleted player privacy. **No production implementation/code tests performed.**

## C. Cross-repository prerequisites and sequencing

1. **Engine E-01:** dedicate separate ADR for core-001.v3 terminal tray representation, legal-placement predicate, natural no-legal-move success, ordered finite supply and cascade exhaustion. v1/v2 fixtures remain unchanged. Freeze vectors for early board-full, partial remaining offers with empty stream, no legal placements with empty board, cascade reopens playable space, move budget exhaustion, malicious terminal proof and backcompat; run independently in Dart/TypeScript with exact score/end reason/hash match. Until PASS, cannot publish real Tournament results.
2. **Blueprint B-01:** versioned v1.1 in both repos to explicitly replace old independent ranked Daily Challenge with Practice/Tournament/Leaderboard; map legacy endpoints/Jira/fixtures/data first, no secret history rewrite and no presumption that live migration is required.
3. **Identity I-01:** launch-enabled provider allowlist based on actual supported Apple/Google/Facebook/TikTok/Instagram/X login/app review and verified account linking; Instagram consumer login and X pricing/approval remain open, never ship a dead auth button or bypass verified login.
4. **Runtime stack:** Accepted ADR-005 chosen stack still requires mandatory executable smoke, NOT_RUN as of inspected architecture. Hosting and operational logs/DB failover require separate environment proof.

These are **technical/release blockers**, not reason to re-ask 31 already accepted product behavior choices.

## D. Compensation module release boundary

Product Q14–Q22 are approved but deliver as an independently gated module:
- human-confirmed verified widespread incident with audit quality sufficient to prove individual active series suffered outage-caused timeout FORFEITED (not merely correlated timestamps), excluding ordinary abandons/completions;
- canonical staff-identity 2-person proposal and approval, immutable auditable event activation;
- identical event fixture, one event/player claim with 72h entry window, eligible started series hard finish at 73h, same inactivity and +60s behavior;
- separate four-category event rankings and one commemorative badge on verified six-game completion;
- evidence-based dual-approval appeals; upheld after 72h recorded **without** new claim or reopened/second event;
- zero mutation of normal daily/weekly leaderboards or FINAL archives.
Do not claim this module is delivered by the core Tournament API. User decision is needed on release phasing only if V1 cannot honestly be shipped with the promised outage compensation; this is **not** a hidden technical implementation acceptance.

## Release-ready check matrix

| Gate | Evidence demanded | Present state |
|---|---|---|
| A1 | Trusted ingress timestamp and ordering semantics with durability/clock/fault proof | SPECIFIED / NOT_RUN |
| A2 | No predeadline H1 loss from queue and no postdeadline acceptance | SPECIFIED / NOT_RUN |
| A3 | Expiry worker and FINAL archive barrier under backlog/crash | SPECIFIED / NOT_RUN |
| B1 | DB schema+unique constraints, CAS, move ledger, exactly-once completion integration suite | SPECIFIED / NOT_RUN |
| B2 | Auth/write fencing, same-key retries, 503 recovery, client pending UX, OpenAPI and mobile parity | SPECIFIED / NOT_RUN |
| C1 | v3 ruleset schema accepted, historical v1/v2 regressions, Dart/TS golden parity | OPEN / NOT_RUN |
| C2 | Blueprint v1.1 both repos, provider feasibility, ADR-005 runtime smoke | OPEN / NOT_RUN |
| D1 | Outage incident causality, dual-staff control, appeals, event rank/badge and publication | DEFERRED / NOT_RUN |

## Approval recommendation

- **Recommend** the core command/ledger/CAS/write-fencing architecture in Gate B conditionally, subject to contract and tests. It is implementation-ready as a **proposal**.
- **Do not accept Gate A yet.** Authenticated crash-durable receipt time and authoritative order of concurrent commands are prerequisites for the owner's strict no-unjust-forfeit guarantee and have not been proven.
- **Do not accept Gate C without engine parity or provider/Blueprint smoke.** These are other Jira work packages, not PZD-38 completion.
- **Split compensation Gate D into separately release-gated implementation** with product scope intact; owner must approve any shipping delay if compensation is expected in the same launch.
- Keep ADR-T01 **Proposed** and PR **Draft**. Nothing in this RFC authorizes runtime code, a merge or a deployment.

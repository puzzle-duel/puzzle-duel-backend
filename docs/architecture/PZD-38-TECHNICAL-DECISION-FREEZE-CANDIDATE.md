# PZD-38 — Technical Decision Freeze Candidate

Status: **OWNER-ACCEPTED TECHNICAL DESIGN (TD-01…TD-18 + X-01 A + X-02 B); EXECUTABLE PROOF NOT_RUN**
Date: 2026-11-16
Sources: PZD-38 owner-approved Q01–Q31; Tournament V1 R-01; ADR-T01; existing PZD-38 core protocol and technical gate review on this branch.
Scope: no development, executable test, merge or deploy. This decision bundle closes the architecture selection discussion without claiming an implementation is already proven.

## A. Recommended technical decisions (TD-01…TD-18)

| ID | Selection | Release/acceptance oracle |
| --- | --- | --- |
| TD-01 | Immutable player_id and original UTC date unique daily-series key; atomic create-or-return-existing; preserve FORFEITED tombstone | Concurrent same-day multi-device/provider start gives one right and original timestamp |
| TD-02 | Trusted server ingress identity, timestamp and deterministic per-series command order in durable admission journal | Predeadline admitted move survives postdeadline DB wait; at deadline rejected |
| TD-03 | Ordered arbiter plus PostgreSQL transaction, row lock and expected board_revision CAS | Different concurrent moves at same revision: one commit, other STATE_CONFLICT |
| TD-04 | Scoped command idempotency key and canonical payload fingerprint, durable original outcome | Same key/payload replay returns first result without new score or clock; changed payload conflict |
| TD-05 | Monotonic writer_generation bound to authenticated device/session, explicit atomic handoff | Old writer fenced; no takeover through repeated Start |
| TD-06 | On accepted legal move, compute idle deadline from original trusted event time +300s; unique verified game Advance likewise +300s once | Read, poll, network, invalid taps and duplicate Advance never refresh |
| TD-07 | One deliberate +60s extension per six games, valid only when remaining time >0 and <=60s; add to current idle deadline, not new 300s | Concurrent extension is once-only; UTC hard cutoff is independent |
| TD-08 | Separate hard-cutoff calculation for ordinary already-inflight prior-day crossing, open-week retroactive backfill and Monday old-week crossover | Follow R-01; never apply expired 00:15 to later valid same-week backfill |
| TD-09 | Command outcome PENDING/APPLIED/REJECTED, authenticated reconciliation endpoint and canonical series state | 5s pending UX; same-key reconcile; no different move during unknown |
| TD-10 | Only ephemeral local move preview; server commits board_revision, score and progress; no automatic resubmit after STATE_CONFLICT | Lost-success reply reconciled once; no speculative ranking or timer |
| TD-11 | Verified pinned immutable six-game manifest and server replay; no user-supplied points, terminal flag or ruleset swaps | Natural terminal requires separate core-001.v3 approval and Dart/TS parity |
| TD-12 | Single atomic terminal COMPLETED and four-category results visibility, including On-Time badge; no partial scores | H1 replay verified, exactly-once Easy/Medium/Hard/All publication |
| TD-13 | Expiry worker waits for eligible admitted command barrier; period settlement waits for pre-cutoff result barrier | Timely H1 cannot be unfairly forfeited, finals never omit eligible settled events |
| TD-14 | Ranking via competition RANK by score descending; row display tie order score descending then internal player_id ascending, not a rank tiebreak | Scores 500,500,450 produce ranks 1,1,3; revision-bound page cursors |
| TD-15 | Proposed initial leaderboard page size 50 and max 100, error SNAPSHOT_CHANGED on provisional revision change | No duplicated/omitted page rows under unchanged snapshot |
| TD-16 | Authenticated immutable player identity, provider-link proof, no cross-player read and private command lookup; redacted logs and audited write/admin actions | Spoofed player/device/claim/key rejected, no existence or PII leakage |
| TD-17 | Compensation as separately isolated event/claim/result namespace, two distinct staff approvers, evidence-based outage causality, 72h entry and 73h finish, audit-only late upheld appeal | No normal daily/weekly scoreboard impact; event-only badge and four ranks |
| TD-18 | OpenAPI-first stable request/response/error envelope and independent core-001.v3 + Blueprint v1.1 cross-repo release checks | Client/backend contract suite and TS/Dart golden vectors PASS before production |

**OWNER DECISION:** TD-01…TD-18 accepted together as the recommended architectural design. This does NOT claim that an exact SQL schema, vendor-specific journal product, implementation, runtime proof or release has been accepted.

## B. Precise temporal ordering (critical Gate A)

A command needs a trusted original ingress timestamp and durable admission identity; it is never assigned a new time when queued, retried or reprocessed. An authenticated per-series arbiter applies distinct commands in a stable total order, evaluates deadline eligibility **after earlier eligible commands have updated canonical state**, verifies active writer generation/board revision and uses transactionally unique ledgers for effects.

Hard expiration is exclusive: trusted received_at must be strictly earlier than both effective 300s inactivity and UTC hard cutoff. Genuine accepted move and first verified advance each refresh idle to their own original accepted ingress time +300s. Extension adds exactly 60s only during the final minute of unexpired idle. A last verified H1 received before the cutoff can commit later; neither worker backlog nor row-lock waiting can automatically forfeit it.

Forfeit worker can publish irrevocable FORFEITED only if a provable ingestion watermark shows no older eligible accepted request is still undecided. Week finalization similarly waits through Monday 01:00 UTC and all previously admitted eligible results before freezing all daily and weekly rank snapshots. A stuck command must be visible as an incident and resolved deterministically, never silently dropped or treated as permanently completed.

**Important impossibility boundary, not silently resolved:** if an HTTP server sees a request before cutoff but ALL durable intake recording is down and the process dies before recording any witness, the initial ingress cannot later be proven. Ingress timestamp stored only in RAM is insufficient. Proposed approach is a separately reliable durable timestamped ingress witness with clock-health monitoring, admission acknowledgments, ordering guarantees and fault-injection tests. If even this witness cannot be written, reject as unverified/UNKNOWN, never fabricate a canonical move. That can affect the product-level Q05/Q13 promise, so this exceptional boundary needs explicit owner approval, not just technical preference.

## C. Proposed concrete API and persistence

Commands: start same player/date; submit move with expected board_revision, pinned ordinal, idempotency key, fenced writer_generation; verified next-game advance; once-only thinking extension; explicit writer handoff; explicitly confirmed abandon. Queries: calendar availability, canonical series, per-command original outcome, category daily/weekly ranks and settlement revision. All writes are server authenticated and atomic; canonical GET or command GET never renew liveness. Response carries series_id, original date, ordinal, board_revision, move cursor, verified score, idle deadline, applicable hard cutoff, terminal reason and ruleset pin. HTTP code names and payload schemas should be frozen with OpenAPI review, not invented by mobile.

Recommended schema entities: daily_series unique(player_id,original_utc_date), series_games keyed series_id+ordinal, command_inbox keyed series_id+command_type+idempotency_key with player binding, accepted move_ledger with unique sequence/revision and request digest, writer generation bound to authenticated session, daily_results/weekly_results with atomic committed completion pointer, revisioned period snapshots, compensation incidents/event proposals/approvals/evidence/claims/badges/audit in separate namespace. Maintain durable idempotency decision evidence through legally relevant retries and archive settlement; do not permit deleted ledger entries to reexecute an old move.

## D. Cross-repo and compensation release boundary

core-001.v3 is not implicitly approved: its exact null/spent offer tray schema, successful legal-move exhaustion predicate and deterministic state/score hashes need a separate accepted ADR plus Dart/TypeScript golden parity. Historical core-001.v1/v2 semantics remain frozen. Root Blueprint v1.1 in both repos, provider feasibility including Instagram consumer sign-in/X access, and ADR-005 executable backend stack smoke remain other release gates.

Compensation Q14–Q22 product behavior is APPROVED. Its backend incident evidence, two different staff approvers, eligibility appeals and dedicated event-only leaderboard/badge implementation are NOT yet built. Recommend separate technical work package, without promising it is available in shipped app until tested. Whether this feature must ship with Tournament V1 or may ship separately is a **product milestone decision**, not engineering-only discretion.

## E. Final review and proof checklist

| Gate | Decision readiness | Executable evidence |
| --- | --- | --- |
| A: deadline and ordering | Design proposal selected; ingress-outage edge OPEN | NOT_RUN: trusted admission, DB failover/process kill, exact boundary, H1 versus expiry, queue watermark |
| B: API/DB/idempotency | Proposed technical choices TD-01–TD-16 | NOT_RUN: PostgreSQL integration/locking, full OpenAPI/mobile, authenticated writer fencing and ledger replay |
| C: parity/Blueprint/identity | Explicit prerequisite work packages identified | NOT_RUN: new v3 TS/Dart golden vectors, historic regression, two Blueprint changes, provider checks, stack smoke |
| D: compensation | Owner Q14–Q22 approved; engineering design selected | NOT_RUN: incident/eligibility proof, two-staff audit, event entry/final cutoff, badge/appeal/score isolation |

## Final owner resolutions (APPROVED 2026-11-16)

**X-01 — ACCEPTED A:** If there is no reliable durable proof of timely server admission, **fail closed**; do not fabricate a move, receipt time, score, extra daily attempt or regular leaderboard adjustment. For verified outage-affected players, use only the separately approved evidence-based compensation event eligibility path (Q14–Q22); no automatic compensation without trustworthy causal evidence. Durable ingress, reproducible ordering and deadline proof remain mandatory for normal operations. This documented exceptional failure handling is not permission to relax Q05/Q13 when receipt evidence exists.

**X-02 — ACCEPTED B:** Launch **ordinary Tournament V1 first** when its own release gates pass; implement, test and deploy the outage-compensation module in a **separately gated later release**. Do not advertise, expose UI controls for, or promise access to compensation functionality that has not shipped. Product rules Q14–Q22 remain approved, not cancelled.

**Owner has explicitly batch-approved TD-01…TD-18 and both X resolutions.** Technical architecture selection is decision-complete. Runtime evidence, the independently versioned core-001.v3 contract, Blueprint migration, provider feasibility, ADR-005 smoke and release gates are still outstanding. No implementation, merge, deploy or Jira Done is authorized by this approval.

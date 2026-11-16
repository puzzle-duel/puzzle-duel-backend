# ADR-T02 — Tournament V1 Core Protocol and Security

Status: **Accepted — architecture decisions; implementation/release NOT_VERIFIED**
Decision date: 2026-11-16
Owner approval: https://puzzle-duel-app.atlassian.net/browse/PZD-38
Draft PR: https://github.com/puzzle-duel/puzzle-duel-backend/pull/12
Related: [technical freeze](../architecture/PZD-38-TECHNICAL-DECISION-FREEZE-CANDIDATE.md), [core contract](../architecture/PZD-38-TOURNAMENT-CORE-PROTOCOL-SECURITY-CONTRACT.md), [technical review](../architecture/PZD-38-TECHNICAL-GATE-REVIEW.md), [ADR-T01](ADR-T01-tournament-ranked-session.md).

## Context

The owner explicitly approved all eighteen technical selections TD-01 through TD-18 and exceptions X-01 A and X-02 B as a single architecture decision package. Approved Q01–Q31 and R-01 remain binding. Accepted here is a **design decision**, not proof of implemented correctness or permission to build, merge or deploy. Wider ADR-T01 remains Proposed while its independent implementation/release prerequisites are unproven.

## Accepted technical design — TD-01 through TD-18

1. Unique immutable daily claim per verified player_id and original UTC date, with forfeiture tombstone.
2. Durable trusted server ingress identity, timestamp and deterministic per-series admission order.
3. Serialized arbiter, PostgreSQL transaction, row lock and board_revision CAS.
4. Durable command-scoped idempotency key + normalized payload hash + original persisted outcome.
5. Authenticated writer binding and monotonic generation; explicit atomic handoff; old writer fenced.
6. Legitimate verified legal move and first verified between-game Advance renew inactivity to original accepted event time +300s exactly once.
7. One deliberate +60s request per entire six-game series, only when remaining idle is >0 and <=60s; add to existing deadline, not beyond UTC hard cutoff.
8. Different hard-cutoff policies for prior-day in-flight rollover, same-week backfill and Monday prior-week rollover under R-01.
9. Pending/applied/rejected command outcome with authenticated same-key reconciliation; 5s client UX verification threshold.
10. Ephemeral local move preview only, server-committed score/revision/progress; conflict replaces preview with canonical state and no automatic move replay.
11. One pinned immutable E1 E2 E3 M1 M2 H1 manifest and independent server replay under accepted versioned rules.
12. Atomic all-six COMPLETED and exactly-once Easy/Medium/Hard/All result and On-Time badge publication.
13. Durable ingress/expiry and weekly snapshot barriers, with no premature forfeiture or immutable settlement.
14. Competition ranks with score-desc ties, deterministic presentation sort and revision-bound pagination.
15. Proposed leaderboard page defaults 50 and maximum 100; snapshot revision conflict requires refresh.
16. Immutable verified player identity, safe account linking, per-read/write authorization, private command query and redacted audit.
17. Outage-compensation isolated event module with verified incident causation, two independent staff approvals, event-only ranking and appeal controls per Q14–Q22.
18. OpenAPI-first client/backend contract and separately versioned core-001.v3 / two-repo Blueprint compatibility gates.

The detailed technical definitions and acceptance oracles are incorporated from the linked technical freeze file, as explicitly accepted by the owner. Product effects Q01–Q31 take precedence over older proposed details; historical accepted generator and v1/v2 engine versions are not silently rewritten.

## X-01 A — Accepted exceptional no-proof boundary

When catastrophic infrastructure failure leaves **no reliable durable trusted record** that a request reached the server before expiry, fail closed. Never invent an accepted command, past receipt time, second entry, normal leaderboard correction or retroactive score from untrusted client timestamps. If the verified outage and an individually outage-caused timeout satisfy Q14–Q22 server-side evidence requirements, the independently released compensation event may provide the approved remedy; no unsupported automatic compensation.

This exception does **not** weaken Q05/Q13 in the normal proven-admission case: a valid final H1 reliably received before deadline stays eligible despite DB lock or processing delays. Reliable ingress evidence, ordering, fault injection and expiry barrier remain mandatory production gates.

## X-02 B — Accepted phased release

Release ordinary Tournament V1 first **only when its release gates are actually proven**. Release the already approved Q14–Q22 compensation module in a **later, independently gated deployment**. Do not display a compensation UI, promise compensation availability, or advertise it as shipped before it exists. Its separate event rankings, badge, verified incident eligibility, two-staff controls, 72h claim / 73h completion and postclosed upheld-appeal audit-only behavior remain binding.

## Invariants, consequences and exclusions

A client GET, duplicate, heartbeat, stale writer request, invalid move, login, app foreground or navigation-only resume must not renew 300s or allocate a second claim. Writer handoff cannot resurrect terminal series. Timely original server admission must survive delayed processing, with terminal scoring and weekly FINAL snapshot barriers settling eligible accepted commands before publishing immutable results.

Only design is Accepted. Exact SQL migrations, HTTP routes, ingestion technology, provider identity implementations, retention policy and UI visuals remain to be supplied by subsequent versioned implementation contracts and tests. The ADR does not accept nonexistent engine-v3 replay parity, unpublished Blueprint updates, runtime test PASS or compensation readiness.

## Mandatory delivery gates (all NOT_RUN)

- A: Authenticated durable ingress and exact deadline/order, clock source, database/process crash, last-H1 race, timeout/weekly-settlement barrier.
- B: Atomic unique claim, idempotency ledger, writer fencing, board CAS, canonical recovery and four-result atomic visibility, OpenAPI and auth/privacy tests.
- C: Separate core-001.v3 spec and Dart/TypeScript parity while preserving v1/v2, two Blueprint v1.1 changes, provider feasibility and ADR-005 stack smoke.
- D: Compensation separately delivered later with operator dual control, incident/appeal evidence, 72h/73h cutoffs, event-only ranking and badge.

No development, merge, deploy or production readiness is authorized by this decision registration. Draft PR remains unmerged. Existing ADR-T01 retains Proposed status until its broader acceptance gates are resolved.

# PZD-38 Phase A — Trusted ingress verification evidence

Branch: `feature/PZD-38-trusted-ingress`  
Base: `origin/main` @ `e3ca274` (ADR-T02 Accepted design squash-merge from PR #12)  
Design: ADR-T02 Accepted — Design only; ADR-T01 remains Proposed.

## Repository integrity

| Item | Value |
| --- | --- |
| Implementation baseline | Merged onto current `origin/main` (not Draft PR #12 branch) |
| Accepted ADR files | Present from `main` (`docs/adr/ADR-T02-…`, contract, freeze, gate review) |
| Runtime scope | Admission journal + series fence + arbiter only |
| Nest / HTTP / auth | NOT implemented (Phase B) |

## What Phase A proves vs does not prove

**Proves (with PG where noted):** trusted server receipt ms, durable admit, exclusive deadline, idempotent admit, advisory-locked seq, expire/weekly barriers, board CAS / writer fence at fence-store layer, X-01 fail-closed on ingress unavailable, H1 COMPLETED vs FORFEITED ordering at fence layer.

**Does not prove:** Nest multi-process consumers, real DB failover/replica promotion, authenticated sessions, atomic Easy/Medium/Hard/All leaderboard rows, OpenAPI, engine v3, NTP multi-host skew SLA.

## Commands

```bash
nvm use 26
npm install
docker compose -f docker-compose.ingress-test.yml up -d
PZD_INGRESS_DATABASE_URL=postgresql://pzd:pzd@127.0.0.1:55432/pzd_ingress \
  npm run test:ingress
```

## Evidence run

```
ℹ tests 24
ℹ pass 24
ℹ fail 0
ℹ skipped 0
```

Captured after verification repairs (duplicate outcome race, PG connect fail-closed, advisory locks, fence CAS).

## Test matrix

| Test | Source | Assertion | Type | Result |
| --- | --- | --- | --- | --- |
| P38-03 ±1ms / equality | deadline-boundary.test.mts | exclusive `isTimely` | Unit | PASS |
| thinking extension window | deadline-boundary.test.mts | (0,60s] only | Unit | PASS |
| predeadline admit / postdeadline adjudicate | deadline-boundary.test.mts | apply uses original ms | Unit (memory journal) | PASS |
| deadline-equal reject | deadline-boundary.test.mts | IDLE_EXPIRED | Unit | PASS |
| clientDeclaredAt ignored | deadline-boundary.test.mts | spoof rejected | Unit / security | PASS |
| X-01 fail-closed | durability-fault.test.mts | unavailable, no row | Fault (memory flag) | PASS |
| crash before admit | durability-fault.test.mts | empty → new admit | Fault sim | PASS |
| crash after admit | durability-fault.test.mts | same trustedReceivedAt | Fault sim | PASS |
| idempotency payload conflict | durability-fault.test.mts | conflict | Unit | PASS |
| timeout vs pending | durability-fault.test.mts | forfeit blocked | Unit | PASS |
| consumer crash pending | durability-fault.test.mts | barrier + duplicate | Fault sim | PASS |
| consumer crash after apply | durability-fault.test.mts | replay no double score | Fault sim | PASS |
| multi-admit seq | durability-fault.test.mts | seq 1..n | Concurrency (memory lock) | PASS |
| Case A revision CAS | concurrency-fence.test.mts | one apply / STATE_CONFLICT | Concurrency | PASS |
| Case B duplicate | concurrency-fence.test.mts | score once | Concurrency | PASS |
| Case C expiry vs pending | concurrency-fence.test.mts | forfeit blocked | Unit | PASS |
| Case D H1 complete | concurrency-fence.test.mts | COMPLETED once; no FORFEITED overwrite | Unit | PASS |
| Case E handoff | concurrency-fence.test.mts | NOT_ACTIVE_WRITER; idle unchanged | Unit | PASS |
| Case F weekly barrier | concurrency-fence.test.mts | finalize blocked | Unit | PASS |
| PG H1 delayed commit | postgres-journal.test.mts | apply + replay + no forfeit | **DB integration** | PASS |
| PG concurrent seq | postgres-journal.test.mts | 20 distinct seq | **DB concurrency** | PASS |
| PG unavailable | postgres-journal.test.mts | INGRESS_UNAVAILABLE | Fault / DB | PASS |
| PG aborted admit | postgres-journal.test.mts | zero rows for key | Fault / DB | PASS |
| PG Case A CAS | postgres-journal.test.mts | one mutation | **DB concurrency** | PASS |

## Gate matrix

| Gate | Required evidence | Result |
| --- | --- | --- |
| A-01 | Trusted original server ingress | PASS (server clock under admit lock; client time ignored) |
| A-02 | Durable admission persistence | PASS (Postgres journal + replay) |
| A-03 | Deterministic command ordering | PASS (per-series advisory lock + admission_seq) |
| A-04 | Strict deadline boundary | PASS (−1 / = / +1 ms) |
| A-05 | Crash and restart recovery | PASS (sim + PG unavailable); **DB failover NOT_RUN** |
| A-06 | Idempotent command admission | PASS |
| A-07 | Timeout versus queued command | PASS |
| A-08 | Multi-instance behavior | PARTIAL (shared PG journal + advisory locks; multi-host NTP NOT_RUN) |
| A-09 | Active writer handoff race | PASS at fence layer; **auth/session binding Phase B** |
| A-10 | H1 completion ordering | PASS barrier/`COMPLETED` fence; **four-category LB rows Phase C BLOCKED** |
| A-11 | Weekly settlement barrier | PASS mechanism; **immutable snapshot publish Phase C BLOCKED** |
| A-12 | X-01 fail-closed | PASS |

## Security findings

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| S1 | P0 | Duplicate concurrent adjudication could mark `rejected` over `applied` | Fixed: conditional outcome update + `lastAppliedAdmissionId` |
| S2 | P0 | PG `MAX(seq)+1` race without series lock | Fixed: `pg_advisory_xact_lock` |
| S3 | P0 | `pool.connect()` failure escaped try/catch → thrown error instead of fail-closed | Fixed |
| S4 | P1 | Memory journal alone is not durable evidence | Documented; PG tests mandatory for A-02 |
| S5 | P1 | Writer fence without authenticated binding | Tracked for Phase B (A-09 partial) |
| S6 | P2 | No retention/TTL policy for journal rows | Deferred |
| S7 | P2 | No rate-limit / poisoned-command quarantine worker | Deferred |
| S8 | P2 | Multi-region clock skew SLO unmeasured | NOT_RUN |

## Explicit non-claims

- No ADR-T01 Acceptance.
- No merge/deploy.
- No Phase B start.
- No compensation module (X-02 B).
- No claim that 24 unit/DB tests equal production Nest readiness.

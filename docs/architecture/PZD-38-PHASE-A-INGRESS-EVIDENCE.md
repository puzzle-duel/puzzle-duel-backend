# PZD-38 Phase A — Trusted ingress evidence log

Branch: `feature/PZD-38-trusted-ingress`  
Design basis: ADR-T02 Accepted design (Draft PR #12 HEAD `170d157`); ADR-T01 remains Proposed.  
Scope: durable admission journal + deadline/fault proofs. No Nest scaffold, no merge/deploy.

## Phase 0 baseline inventory

| Area | Existing | Missing | Dependency | Risk |
| --- | --- | --- | --- | --- |
| Authentication | None in backend runtime | Verified identity, sessions, writer binding | Provider feasibility; Blueprint v1.1 | High — ranked mutations blocked without it |
| Series state | Architecture docs only (PR #12 / main docs) | Canonical six-game series persistence + state machine | Phase A ingress; ADR-T01 gates | High |
| Persistence | Generator fixtures; no Nest/PG app schema on `main` | Series, results, leaderboard tables; migrations | ADR-005 Nest/PG18 smoke | High — smoke NOT_RUN |
| Trusted ingress | **This branch** memory+Postgres journal + arbiter | Nest HTTP admission path; multi-region failover proof | PG18 ops | Medium after Gate A unit/PG proofs |
| Gameplay engine | TS generator + client Dart rules (`core-001.v1/v2`) | Accepted `core-001.v3` natural termination | Separate ruleset ADR/review | Blocker for Phase C ranked play |
| Tournament API | OpenAPI described in docs only | Versioned handlers | Phase B contracts | High |
| Client | Offline board / PZD-23 UX; no tournament UI | Series indicator, pending move UX, recovery | Stable OpenAPI | High |
| Leaderboard | Spec only | Atomic 4-category publish + weekly barrier | Settlement + engine | High |
| Test infrastructure | Node strip-types generator tests; client widget tests | Nest e2e, failover, settlement, golden v3 parity | ADR-005 scaffold | Medium |

**Jira PZD-38:** status `Analysis` (description still says analysis-only). Owner assignment for this workstream authorized Phase A implementation against Accepted ADR-T02 design. Do not mark Done / Accept ADR-T01.

**Draft architecture PR #12:** preserved on `docs/pzd-38-core-protocol-security-contract` @ `170d157` — not mixed into this runtime branch.

## Environment

| Prerequisite | Result |
| --- | --- |
| Node.js 26 | `v26.13.1` (nvm) |
| ADR-005 Nest smoke | NOT_RUN (no Nest app scaffolded yet) |
| PostgreSQL 18 (docker compose) | `postgres:18` healthy on `127.0.0.1:55432` for evidence run |
| Draft docs PR #12 | Preserved |

## Module

- `src/tournament/ingress/*` — clock, types, memory journal, postgres journal (`trusted_received_at_ms` BIGINT), arbiter
- `test/tournament/ingress/*` — deadline, durability/fault, postgres
- `docker-compose.ingress-test.yml` — isolated PG18 for proofs

## Commands

```bash
nvm use 26
npm install
docker compose -f docker-compose.ingress-test.yml up -d
PZD_INGRESS_DATABASE_URL=postgresql://pzd:pzd@127.0.0.1:55432/pzd_ingress \
  npm run test:ingress
```

## Evidence run (executable)

Captured locally 2026-11-17 after epoch-ms PG journal fix:

```
▶ PZD-38 Gate A — deadline boundaries
  ✔ P38-03: deadline−1ms eligible; equality expired; +1ms expired
  ✔ thinking extension only when remaining idle in (0, 60s]
  ✔ predeadline admit + postdeadline adjudication still eligible
  ✔ deadline-equal ingress is rejected even if processing is immediate
  ✔ clientDeclaredAt is ignored for eligibility
▶ PZD-38 Gate A — durability and fault injection
  ✔ P38-05: fail closed when durable ingress unavailable — no fabricated accept
  ✔ crash before durable admission: no row, retry creates new admission
  ✔ crash after durable admission: retry returns same trustedReceivedAt
  ✔ same key different payload => IDEMPOTENCY_PAYLOAD_CONFLICT
  ✔ timeout worker blocked while eligible pending admission exists
  ✔ multi-instance competing admits: one seq order, stable idempotent winner
▶ PZD-38 Gate A — PostgreSQL durable journal
  ✔ admits predeadline H1, survives delayed commit past deadline
ℹ tests 12  pass 12  fail 0
```

Final re-run after consumer-crash cases:

```
ℹ tests 14  pass 14  fail 0  skipped 0
```

`npm run test:generator` without `PZD_GENERATOR_FIXTURES`: FAIL (assert requires fixtures; not silently skipped). Untouched by this branch; fixture path env not configured in this shell.

## Gate A checklist

| # | Oracle | Status |
| --- | --- | --- |
| 1 | Deadline −1ms | PASS |
| 2 | Deadline equality | PASS |
| 3 | Deadline +1ms | PASS |
| 4 | Predeadline + postdeadline lock delay | PASS (unit + PG) |
| 5 | Final H1 predeadline, commit after | PASS (unit + PG) |
| 6 | Multi-instance competing admits | PASS (shared journal; not multi-host NTP) |
| 7 | Duplicate admission / response loss | PASS |
| 8 | Crash before durable admission | PASS |
| 9 | Crash after durable admission | PASS |
| 10 | Consumer crash before DB commit | PASS (journal pending barrier + duplicate retry; Nest consumer NOT_RUN) |
| 11 | Consumer crash after commit before response | PASS (idempotent retry; Nest HTTP NOT_RUN) |
| 12 | Database failover | NOT_RUN |
| 13 | Clock skew / inconsistent ordering | PARTIAL (client clock ignored; multi-node NTP NOT_RUN) |
| 14 | Timeout worker vs queued valid move | PASS |
| 15 | Weekly snapshot + outstanding H1 | NOT_RUN (settlement module not built) |

## Explicit non-claims

- Does not mark ADR-T01 Accepted.
- Does not implement Nest HTTP / auth / series persistence (Phase B).
- Does not implement compensation (X-02 B deferred).
- Does not claim production readiness or full Gate A #12/#15.
- Does not weaken Q05/Q13 exclusive deadline semantics.

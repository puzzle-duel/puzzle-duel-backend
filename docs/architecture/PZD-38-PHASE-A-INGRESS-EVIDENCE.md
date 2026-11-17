# PZD-38 Phase A — Trusted ingress verification evidence

Branch: `feature/PZD-38-trusted-ingress`  
Base: `origin/main` @ `e3ca274` (ADR-T02 Accepted design squash-merge from PR #12)  
Design: ADR-T02 Accepted — Design only; ADR-T01 remains Proposed.  
Draft PR: [#13](https://github.com/puzzle-duel/puzzle-duel-backend/pull/13)

## Repository integrity

| Item | Value |
| --- | --- |
| Implementation baseline | Merged onto current `origin/main` (not Draft PR #12 branch) |
| Accepted ADR files | Present from `main` (`docs/adr/ADR-T02-…`, contract, freeze, gate review) |
| Runtime scope | Admission journal + series fence + arbiter only |
| Nest / HTTP / auth | NOT implemented (Phase B) |
| Reviewed HEAD before remediation | `4473a39a39def068701b2a0c8f633b2dfcc38dd2` |
| Remediation tip | `79142766684f795733df60ab354cf11dcb3da1d3` |

## What Phase A proves vs does not prove

**Proves (with PG where noted):** trusted server receipt ms, durable admit, exclusive deadline, idempotent admit, advisory-locked seq, expire/weekly barriers, board CAS / writer fence at fence-store layer, X-01 fail-closed on ingress unavailable, H1 COMPLETED vs FORFEITED ordering at fence layer, **one-shot thinking extension**, **hard-cutoff-capped extension**, **atomic forfeit vs pending admission**, **rejection of client score/completion authority**.

**Does not prove:** Nest multi-process consumers, real DB failover/replica promotion, authenticated sessions (Phase B), atomic Easy/Medium/Hard/All leaderboard rows (Phase C), OpenAPI, engine v3, NTP multi-host skew SLA, immutable weekly FINAL snapshot publish under one multi-series transaction (Phase C).

## Commands

```bash
nvm use 26   # engines.node >=26
npm install
docker compose -f docker-compose.ingress-test.yml up -d
PZD_INGRESS_DATABASE_URL=postgresql://pzd:pzd@127.0.0.1:55432/pzd_ingress \
  npm run test:ingress
```

`npm run typecheck` — **NOT_RUN** (Phase A branch has no `tsconfig.json`; Node `--experimental-strip-types` executes tests directly).

## Evidence run (post P1 remediation)

```
ℹ tests 46
ℹ pass 46
ℹ fail 0
ℹ skipped 0
```

Toolchain: Node with `--experimental-strip-types --test --test-concurrency=1`, disposable Postgres 18 on `127.0.0.1:55432`.

Generator golden parity (`npm run test:generator` GEN-07): **NOT_RUN** without `PZD_GENERATOR_FIXTURES` (pre-existing env gate; not a Phase A ingress regression).

## P1 remediation (review comment on `4473a39`)

### P1-01 — One thinking extension per series

| | |
| --- | --- |
| **Original failure** | `thinking_extension` always added +60s; no durable consumption bit; distinct idempotency keys could stack |
| **Root cause** | `SeriesFenceState` / DDL lacked `thinkingExtensionConsumed`; arbiter never checked one-shot TD-07 rule |
| **Changed source** | `types.mts`, `series-fence.mts` (DDL + column), `arbiter.mts` |
| **Before** | Repeated extensions with new keys succeeded |
| **After** | First successful extension sets `thinkingExtensionConsumed=true`; further keys → `EXTENSION_UNAVAILABLE`; same-key retry returns prior apply without re-extending; ineligible reject does **not** consume |
| **Tests** | `p1-remediation.test.mts` P1-01 (memory concurrent/restart + **PostgreSQL durable flag**) |
| **Remaining** | Authenticated who-may-request-extension is Phase B |

### P1-02 — Hard cutoff enforcement

| | |
| --- | --- |
| **Original failure** | Arbiter used raw `idleDeadlineAt + 60_000` without `applyThinkingExtension` / hard-cutoff cap |
| **Root cause** | Helper existed but was unused on the mutation path |
| **Changed source** | `arbiter.mts` (calls `applyThinkingExtension`); deadline unit tests expanded |
| **Before** | Extension could push idle past hard cutoff |
| **After** | Window (0, 60s]; capped at `hardCutoffAt`; hard equality/+1ms reject moves |
| **Tests** | remaining 60001/60000/1/0; hard 30s away; at/after cutoff; PG path uses same arbiter |
| **Remaining** | none for Phase A math |

### P1-03 — Atomic expiry / pending-admission barrier

| | |
| --- | --- |
| **Original failure** | `tryForfeitForInactivity` listed pending then separately `fence.mutate` → TOCTOU |
| **Root cause** | Barrier check and FORFEITED write not under shared series lock with admit |
| **Changed source** | `PostgresSeriesFenceStore.tryForfeitAtomically` (advisory lock → FOR UPDATE → pending count → forfeit); memory `withSeriesLock` path; admit and fence.mutate both take `seriesAdvisoryKeys` first |
| **Before** | Admit could commit between unlocked check and forfeit |
| **After** | Locked re-check sees pending → `BLOCKED_PENDING`; PG interleaving test with `beforeLockedBarrier` |
| **Tests** | PG TOCTOU, reversed order, simultaneous completion vs forfeit |
| **Remaining / blocked gate** | **Multi-series weekly FINAL snapshot publish in one atomic settlement TX is Phase C NOT_RUN.** Phase A proves pending watermark via `canSafelyFinalizeWeekly` (sorted keys + listEligiblePendingForSeries) only — not immutable period_snapshot rows. |

### P1-04 — Untrusted score / completion authority

| | |
| --- | --- |
| **Original failure** | Client `scoreDelta` / `completesSeries` flowed into fence score/COMPLETED and set `resultsPublished=true` |
| **Root cause** | Phase A used command fields as if trusted gameplay |
| **Changed source** | `AdmitCommandInput` deprecated fields rejected at `admitAndEvaluate`; `ServerMoveEffectResolver` test-only effects; COMPLETED keeps `resultsPublished=false`; journal inserts NULL/FALSE for legacy columns |
| **Before** | Forged score/completion could mutate fence and claim publish |
| **After** | Client fields → `UNTRUSTED_*`; trusted resolver may COMPLETE without publish; no resolver → `MOVE_EFFECT_UNAVAILABLE` |
| **Tests** | positive/negative/overflow scoreDelta; forged completesSeries; resolver COMPLETE without publish |
| **Remaining** | Real replay-derived scoring is Stage E / gameplay — not Phase A |

## Stage E synchronization plan (do **not** edit PR #17 here)

Stage E (`feature/PZD-39-core001v3-tournament-integration` / PR #17) imported Phase A at `4473a39`. After this remediation, these ingress files **differ** and need a controlled sync PR (separate review):

| File | Sync needed | Conflict notes |
| --- | --- | --- |
| `types.mts` | Yes | Add `thinkingExtensionConsumed`; keep Stage E deprecation of score fields; add `ServerMoveEffectResolver` types if missing |
| `series-fence.mts` | Yes | DDL column + `tryForfeitAtomically` + advisory lock on mutate; Stage E memory/PG fence must gain consumed flag |
| `arbiter.mts` | Yes — careful | Phase A now rejects client score and uses resolver; Stage E uses `TrustedGameplayService` instead of arbiter for ranked moves — sync forfeit/extension fixes without regressing Stage E UoW/auth |
| `journal.mts` / `postgres-journal.mts` | Yes | Strip score persistence; shared `seriesAdvisoryKeys`; Stage E also added `result_json` — **merge both** |
| `test/tournament/ingress/*` | Yes | Bring P1 remediation tests; adapt seeds for `thinkingExtensionConsumed` |
| Stage E `adjudication/*` | **Do not overwrite** | Keep PG UoW, auth gateway, immutable results, closed-schema commands |

**Behavioral conflicts to resolve in sync review:**

1. Stage E `TrustedGameplayService` already rejects client score — align extension consumption + hard-cutoff on its non-move path with Phase A.
2. Stage E fence puts must set `thinkingExtensionConsumed` (default false) or PG reads break.
3. Do not double-import or force-merge PR #13 into #17 without an explicit sync commit list.

## Test matrix (updated)

| Test | Source | Result |
| --- | --- | --- |
| Prior Gate A suite (deadline/durability/concurrency/PG) | existing | PASS |
| P1-01 extension one-shot + PG durable | p1-remediation.test.mts | PASS |
| P1-02 hard cutoff boundaries | p1-remediation + deadline-boundary | PASS |
| P1-03 PG TOCTOU / reverse / completion race | p1-remediation.test.mts | PASS |
| P1-04 forged score/completion | p1-remediation.test.mts | PASS |

## Gate matrix

| Gate | Result |
| --- | --- |
| A-01…A-08, A-12 | PASS (prior + preserved) |
| A-09 Active writer handoff | PASS at fence; **auth/session Phase B NOT_RUN** |
| A-10 H1 completion | PASS fence COMPLETED; **four-category publish Phase C NOT_RUN** |
| A-11 Weekly settlement barrier | PASS pending watermark; **immutable snapshot publish Phase C NOT_RUN** |

## Explicit non-claims

- No ADR-T01 Acceptance.
- No merge/deploy / Jira Done.
- No Phase B authorization start.
- No Phase C four-category publication.
- No claim that Stage E is auto-synced.

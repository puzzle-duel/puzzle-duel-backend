# PZD-39 Stage E — Trusted tournament replay integration

Status: **STAGE E SYNC — READY FOR INDEPENDENT RE-REVIEW** (engine+service layer; production ranked HTTP release remains BLOCKED)  
Date: 2026-11-17  
Jira: [PZD-39](https://puzzle-duel-app.atlassian.net/browse/PZD-39) (depends on [PZD-38](https://puzzle-duel-app.atlassian.net/browse/PZD-38))  
Branch: `feature/PZD-39-core001v3-tournament-integration`  
Draft PR: [#17](https://github.com/puzzle-duel/puzzle-duel-backend/pull/17)

## Source HEADs

| Pin | SHA |
| --- | --- |
| Stage E starting HEAD (pre-sync) | `41e9e79c2b98b551b1dfcbbca415ee80e1fa2607` |
| Stage E base (Stage D) | `7036f17f187742bf8551302801469673514650d9` |
| Stage C engine | `25efb2473f3517027769ee978b31ab6e3dc41030` |
| Phase A squash merge on `main` | `2ea3d9337978321458ca9f0649f27e31454f710d` |
| Phase A source HEAD | `733ee2e4d4aaa45058a2d9ce36d441890c17632e` |
| Client Stage B | `946f015a5124d1a9dfd6f3440cc916b9eb1789f8` |

ADR-E01 / ADR-T01 / ADR-T02 were **not** modified by this sync. Draft PR #17 remains Draft.

## Phase A controlled sync (this delivery)

Merged Phase A PR #13 (`2ea3d93` / source `733ee2e`) was synchronized into Stage E without wholesale ingress replacement.

### P1-01 … P1-05 synchronization results

| ID | Result | Stage E integration |
| --- | --- | --- |
| P1-01 one thinking extension | **SYNCED** | Durable `thinkingExtensionConsumed` on fence (DDL+ALTER+read/write); arbiter + `TrustedGameplayService.#nonMoveMutate` set flag on success; second distinct key → `EXTENSION_UNAVAILABLE`; same-key retry is duplicate without re-extend |
| P1-02 hard cutoff | **SYNCED** | Both arbiter and trusted gameplay use `applyThinkingExtension`; never exceed `hardCutoffAt` |
| P1-03 atomic forfeit vs pending | **SYNCED** | `PostgresSeriesFenceStore.tryForfeitAtomically` under same advisory+`FOR UPDATE` as admit; `BLOCKED_PENDING` when eligible pending exists |
| P1-04 untrusted score/completion | **PRESERVED** | Arbiter rejects client `scoreDelta`/`completesSeries`; Stage E closed schema + server digest + resolver path retained |
| P1-05 no premature forfeit | **SYNCED** | Trusted clock sampled under lock/TX; `−1ms` → `NOT_EXPIRED`; equality/+1ms may forfeit only with empty pending |

### File-level reconciliation

| File | Action | Notes |
| --- | --- | --- |
| `ingress/types.mts` | **Imported** | `thinkingExtensionConsumed`; `applyThinkingExtension`; `ServerMoveEffectResolver` |
| `ingress/series-fence.mts` | **Imported** | Shared `seriesAdvisoryKeys`; DDL+ALTER for consumed flag; `tryForfeitAtomically`; memory `withSeriesLock` |
| `ingress/arbiter.mts` | **Imported** | Extension consume + cutoff + clock-gated forfeit; untrusted score rejection |
| `ingress/postgres-journal.mts` | **Adapted** | Keep Stage E `result_json` / `markOutcomeWithResult` / `getResult`; import shared `seriesAdvisoryKeys`; add `countEligiblePendingOn`; legacy score columns always NULL/FALSE |
| `ingress/journal.mts` | **Excluded (intentional)** | Stage E memory journal retains immutable admission results |
| `adjudication/trusted-gameplay.mts` | **Adapted** | Extension path uses `applyThinkingExtension` + consumed flag; auth/UoW/closed-schema unchanged |
| `adjudication/postgres-uow.mts` | **Adapted** | Fence UPDATE/SELECT map `thinking_extension_consumed`; advisory keys from shared helper (deadlock-safe ordering) |
| `AuthorizationGateway` / closed schema / V3-48 / CORE-001.v3 replay | **Preserved** | No regression intended |
| Ingress P1 remediation tests + helpers | **Imported** | Wired into `npm run test:ingress` |
| `test/.../phase-a-sync.test.mts` | **Added** | TrustedGameplayService extension + cutoff proofs |

### Migration compatibility with `main`

- Phase A on `main` already ships `thinking_extension_consumed` (CREATE + `ADD COLUMN IF NOT EXISTS`).
- Stage E migrate uses the same additive ALTER; existing DBs without the column get `DEFAULT FALSE`.
- Stage E keeps `result_json` (absent from Phase A journal DDL). Future main←Stage E merge must retain `result_json` ALTER/DDL; no conflicting column types.
- Shared `seriesAdvisoryKeys` eliminates duplicate hash helpers that could diverge and deadlock across admit / UoW / forfeit.

### PostgreSQL transaction proof (unchanged Stage E + sync)

- Admission: separate durable write under series advisory lock (ADR-T02).
- Adjudication UoW: advisory → admission `FOR UPDATE` → challenge → fence `FOR UPDATE` → replay → ledger → snapshot → fence UPDATE (incl. `thinking_extension_consumed`) → outcome+`result_json`.
- Forfeit: same advisory key pair → fence `FOR UPDATE` → clock under TX → pending count on same connection → `FORFEITED` only if expired and pending=0.
- Fault injection at eight in-TX points: full rollback; admission stays pending; no partial score.

## Trust boundary (post-remediation + sync)

```text
RankedCommandHints (non-authoritative lookup aids)
  → AuthorizationGateway.authorize → TrustedAuthorizationContext
       (FailClosedAuthorizationGateway when HTTP/session contracts unavailable)
  → validateUntrustedClientCommand (closed schema; rejects seriesKey/playerId/payloadHash)
  → computeAuthoritativePayloadDigest(auth, command)  // server-only
  → AdmissionJournal.admit (ADR-T02 separate durable admission)
  → PostgresTrustedUnitOfWork / memory series-lock adjudication
       lock → challenge → replay → ledger → snapshot → fence → outcome+immutable result
  → return frozen admission result (duplicates never re-resolve active ordinal)
```

## Quality matrix (executed on synchronized Stage E worktree)

| Gate | PASS | FAIL | SKIP | NOT_RUN |
| --- | ---: | ---: | ---: | ---: |
| PZD-38 Phase A ingress memory+PG (`test:ingress`) | **51** | 0 | 0 | |
| Stage E adjudication (`test:stage-e`) | **44** | 0 | 0 | |
| — incl. Phase A sync (TrustedGameplayService) | 3 | 0 | 0 | |
| — incl. PG atomic UoW + faults + race + restart | 11 | 0 | 0 | |
| — incl. PG V3-48 service | 3 | 0 | 0 | |
| Stage C engine (`test:core001v3`) | **75** | 0 | 0 | |
| Stage D 33-fixture parity | **33** | 0 | 0 | |
| Stage D checksum integrity | **33** | 0 | 0 | |
| Stage D comparator mutations | **9** forced fail | 0 | 0 | |
| Historical v1/v2 + gen-001.v1 TS vectors | **6** | 0 | 0 | |
| Generator GEN-07 Python/Dart fixture parity | | | | **NOT_RUN** (`PZD_GENERATOR_FIXTURES` unset; assert fails closed — not claimed PASS) |
| Authentication HTTP boundary | | | | **NOT_RUN** |
| Tournament HTTP E2E | | | | **NOT_RUN** |
| Four-category leaderboard publish | | | | **NOT_RUN** |
| Production release | | | | **NOT_RUN** |

Commands actually run (exit 0 unless noted):

```bash
npx tsc --noEmit -p tsconfig.json
PZD_INGRESS_DATABASE_URL=postgresql://pzd:pzd@127.0.0.1:55432/pzd_ingress npm run test:ingress   # 51 PASS
PZD_INGRESS_DATABASE_URL=... npm run test:stage-e   # 44 PASS
npm run test:core001v3                              # 75 PASS
npm run test:stage-d-parity                         # pass 33 fail 0
npm run test:stage-d-checksums                      # verified 33; fail 0
python3 tools/stage_d/parity/test_comparator_mutations.py  # mutations=9 all_forced_fail=true
node --experimental-strip-types --test test/engine/core001v3/historical_regression.test.mts  # 6 PASS
```

Disposable Postgres 18 via `docker-compose.ingress-test.yml`.

### Independent sync review (pre-push)

| Check | Result |
| --- | --- |
| Reintroduced untrusted score | No — client score still rejected / ignored |
| Missing auth on non-move | No — gateway still required |
| Repeatable thinking extension | No — consumed flag durable |
| Premature forfeiture | No — NOT_EXPIRED under lock |
| Extension past hard cutoff | No — applyThinkingExtension cap |
| Advisory-lock deadlocks | Shared `seriesAdvisoryKeys`; same (k1,k2) for admit/UoW/forfeit |
| Partial PG TX | UoW fault suite still PASS |
| Ledger/snapshot disagreement | UoW one-TX preserved |
| Missing fence field | INSERT/UPDATE/SELECT/map include `thinking_extension_consumed` |
| Migration on existing DB | ADD COLUMN IF NOT EXISTS |
| Stage E tests compile | typecheck exit 0; 44 Stage E PASS |

**New P0/P1 findings from this sync:** none.

## Stage F / production blockers

1. Accepted HTTP/OpenAPI + Nest session wiring (replace fail-closed / test gateway)
2. Four-category publish + On-Time badge
3. Blueprint v1.1 / AGENTS.md tournament MVP reconciliation
4. Production migration pack + owner pin of v3 manifests
5. Do not claim full V3-48 ranked HTTP authorization PASS until ownership is on the real request path

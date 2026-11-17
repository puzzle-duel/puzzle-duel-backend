# PZD-39 Stage E — Trusted tournament replay integration

Status: **STAGE E — READY FOR INDEPENDENT RE-REVIEW** (engine+service layer; production ranked HTTP release remains BLOCKED)  
Date: 2026-11-17  
Jira: [PZD-39](https://puzzle-duel-app.atlassian.net/browse/PZD-39) (depends on [PZD-38](https://puzzle-duel-app.atlassian.net/browse/PZD-38))  
Branch: `feature/PZD-39-core001v3-tournament-integration`  
Draft PR: [#17](https://github.com/puzzle-duel/puzzle-duel-backend/pull/17)

## Source HEADs

| Pin | SHA |
| --- | --- |
| Stage E remediation tip | *(see git HEAD after remediation commit)* |
| Stage E base (Stage D) | `7036f17f187742bf8551302801469673514650d9` |
| Stage C engine | `25efb2473f3517027769ee978b31ab6e3dc41030` |
| PZD-38 Phase A import provenance | `4473a39a39def068701b2a0c8f633b2dfcc38dd2` (copied; not merge-ancestor) |
| Client Stage B | `946f015a5124d1a9dfd6f3440cc916b9eb1789f8` |

**PR #13 was not merged.** Phase A files were copied into this stacked branch with an explicit import manifest (`docs/architecture/PZD-39-STAGE-E-PHASE-A-IMPORT-MANIFEST.md`).

ADR-E01 and ADR-T02 were **not** modified by this remediation.

## Trust boundary (post-remediation)

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

Client-reported hashes are diagnostics only. Matching a self-consistent forged hash never grants ranked success.

### Public vs internal commands

| Layer | Fields |
| --- | --- |
| Untrusted client | commandType, idempotencyKey, move.{offerIndex,tap,expectedBoardRevision,writerGeneration,clientReportedStateHash?} |
| Forbidden on client | seriesKey, playerId, payloadHash, scoreDelta, score, completesSeries, terminalReason, board, offers, checkpoint, initialState, status, turnsUsed, stateHash (as authority) |
| Server-derived | identity from TrustedAuthorizationContext; payload digest; scoreDelta; score; terminalReason; stateHash; ledger watermark; checkpoint snapshot; resultsPublished(=false until publish gate) |

## Remediation findings (review at `0bf1e98`)

| ID | Sev | Root cause | Patch | Evidence |
| --- | --- | --- | --- | --- |
| P0-E01 | P0 | `fence.mutate` committed before ledger/snapshot/outcome; catch marked rejected while fence advanced | `PostgresTrustedUnitOfWork.adjudicateAcceptedMove` — one TX; faults roll back; admission stays pending | `postgres-atomic-gameplay.test.mts` — 11 PASS (8 fault points + race + restart + happy path) |
| P0-E02 | P0 | Untrusted `seriesKey`/`playerId` authorized mutations | `AuthorizationGateway` + fail-closed default; identity only from verified context | `authorization.test.mts` — 8 PASS; cross-player/series/stale-writer/handoff negatives |
| P1-E03 | P1 | Open schema + client `payloadHash` | Closed TOP_LEVEL/MOVE keys; server `computeAuthoritativePayloadDigest` with recursive canonical JSON | `command-schema.test.mts` — 7 PASS |
| P1-E04 | P1 | Duplicate replay used current active ordinal snapshot | Immutable `result_json` / `markOutcomeWithResult`; retries return frozen envelope | `duplicate-result.test.mts` — 4 PASS (before/after advance, completion, concurrent) |
| P1-E05 | P1 | V3-48 only via memory helper | PG service-boundary checkpoint rejects + auth | PG V3-48 suite — 3 PASS; memory+auth — 8 PASS |

## PostgreSQL transaction proof

- Admission remains a separate durable write (ADR-T02).
- Adjudication TX covers: advisory series lock → admission FOR UPDATE → challenge → fence FOR UPDATE → replay/`applyMove` → ledger INSERT → snapshot UPSERT → fence UPDATE → outcome+`result_json`.
- Injected faults at `before_ledger`, `after_ledger`, `before_snapshot`, `after_snapshot`, `before_fence`, `after_fence`, `before_outcome`, `before_commit`: all roll back; fence score/revision unchanged; retry after clearing fault applies once.
- Crash after COMMIT before response: state durable; new process duplicate returns frozen result.
- Concurrent moves on separate pool connections: exactly one apply, one ledger row.

## Authorization proof

- Default gateway: `FailClosedAuthorizationGateway` → `AUTH_CONTRACT_UNAVAILABLE` (no invented HTTP auth).
- Test gateway: `MemoryVerifiedAuthorizationGateway` — explicitly **not** HTTP authentication; pre-registered verified contexts only.
- Negatives: cross-player, cross-series, stale writer, unauthorized handoff.
- All mutating command types require authorize: start/move/advance/thinking_extension/device_handoff/abandon.
- **Remaining limitation:** authenticated Nest/HTTP session wiring is **NOT_RUN** (no accepted session/token contract). Ranked production exposure stays fail-closed.

## V3-48 evidence label

Labeled **PostgreSQL service integration** (authorized service boundary), not HTTP E2E. Full V3-48 ranked authorization PASS is **not** claimed until HTTP ownership boundary exists.

## Quality matrix (executed this worktree after remediation)

| Gate | PASS | FAIL | SKIP | NOT_RUN |
| --- | ---: | ---: | ---: | ---: |
| Stage C engine tests (`test:core001v3`) | 75 | 0 | 0 | |
| Stage D checksum integrity | 33 | 0 | 0 | |
| Stage D comparator mutations | 9 forced | 0 | 0 | |
| Stage D 33-fixture parity | 33 | 0 | 0 | |
| PZD-38 Phase A memory+PG ingress (`test:ingress`) | 25 | 0 | 0 | |
| Stage E service+auth+schema+dup (`test:stage-e` excl. PG subset counted below) | 41 | 0 | 0 | |
| PostgreSQL atomic gameplay TX + fault injection | 11 | 0 | 0 | |
| PostgreSQL V3-48 service integration | 3 | 0 | 0 | |
| Authentication HTTP boundary | | | | **NOT_RUN** |
| Tournament HTTP E2E | | | | **NOT_RUN** |
| Four-category leaderboard publish | | | | **NOT_RUN** |
| Production release | | | | **NOT_RUN** |

Commands actually run (exit 0 unless noted):

```bash
npm run typecheck
npm run test:core001v3          # 75 PASS
npm run test:stage-e            # 41 PASS (incl. PG when PZD_INGRESS_DATABASE_URL set)
PZD_INGRESS_DATABASE_URL=... npm run test:ingress   # 25 PASS
npm run test:stage-d-checksums  # verified 33; fail 0
python3 tools/stage_d/parity/test_comparator_mutations.py  # mutations=9 all_forced_fail=true
npm run test:stage-d-parity     # pass 33 fail 0
```

Disposable Postgres 18 via `docker-compose.ingress-test.yml` (`PZD_INGRESS_DATABASE_URL=postgresql://pzd:pzd@127.0.0.1:55432/pzd_ingress`).

## Stage F / production blockers

1. Accepted HTTP/OpenAPI + Nest session wiring (replace fail-closed / test gateway)
2. Four-category publish + On-Time badge
3. Blueprint v1.1 / AGENTS.md tournament MVP reconciliation
4. Production migration pack + owner pin of v3 manifests
5. Do not claim full V3-48 ranked HTTP authorization PASS until ownership is on the real request path

# PZD-39 Stage E — Trusted tournament replay integration

Status: **STAGE E — READY FOR INDEPENDENT REVIEW** (engine+service layer; production ranked release remains BLOCKED)  
Date: 2026-11-17  
Jira: [PZD-39](https://puzzle-duel-app.atlassian.net/browse/PZD-39) (depends on [PZD-38](https://puzzle-duel-app.atlassian.net/browse/PZD-38))  
Branch: `feature/PZD-39-core001v3-tournament-integration`

## Source HEADs

| Pin | SHA |
| --- | --- |
| Stage E base (Stage D) | `7036f17f187742bf8551302801469673514650d9` |
| Stage C engine | `25efb2473f3517027769ee978b31ab6e3dc41030` |
| PZD-38 Phase A import provenance | `4473a39a39def068701b2a0c8f633b2dfcc38dd2` |
| Client Stage B | `946f015a5124d1a9dfd6f3440cc916b9eb1789f8` |

**PR #13 was not merged.** Phase A files were copied into this stacked branch with an explicit import manifest (`docs/architecture/PZD-39-STAGE-E-PHASE-A-IMPORT-MANIFEST.md`).

## Trust boundary

```text
UntrustedClientCommand
  → validateUntrustedClientCommand (rejects score/completion/checkpoint fields)
  → AdmissionJournal.admit (trusted receipt + seq; no client score persisted)
  → Series fence (deadline, writer, boardRevision)
  → TrustedChallengeStore (server-owned initialState)
  → replayCore001V3(history) + applyMove(candidate)
  → AcceptedMoveLedger + AuthoritativeSnapshot (server-written)
  → return server score / stateHash / terminal
```

Client-reported `stateHash` is diagnostics only. Matching a self-consistent forged hash never grants ranked success.

### Public vs internal commands

| Layer | Fields |
| --- | --- |
| Untrusted client | seriesKey, playerId, commandType, idempotencyKey, payloadHash, move.{offerIndex,tap,expectedBoardRevision,writerGeneration,clientReportedStateHash?} |
| Forbidden on client | scoreDelta, score, completesSeries, terminalReason, board, offers, checkpoint, initialState, status, turnsUsed, stateHash (as authority) |
| Server-derived | scoreDelta, score, terminalReason, stateHash, ledger watermark, checkpoint snapshot, resultsPublished(=false until publish gate) |

## Trusted challenge binding

`bindTrustedChallenge` runs `parseInitialGameState` and stores digest + immutable state keyed by series/player/ordinal. Ranked replay never accepts client `initialState`.

## Replay-derived scoring

`TrustedGameplayService` reconstructs state from challenge + accepted ledger via Stage C `replayCore001V3`, then `applyMove`. Fence score increments only by engine `scoreDelta`.

## V3-48 checkpoint security

`rejectCheckpointOverwrite` / `checkpoint_overwrite` commands always reject. Trusted snapshot, ledger, board revision and score remain unchanged. Executable tests: `test/tournament/adjudication/v3-48-checkpoint.test.mts` — **6 PASS**.

## Transaction notes

Memory path: fence CAS → ledger append → snapshot put → markOutcome (best-effort; crash between steps covered by admission pending + revision CAS).  
PostgreSQL Phase A journal/fence concurrency re-executed — **5 PASS** on disposable Postgres 18 (`PZD_INGRESS_DATABASE_URL`).  
Single-TX unit-of-work for ledger+fence+outcome remains a Stage F hardening item if production durability requires stricter atomicity than current Phase A two-step markOutcome.

## Natural terminal / advance

Engine terminals `move_limit_reached` / `no_legal_moves` set fence `AWAIT_ADVANCE`. Advance requires verified ended snapshot. Completing ordinal ≥6 may mark `COMPLETED` with `resultsPublished=false` (four-category publish **NOT_RUN**).

## Quality matrix (executed this worktree)

| Gate | PASS | FAIL | SKIP | NOT_RUN |
| --- | ---: | ---: | ---: | ---: |
| Stage C engine tests | 75 | 0 | 0 | |
| Stage D checksum integrity | 33 | 0 | 0 | |
| Stage D comparator mutations | 9 forced | 0 | 0 | |
| Stage D 33-fixture parity | 33 | 0 | 0 | |
| PZD-38 Phase A memory ingress | 20 | 0 | 0 | |
| PZD-38 Phase A PostgreSQL | 5 | 0 | 0 | |
| Trusted challenge binding | covered | 0 | 0 | |
| Ordered move ledger | covered | 0 | 0 | |
| Replay-derived scoring | covered | 0 | 0 | |
| V3-48 checkpoint overwrite | 6 | 0 | 0 | |
| PostgreSQL atomicity (ledger+fence one TX) | | | | partial (Phase A fence+journal) |
| Authentication HTTP boundary | | | | **NOT_RUN** |
| Tournament HTTP E2E | | | | **NOT_RUN** |
| Four-category leaderboard publish | | | | **NOT_RUN** |
| Production release | | | | **NOT_RUN** |

## P0/P1/P2

| ID | Sev | Finding | Status |
| --- | --- | --- | --- |
| E-1 | P0 | Client scoreDelta/completesSeries authority | **Fixed** in Stage E |
| E-2 | P1 | Auth/session binding for writerGeneration | NOT_RUN — consistency only |
| E-3 | P1 | Four-category atomic publish | NOT_RUN |
| E-4 | P2 | Fence mutate + markOutcome still two steps (Phase A) | Documented; Stage F TX UoW |
| E-5 | P2 | Production SQL migrations / rollback | Documented gap |

## Stage F prerequisites

1. Accepted HTTP/OpenAPI + Nest wiring without speculative routes  
2. Auth/session/device model for TD-05  
3. Single PostgreSQL transaction wrapping fence+ledger+snapshot+outcome  
4. Four-category publish + On-Time badge  
5. Blueprint v1.1 / AGENTS.md tournament MVP reconciliation  
6. Production migration pack + owner pin of v3 manifests  

## Commands

```bash
npm run typecheck
npm run test:core001v3
npm run test:stage-e
npm run test:ingress   # includes PG when PZD_INGRESS_DATABASE_URL reachable
python3 tools/stage_d/parity/verify_checksums.py
python3 tools/stage_d/parity/test_comparator_mutations.py
python3 tools/stage_d/parity/run_parity.py
```

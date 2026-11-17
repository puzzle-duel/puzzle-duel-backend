# PZD-41 Stage F2-B — Atomic six-game publication

Status: **IMPLEMENTED, NOT MERGED, NOT DEPLOYED**. Ranked HTTP stays disabled. PZD-41 is not Done.

PR: https://github.com/puzzle-duel/puzzle-duel-backend/pull/18
Jira: https://puzzle-duel-app.atlassian.net/browse/PZD-41
Accepted F2-A baseline: `eca1dae966708253f8985b0b7a9f387b184b3054`
F2-A security review was not reopened. No new evidence showed an F2-A regression: the structural view still forces `publication_authorized=false`, and eligibility without the server key stays `F2B_PROVENANCE_SEAL_UNVERIFIED`.

The full HEAD SHA of this delivery is the branch tip recorded in PR #18 after push. This file cannot name its own commit.

## Completion event

Accepted Q13 and ADR-T02 TD-12 publish the four category rows together when the verified terminal H1 move commits. Accepted Q07 and TD-06 describe Advance as the first verified continue **to the next ordinal**, which renews the idle deadline. There is no next ordinal after H1.

F2-B therefore publishes only for `event: 'h1_terminal_move'` after replay shows H1 `status === 'ended'`. `event: 'between_game_advance'` returns `COMPLETION_EVENT_BLOCKED` and writes nothing. A nonterminal H1 returns `H1_NOT_TERMINAL`.

## Ordinal-6 Advance

`applyAdvance` lives only inside `TrustedGameplayService.#handleAdvance`. Both the PostgreSQL unit of work and the memory fence path call it.

Authenticated HTTP (`tournament-http.mts`) reaches that method through `SessionAuthorizationGateway`. The gateway takes the ordinal from `resolveActiveSubgameOrdinal`, not from the client. `AWAIT_ADVANCE` with six ended snapshots is `SERIES_STATE_CORRUPT` before the handler runs. Ingress `SeriesCommandArbiter` is not on that HTTP path. Its advance branch sets `ACTIVE`, and it does not call `applyAdvance`.

The writer itself used to set `COMPLETED` with `results_published=false` when the authorized ordinal was 6. That transition is now rejected:

- writer generation must match the fence, or the result is `STALE_WRITER`
- `COMPLETED` or `FORFEITED` returns `SERIES_TERMINAL`
- ordinal 6 or above returns `NO_NEXT_ORDINAL`
- ordinals 1 through 5 still require `AWAIT_ADVANCE` and an ended snapshot, then move to `ACTIVE`

A rejected advance stores the frozen rejection and does not change the fence. A later verified terminal H1 move can still publish once.

Phase A `SeriesCommandArbiter` is not the HTTP handler. A trusted `completesSubgame` effect now sets `AWAIT_ADVANCE` and keeps `resultsPublished=false`. It does not insert completion, score, category, badge, or provenance rows. Series `COMPLETED` remains the F2-B terminal H1 publication.

## Transaction and lock

`PostgresTrustedUnitOfWork.adjudicateAcceptedMove` calls `publishOnOpenTransaction` on the same client when a terminal ordinal-6 move is accepted and a publisher is attached. The publisher does not `BEGIN` or `COMMIT` on that path. `published` and a verified `duplicate` set the fence to `COMPLETED` with `results_published=true` in that same transaction. Any `rejected` publication throws `F2B_PUBLICATION_REJECTED`, so the ledger, terminal snapshot, fence, admission outcome, and publication writes roll back together. The admission stays `pending` and the same command can be retried after the proof is corrected.

No attached publisher is the production-disabled setting. A terminal H1 then stays `AWAIT_ADVANCE` with `resultsPublished=false`. That commit is not a ranked completed series. Stage E keeps this default.

`publish()` is the standalone unit of work. It `BEGIN`s, locks, writes, and `COMMIT`s once.

Lock order, shared with ingress and the unit of work:

1. `lockSeriesForTransaction` → `pg_advisory_xact_lock` on the two int4 keys from SHA-256 of the series id.
2. `series_fence_state` `FOR UPDATE`.
3. `tournament_series_writer` `FOR UPDATE`.
4. `tournament_daily_claim` `FOR UPDATE`.

The advisory lock is the deadlock boundary. Publication rows are inserted only after it.

Write order inside the transaction: one completion, six subgame scores, four categories, one badge, one provenance row, then fence and claim `COMPLETED`. Any fault in `F2B_FAULT_POINTS` throws before commit. PostgreSQL rolls the transaction back, so no category row is visible to another connection.

## Scores

For each ordinal 1..6 the service replays the accepted move ledger with the pinned initial state. The published score is that ordinal's replayed score. It is the sum of that ordinal's `score_delta` values and must equal `GameState.score`.

`authoritative_game_snapshot.score` and `accepted_move_ledger.score_after` remain the cumulative series score. Publication rejects the row when the snapshot score disagrees with the running cumulative ledger (`LEDGER_SNAPSHOT_SCORE_MISMATCH`) or when the fence score disagrees with the sum of the six individual scores (`FENCE_SCORE_MISMATCH`). The six published scores are not copies of the series aggregate. Journal `score_delta` and `completes_series` are ignored.

A finished game whose replayed score is 0 is valid. Five games, a missing ordinal, or a duplicate terminal ledger row do not publish.

## Authorization

Only `F2BPublicationService`, running inside the series transaction after replay, inserts `tournament_f2b_trusted_provenance`. The row stores HMAC-SHA256 over canonical JSON of the replay proof. The key is a server secret of at least 32 characters passed to the constructor. It is not an environment default, a request field, or a `verified:true` flag.

`evaluateLeaderboardReadEligibility(db, seriesId)` without the key stays unauthorized. With `{ provenanceKey }`, `authorizePublishedSeries` reloads the claim, fence, six scores, four categories, badge, and provenance, replays the six games, and compares the seal with `timingSafeEqual`. A missing row, a forged seal, a score that does not match replay, or a fence that is not `COMPLETED` with `results_published=true` returns `F2B_PROVENANCE_SEAL_UNVERIFIED` or `TRUSTED_PROVENANCE_REQUIRED`.

Caller fields `verified`, `provenance`, `provenanceSeal`, `authorized`, `score`, `scores`, `completesSeries`, `completed`, `onTimeAwarded`, `clientTimestamp`, and `terminal` throw `CLIENT_AUTHORITY_FORBIDDEN` before a transaction starts. `rejectInMemoryProvenanceAttestation` still throws `IN_MEMORY_PROVENANCE_FORBIDDEN`.

`BEFORE UPDATE OR DELETE` triggers raise `F2B_PUBLICATION_IMMUTABLE` on the five publication tables. A hand-inserted structural row whose seal was not produced from the persisted replay does not authorize.

The idempotency key is `f2-publish:<lowercase series uuid>`. The caller's command key is stored once as `source_command_idempotency_key` and is not the unique key. Same-key and different-key retries after commit return `duplicate` with revision 1, the original scores, badge, and seal. A stale writer generation before any row returns `STALE_WRITER`. After commit, a different generation still receives the original duplicate and writes nothing. A forfeited series returns `FORFEITED_SERIES`.

## Local verification

Node 26.13.1. PostgreSQL 18 at `127.0.0.1:55432`, database `pzd_ingress`. No skipped tests were counted as pass.

| Suite | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run test:stage-f2` | 58 pass, 0 fail, 0 skip |
| `npm run test:stage-f1` | 10 pass, 0 fail, 0 skip |
| `npm run test:stage-f1-auth` | 49 pass, 0 fail, 0 skip |
| `npm run test:stage-f1-http` | 2 pass, 0 fail, 0 skip |
| `npm run test:ingress` | 54 pass, 0 fail, 0 skip |
| `npm run test:stage-e` | 44 pass, 0 fail, 0 skip |
| `npm run test:core001v3` | 75 pass, 0 fail, 0 skip |
| `npm run test:generator` | 17 pass, 0 fail, 0 skip |
| `python3 tools/pr_quality_gate_test.py` | PASS |
| `python3 tools/pr_quality_gate.py` | PASS links, ADR vocabulary, secrets, fixtures 01-12 |

`pr_quality_gate.py` pull-request metadata is **NOT_RUN** locally because `GITHUB_EVENT_PATH` is unset. CI supplies it.

Stage F2 covers six valid games, five games, duplicate and missing ordinals, forged digest, forged state hash, ledger/snapshot mismatch, in-memory provenance, forged database provenance, two-connection publication, same-key and different-key retry, stale writer, every fault point, commit-uncertainty reconciliation, On-Time across UTC midnight, a zero-score series, a forfeited series, and no partial visibility after rollback.

## Unresolved

- U-F2A-01 production migration IDs and backup/restore: **NOT_RUN**
- U-F2A-02 a fence `results_published` flag alone must not gate reads; eligibility is the join plus seal
- U-F2A-04 weekly snapshot DDL is implemented for test environments in F2-C. Production migration IDs remain NOT_RUN
- U-F2A-05 TD-15 pagination and U-F2A-06 retention: still Proposed
- F2-C daily/weekly ranks and FINAL: implemented in `PZD-41-STAGE-F2-C-IMPLEMENTATION.md`
- Ranked HTTP: disabled
- Multi-host, NTP, and failover: **NOT_RUN**
- Merge, deploy, and PZD-41 Done: not authorized

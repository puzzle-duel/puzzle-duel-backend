# PZD-41 F2-C lock order and durability map

Status: implementation note. Not a production failover pass. Ranked HTTP stays disabled.

## Writers

| Path | Settlement lock | Series lock | Durable write | Closed-week guard |
| --- | --- | --- | --- | --- |
| `AtomicDailyClaimBootstrap.claimAndBootstrap` | before the database clock sample | no | claim, fence, ordinal-1 snapshot | trigger `trg_f2c_claim_period_closed` |
| `PostgresDailyClaimStore.claimForVerifiedPrincipal` | before the database clock sample | no | claim row | same trigger |
| `PostgresAdmissionJournal.admit` | before the series lock | yes | pending journal row and both receipt stamps | waits on the settlement lock, so it cannot commit during FINAL |
| `PostgresTrustedUnitOfWork.adjudicateAcceptedMove` | before the series lock | yes | ledger, snapshot, fence, outcome, optional F2-B publication | publication checks `tournament_f2c_settlement` and the completion trigger |
| `F2BPublicationService.publish` | before the series lock | yes | completion, scores, categories, badge, HMAC | `PERIOD_CLOSED` plus `trg_f2c_publication_period_closed` |
| `F2BPublicationService.publishOnOpenTransaction` | already held by the unit of work | already held | same publication rows | same checks |
| `PostgresSeriesFenceStore.tryForfeitAtomically` | no | yes | fence `FORFEITED` | does not insert a claim or a publication |
| `F2CRankingService.finalizeWeek` | first | then series ids ascending | one FINAL row and 32 board snapshots | refuses `pg_is_in_recovery()` or `transaction_read_only=on` |

Direct SQL inserts into `tournament_daily_claim` or `tournament_daily_series_completion` hit the same triggers. The trigger takes the settlement advisory lock `(1973609813, 1888871555)` and then reads the committed FINAL row. A preflight SELECT without that lock is not the guard.

## Order

1. Weekly settlement advisory lock.
2. Series advisory locks, ascending series id.
3. Row locks: `series_fence_state`, `tournament_series_writer`, `tournament_daily_claim`.

Publication and adjudication take step 1 before step 2. FINAL does the same. The trigger's settlement lock is re-entrant inside a transaction that already holds it, so those paths do not deadlock.

## What the journal scan proves

FINAL holds the settlement lock and every claimed series lock before it reads `command_admission_journal`. An admit or claim that has not committed is waiting on that settlement lock. A non-terminal row with no claim, a missing database stamp, or either stamp before Monday 01:00 UTC keeps the week provisional. `MAX(admission_seq)` is stored and is not the proof.

## Local verification

Node 26.13.1. PostgreSQL 18. No skipped tests counted as pass. typecheck PASS. Ingress 54/0/0. Stage E 44/0/0. F1 10/0/0. F1 auth 49/0/0. F1 HTTP 2/0/0. Stage F2 69/0/0. core001v3 75/0/0. Generator 17/0/0.

## Not proven here

An actual PostgreSQL replica promotion, a stale read replica, a primary restart, and a backward step of the PostgreSQL clock are NOT_RUN. Settlement refuses a session that reports recovery or read-only, which is necessary and not a failover drill. A clock step backward after FINAL can still create a new database receipt before Monday 01:00; the period trigger rejects claim and publication writes anyway, and FINAL is not rewritten.

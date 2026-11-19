# PZD-41 Stage F2-C — Daily/weekly rankings and immutable FINAL

Status: **IMPLEMENTED, NOT MERGED, NOT DEPLOYED**. Ranked HTTP stays disabled. PZD-41 is not Done. TD-15 page size 50 and maximum 100 remain Proposed and are not applied.

PR: https://github.com/puzzle-duel/puzzle-duel-backend/pull/18
Jira: https://puzzle-duel-app.atlassian.net/browse/PZD-41
F2-B baseline, including the closed P1-F2B-01 fix: `fe6d03d04c0f0095381d5b2900044fb1edc0b523`

The full HEAD SHA of this delivery is the branch tip recorded in PR #18 after push. This file cannot name its own commit.

## What a ranking row is

`F2CRankingService` loads candidate claims, then calls `evaluateLeaderboardReadEligibility` with the server HMAC key. That function replays the six games and checks the stored seal. A row is included only when the result is `authorized: true`.

These do not authorize a leaderboard row:

- `series_fence_state.results_published`
- a category row or a provenance hex string by itself
- a TypeScript object, client score, or client timestamp
- a partial series, a forfeited series, or a claim that is not `COMPLETED`

A completed series whose replayed total is 0 is included with score 0. A missing day contributes no row. It is not stored as a completed zero.

Competition rank is `1 + count(players with a strictly greater score)`. Equal scores share a rank and the next rank skips. Display order is score descending, then internal `player_id` ascending. That order does not change the rank. The response fields are `playerId`, `score`, `rank`, `displayPosition`, and `onTimeAwarded`. Emails, provider identifiers, sessions, tokens, and seals are not selected.

Daily categories are EASY, MEDIUM, HARD, and ALL, taken from the authorized F2-B body. Weekly score for one player and category is the safe-integer sum of that player's authorized daily scores in the UTC Monday–Sunday week. Overflow returns `WEEKLY_SCORE_OVERFLOW` and does not wrap. One player has at most one authorized series per original UTC date. The completion table's unique `(player_id, original_utc_date)` constraint is the duplicate-credit barrier.

The visible window is the current UTC week and the five previous weeks, the window stated with owner-approved R-01. ADR-T01 itself remains Proposed. A request outside that window returns `PERIOD_NOT_VISIBLE`. Snapshots older than the window are not deleted; retention beyond it remains Proposed.

## Provisional pages

A cursor is an opaque version-1 token. It binds:

- period identity
- `daily` or `weekly`
- category
- revision (`provisional.<sha256>` or `final.<settlement id>.<sha256>`)
- offset and the preceding player id and score
- the requested page size

The revision is a hash of the ordered authorized rows. If a later authorized publication changes a provisional board, the old cursor returns `SNAPSHOT_CHANGED`. The service does not skip or duplicate players to finish the page. There is no default page size. `F2C_PAGE_SIZE_LIMIT` (1000) only rejects an unbounded request. It is not the Proposed TD-15 maximum of 100.

## Monday FINAL

The wall clock reaching Monday 01:00 UTC does not by itself write FINAL. `finalizeWeek` does all of the following in one PostgreSQL transaction:

1. Take the weekly settlement advisory lock (`lockWeeklySettlement`).
2. Return the existing settlement if this week is already FINAL. It does not rewrite it.
3. Sample `clock_timestamp()`. If that time is still before Monday 01:00 UTC after the week, roll back with `CUTOFF_NOT_REACHED`.
4. Load every claim whose original UTC date is in the seven-day week.
5. Take `lockSeriesForTransaction` in ascending series-id order.
6. Fail closed with `UNCERTAIN_SERIES` when a fence is missing, claim and fence terminal status disagree, a non-terminal claim has publication rows, or a non-terminal fence has no hard cutoff.
7. Fail closed with `ELIGIBLE_SESSION_OPEN` when a non-terminal series still has `hard_cutoff_at_ms` after the sampled time.
8. Require `command_admission_journal` to exist. A missing relation is `WATERMARK_UNAVAILABLE`. There is no second, in-memory watermark.
9. Read `max(admission_seq)` for the locked series and any pre-cutoff row whose outcome is neither `applied` nor `rejected`. `pending` is `PENDING_ADMISSION`. Any other outcome is `UNKNOWN_OUTCOME`.
10. Authorize every `COMPLETED` claim with the F2-B HMAC on this same connection. A failure is `AUTHORIZATION_FAILED`. Forfeited and expired incomplete series are not included.
11. Insert one settlement row, 32 board headers, and the rank rows. A hook failure or a header count other than 32 rolls the transaction back.
12. Commit once.

After commit, `BEFORE UPDATE OR DELETE` triggers raise `F2C_FINAL_IMMUTABLE`. A later F2-B publication for that week does not change the snapshot read. A second `finalizeWeek` returns `alreadyFinal` and the same settlement id.

## Lock order and the pending-admission proof

Lock order is settlement advisory lock, then series advisory locks in series-id order, then the fence, writer, and claim row locks already used by ingress and F2-B.

F2-B publication takes only the series lock. It does not take the settlement lock, so FINAL (settlement, then series) cannot deadlock with an H1 publication (series only).

`AtomicDailyClaimBootstrap.claimAndBootstrap` takes the settlement lock before the player/date lock and before `clock_timestamp()`. A claim blocked behind FINAL cannot keep a timestamp sampled before the lock. After FINAL commits, the claim samples the database clock and `claimWindowClosed` rejects a previous-week date. That is the Monday 00:00 new-claim rule already enforced by the bootstrap. F2-C did not add a second clock.

A pre-cutoff H1 that is blocked on the series lock cannot commit its journal row until FINAL releases that lock. FINAL either sees the pending row that was committed before the lock, or it cannot acquire the lock and stays provisional (`LOCK_NOT_ACQUIRED`). The PostgreSQL test holds the series lock, observes `LOCK_NOT_ACQUIRED` and no settlement row, then commits the pending admission and observes `PENDING_ADMISSION`.

`SeriesCommandArbiter.canSafelyFinalizeWeekly` only lists pending rows for a caller-supplied key list. It does not lock, authorize publications, or commit FINAL. `finalizeWeek` does not call it.

## Security review correction

Independent review of `32672a3` found three P1 holes in the settlement barrier. This change fixes them:

- `PostgresAdmissionJournal.admit` now stores `db_trusted_received_at_ms` from PostgreSQL `clock_timestamp()` under the series lock. The process clock remains the idle-deadline stamp. A hard cutoff allows the move only when the stored process stamp, the stored database stamp, and the adjudication input all agree and are strictly before the cutoff. A missing database stamp fails closed.
- FINAL treats a non-terminal journal row as blocking when its database stamp is missing, or when either stamp is before Monday 01:00 UTC.
- A non-completed, non-forfeited series with an ended H1 snapshot stays `PUBLICATION_UNSETTLED`. `F2BPublicationService.publish` can still publish that series, including after the hard cutoff, so FINAL must not omit it.
- `PostgresDailyClaimStore.claimForVerifiedPrincipal` takes the weekly settlement lock before it samples `clock_timestamp()`.

A backward step of the PostgreSQL clock after FINAL commits is still unprovable. Multi-host clock and failover remain NOT_RUN. `MAX(admission_seq)` is still not a global watermark.

## What remains unproven

- No global monotonic watermark table exists beyond `command_admission_journal`. A dropped or renamed journal blocks FINAL. An in-memory counter is not used.
- Production versioned migration IDs are NOT_RUN. The DDL is applied by `F2CRankingService.migrate()` in test environments.
- Ranked HTTP is not enabled. No new public route was added.
- TD-15's 50 and 100 were not accepted.
- Multi-host clock, NTP, and failover are NOT_RUN.
- Compensation events were not started.
- This does not merge, deploy, or mark PZD-41 Done.

P1-F2B-01 is unchanged. A rejected `publishOnOpenTransaction` still throws, rolls back the H1 transaction, and leaves the admission pending. An absent publisher still does not create a ranked completed series.

## Local verification

Node 26.13.1. PostgreSQL 18 at `127.0.0.1:55432`, database `pzd_ingress`. `SHOW server_version_num` is asserted in the F2-C test. No skipped tests were counted as pass.

| Suite | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run test:stage-f2` | 69 pass, 0 fail, 0 skip |
| `npm run test:stage-f1` | 10 pass, 0 fail, 0 skip |
| `npm run test:stage-f1-auth` | 49 pass, 0 fail, 0 skip |
| `npm run test:stage-f1-http` | 2 pass, 0 fail, 0 skip |
| `npm run test:ingress` | 54 pass, 0 fail, 0 skip |
| `npm run test:stage-e` | 44 pass, 0 fail, 0 skip |
| `npm run test:core001v3` | 75 pass, 0 fail, 0 skip |
| `npm run test:generator` | 17 pass, 0 fail, 0 skip |
| `python3 tools/pr_quality_gate.py` | PASS links, ADR vocabulary, secrets, fixtures 01-12 |

`pr_quality_gate.py` pull-request metadata is **NOT_RUN** locally because `GITHUB_EVENT_PATH` is unset. CI supplies it.

`test:stage-f2` includes the F2-C file. That file passed 9 tests, 0 fail, 0 skip, covering daily categories, seven-day weekly sums, ranks 1/1/3, display order, a zero-score completion, missing, partial, and forfeited days, duplicate publication, a forged HMAC key, an uncommitted publication, Sunday/Monday separation, same-week backfill, Monday 00:00 claim closure, Monday 01:00 cutoff, a lock-blocked pending H1, a missing journal, an unknown outcome, failure injection on every snapshot label, rollback, immutable FINAL, a stale cursor, and metadata keys.

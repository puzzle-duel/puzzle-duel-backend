# PZD-41 F2-C independent FINAL settlement review

Status: **P1 defects fixed in this branch. Not merged. Not deployed. PZD-41 is not Done.**

Reviewed tree: `32672a322c2e771343db18769b77ed615113098e`
Jira checkpoint: PZD-41 comment 10392
The fix is in the same change as this report. Closed F2-B findings, including P1-F2B-01, were not reopened.

## Decision

FINAL at `32672a3` did **not** have a complete durable barrier. Three P1 defects were proven from the source. The fix keeps FINAL fail-closed unless the database clock stamp and the publication state account for every series that can still score.

`MAX(admission_seq)` is audit metadata. It does not prove that ingress is complete.

## Lock and visibility map

| Writer | First lock | Timestamp | Commit |
| --- | --- | --- | --- |
| `AtomicDailyClaimBootstrap.claimAndBootstrap` | weekly settlement, then player/date | `clock_timestamp()` after the settlement lock | claim, fence, ordinal-1 snapshot |
| `PostgresDailyClaimStore.claimForVerifiedPrincipal` | weekly settlement, after the fix | `clock_timestamp()` after the settlement lock | claim row only |
| `PostgresAdmissionJournal.admit` | series advisory | process clock and `clock_timestamp()` after the series lock | pending journal row |
| `PostgresTrustedUnitOfWork.adjudicateAcceptedMove` | same series advisory | uses the stored stamps for the hard cutoff | ledger, snapshot, fence, outcome; F2-B publication when attached |
| `F2BPublicationService.publish` | same series advisory | does not re-check the cutoff | publication rows |
| `F2CRankingService.finalizeWeek` | weekly settlement, then series ids ascending | `clock_timestamp()` | 32 board snapshots, or rollback |

Under READ COMMITTED, a row is visible to FINAL only after its writer commits. FINAL holds each series lock before it scans that series, so an admit or adjudication blocked on the lock cannot commit underneath the scan. The hole at `32672a3` was what that writer could stamp, or publish, after FINAL released the lock.

## Proven defects

| Severity | Location | Finding |
| --- | --- | --- |
| P1 | `postgres-journal.mts` admit, `postgres-uow.mts` hard cutoff | Admission eligibility was `new Date()` while FINAL decided Monday 01:00 from `clock_timestamp()`. An admit waiting on the series lock could commit after FINAL with a process stamp still before the cutoff, and adjudication would accept it. |
| P1 | `f2c-rankings.mts` `finalizeWeek`, `f2b-publication.mts` `publish` | An ended H1 with no publication row was omitted once its hard cutoff was past. `publish` still accepts that series, including when the cutoff is already past, so the score could appear after the snapshot was immutable. |
| P1 | `postgres-daily-claim.mts` `claimForVerifiedPrincipal` | This claim writer sampled the database clock and inserted a claim without the settlement lock. A claim that had sampled a time before Monday 00:00 could commit after FINAL had loaded its claim list and would not be locked. |

## Fix

- Every PostgreSQL admission stores `db_trusted_received_at_ms`. A hard cutoff rejects the move unless both stored stamps and the adjudication input are strictly before it.
- FINAL blocks on a non-terminal journal row when the database stamp is missing or when either stamp is before the cutoff.
- FINAL returns `PUBLICATION_UNSETTLED` while a non-terminal series has an ended H1 snapshot.
- The direct claim store takes the settlement lock before its clock sample.

## Still unprovable

A backward step of the PostgreSQL clock after FINAL commits can mint a new database stamp before Monday 01:00. This review does not treat NTP, multi-host failover, or a second database as proven. There is still no global ingress watermark beyond the journal rows of series that have a claim in the week. Production migration IDs, ranked HTTP, compensation events, merge, deploy, and PZD-41 Done remain unauthorized.

## Local verification of the fix

Node 26.13.1. PostgreSQL 18. No skipped tests counted as pass.

| Suite | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run test:ingress` | 54 pass, 0 fail, 0 skip |
| `npm run test:stage-e` | 44 pass, 0 fail, 0 skip |
| `npm run test:stage-f1` | 10 pass, 0 fail, 0 skip |
| `npm run test:stage-f1-auth` | 49 pass, 0 fail, 0 skip |
| `npm run test:stage-f1-http` | 2 pass, 0 fail, 0 skip |
| `npm run test:stage-f2` | 68 pass, 0 fail, 0 skip |
| `npm run test:core001v3` | 75 pass, 0 fail, 0 skip |
| `npm run test:generator` | 17 pass, 0 fail, 0 skip |

Exact-tip GitHub Actions for the fix commit are recorded after push.

## Tests added

PostgreSQL 18, two connections where the race is a lock wait:

- FINAL times out while another transaction holds the series lock, then sees the pending row that transaction commits, including a pending row whose process stamp is after the cutoff but whose database stamp is missing.
- An ended unpublished H1 keeps the week provisional.
- Adjudication rejects an H1 whose database receipt is at the cutoff even though the process stamp is one millisecond earlier.

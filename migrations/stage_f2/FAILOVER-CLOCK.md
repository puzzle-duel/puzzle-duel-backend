# PZD-41 failover and clock evidence

This is evidence from disposable containers. It is not a production failover acceptance.

## Executed locally

`npm run test:stage-f2-failover` started PostgreSQL 18 containers `pzd-f2-gate-primary` and `pzd-f2-gate-replica` on ports 55440 and 55441. The run that produced this note passed with `postgresql-clock=PASS`. Zero tests were skipped.

| Case | Result |
| --- | --- |
| Two connections and lock reacquisition after a primary restart | PASS. The advisory lock was held, the primary restarted, and a new connection acquired it within one second. |
| Primary restart during an uncommitted admission, publication, and FINAL insert | PASS. Those rows were absent after restart. |
| Committed pending journal and committed FINAL across restart | PASS. The journal stayed `pending`. The settlement id was unchanged. Restart did not insert another settlement. |
| Lost commit acknowledgement | PASS. A second `finalizeWeek` returned `alreadyFinal` and the same settlement id. |
| Primary commit while replica replay is paused | PASS. The witness table was invisible on the replica until `pg_wal_replay_resume`. `synchronous_commit` was `on`, which acknowledges the primary WAL and not the replica. |
| Write and settlement on a recovering replica | PASS. `finalizeWeek` returned `NOT_WRITABLE_PRIMARY` and the claim insert was rejected. |
| Stop the old primary, `pg_promote` the replica | PASS. The promoted database was not in recovery. The FINAL settlement id was unchanged. `DELETE` raised `F2C_FINAL_IMMUTABLE`. A claim for that week raised `F2C_PERIOD_CLOSED`. |
| Set the promoted container clock to `2019-01-01 00:00:00` | PASS inside that container. The closed-week claim still raised `F2C_PERIOD_CLOSED`, and the settlement id did not change. |

## Not this evidence

GitHub Actions job `stage-e-pg` has no Docker daemon. Its workflow prints `FAILOVER_TOPOLOGY NOT_RUN` instead of running the harness. A hosted-runner log is not this local PASS.

The container clock change is not an NTP step on a production host, a disk promotion of a cloud replica, or a stale read replica in another region. `synchronous_commit=on` does not mean the replica has the commit. The pause/resume case is the demonstration of that difference.

## Reproduce

Docker and the `postgres:18` image are required. The harness removes its containers and network at the end.

```bash
npm run test:stage-f2-failover
```

Without Docker, set `PZD_FAILOVER_ALLOW_NOT_RUN=1` only when the expected result is an explicit NOT_RUN. Do not treat that setting as a pass of the scenarios above.

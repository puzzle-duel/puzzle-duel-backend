# PZD-41 database privileges

The migration role owns the tables, the view, and the trigger functions. The other roles are `NOLOGIN`, `NOSUPERUSER`, `NOCREATEROLE`, `NOINHERIT`, and `NOBYPASSRLS`. An operator creates a passworded login outside this repository and grants one of these roles to it. This repository does not store a production password.

| Capability | Migration owner | App runtime | Settlement worker | Leaderboard reader | Audit |
| --- | --- | --- | --- | --- | --- |
| Claim insert and status update | owner | yes | no | no | no |
| Journal insert, outcome, and result update | owner | yes | no | no | no |
| Journal receipt or identity update | blocked by trigger | blocked by trigger | no | no | no |
| Publication insert | owner | yes | no | no | no |
| Publication update or delete | owner, blocked by trigger unless the trigger is disabled | no | no | no | no |
| Provenance insert | owner | yes | no | no | no |
| FINAL insert | owner | no | yes | no | no |
| FINAL update or delete | owner, blocked by trigger unless the trigger is disabled | no | no | no | no |
| Leaderboard read | owner | no | yes | yes | yes |
| Migration history read | owner | no | no | no | yes |
| Migration history change | owner, blocked by trigger unless the trigger is disabled | no | no | no | no |

A provenance insert is not authorization. `evaluateLeaderboardReadEligibility` recomputes the HMAC with the server key. The structural view keeps `publication_authorized` false.

Trigger functions are `SECURITY INVOKER` with `search_path = pg_catalog`. The period-closure function reads `public.tournament_f2c_settlement` by schema, so a caller's `search_path` cannot point it at another table. The runtime roles are not members of the migration owner and cannot `SET ROLE` to it, replace a function, or disable a trigger.

A table owner or a superuser can `DISABLE TRIGGER` or set `session_replication_role`. The disposable test shows a superuser insert into a closed week succeeding only inside a transaction that disables the trigger, then rolling that transaction back. Ordinary triggers do not constrain a superuser or the table owner. That is the trust boundary.

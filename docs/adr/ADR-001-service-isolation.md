# ADR-001 — SportsDash host isolation

Status: **Proposed**. Host and deployment statements in this record are not Accepted. [PZD-12](https://puzzle-duel-app.atlassian.net/browse/PZD-12) is still To Do. This task did not inspect or change a host, a database, a proxy, or a credential.

The application stack is a separate question and is proposed in [ADR-005](ADR-005-application-stack.md). Choosing NestJS and PostgreSQL there does not decide where they run.

## 1. Context

Puzzle Duel and SportsDash must not share a trust boundary. A shared machine, if one is ever used, is still a separate service, database, credential, log stream, and deploy unit. The current text of this ADR was a short candidate. PZD-14 can evaluate the application technology without the host survey. It cannot finish isolation.

## 2. Decision question

What isolation is required if Puzzle Duel is later placed near SportsDash, and which parts of that question are blocked until PZD-12 reports evidence?

## 3. Evaluated alternatives

| Alternative | Result |
| --- | --- |
| Separate service, database, role, port, backups, logs, and release path, even on a shared machine | Still the isolation candidate. Not Accepted. |
| Share SportsDash tables or database role | Rejected. |
| Decide CPU, RAM, disk, and proxy routes in PZD-14 | Rejected. No inventory was taken. |
| Treat ADR-005's PostgreSQL recommendation as proof the current host can run it | Rejected. |

## 4. Evidence

PZD-12's Jira description asks for a read-only inventory of CPU, memory, services, ingress, database backups, ports, secrets, network rules, and the deploy process. That inventory does not exist in this repository. No SSH session, panel, or metric API was used for PZD-14.

[ADR-005](ADR-005-application-stack.md) records NestJS and PostgreSQL versions from vendor documentation. Those are product-stack facts, not host facts.

## 5. Constraints

- Do not reuse SportsDash application tables or secrets.
- Do not bind Puzzle Duel to a SportsDash port or deploy pipeline by assumption.
- Do not copy credentials into this repository.
- Ranked data stays in the Puzzle Duel database. SportsDash is not a leaderboard source.
- Application code, when it exists, must still run if the host decision is "new machine" rather than "shared machine".

## 6. Advantages and disadvantages

A hard boundary limits blast radius and makes backups restorable without SportsDash data. The disadvantage is extra operational surface: another database, another credential, another backup job. Whether the current host has room for that surface is exactly what PZD-12 must measure.

Sharing tables would be cheaper and would mix trust zones. That is rejected even if the survey later shows spare capacity.

## 7. Security implications

Separate database roles mean a Puzzle Duel credential cannot read SportsDash tables, and the reverse. Separate logs reduce the chance that provider tokens from one product land in the other product's sink. Secrets stay in the host's secret store, not in Git.

None of those controls were configured here. Naming them is not evidence they exist.

## 8. Testing and CI implications

No deploy workflow is added. Future isolation tests, after PZD-12 and an accepted deploy design, are: a migration rollback drill, a backup restore into an empty Puzzle Duel database, and a check that the application credential fails when pointed at a SportsDash schema. They are **NOT_RUN**.

The fixture workflow on pull requests does not prove isolation.

## 9. Performance considerations

No CPU, memory, connection, or disk figure is available. Any number would be an invention. Capacity is an output of PZD-12, not of this ADR.

## 10. Maintenance and cost implications

Two services cost more to patch than one shared database. The cost is accepted as the isolation requirement from [AGENTS.md](../../AGENTS.md). The amount is **NOT_MEASURED**. A shared host does not remove the need for a separate backup of Puzzle Duel.

## 11. Migration and rollback

There is no Puzzle Duel production database to migrate. Rollback of a future first deploy must be a documented service stop plus database restore from a Puzzle Duel backup, without restoring over SportsDash. The procedure cannot be written honestly until PZD-12 identifies the backup tool. This ADR does not invent that procedure.

## 12. Outstanding unknowns

All of the following depend on PZD-12:

- Whether a shared host exists and what it runs.
- Free CPU, memory, and disk.
- Existing PostgreSQL major, if any, and whether Puzzle Duel gets a new instance.
- Reverse-proxy routes and free ports.
- Backup tool, retention, and a tested restore.
- Secret storage and network policy.
- Who is allowed to deploy.

Also still open, and not a host question: early board-end tray representation, and transport error names.

## 13. Recommendation

Keep isolation as a Proposed requirement: separate service, database, credentials, logs, backups, and release path. Do not mark it Accepted. Do not choose a machine. Use [ADR-005](ADR-005-application-stack.md) for the application stack, which can be reviewed without this survey.

## 14. Owner-approval requirements

The owner must not be asked to Accept this ADR until a PZD-12 survey is in the repository and a deploy design cites it. The owner may Accept ADR-005 first. That acceptance still does not deploy anything and does not Accept this record.

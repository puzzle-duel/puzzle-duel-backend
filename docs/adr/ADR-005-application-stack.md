# ADR-005 — Application stack

Status: **Proposed**. Owner approval is required before this status becomes Accepted. This record selects an application stack only. It does not decide a host, create a database, or accept [ADR-001](ADR-001-service-isolation.md).

Jira: [PZD-14](https://puzzle-duel-app.atlassian.net/browse/PZD-14). Evidence: [PZD-14-EVIDENCE.md](../architecture/PZD-14-EVIDENCE.md). Parity: [PZD-14-GAMEPLAY-PARITY.md](../architecture/PZD-14-GAMEPLAY-PARITY.md).

## 1. Context

The backend must verify ranked attempts by replaying moves. A client score is not authoritative. The service needs modules, validation, transactions, and tests. Where that process runs, and how it is isolated from SportsDash, is [ADR-001](ADR-001-service-isolation.md) and depends on [PZD-12](https://puzzle-duel-app.atlassian.net/browse/PZD-12). PZD-12 has not been done. No host was inspected for this record.

## 2. Decision question

Which language, HTTP framework, and database should the Puzzle Duel application use, independent of the machine it is later deployed on?

## 3. Evaluated alternatives

| Alternative | Result |
| --- | --- |
| Node.js 26 Active LTS, TypeScript, NestJS 12, PostgreSQL 18 | Recommended application stack. |
| A smaller TypeScript HTTP framework alone, such as Fastify, Hono, or Express without Nest | Rejected as the primary structure. |
| Local Node 20, or any Node 20 CI image | Rejected. Node 20 Iron is EOL as of the Node.js release table, last updated 2026-03-24. Nest's FAQ still lists 20.19+ as a runtime floor. That floor is not a production or CI target. |
| SQLite as the ranked store | Rejected. Concurrent official attempts want a server database with explicit transactions. |
| PostgreSQL 14 | Rejected. Its listed final release date is 2026-11-12. |
| PostgreSQL 19 | Rejected. It was a release candidate on the versioning page, not a supported final major. |

Nest's own docs, from v12.3, recommend the `node:http` adapter and say it is not the default yet. The HTTP adapter is an implementation choice inside this stack. It is not a reason to pick a different framework. No adapter was benchmarked.

## 4. Evidence

Details and links are in [PZD-14-EVIDENCE.md](../architecture/PZD-14-EVIDENCE.md).

- Node.js 26 is Active LTS. 26.13.1 is dated 2026-11-10. Node 24 and 22 are Maintenance LTS. Node 20 is EOL. Source: [Node.js releases](https://nodejs.org/en/about/previous-releases).
- `@nestjs/core` 12.5.0 was the registry latest. `engines.node` is `>=20`. The [version FAQ](https://docs.nestjs.com/faq/versions) says applications run on Node 20.19+, or 22.12+ on the 22 line. CLI generators need 22.22.3+, 24.15+, or 26+. Node 26 meets the generator line. Node 20 does not, and it is EOL.
- The Nest 12 migration guide says `nest upgrade` moves TypeScript to v6. This review did not generate a project, so no TypeScript, Nest, or RxJS patch is locked.
- NestJS 12 on Node 26 with that TypeScript line has not had the smoke test in the evidence log. The result is **NOT_RUN**.
- PostgreSQL 18.7 is the newest stable minor on the versioning page, supported until 2030-11-14. 17, 16, and 15 are also marked supported. 14's final release date is already past this review date.
- Local `node --version` printed v20.20.2. That binary was not used as a target. `nest new` was not run.

## 5. Constraints

- The replay function does not import Nest, the database, or the network. Nest calls it.
- Replay uses the attempt's stored `rulesVersion`. `core-001.v1` and `core-001.v2` are not interchangeable. See the parity document.
- A submitted score is ignored as authority. The stored score is the replay score.
- Identity and ranked-attempt protocol stay in [ADR-002](ADR-002-identity-and-linking.md) and [ADR-003](ADR-003-ranked-replay.md). This record does not expand them.
- No endpoint, schema, migration, or credential is added here.
- Production and CI use Node 26. They do not use the local Node 20 binary.
- Package versions are locked in the scaffold commit that the owner authorizes. This record does not pin a patch that was not installed.
- Host capacity, ports, proxy routes, and backup locations are not claimed. Those wait for PZD-12.

Proposed module split:

```mermaid
flowchart TD
  http["Nest HTTP adapter"]
  attempts["Attempt module"]
  replay["Pure TypeScript replay"]
  db["PostgreSQL via repository"]
  http --> attempts
  attempts --> replay
  attempts --> db
```

`replay` does not point at `db` or `http`.

## 6. Advantages and disadvantages

Nest provides modules, dependency injection, pipes for validation, guards for authentication interfaces, and a testing module. That matches a service with a hard boundary between HTTP and replay. The cost is framework weight, RxJS as a peer, and ESM rules that raise the Node floor.

A smaller HTTP library is less to learn and can be faster to boot. This review did not measure that. The cost of the smaller library is hand-built wiring for the same boundaries, transactions, and tests. For a ranked replay service those boundaries matter more than an unmeasured hello-world latency.

PostgreSQL gives transactions for the one-official-attempt rule. The disadvantage is operational cost, which PZD-12 must size. SQLite avoids a server and loses a clear concurrent writer story for ranked claims.

## 7. Security implications

Validation rejects malformed bodies before replay. Replay rejects illegal boards and unknown rulesets. Database access uses parameters and transactions. Idempotency keys are stored with the attempt so a retry cannot create a second official attempt. Logs must not contain provider tokens or raw credentials.

Authentication providers are not implemented here. The HTTP edge may depend on an authentication interface later. ADR-002 remains the identity proposal.

No secret is introduced by this document.

## 8. Testing and CI implications

Future jobs, not created here:

- Unit tests of the pure replay module against `v1` and `v2` fixtures.
- Negative fixtures and double replay, as in the parity document.
- Integration tests with a disposable PostgreSQL: one official attempt, conflicting concurrent claims, idempotent retry.
- Contract tests that the HTTP layer cannot persist a client score that disagrees with replay.

Ubuntu runners are sufficient for those jobs. This PR does not add them. The existing workflow only runs the Python and Node reference checkers for fixture paths. Documentation pulls do not get a new docs linter in CI.

Before a Nest scaffold is treated as verified, the evidence-log smoke test must pass on Node 26: install, TypeScript compile, startup, and shutdown. The lockfile from that run is the version pin. The current result is **NOT_RUN**. A passing test on Node 20 would fail the gate.

## 9. Performance considerations

MVP boards are 5×5 to 7×7 with short move lists. Replay cost is small beside database transactions. No request-rate or query-time number was measured. Background workers are not required for replay. A later queue needs its own justification and is not part of this decision.

Connection pooling and statement timeouts belong to the deployment design after PZD-12. They are not tuned here.

## 10. Maintenance and cost implications

Node 26 Active LTS is the runtime target so the CLI generators and the application share one supported line. Node 20 is EOL and is excluded from production and CI. Nest and PostgreSQL majors are upgraded by later ADR or a reviewed bump, not by this document silently tracking latest. The exact Nest, TypeScript, and RxJS patches are locked when the authorized smoke test installs them.

Dollar cost of PostgreSQL and of GitHub minutes is **NOT_MEASURED**. PZD-12 must supply host capacity before anyone claims the service fits on existing hardware.

## 11. Migration and rollback

There is no production schema. Rollback of this proposal is owner rejection, with no data migration. When migrations exist later, each must have a down path or a documented expand/contract replacement. This ADR does not write those files.

Switching away from Nest later would keep the pure replay module and replace the HTTP shell. That is the reason the replay module must not import Nest.

## 12. Outstanding unknowns

- PZD-12: CPU, memory, disk, existing PostgreSQL, proxy, backups, and whether a new instance is required.
- HTTP adapter: Nest recommends `platform-node` from v12.3 and has not made it the default. Choose it at scaffold time unless a measured defect appears. No measurement exists.
- NestJS 12, Node 26, and TypeScript have not been installed together. The smoke test is **NOT_RUN**. The migration guide says TypeScript v6. The patch stays unknown until that test's lockfile exists.
- Transport field names, status enums, and error strings. PD-13 did not freeze them.
- Early board-full end with an empty piece stream. Engines fail closed until a product decision exists.

## 13. Recommendation

Use NestJS 12 and TypeScript on Node.js 26 Active LTS, with PostgreSQL 18 as the application database. Keep replay in a pure TypeScript module. Do not treat a smaller HTTP framework as the primary structure. Do not use Node 20. Do not treat the combination as executed until the Node 26 smoke test passes. Do not deploy, create a database, or claim SportsDash capacity.

## 14. Owner-approval requirements

The owner decides whether this Proposed record becomes Accepted. Acceptance allows a later task to scaffold Nest and migrations. It does not authorize deployment, a host change, or acceptance of ADR-001. PZD-12 remains required before any isolation or capacity claim is accepted.

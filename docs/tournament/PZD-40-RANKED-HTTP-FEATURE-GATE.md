# PZD-40 — Production-disabled ranked HTTP feature gate

Status: **implemented (candidate)** — required for conditional F1 merge per owner decision (Jira PZD-40 comment 10364).  
Live Apple/Google OIDC, Accepted OpenAPI, deploy, and Jira Done remain **BLOCKED**.

## Threat model

| Threat | Mitigation |
| --- | --- |
| Accidental production ranked exposure after F1 merge | Gate defaults DISABLED; `production` / `prod` / missing / unknown profiles cannot enable |
| Mis-set enable flag in prod | Enable requires exact string `true` **and** allowlisted profile (`test` \| `development`) |
| Client bypass via header/query/body | Gate reads only server bootstrap/env or injected server config; request fields ignored |
| Auth/session side effects while “disabled” | Gate runs **before** JWT verify, session open, claim, fence, writer, gameplay |
| Ambiguous config | Empty, `TRUE`, `1`, `yes`, unknown profiles → DISABLED |

## Configuration matrix

| `PZD_RUNTIME_PROFILE` (or `NODE_ENV` fallback) | `PZD_RANKED_HTTP_ENABLED` | Result |
| --- | --- | --- |
| _(missing/empty)_ | any | **DISABLED** |
| `production` / `prod` | `true` | **DISABLED** (hard deny) |
| `staging` / other | `true` | **DISABLED** |
| `test` / `development` | _(missing)_ / `false` / `1` / `TRUE` | **DISABLED** |
| `test` / `development` | `true` (exact) | **ENABLED** (test-only candidate) |

Source: `src/tournament/auth/ranked-feature-gate.mts`  
Wiring: `createTournamentHttpHandler`, `createInternalSessionHttpHandler` — first statement returns HTTP **503** + `cache-control: no-store` + `{ error: "RANKED_HTTP_DISABLED" }`.

## Production disabled evidence

- No Nest/production bootstrap in this repository enables the gate.
- Default handler construction without `rankedHttpGate` uses env; production profile cannot enable.
- Test harnesses that exercise authenticated HTTP inject `explicitTestRankedHttpGateConfig()` only.
- Disabled path tests prove **zero** calls to verifier/session/claim/writer/fence/gameplay factories.

## Residual NOT_RUN

Live provider credentials; owner-Accepted OpenAPI; Nest deploy wiring audit on a production host; PZD-41 publication.

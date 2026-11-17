# PZD-40 — Production-disabled ranked HTTP feature gate

Status: **implemented (candidate)** — required for conditional F1 merge per owner decision (Jira PZD-40 comment 10364).  
Live Apple/Google OIDC, Accepted OpenAPI, deploy, and Jira Done remain **BLOCKED**.

## Threat model

| Threat | Mitigation |
| --- | --- |
| Accidental production ranked exposure after F1 merge | Gate defaults DISABLED; `production` / `prod` / missing / unknown profiles cannot enable |
| **P0-FG01** `NODE_ENV=production` + `PZD_RUNTIME_PROFILE=development` + enable | **Non-overridable NODE_ENV hard deny** in resolve + both HTTP entry points; profile/injected config cannot bypass |
| **P0-FG01** injected test `rankedHttpGate` under real production NODE_ENV | Handlers pass `actualEnv: process.env` (or harness `actualRuntimeEnv`); hard deny still applies |
| Mis-set enable flag in prod | Enable requires exact string `true` **and** allowlisted profile (`test` \| `development`) |
| Client bypass via header/query/body | Gate reads only server bootstrap/env or injected server config; request fields ignored |
| Auth/session side effects while “disabled” | Gate runs **before** JWT verify, session open, claim, fence, writer, gameplay |
| Ambiguous config | Empty, `TRUE`, `1`, `yes`, unknown profiles → DISABLED |

## Configuration matrix

| Actual `NODE_ENV` | `PZD_RUNTIME_PROFILE` | `PZD_RANKED_HTTP_ENABLED` | Result |
| --- | --- | --- | --- |
| `production` / `prod` | any (incl. `development`) | any (incl. `true`) | **DISABLED** (`node_env_production_hard_deny`) |
| _(non-prod)_ | _(missing/empty)_ | any | **DISABLED** |
| _(non-prod)_ | `production` / `prod` | `true` | **DISABLED** |
| _(non-prod)_ | `staging` / other | `true` | **DISABLED** |
| _(non-prod)_ | `test` / `development` | _(missing)_ / `false` / `1` / `TRUE` | **DISABLED** |
| _(non-prod)_ | `test` / `development` | `true` (exact) | **ENABLED** (test-only candidate) |

Source: `src/tournament/auth/ranked-feature-gate.mts`  
Wiring: `createTournamentHttpHandler`, `createInternalSessionHttpHandler` — first statement returns HTTP **503** + `cache-control: no-store` + `{ error: "RANKED_HTTP_DISABLED" }`.

## Production disabled evidence

- No Nest/production bootstrap in this repository enables the gate.
- **P0-FG01:** `isNodeEnvProductionHardDeny(actualEnv)` runs in `resolveRankedHttpFeatureGate` before profile/flag checks; both HTTP factories pass `actualEnv: deps.actualRuntimeEnv ?? process.env`.
- `rankedHttpGateConfigFromEnv` forces `runtimeProfile: 'production'` when `NODE_ENV` is production/prod so `PZD_RUNTIME_PROFILE=development` cannot soft-enable.
- Test harnesses that exercise authenticated HTTP inject `explicitTestRankedHttpGateConfig()` **and** non-production `actualRuntimeEnv`.
- Disabled path tests (including injected enable + `NODE_ENV=production`) prove **zero** calls to verifier/session/claim/writer/fence/gameplay factories.

## Residual NOT_RUN

Live provider credentials; owner-Accepted OpenAPI; Nest deploy wiring audit on a production host; PZD-41 publication.

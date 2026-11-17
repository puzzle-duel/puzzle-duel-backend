# Stage E — PZD-38 Phase A controlled import / sync

## Baselines

| Pin | SHA |
| --- | --- |
| Stage E starting HEAD | `41e9e79c2b98b551b1dfcbbca415ee80e1fa2607` |
| Phase A squash on `main` (PR #13) | `2ea3d9337978321458ca9f0649f27e31454f710d` |
| Phase A source HEAD | `733ee2e4d4aaa45058a2d9ce36d441890c17632e` |
| Earlier Stage E copy provenance (pre-merge) | `4473a39a39def068701b2a0c8f633b2dfcc38dd2` |

**Not a git merge of `main` into Stage E.** Controlled file sync of P1-01…P1-05 into the stacked tournament branch while preserving Stage E auth/UoW/`result_json`.

## Sync actions (2026-11-17)

| Path | Action |
| --- | --- |
| `src/tournament/ingress/types.mts` | Imported from Phase A |
| `src/tournament/ingress/series-fence.mts` | Imported from Phase A |
| `src/tournament/ingress/arbiter.mts` | Imported from Phase A |
| `src/tournament/ingress/postgres-journal.mts` | Adapted (keep `result_json`; shared advisory keys; `countEligiblePendingOn`) |
| `src/tournament/ingress/journal.mts` | Excluded — Stage E immutable results retained |
| `src/tournament/adjudication/trusted-gameplay.mts` | Adapted extension path |
| `src/tournament/adjudication/postgres-uow.mts` | Adapted fence mapping + shared advisory keys |
| `test/tournament/ingress/*` (P1 + helpers) | Imported / refreshed from Phase A |
| `test/tournament/adjudication/phase-a-sync.test.mts` | Added |

## Intentionally not copied wholesale

- Phase A `package.json` / lockfile (would drop Stage D/E scripts) — only `test:ingress` script extended
- Ingress directory wholesale replace (would drop Stage E `result_json`)
- Client-trusted `scoreDelta` / `completesSeries` authority

## Stage E invariants preserved

- `AuthorizationGateway` + fail-closed auth
- Closed-schema client commands + server payload digest
- `PostgresTrustedUnitOfWork` one-TX ledger+snapshot+fence+outcome
- Immutable `result_json` / stable duplicate responses
- CORE-001.v3 server replay + V3-48 checkpoint overwrite rejection

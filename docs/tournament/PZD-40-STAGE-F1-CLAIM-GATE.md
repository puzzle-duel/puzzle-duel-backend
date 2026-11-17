# PZD-40 Stage F1 — Authenticated HTTP and immutable daily claim

Status: **PZD-40 F1 — READY FOR INDEPENDENT SECURITY RE-REVIEW**  
(Live Apple/Google provider credentials and Accepted OpenAPI freeze remain BLOCKED.)

Jira: https://puzzle-duel-app.atlassian.net/browse/PZD-40  
Draft PR: https://github.com/puzzle-duel/puzzle-duel-backend/pull/19  
Branch: `feature/PZD-40-stage-f1-verified-claim-foundation`  
Pre-remediation review HEAD: `d543568bd399cc5000c735132fdf6fa9ce156f72`

## Security remediation (review comment 6954904146)

| ID | Sev | Finding | Remediation |
| --- | --- | --- | --- |
| P0-F11 | P0 | Non-writer same-player session could seize writer via server-fetched generation | Fail-closed: only active writer session/device may hand off; require caller-observed `expectedWriterGeneration`; cross-device seize BLOCKED |
| P0-F12 | P0 | Writer row updated without fence/snapshot/admission atomicity | `AtomicDeviceHandoffUnitOfWork` — one TX under series advisory lock: admission → writer CAS → fence → snapshot → outcome |
| P1-F13 | P1 | `hard_cutoff_at_ms=NULL` | `computeSeriesHardCutoffMs` (R-01): same-day min(next-day 00:15, week Mon+7d 01:00); retrospective same-week uses week Mon+7d 01:00 only; fail closed if incalculable |
| P1-F14 | P1 | `resolveActiveOrdinal: async () => 1` | `resolveActiveSubgameOrdinal` from fence+ended snapshots; all 6 challenges pinned at claim; Advance materializes next snapshot in same TX |
| P1-F15 | P1 | Handoff before admission/outcome | HTTP no longer mutates writer pre-gameplay; same-key idempotent digest omits post-handoff auth writerGeneration; conflict on payload change |

## Local verification matrix (PostgreSQL 18)

| Gate | PASS | FAIL | SKIP |
| --- | ---: | ---: | ---: |
| `npm run typecheck` | exit 0 | 0 | 0 |
| `test:stage-f1-auth` (incl. P0/P1 remediation) | **26** | 0 | 0 |
| `test:stage-f1` | **10** | 0 | 0 |
| `test:stage-f1-http` | **2** | 0 | 0 |
| `test:ingress` | **51** | 0 | 0 |
| `test:stage-e` | **44** | 0 | 0 |
| `test:core001v3` | **75** | 0 | 0 |

SKIP never counted as PASS. Prior ~201 passing suite preserved (+ new remediation cases).

## Remaining BLOCKED / NOT_RUN

- Live Apple/Google OIDC credentials, JWKS fetch, PKCE
- Owner-accepted OpenAPI freeze (`docs/contracts/tournament/openapi-f1-candidate.yaml` remains candidate)
- Cross-device recovery beyond current-writer handoff (product policy)
- Nest production hosting / deploy
- PZD-41 four-category publication

## Gate

Do not merge/deploy or mark PZD-40 Done. ADR-T01 remains Proposed. ADR-T02 unchanged. **PZD-40 blocks PZD-41**.

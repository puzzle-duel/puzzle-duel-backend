# PZD-40 Stage F1 — Authenticated HTTP and immutable daily claim

Status: **PZD-40 F1 — READY FOR INDEPENDENT FEATURE-GATE REVIEW**  
(Owner Option A: candidate merge only behind production-disabled ranked HTTP gate. Live Apple/Google credentials, Accepted OpenAPI, deploy, and Jira Done remain BLOCKED.)

Jira: https://puzzle-duel-app.atlassian.net/browse/PZD-40  
Draft PR: https://github.com/puzzle-duel/puzzle-duel-backend/pull/19  
Branch: `feature/PZD-40-stage-f1-verified-claim-foundation`  
Feature gate: [PZD-40-RANKED-HTTP-FEATURE-GATE.md](./PZD-40-RANKED-HTTP-FEATURE-GATE.md)  
Prior remediation HEAD: `fb71c28950ea171969408859c96ea5bc383f40e7`  
Re-review: https://github.com/puzzle-duel/puzzle-duel-backend/pull/19#pullrequestreview-5943414691

## Security remediation (review comment 6954904146)

| ID | Sev | Finding | Remediation |
| --- | --- | --- | --- |
| P0-F11 | P0 | Non-writer same-player session could seize writer via server-fetched generation | Fail-closed: only active writer session/device may hand off; require caller-observed `expectedWriterGeneration`; cross-device seize BLOCKED |
| P0-F12 | P0 | Writer row updated without fence/snapshot/admission atomicity | `AtomicDeviceHandoffUnitOfWork` — one TX under series advisory lock: admission → writer CAS → fence → snapshot → outcome |
| P1-F13 | P1 | `hard_cutoff_at_ms=NULL` | `computeSeriesHardCutoffMs` (R-01): same-day min(next-day 00:15, week Mon+7d 01:00); retrospective same-week uses week Mon+7d 01:00 only; fail closed if incalculable |
| P1-F14 | P1 | `resolveActiveOrdinal: async () => 1` | `resolveActiveSubgameOrdinal` from fence+ended snapshots; all 6 challenges pinned at claim; Advance materializes next snapshot in same TX |
| P1-F15 | P1 | Handoff before admission/outcome | HTTP no longer mutates writer pre-gameplay; same-key idempotent digest omits post-handoff auth writerGeneration; conflict on payload change |

## Integrity re-review remediation (PR review 5943414691)

| ID | Sev | Finding | Remediation | Verified by tests |
| --- | --- | --- | --- | --- |
| P1-R01 | P1 | Snapshot UPDATE without `rowCount === 1` | Require exactly one `authoritative_game_snapshot` row; throw → ROLLBACK | missing / mismatched ordinal snapshot → `HANDOFF_UNAVAILABLE`, writer/fence/admission unchanged |
| P1-R02 | P1 | Admission outcome UPDATE without `rowCount === 1` | `#writeOutcome` requires exactly one pending→final row; reject non-pending without durable result | non-pending / deleted admission / same-key replay proofs |
| P1-R03 | P1 | Ordinal fail-open on missing fence / gaps | `OrdinalIntegrityError`; no ordinal-1 fallback; contiguous ended prefix + challenge consistency; gateway → `SERIES_STATE_CORRUPT` | missing fence, gap, challenge mismatch, E1…H1 + COMPLETED |

## Local verification matrix (PostgreSQL 18)

| Gate | PASS | FAIL | SKIP |
| --- | ---: | ---: | ---: |
| `npm run typecheck` | exit 0 | 0 | 0 |
| `test:stage-f1-auth` (incl. P0/P1 + P1-R01..R03) | **38** | 0 | 0 |
| `test:stage-f1` | **10** | 0 | 0 |
| `test:stage-f1-http` | **2** | 0 | 0 |
| `test:ingress` | **51** | 0 | 0 |
| `test:stage-e` | **44** | 0 | 0 |
| `test:core001v3` | **75** | 0 | 0 |

SKIP never counted as PASS. Prior 26 auth cases retained; +12 P1-R01..R03 integrity proofs.

## P0 ranked HTTP feature gate (owner comment 10364)

Server-side default-deny gate (`ranked-feature-gate.mts`) wraps `/v1/tournament/*` and `/internal/tournament/session` **before** JWT/session/claim/gameplay. Production cannot enable. See [PZD-40-RANKED-HTTP-FEATURE-GATE.md](./PZD-40-RANKED-HTTP-FEATURE-GATE.md).

## Remaining BLOCKED / NOT_RUN

- Live Apple/Google OIDC credentials, JWKS fetch, PKCE
- Owner-accepted OpenAPI freeze (`docs/contracts/tournament/openapi-f1-candidate.yaml` remains candidate)
- Cross-device recovery beyond current-writer handoff (product policy)
- Nest production hosting / deploy
- PZD-41 four-category publication

## Gate

Conditional candidate merge only with production-disabled ranked HTTP gate verified. **Do not deploy or mark PZD-40 Done.** ADR-T01 remains Proposed. ADR-T02 unchanged. **PZD-40 blocks PZD-41**.

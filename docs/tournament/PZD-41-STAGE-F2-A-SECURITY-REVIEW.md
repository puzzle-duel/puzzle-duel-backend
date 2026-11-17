# PZD-41 Stage F2-A — Security review report

Status: **READY FOR INDEPENDENT F2-A FINAL RE-REVIEW** (candidate).  
PR: https://github.com/puzzle-duel/puzzle-duel-backend/pull/18  
Jira: https://puzzle-duel-app.atlassian.net/browse/PZD-41

## Scope

F2-A schema / structural completeness / fail-closed leaderboard gate design only.  
**Not** F2-B publish UoW, **not** F2-C ranking HTTP, **not** production ranked enablement.

## Remediation vs comment 10373 / follow-up blockers

| Blocker | Resolution | Evidence |
| --- | --- | --- |
| Deprecated `evaluatePublicationReadiness` / `visible` ambiguity | **Removed** from exports | `src/tournament/results/f2a-publication-schema.mts`; test asserts export absent |
| TS branding as trusted F2-B auth | **Removed** brand mint path; DB-only gate | `tournament_f2b_trusted_provenance` + `evaluateLeaderboardReadEligibility(db, seriesId)` |
| Structural completeness granting visibility | Structural view forces `publication_authorized=false`; leaderboard gate fail-closed | `tournament_f2a_structural_readiness`; adversarial synthetic fixture test |

## Exact file references

| Path | Role |
| --- | --- |
| `src/tournament/results/f2a-publication-schema.mts` | Claim identity DDL, publication tables, provenance table, structural view, eligibility gate |
| `src/tournament/results/four-category-scores.mts` | Pure calculator (unchanged authority boundary) |
| `test/tournament/results/f2a-publication-schema.test.mts` | Adversarial PG18 matrix + auth separation + idempotent migrate |
| `docs/tournament/PZD-41-STAGE-F2-A-SCHEMA.md` | Contract + unresolved decisions |
| `migrations/stage_f2/README.md` | Rollback / upgrade notes |

## Trust boundary (binding)

1. `evaluateStructuralReadiness` ⇒ completeness only (`structurallyComplete`), never authorization.
2. `evaluateLeaderboardReadEligibility` ⇒ DB-only; no provenance JS parameter.
3. `rejectInMemoryProvenanceAttestation` ⇒ throws `IN_MEMORY_PROVENANCE_FORBIDDEN`.
4. Empty or forged `tournament_f2b_trusted_provenance` rows cannot yield `authorized:true` in F2-A (`TRUSTED_PROVENANCE_REQUIRED` / `F2B_PROVENANCE_SEAL_UNVERIFIED`).

## Test counts (local)

| Suite | Pass | Fail | Skip |
| --- | --- | --- | --- |
| typecheck | PASS | — | — |
| stage-f2 | 14 | 0 | 0 |
| stage-f1-auth | 49 | 0 | 0 |
| stage-f1 | 10 | 0 | 0 |
| stage-f1-http | 2 | 0 | 0 |
| ingress | 51 | 0 | 0 |
| stage-e | 44 | 0 | 0 |
| core001v3 | 75 | 0 | 0 |
| generator | 17 | 0 | 0 |
| **TOTAL** | **262** | **0** | **0** |

Original 20 adversarial claim/integrity cases preserved.

## Remaining blockers (Proposed / deferred)

- U-F2A-01 production versioned migration IDs
- U-F2A-03 H1 vs Advance COMPLETED timing (F2-B)
- F2-B seal algorithm + TX writer (not started)
- U-F2A-04 weekly shapes (F2-C)
- U-F2A-05 TD-15 pagination (Proposed in ADR-T02)
- U-F2A-06 retention

## Commit / CI

- Commit SHA: `93c4786ae91ff4f6917f78fd1223578d8df37d72`
- quality-gate: https://github.com/puzzle-duel/puzzle-duel-backend/actions/runs/44178442053
- stage-e-pg: https://github.com/puzzle-duel/puzzle-duel-backend/actions/runs/44178442031
- generator-parity: https://github.com/puzzle-duel/puzzle-duel-backend/actions/runs/44178442276

## Hard restrictions observed

Draft PR only; no merge/deploy; PZD-41 not Done; no F2-B implementation beyond table shape; PZD-40 untouched.

# PZD-40 Stage F1 — Authenticated HTTP and immutable daily claim

Status: **F1 CANDIDATE IMPLEMENTATION — READY FOR INDEPENDENT RE-REVIEW**  
(Live Apple/Google provider credentials and Accepted OpenAPI freeze remain BLOCKED.)

Jira: https://puzzle-duel-app.atlassian.net/browse/PZD-40  
Draft PR: https://github.com/puzzle-duel/puzzle-duel-backend/pull/19  
Stacked base: Stage E PR #17 (`feature/PZD-39-core001v3-tournament-integration`)  
Depends on: PZD-38 Phase A; PZD-39 Stage E; blocks PZD-41 Stage F2.

## Independent security review findings (remediated)

| ID | Sev | Finding | Fix |
| --- | --- | --- | --- |
| P0-F01 | P0 | Claim row not atomically bound to fence/challenge/snapshot | `AtomicDailyClaimBootstrap` one-TX claim+fence+challenge+snapshot+writer |
| P0-F02 | P0 | No session-backed AuthorizationGateway for ranked commands | `SessionAuthorizationGateway` (never Memory gateway on HTTP) |
| P0-F03 | P0 | No authenticated ranked HTTP surface | `createTournamentHttpHandler` candidate routes under `/v1/tournament/*` |
| P1-F04 | P1 | Single JWT kid (no rotation) | Multi-key pinned `keys[]` map by kid |
| P1-F05 | P1 | No series writer binding / handoff store | `PostgresSeriesWriterStore` + HTTP `device_handoff` |
| P1-F06 | P1 | Guest tokens not rejected | JWT rejects `guest` / `account_type=guest` / `amr` guest |
| P1-F07 | P1 | Monday early-return in claim test (SKIP-as-PASS risk) | Always asserts open-week Monday date + previous-week closed |
| P1-F08 | P1 | Client could supply playerId/manifest on claim | HTTP closed body; bootstrap uses session playerId + pinned registry only |
| P1-F09 | P1 | Missing rate/size limits on ranked routes | 16 KiB body cap + per-player rate window |
| P1-F10 | P1 | Embedded JWK/x5c not fully covered | Reject `jwk`/`jku`/`x5u`/`x5c`/`crit` |

## Delivered

### Authentication (test-issuer verified; live providers BLOCKED)
- Pinned RS256 JWT: iss/aud/exp/nbf/iat, alg confusion denied, unsigned denied, unknown kid denied, rotation via pinned keys, guest denied.
- Issuer+subject → immutable internal `player_id` (UUID), never email merge.
- Opaque session secret (SHA-256 digest at rest), expiry + revocation.
- No bearer/session secrets logged.

### Daily claim + Stage E bootstrap
- Unique `(player_id, original_utc_date)` with DB clock `started_at_ms`.
- R-01 window: same open UTC week backfill allowed; previous/future denied.
- Atomic TX: claim + fence + first challenge + snapshot + writer generation=1.
- Lost Start recovers original entitlement; FORFEITED remains spent.
- Manifest from server `PinnedManifestRegistry` only.

### HTTP candidate (OpenAPI-first, owner freeze pending)
See `docs/contracts/tournament/openapi-f1-candidate.yaml`:
- `POST/GET/DELETE /v1/tournament/session`
- `POST /v1/tournament/claims/daily`
- `GET /v1/tournament/series/{seriesId}` (no inactivity renew)
- `POST /v1/tournament/series/{seriesId}/commands`

Framework: Node `http` only (no NestJS dependency in this repo yet; ADR-005 scaffolding not authorized).

### Intentionally NOT claimed PASS
- Live Apple/Google OAuth/OIDC credentials, JWKS fetch, PKCE callbacks.
- Accepted production OpenAPI freeze.
- Four-category leaderboard publish (PZD-41).
- Nest production hosting / deploy.

## Local verification matrix (PostgreSQL 18 @ 127.0.0.1:55432)

| Gate | PASS | FAIL | SKIP |
| --- | ---: | ---: | ---: |
| `npm run typecheck` | exit 0 | 0 | 0 |
| `test:stage-f1-auth` | **19** | 0 | 0 |
| `test:stage-f1` (claim + atomic bootstrap) | **10** | 0 | 0 |
| `test:stage-f1-http` | **2** | 0 | 0 |
| `test:ingress` | **51** | 0 | 0 |
| `test:stage-e` | **44** | 0 | 0 |
| `test:core001v3` | **75** | 0 | 0 |

SKIP is never counted as PASS. Live Apple/Google provider integration remains **NOT_RUN**.

## Test commands

```bash
npm run typecheck
PZD_INGRESS_DATABASE_URL=postgresql://pzd:pzd@127.0.0.1:55432/pzd_ingress npm run test:stage-f1-auth
PZD_INGRESS_DATABASE_URL=... npm run test:stage-f1
PZD_INGRESS_DATABASE_URL=... npm run test:stage-f1-http
PZD_INGRESS_DATABASE_URL=... npm run test:ingress
PZD_INGRESS_DATABASE_URL=... npm run test:stage-e
npm run test:core001v3
```

## Gate

**PZD-40 F1 — READY FOR INDEPENDENT RE-REVIEW** for test-issuer authenticated HTTP + atomic claim foundation.

Do not merge/deploy or mark PZD-40 Done until independent re-review and live-provider configuration evidence exist. ADR-T01 remains Proposed. ADR-T02 unchanged. PZD-40 continues to block PZD-41.

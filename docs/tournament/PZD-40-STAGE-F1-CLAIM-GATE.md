# PZD-40 Stage F1 — Authenticated HTTP and immutable daily claim

Status: **CLAIM FOUNDATION IMPLEMENTED / HTTP AUTH BLOCKED** (Draft; no ranked request route).

Jira: https://puzzle-duel-app.atlassian.net/browse/PZD-40
Source baseline: Stage E PR #17 HEAD c5a01f7bf03e4c30fdd9375843e3906ae3273bba
Depends on: PZD-38 Phase A merged; PZD-39 Stage E source+PG CI; PZD-41 Stage F2.

## Delivered slice

- PostgreSQL 18 additive tournament_daily_claim table with immutable series UUID, player_id, original UTC DATE, database-clock started_at_ms, server-pinned manifest digest, unique(player_id, original_utc_date), terminal tombstones.
- One atomic INSERT ON CONFLICT DO NOTHING returning the original claim, never minting a second same-player same-date series.
- Same-open-UTC-week retroactive claims remain eligible; previous-week new claims and future dates denied. Existing claims from closed weeks are intentionally NOT reconstructed by claim start: later private authorized GET handles recovery.
- PostgreSQL DATE mapped to explicit YYYY-MM-DD via to_char, avoiding application timezone drift.
- **No claim is currently exposed to HTTP**. The function caller must already have verified internal player identity and immutable pinned six-game manifest. TypeScript typing is NOT security verification; do not use it as proof of trusted actor or manifest.
- Real PostgreSQL concurrency/restart tests: 12 concurrent starts, same-key duplicate recovery, FORFEITED tombstone, independent verified players, invalid/future/previous-week claims and zero side effects.

## Mandatory F1 remainder — NOT_RUN

1. Freeze real HTTP/OpenAPI request/response contract; proposed route names are not Accepted merely by being in docs.
2. Select and verify production identity provider integration and runtime framework per ADR-005, issuer/audience/JWKS/PKCE/nonce, token revocation and account-link proof; do not ship a fake gateway.
3. Create server-verified session/device writer binding and challenge manifest registry; ensure verified identity + manifest provenance in the same claim transaction. Neither arbitrary playerId nor manifestDigest may be taken from request JSON.
4. Tie entitlement row to Stage E trusted challenge binding, fence status, writer generation, authenticated daily start and read-reconciliation. Start/GET must be idempotent and private; GET does not reset inactivity.
5. Test legitimate previous-week in-flight resumption until accepted Monday hard cutoff without reopening a fresh claim. Migrate/read old status without title/DATE/clock ambiguity.
6. HTTP E2E: valid/expired/tampered/wrong-audience tokens, two users, two devices, replay same key, concurrent starts, writer handoff, outage recovery, private command lookup and canonical state.
7. Server-side request/body size limits, rate limits, audit redaction; multi-process race/crash, migration rollback, real provider configuration and production stack smoke.
8. F2 must not award On-Time until verified first E1 start/claim and all six replayed terminal snapshots are bound to this original immutable record.

**Owner binding:** ADR-T02 TD-01…TD-18 accepted technical rules, ADR-T01 Proposed. Guest ranked participation denied. Stage E's MemoryVerifiedAuthorizationGateway is for tests, NOT a real HTTP identity provider.

## Gate

The foundation PG tests may pass independently, but F1 cannot be called COMPLETE until real verified HTTP/session/device/claim E2E tests pass. No merge, deploy or Jira Done.

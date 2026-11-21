# PZD-49 — Backend-managed guest identity contract (staging candidate)

Status: proposed implementation contract; **not implemented, tested or deployed**. Firebase Auth is not used. Firebase Crashlytics is independent.

## Non-negotiable boundaries

- No login screen for first launch. Client creates a guest identity over **HTTPS only**.
- Server generates opaque, unguessable player identity and credentials; never trust client-supplied playerId or user role.
- Guest identity survives app restart and access-token expiry; persist credentials in platform secure storage, not shared preferences or analytics.
- Never log access tokens, refresh tokens, authorization headers, raw guest IDs or device secrets.
- Guest authentication is distinct from tournament **verified session and writer binding**. Token refresh must not rotate or steal a live writer session.
- Staging uses isolated `pzd_staging` database and a separate signing key. Never reuse UAT token issuers/keys or expose UAT token-issuance routes.
- No anonymous guest creation until rate limits, abuse controls and revocation are enforced. Production ranked HTTP remains disabled.

## Candidate HTTP contract

- `POST /v1/auth/guest`: create guest account, server-assigned UUID, short-lived signed RS256 access JWT, one-time opaque rotating refresh token. Require HTTPS, reject client-supplied player identity.
- `POST /v1/auth/refresh`: accept opaque refresh token; transactional single-use rotation with replay detection and token-family revocation. Reuse must not create a second player identity.
- `POST /v1/auth/logout`: revoke refresh family and current server-side authorization; does not delete scores.
- `POST /v1/tournament/session`: existing verified JWT verifier accepts **staging-specific issuer/audience/key** and resolves guest subject to stable player identity; do not replace tournament session secret on routine access token refresh.
- Apple/Google later: authenticated provider-linking transaction attaches provider to existing playerId; collision and account-recovery policy requires separate approval.

## Persistence / operational gates

- Versioned migrations for guest account, refresh family, hashed refresh-token digest, expiration, revocation and replay metadata. No DDL at runtime startup.
- Only hashes of refresh tokens at rest; rotate signing keys via `kid` with pinned public-key allowlist; server stores private keys outside repo and CI logs.
- Rate-limit guest creation per IP/device signal without collecting invasive fingerprints; bounded DB pool and request body; redact logs and correlate via request ID.
- Access token lifetime <= 15 minutes; refresh expiry and guest account recovery policy to be approved before production.
- Test guest creation, concurrent refresh (exactly one winner), replay revocation, expired/revoked credentials, process restart, two-player isolation, writer continuity, daily/weekly rankings, no retroactive daily points, and cross-device takeover denial.
- Prove backup/restore, negative authorization tests, migration readiness, TLS, smoke tests and rollback before enabling staging CD.

## Release gate

Keep `PZD_RANKED_HTTP_ENABLED=false`, staging CD disabled, PR unmerged until implementation and integration tests pass. No change to game mechanics, visuals or animation.

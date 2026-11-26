# PZD-26 — Direct Apple/Google provider authentication (staging contract)

Status: implementation contract on `feature/PZD-26-provider-recovery` (extends merged PZD-26 @ `be7a510`).  
Owner decisions: Jira PZD-26 comments 10597 / 10589; PZD-27 recovery review #10633. Firebase Auth is **not** used. Crashlytics remains independent.

## Product rules
- No compulsory login at first launch; Practice remains guest.
- Apple **or** Google verification is mandatory before official ranked tournament entry (staging included).
- Guest HTTP callers receive `RANKED_AUTH_REQUIRED` before claim/writer/gameplay mutation.
- Guest link preserves immutable `player_id`. Email is never an identity or merge key.
- Unknown provider subject on explicit **login** creates a new `player_id`.
- **Recovery never creates** a player, identity link, or session family for an unknown/mismatched subject.
- Shared `POST /v1/auth/refresh` for guest and verified families.

## HTTP surface
| Method | Path | Notes |
|---|---|---|
| POST | `/v1/auth/providers/challenge` | Body `{ provider, purpose }`. `purpose=login` returns `{ nonce, binding }`. `purpose=link` requires guest Bearer bound to exact `fid`; challenge binding is `link:{playerId}:{familyId}`. `purpose=continue` (unified UX) — see `PZD-26-UNIFIED-PROVIDER-CONTINUE.md`. |
| POST | `/v1/auth/providers/login` | Body `{ provider, idToken, nonce, binding }` → verified access/refresh with `fid`. Unknown subject creates a new player. |
| POST | `/v1/auth/providers/link` | Guest Bearer (`account_type=guest` + exact `fid`) + `{ provider, idToken, nonce }` → same `player_id`, new verified family; prior guest families revoked. |
| POST | `/v1/auth/providers/recover` | Body `{ provider, idToken, nonce, binding, expectedPlayerId }`. Reuses **login** challenge purpose/binding. Resolves existing provider identity; requires `player_id === expectedPlayerId` **before** issuing a family. `expectedPlayerId` is never ownership proof. Unknown subject → `RECOVERY_NOT_LINKED` (no create). Wrong linked player → `ACCOUNT_CONFLICT`. |
| POST | `/v1/auth/providers/continue` | Unified continue — see `PZD-26-UNIFIED-PROVIDER-CONTINUE.md`. |
| POST | `/v1/auth/providers/continue/confirm` | Single-use account-switch confirmation — see addendum. |
| POST | `/v1/auth/refresh` | Existing shared refresh (mints `account_type` from DB `account_class` and exact `fid`). |
| POST | `/v1/auth/logout` | Existing logout. |

Safe errors include `INVALID_PROVIDER_ASSERTION`, `INVALID_PROVIDER_CHALLENGE`, `ACCOUNT_CONFLICT`, `GUEST_PROOF_REQUIRED`, `RECOVERY_NOT_LINKED`, `RANKED_AUTH_REQUIRED`, `AUTH_UNAVAILABLE`, `PROVIDER_CONFIG_MISSING`.

Never log ID tokens, refresh/access tokens, raw nonces, Authorization headers, provider subjects, or email.

## Configuration (owner-supplied; never commit secrets)
- `PZD_STAGING_APPLE_AUDIENCES` — comma-separated Apple client IDs (bundle / Services ID).
- `PZD_STAGING_GOOGLE_AUDIENCES` — comma-separated Google OAuth client IDs (iOS/Android/Web as required).
- Existing guest signing key path/kid remain required for backend-minted JWTs.

## Access token family binding
Staging access JWTs include `fid` (exact refresh family). Authorization never accepts “any active family for this player”. Exact-family auth requires ownership, non-revoked family, JWT/`account_class` match, and a non-expired unused refresh tip. Revoked or rotated-away families fail closed even if another family for the same player is active.

Link, refresh, and logout share the same transaction advisory family lock so concurrent logout cannot commit after link validation and before link mutation.

## Migrations
- `0005_provider_challenges` — nonce challenge table + least-privilege grants.
- `0006_provider_identity` — `account_class`, `pzd_identity_links`, challenge immutability trigger.
- `0007_identity_immutability` — reject UPDATE/DELETE on identity links without granting UPDATE to runtime.
- `0008_provider_continue` — unified `purpose=continue` + `pzd_provider_continuations` (see `PZD-26-UNIFIED-PROVIDER-CONTINUE.md`).

Provider HTTP routes mount only when `0005`–`0007` readiness checks pass (including immutability triggers). Identity concurrency uses transaction advisory locks (no `SELECT FOR UPDATE` on identity links). Operator cleanup of expired challenges uses `cleanupExpiredProviderChallenges` (elevated DELETE); runtime role has none.

## Account deletion / Apple revocation
MVP must document and implement deletion + Apple token revocation flows before production enablement. Staging contract records the requirement; production activation remains owner-gated.

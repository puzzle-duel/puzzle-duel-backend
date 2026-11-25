# PZD-26 — Direct Apple/Google provider authentication (staging contract)

Status: implementation contract on `feature/PZD-26-provider-auth` (not production-enabled).  
Owner decisions: Jira PZD-26 comments 10597 / 10589. Firebase Auth is **not** used. Crashlytics remains independent.

## Product rules
- No compulsory login at first launch; Practice remains guest.
- Apple **or** Google verification is mandatory before official ranked tournament entry (staging included).
- Guest HTTP callers receive `RANKED_AUTH_REQUIRED` before claim/writer/gameplay mutation.
- Guest link preserves immutable `player_id`. Email is never an identity or merge key.
- Unknown provider subject on explicit login creates a new `player_id`.
- Shared `POST /v1/auth/refresh` for guest and verified families.

## HTTP surface
| Method | Path | Notes |
|---|---|---|
| POST | `/v1/auth/providers/challenge` | Body `{ provider, purpose }`. `purpose=login` returns `{ nonce, binding }`. `purpose=link` requires guest Bearer; returns `{ nonce }`. |
| POST | `/v1/auth/providers/login` | Body `{ provider, idToken, nonce, binding }` → verified access/refresh. |
| POST | `/v1/auth/providers/link` | Guest Bearer + `{ provider, idToken, nonce }` → same `player_id`, new verified family; prior guest families revoked. |
| POST | `/v1/auth/refresh` | Existing shared refresh (mints `account_type` from DB `account_class`). |
| POST | `/v1/auth/logout` | Existing logout. |

Safe errors include `INVALID_PROVIDER_ASSERTION`, `INVALID_PROVIDER_CHALLENGE`, `ACCOUNT_CONFLICT`, `GUEST_PROOF_REQUIRED`, `RANKED_AUTH_REQUIRED`, `AUTH_UNAVAILABLE`, `PROVIDER_CONFIG_MISSING`.

Never log ID tokens, refresh/access tokens, raw nonces, Authorization headers, provider subjects, or email.

## Configuration (owner-supplied; never commit secrets)
- `PZD_STAGING_APPLE_AUDIENCES` — comma-separated Apple client IDs (bundle / Services ID).
- `PZD_STAGING_GOOGLE_AUDIENCES` — comma-separated Google OAuth client IDs (iOS/Android/Web as required).
- Existing guest signing key path/kid remain required for backend-minted JWTs.

## Migrations
- `0005_provider_challenges` — nonce challenge table + least-privilege grants.
- `0006_provider_identity` — `account_class`, `pzd_identity_links`, challenge immutability trigger.

Operator cleanup of expired challenges requires elevated DELETE rights (runtime role has none).

## Account deletion / Apple revocation
MVP must document and implement deletion + Apple token revocation flows before production enablement. Staging contract records the requirement; production activation remains owner-gated.

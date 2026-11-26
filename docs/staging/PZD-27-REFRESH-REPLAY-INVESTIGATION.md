# PZD-27 — REFRESH_REPLAY investigation (staging)

**Status:** Investigation + regression evidence. No revoke-policy relaxation.  
**Scope:** Guest refresh rotation on staging Oracle / client vault.  
**Related:** Physical UAT `FAMILY_REVOKED` after `REFRESH_REPLAY` at `2026-11-22T19:09:06Z` for player `5d224f58-…`.

## Mechanism (current)

1. Refresh marks the presented token `used_at` and inserts a successor.
2. Presenting an already-used token without a valid **retryable rotation proof** sets `pzd_guest_families.revoked_at` and throws `REFRESH_REPLAY`.
3. Later refreshes against that family surface diagnostic `FAMILY_REVOKED` (HTTP body still `INVALID_REFRESH`).
4. Retryable mode: client persists a 32-hex `rotationId` **before** the HTTP call; same id within the retry window returns the deterministic successor without revocation.
5. Client `authenticate` single-flights concurrent callers on the same credential generation so two in-flight refreshes do not dual-post.

## Scenario matrix

| Scenario | Expected | Evidence |
| --- | --- | --- |
| Concurrent refresh (same client) | Single-flight; one HTTP refresh | Client test `concurrent authenticate single-flights without dual refresh` |
| Single-flight + generation bump (logout/link) | Stale future discarded | Existing guest auth generation guards |
| Rotation retry (same rotationId, cutover) | No revoke; same successor | `guest-refresh-retry.test.mts` cutover test |
| Wrong / expired rotationId on used token | `REFRESH_REPLAY` + family revoke | `wrong rotation ID replays and revokes` |
| Lost HTTP response **with** durable rotationId | Retry returns same successor | Retryable successor path |
| Lost HTTP response **without** rotation intent | Used-token retry → `REFRESH_REPLAY` | By design (legacy / flag off) |
| App kill during refresh (intent saved) | Restart reuses pending rotationId | Client `acquireVerifiedGuestRotationId` durability tests |
| Keychain write failure after 200 | `SECURE_STORE_*`; no silent mint | Persist verified read-back tests |
| Stale credential response | `STALE_CREDENTIAL_RESPONSE`; no compensating write | Generation checks in `_commitCredentials` |
| Logout/refresh race | Serialized vault mutation queue | `_serializedMutation` |
| Process restart mid-rotation | Intent survives; no new id | Pending intent cutover test |
| Real refresh-token replay attack | Family revoke | Same as wrong-id / used-token path |

## Oracle UAT correlation (read-only)

- Sole revoked staging family for the correlated device guest: revoke timestamp aligns with a `guest_auth` **401** (not logout 200) → **REFRESH_REPLAY** path.
- ~2.3h after last successful rotation; unused successor row existed → client likely presented the **previous** used token (lost persist or stale vault) without a successful retry proof.
- **Conclusion:** Normal happy-path refresh with rotation retry enabled does **not** revoke. Revocation requires used-token reuse without valid retry proof (bug/race on client persist, or intentional replay).

## Product / security decision

- **Do not** reactivate revoked families.
- **Do not** loosen `REFRESH_REPLAY` revoke semantics.
- Explicit guest recovery (client) offers confirmed **new guest** mint; old player/family/score rows remain on the server.
- Backend change for this investigation: **none required** beyond documenting + keeping existing retry regressions green. If a future fix is needed, prefer client vault durability / rotation intent — not server replay weakening.

## Tests to keep green

```bash
node --test test/staging/guest-refresh-retry.test.mts
node --test test/staging/guest-auth-http.test.mts
```

Client (puzzle-duel-client):

```bash
flutter test test/tournament/guest_session_recovery_test.dart
flutter test test/tournament/guest_refresh_durability_test.dart
```

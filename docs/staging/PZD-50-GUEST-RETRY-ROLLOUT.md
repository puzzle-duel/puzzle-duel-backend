# PZD-50 — staging guest rotation durability rollout (candidate)

**Status:** implementation under review; **OFF by default**, not an account recovery feature.

## Threat and continuity model
- A refresh token is one-time-use; an interrupted response may strand the client after the DB commits the rotation.
- Client persists a 128-bit `rotationId` in iOS Keychain **before** sending POST /v1/auth/refresh, and retains it across crashes until the successor token is written and verified by reading it back.
- In staging-only opt-in mode, the backend stores only the SHA-256 digest of this request ID next to the consumed refresh-token digest; it derives the successor as HMAC-SHA512(old refresh secret, domain || rotationId), truncated to 48 bytes.
- Repetition of the **same old secret and same rotationId** within **10 minutes**, while the successor remains unused and the family unrevoked, returns the same successor. Wrong rotation ID, elapsed window or already-consumed successor remains a replay and revokes the family. New JWT access expiry is calculated at retry time. API does not expose family state.
- A sender with only the previous token cannot guess the random rotationId. Request correlation IDs and rotation IDs are not authorization proofs for other APIs.
- Historic revoked families are not changed or reactivated. Daily/weekly manifests, scores, game mechanics and writer sessions untouched.
- **Important limitation:** interrupted transactions that are not resumed within 10 minutes still fail closed; they require separate **independent account ownership proof** and a future explicit guest recovery flow. Never promise that every future loss is impossible.

## Release sequence and gates
1. Verify backend and client PRs are fully green, including actual iOS staging build, two separate code reviews and all negative tests. Do NOT enable either flag solely because CI passes.
2. Run dedicated migration workflow **plan** for `0002_guest_refresh_retry` against `pzd_staging` only. Inspect plan and backup/role checks.
3. With operator approval, run migration workflow **apply** using `APPLY pzd_staging 0002_guest_refresh_retry`. Never migrate on app startup or from public push.
4. Read-only migration verification must PASS; confirm `pzd_guest_refresh.rotation_id_digest` column exists, with no guest record changes.
5. Enable server `PZD_STAGING_GUEST_RETRY_ENABLED=true` only for isolated staging service, restart and verify healthy. If unavailable, keep OFF; retry-enabled client fails 503 before changing credentials.
6. Build iPhone staging from the reviewed client commit with `--dart-define=PZD_GUEST_RETRY_ENABLED=true`; no uninstallation, no Keychain clear, no new guest account replacement.
7. Fresh sacrificial guest fixture (not historical owner account): test 02:59/03:02 UTC boundary, response loss AFTER server commit, app termination BEFORE Keychain update, simultaneous refresh, retry with identical ID, retry with different ID, delayed retry beyond grace, logout then retry, interrupted Keychain write, secure-store readback failure, old client interoperability. Verify immutable claim, score and badge parity across each.
8. After all tests, review evidence and decide whether to promote. Never activate in production without explicit separate approval and independent account recovery.

## Rollback
- Turn OFF client build flag and server flag, but **do not revert the additive column** or delete old refresh rows. Existing old-format clients continue legacy rotation behavior.
- Do not disable replay detection or revive revoked token families.
- Preserve redacted request-level diagnostics; no tokens, family IDs, player IDs, or digests in GitHub Actions.

## Open security gate
The iPhone whose existing guest family is already revoked is **not** recovered by this change. Require independent proof of prior device-key enrollment and explicit safe account claim, or a separately reviewed alternative proof path. There must be no insecure `playerId`-only linking.

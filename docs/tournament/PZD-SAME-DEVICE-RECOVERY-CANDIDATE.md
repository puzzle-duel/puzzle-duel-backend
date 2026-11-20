# PZD — Same-device writer recovery candidate (NOT ACCEPTED)

Status: implementation in progress, **not callable**, **not release approved**.
Baseline: PZD-40 P0-F11/F12/P1-F15; never relax existing `device_handoff`.

## Proven failure chain

- The client caches the session secret under a hash of the **entire JWT**, not a stable verified account identity. A renewed JWT misses the cache.
- `POST /session` creates a new `session_id` **and** a new random `device_id`.
- `tournament_series_writer` is bound to both previous identifiers.
- Owned board GET remains readable, while command authorization requires exact active session and device match.
- `409 WRITER_NOT_AUTHORIZED` is a fail-closed security outcome, **not** permission to takeover on a fresh JWT.

## Chosen recovery protocol (future implementation)

Only a device key registered *before the first daily claim* may establish
same-device continuity. New JWT + same playerId alone are insufficient.

1. Client creates account-scoped, non-exportable signing key in secure device storage.
2. Server challenges key possession **before** registration and binds verified
   (issuer, subject, player_id, public key fingerprint, credential ID).
3. The original claim's active writer session is anchored to that credential
   through a server-owned immutable writer provenance record. Registration on
   a new device never grants retroactive authority over an existing series.
4. After auth session expires, fresh verified JWT + new authenticated session
   requests a one-time nonce. Server verifies the original writer device anchor,
   active claim ownership and series eligibility.
5. Client signs `canonicalDeviceRecoveryProof`: domain separator, player,
   series, new session, device credential, challenge ID, nonce, observed writer
   generation and expiry.
6. One PostgreSQL TX takes the **same series advisory lock** as command admission,
   locks writer/fence/snapshot/challenge, checks original credential anchor,
   old writer session expired or explicitly revoked, immutable claim, server
   time vs idle/hard cutoff, nonterminal state, expected generation and current
   ordinal. One-time challenge and idempotency are checked inside the TX.
7. Update writer session/device to the new server-issued session/device,
   increment generation and update fence + exactly one active snapshot. Challenge
   is consumed and the immutable result recorded atomically.
8. Old generation must fail all further commands. Repeated idempotency key
   returns the committed result; conflicting payload fails closed.

## Suggested candidate endpoints (NOT WIRED)

- `POST /v1/tournament/devices/registration-challenge`
- `POST /v1/tournament/devices/register`
- `POST /v1/tournament/series/{id}/recovery-challenge`
- `POST /v1/tournament/series/{id}/recover-writer`

Responses must use `Cache-Control: no-store`. Recovery should explicitly
distinguish `RECOVERY_NOT_ELIGIBLE`, `STALE_WRITER`, `SERIES_TERMINAL`,
`RECOVERY_PROOF_INVALID`, and `IDLE_EXPIRED` without revealing other players'
series or credential details.

## Migration and compatibility

Add distinct account-scoped device credential, original writer provenance,
challenge ledger and idempotency/outcome tables via additive migration.
Existing claims lacking a registered key **must not** auto-recover; recovery
cannot infer a physical device from a UUID or the caller's JWT.
Client key in iOS secure storage should be user/account scoped, avoid shared
JWT-hash keys, and be inaccessible to other users of the same phone.

## Security tests required before integration

- Expired original session + matching registered device proof: exactly one rebind.
- Player A / Player B / Player A: no mixing account keys or session secrets.
- Another device with same player's JWT cannot recover.
- New key registration after original claim cannot authorize its recovery.
- Original writer still active, hard/idle cutoff passed, or terminal series:
  fail closed without ledger, writer, fence or snapshot mutations.
- Two concurrent recoveries: exactly one CAS increment.
- Replayed challenge / mismatched payload: immutable outcome or rejection.
- Stale writer command blocked after recovery.
- Interrupted TX and missing snapshot: full rollback.
- Feature disabled: zero DB/auth-side effects before parsing request.
- Recovery must not change immutable claim, score, deadline or historical results.

## Two-track UAT gate

Track A client animation PR #23 must pass Flutter CI independently.
Track B same-device recovery must have backend PostgreSQL concurrency tests,
client key storage implementation, independent PZD-40 security re-review
and owner approval. Only then combine them in one physical iPhone test session.

Current scope contains **only the stand-alone Ed25519 proof verifier and tests**.
No device key registration, no backend recovery route, no DB migration, no
client implementation. Do not claim the A→B→A scenario is fixed.

# ADR-003 — Ranked attempt protocol and server replay
Status: Proposed
Issue signed/opaque versioned challenge ID and deterministic piece stream. The server atomically reserves or records an eligible official attempt for (player, challenge); client submits move transcript with idempotency key. Replay every move using canonical rules, enforce bounds, move budget, configured obstacles, offered-piece selection, transitions, cascade score; reject impossible transcripts and tampered metadata. Do not compare only client supplied score. Require concurrency tests, tamper fuzzing, replay version compatibility, audit with retention limits.

## PZD-14 compatibility note

Status stays Proposed. This note does not accept the ADR and does not add an endpoint.

The server replay must dispatch on the attempt's stored `rulesVersion`. `core-001.v1` keeps its historical empty-stream abort. `core-001.v2` writes a single null offer only when the resolved move reaches `moveLimit` and `futurePieces` is empty. A client-supplied score is not the stored score. The pure TypeScript module and the Dart client engine both read the same fixtures, as described in [PZD-14-GAMEPLAY-PARITY.md](../architecture/PZD-14-GAMEPLAY-PARITY.md). They do not call each other.

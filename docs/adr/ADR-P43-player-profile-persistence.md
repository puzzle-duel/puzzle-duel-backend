# ADR-P43 — Player profile practice persistence and badge reads

Status: **Proposed** (mirror of client ADR; owner freeze required)

## Backend decisions for PZD-43 hardening

1. `POST /v1/tournament/session` and `GET /v1/tournament/session` return the caller's own internal `playerId` so the client can scope local practice without using display labels.
2. `GET /v1/tournament/me/badges` remains a candidate read of immutable F2-B On-Time grants for that same authenticated `playerId`.
3. No practice cloud sync, no production migration for practice data, no ranked HTTP enablement in production.

See client `docs/adr/ADR-P43-player-profile-persistence.md` for full identity and durable-storage rules.

# ADR-T01 — Tournament time, attempt ownership and ranked truth

Status: **PROPOSED — NOT ACCEPTED**
Date: 2026-11-16
Related: Tournament V1 Blueprint Change Proposal; original DRAFT BLUEPRINT.md; PZD-10 PD-01..PD-13; GEN-01..07 Accepted; ADR-001 Accepted.

## Context
Current DRAFT Blueprint excludes tournaments and provides a daily-only leaderboard; the owner now proposes a tournament with retroactive daily series inside an open UTC week and in-flight series crossing the weekly cutoff. This is a material product scope change requiring explicit reconciliation, not a stealth revision of PD-03.

## Proposed decision
1. UTC half-open week [Mon 00:00, following Mon 00:00). One immutable published six-challenge manifest per UTC date, all players identical and deterministic under pinned `gen-001.v1` + `core-001.v2` or later explicitly accepted versions.
2. A single server-issued authenticated official `daily_series` claim per player/day, unique and idempotent. Claim timestamp from server DB is authoritative. A claim before weekly cutoff can advance through all six games after the cutoff while session remains valid. New claims for old dates denied at cutoff.
3. Inactivity measured from last valid server-received activity; timeout threshold 300 seconds. What constitutes activity and the fate of an incomplete series is pending.
4. Server replay verifies every move; clients cannot write scores. Daily All=3 Easy+2 Medium+1 Hard; weekly categories are sums across up to seven completed day series. Practice is separate.
5. At cutoff mark prior week settling; final snapshot only once eligible in-flight series are terminal. Maintain current and five previous weekly filters plus today's daily board; no month aggregate.
6. On-time badge is non-scoring; exact eligibility is pending.

## Alternative considered
- End all games at cutoff: simpler but violates owner-confirmed requirement.
- Allow prior-week starts until idle grace: unfair late claims, rejects owner rule.
- Trust client timestamps/scores: insecure.
- Precompute leaderboard final snapshot at midnight: omits legitimate in-flight results.
- One shared local randomized practice board: violates request for variation.

## Consequences
Backend needs locked series ledger and verified replay with cross-runtime parity; cutover requires reliable clock/expiration and anti-fraud controls; legacy MVP scope requires amended blueprint/acceptance; score revisions during settling require provisional status.

## Explicit acceptance gates
Resolve T-01–T-10 in linked Tournament V1 proposal before marked Accepted. No implementation/deploy permission follows from this Proposed ADR.

# ADR-T01 — Tournament time, attempt ownership and ranked truth

Status: **PROPOSED — NOT ACCEPTED**
Date: 2026-11-16
Related: Tournament V1 Blueprint Change Proposal; original DRAFT BLUEPRINT.md; PZD-10 PD-01..PD-13; GEN-01..07 Accepted; ADR-001 Accepted.

## Context
Current DRAFT Blueprint excludes tournaments and provides a daily-only leaderboard; the owner now proposes a tournament with retroactive daily series inside an open UTC week and in-flight series crossing the weekly cutoff. This is a material product scope change requiring explicit reconciliation, not a stealth revision of PD-03.

## Proposed decision
1. UTC half-open week [Mon 00:00, following Mon 00:00). One immutable published six-challenge manifest per UTC date, all players identical and deterministic under pinned `gen-001.v1` + `core-001.v2` or later explicitly accepted versions.
2. A single server-issued authenticated official `daily_series` claim per player/day, unique and idempotent. Claim timestamp from server DB is authoritative. A claim before weekly cutoff can advance through all six games after the cutoff while session remains valid. New claims for old dates denied at cutoff.
3. **T-01 option B — latest owner-approved choice (2026-11-16), superseding prior A:** if no valid server activity is received for 300 seconds, atomically **forfeit the entire incomplete daily series**. The official claim stays spent; the player cannot resume or restart that date; no completed-day leaderboard score is awarded. Any server-verified move logs can remain for audit only. An actively played pre-cutoff series can still finish all six games after UTC rollover if it never hits the inactivity threshold. The precise valid-activity definition and race handling remain T-06. Prior A preservation/resume policy is revoked; the formerly open T-01B grace-period question is not applicable.
4. Server replay verifies every move; clients cannot write scores. **T-02 owner-approved 2026-11-16:** publish a daily ranked result and all four category totals (Easy=E1+E2+E3, Medium=M1+M2, Hard=H1, All=Easy+Medium+Hard) **atomically only after all six subgames are completed and verified**. Incomplete/forfeited series have no daily or weekly leaderboard category scores, though their verified partial scores may be visible privately in the player's progress view. Weekly categories sum only eligible completed daily series. Practice is separate.
5. At cutoff mark prior week settling; final snapshot only once eligible in-flight series are terminal. Maintain current and five previous weekly filters plus today's daily board; no month aggregate.
6. **T-03 owner-approved (2026-11-16):** On-Time badge is earned only by a fully completed and server-verified six-game daily series whose **server-authoritative claim/start timestamp** lies inside that series' own UTC date. Finishing later does not disqualify. Retrospective series started outside their own UTC date and forfeited/incomplete series earn no badge. Badge never adds ranking points or breaks ties; award atomically/idempotently with completed-series finalization.

## Alternative considered
- End all games at cutoff: simpler but violates owner-confirmed requirement.
- Allow prior-week starts until idle grace: unfair late claims, rejects owner rule.
- Trust client timestamps/scores: insecure.
- Precompute leaderboard final snapshot at midnight: omits legitimate in-flight results.
- One shared local randomized practice board: violates request for variation.

## Consequences
Backend needs locked series ledger and verified replay with cross-runtime parity; cutover requires reliable clock/expiration and anti-fraud controls; legacy MVP scope requires amended blueprint/acceptance; score revisions during settling require provisional status.

## Owner decision history and unresolved technical boundary

Owner first selected T-01 option A (session closes, progress resumable) and then **explicitly replaced it with option B** (after five minutes inactivity, the unfinished daily series is forfeited, with no leaderboard completed-day score and no replay entitlement). The latest B decision is the binding **product input** for this draft. Former T-01B grace-period extension is no longer applicable. T-06 still requires a definition of valid server activity and atomic racing completion versus timeout. The ADR as a whole remains Proposed.

## T-02 product decision

Owner approved all-or-nothing six-game daily ranking eligibility (2026-11-16). Partial scores stay private and do not affect daily, weekly or archived ranking categories. The ADR remains Proposed until other gates resolve.

## T-03 product decision

Owner selected option A (2026-11-16): the verified start/claim timestamp, not the completion timestamp, controls On-Time eligibility. Award badge only after complete verified series; timezone is UTC. This is owner-approved product input, while the ADR as a whole remains Proposed.

## Explicit acceptance gates
Resolve T-04–T-10 (especially T-06) in linked Tournament V1 proposal before marking the **ADR** Accepted. No implementation/deploy permission follows from this Proposed ADR.

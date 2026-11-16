# ADR-T01 — Tournament time, attempt ownership and ranked truth

Status: **PROPOSED — NOT ACCEPTED**
Date: 2026-11-16
Related: Tournament V1 Blueprint Change Proposal; original DRAFT BLUEPRINT.md; PZD-10 PD-01..PD-13; GEN-01..07 Accepted; ADR-001 Accepted.

## Context
Current DRAFT Blueprint excludes tournaments and provides a daily-only leaderboard; the owner now proposes a tournament with retroactive daily series inside an open UTC week and in-flight series crossing the weekly cutoff. This is a material product scope change requiring explicit reconciliation, not a stealth revision of PD-03.

## Proposed decision
1. UTC half-open week [Mon 00:00, following Mon 00:00). One immutable published six-challenge manifest per UTC date, all players identical and deterministic under pinned `gen-001.v1` + `core-001.v2` or later explicitly accepted versions.
2. **T-08A owner-approved (2026-11-16):** one server-issued authenticated official `daily_series` entitlement covers all **six** ordered games E1→E2→E3→M1→M2→H1. It is claimed/consumed atomically **at start of E1**, not once per subgame. Unique (player_id, UTC date), idempotent transaction; claim timestamp from server DB is authoritative. A claim before weekly cutoff can advance through all six games after the cutoff while active, subject to T-01 forfeit and T-07 hard deadline. New claims for old dates denied at cutoff. An expired/forfeited claim never opens a fresh one.
3. **T-01 option B — latest owner-approved choice (2026-11-16), superseding prior A:** if no valid server activity is received for 300 seconds, atomically **forfeit the entire incomplete daily series**. The official claim stays spent; the player cannot resume or restart that date; no completed-day leaderboard score is awarded. Any server-verified move logs can remain for audit only. An actively played pre-cutoff series can still finish all six games after UTC rollover if it never hits the inactivity threshold. **T-06A owner-approved 2026-11-16:** only server-accepted actual player interactions may refresh liveness; an automatic heartbeat or a live app/network connection alone never does. The precise allowlist, anti-abuse criteria and atomic race handling remain **T-06B**. Prior A preservation/resume policy is revoked; the formerly open T-01B grace-period question is not applicable.
4. Server replay verifies every move; clients cannot write scores. **T-02 owner-approved 2026-11-16:** publish a daily ranked result and all four category totals (Easy=E1+E2+E3, Medium=M1+M2, Hard=H1, All=Easy+Medium+Hard) **atomically only after all six subgames are completed and verified**. Incomplete/forfeited series have no daily or weekly leaderboard category scores, though their verified partial scores may be visible privately in the player's progress view. Weekly categories sum only eligible completed daily series. Practice is separate.
5. **T-07A owner-approved (2026-11-16):** closing a normal UTC day at 00:00 opens a maximum **15-minute** grace period for already-claimed prior-day series (through 00:15 UTC). At Monday 00:00 UTC the prior **week** instead gets maximum **one-hour** grace (through Monday 01:00 UTC / Türkiye 04:00), and **overrides** the otherwise overlapping 00:15 daily window; all active previously claimed old-week daily series can finish within that window. The rolling 300-second inactivity-forfeit rule continues concurrently. Beyond hard deadline, incomplete daily series are forfeited without ranked credit; no late old-period start or completion is accepted. Treat standings as provisional while settling, then finalize only after accepting valid pre-deadline results. Maintain current and five previous weekly filters plus today's daily board; no month aggregate. Settlement process may finish after deadline but scoring deadline never moves.
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

Owner first selected T-01 option A (session closes, progress resumable) and then **explicitly replaced it with option B** (after five minutes inactivity, the unfinished daily series is forfeited, with no leaderboard completed-day score and no replay entitlement). The latest B decision is the binding **product input** for this draft. Former T-01B grace-period extension is no longer applicable. T-06A now approves server-accepted real player interactions (not automatic heartbeat) as the liveness source. T-06B still requires a precise event allowlist, anti-spam protections and atomic finish/timeout race adjudication. The ADR as a whole remains Proposed.

## T-02 product decision

Owner approved all-or-nothing six-game daily ranking eligibility (2026-11-16). Partial scores stay private and do not affect daily, weekly or archived ranking categories. The ADR remains Proposed until other gates resolve.

## T-03 product decision

Owner selected option A (2026-11-16): the verified start/claim timestamp, not the completion timestamp, controls On-Time eligibility. Award badge only after complete verified series; timezone is UTC. This is owner-approved product input, while the ADR as a whole remains Proposed.

## T-05A owner-approved equal-score ranking (2026-11-16)

Competition ranking applies to every daily/weekly/archived All/Easy/Medium/Hard board: `rank(score) = 1 + count(verified eligible players with a strictly greater score)`. Equal scores share the same rank, with subsequent ranks skipped (500,500,450 => 1,1,3). The non-scoring On-Time badge and any start/finish/submit timestamp cannot break score ties. Deterministic display order among tied rows is permitted only for stable pagination without changing shared rank. T-05B remains OPEN for display sort/pagination, archive finalization and late reconciliation.

## T-04 owner-approved authentication requirement (provider feasibility still open)

Owner requires a **verified login via one of Apple, Google, Instagram, Facebook, TikTok or X (Twitter)** for any official tournament participation (2026-11-16); offline practice remains accessible without login. Architecture proposal: provider-agnostic OAuth/OIDC identity adapters map verified provider-specific subject identifiers to one internal server player ID; linked providers **do not** create extra tournament entry rights. Existing Apple/Google and Facebook user login paths can be assessed for implementation; TikTok Login Kit supports iOS/Android OAuth according to https://developers.tiktok.com/docs/en/login-kit-overview. **Instagram personal-account login is not established by the documented professional Instagram API** (https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/v21.0/). Treat Instagram consumer login as feasibility/app-review gate, not guaranteed. Backend code exchange, state/nonce/PKCE, token validation, least privilege, account linking conflicts, revocation, deletion and auth UI compliance require detailed ADR/security approval. **Guest ranked eligibility is CLOSED: disallowed.** X adds a provider adapter requiring official OAuth user authorization, developer app access, verified subject handling and current provider plan/pricing/app-review validation. The Instagram personal-login feasibility caveat remains. Per-provider release support and account-link proof are separate gates; do not expose broken provider buttons.

## T-06A owner-approved genuine activity rule (2026-11-16)

The 300-second inactivity window resets **only on authenticated, server-accepted, genuine player-triggered interaction**, not on automatic heartbeat, connectivity, application foregrounding or idle screen-on status. Qualifying candidate interactions include actual legal gameplay moves and genuine deliberate UI actions, but their precise event names, validity and abuse controls are **T-06B OPEN**. Server-receipt timestamps control, and at the expiry boundary T-01 B permanently forfeits an incomplete daily series. Concurrency, invalid taps, spam interaction attempts and delayed requests need an approved testable contract.

## T-07A owner-approved daily/weekly hard settlement windows

On 2026-11-16 owner approved **post-cutoff completion** grace windows: **15 minutes for ordinary UTC day rollover**, **one hour for UTC Monday week rollover**, the latter superseding the former where both overlap. Previously started daily series may finish during the applicable window only while they have not hit T-01's 300-second genuine-interaction inactivity limit. Unfinished series at hard deadline forfeit and cannot contribute scores. Old period remains provisional until pre-deadline completed results are verified and durably applied; then immutable archive. Exact boundary race ordering, retry safety, delayed commit and archive UI remain technical contract gates.

## T-08 entitlement and six-step progress UI owner approval (2026-11-16)

Owner approved **one six-game daily series = one official attempt**, reserved when E1 begins; E2/E3/M1/M2/H1 only advance the already claimed attempt. Server owns immutable ordinal progression, one claim per player/day, and idempotent double-tap/multi-device transaction control. Also requested a visible **six-step bar** at the top or bottom of the tournament play screen, showing completed/active/upcoming games, order and difficulty (3 Easy / 2 Medium / 1 Hard). The bar must present authoritative progress; it is not independent game state, and must not imply a partial leaderboard score before all six finish (T-02). Specific placement/animation remains UI/UAT choice. T-08C remains open for crash/reconnection and atomic racing requests subject to T-01/T-07.

## T-09A owner-approved primary competition scope (2026-11-16)

The primary player navigation is **Practice / Tournament / Leaderboard**. The Tournament six-game daily series becomes the **only daily ranked competition path**, replacing the earlier independent daily challenge planned by the DRAFT Blueprint. Practice stays accessible to guests offline and cannot generate ranking credit. This is an intentional scope supersession of the previous DRAFT tournament exclusion and daily-only MVP plan; prior PD-03 history stays intact as historical evidence. Reconcile and version BLUEPRINT.md across both repositories and any existing legacy endpoints/tasks before implementing; do not silently delete schema, history or rankings. Release milestone, migration and compatibility are T-09B OPEN. The ADR remains Proposed.

## Explicit acceptance gates
Resolve outstanding T-05B, T-06B, T-07B, T-08C, T-09B and T-10 (plus T-04 provider feasibility), especially T-06B in linked Tournament V1 proposal before marking the **ADR** Accepted. No implementation/deploy permission follows from this Proposed ADR.

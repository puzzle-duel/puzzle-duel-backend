# Tournament V1 — Implementation-Ready Architecture / Decision Gate

Status: **PROPOSED FOR OWNER REVIEW — NOT ACCEPTED**
Date: 2026-11-16
Tracking: [PZD-37](https://puzzle-duel-app.atlassian.net/browse/PZD-37) · [Draft PR #11](https://github.com/puzzle-duel/puzzle-duel-backend/pull/11)
Relationship: companion to [TOURNAMENT-V1-BLUEPRINT-PROPOSAL.md](../product/TOURNAMENT-V1-BLUEPRINT-PROPOSAL.md), [ADR-T01](../adr/ADR-T01-tournament-ranked-session.md). This is a proposed **normative implementation contract**; product decisions T-01–T-10 are owner-approved, but *technical recommendations below are not automatically owner-approved*. No merge/deploy or ADR acceptance is implied.

## 0. Evidence and decision authority

Inspected on 2026-11-16:
- Client and backend `BLUEPRINT.md` (both currently DRAFT v1.0), where the independent daily challenge was MVP and tournament was post-MVP; user subsequently approved T-09 replacing that scope.
- Backend `docs/adr/ADR-002-identity-and-linking.md` (Proposed), `ADR-003-ranked-replay.md` (Proposed), `ADR-004-leaderboard.md` (Proposed) and `ADR-005-application-stack.md` (Accepted stack with mandatory pending smoke-test).
- Client `docs/engine/PZD-20-RESOLUTION.md` (the currently failing `core-001.v2` early-board-full empty-stream case) and `docs/engine/PZD-21-GENERATOR-DECISIONS.md` (owner-Accepted GEN-01…GEN-07).
- Backend `docs/architecture/PZD-14-GAMEPLAY-PARITY.md` (product-engine parity not established merely by fixture checkers).
- Tournament V1 draft product proposal and ADR-T01 in PR #11.

**Source precedence:** explicit latest owner choices T-01B and T-02…T-10A > older Proposed architecture and older DRAFT product scope. Accepted generator decisions and existing versioned rulesets are not silently rewritten. The implementation stack follows Accepted backend ADR-005 (Node 26 / NestJS 12 / TypeScript / PostgreSQL 18), **subject to its not-yet-run mandatory executable smoke test**. Hosting/networking remains a separate approval, not inferred here.

## 1. Approved product invariants — not being reopened

- App journeys: **Practice / Tournament / Leaderboard**. Guest/offline repeatable practice (5×5/6×6/7×7), three local personal bests, never ranked. Single ranked competition is Tournament, not old standalone Daily Challenge.
- Tournament is online and requires a verified account; requested providers Apple, Google, Facebook, TikTok, Instagram, X. One internal `player_id`, multiple explicitly linked providers. Provider availability is not guaranteed (see §6).
- Each UTC date offers the identical immutable sequence **E1,E2,E3,M1,M2,H1** across all players. Only **one** official daily-series claim per player/date, atomically consumed at server-authorized E1 start. No independent subgame re-entry.
- A daily score exists **only** after all six games terminate successfully with verified replay; four categories `Easy=E1+E2+E3`, `Medium=M1+M2`, `Hard=H1`, `All=Easy+Medium+Hard`. Private partial progress may appear but never enters any leaderboard.
- First valid server claim **within that date** qualifies for non-scoring On-Time badge **after** all six complete; timestamp never changes rank.
- Each leaderboard uses competition rank `1 + number_of_verified_players_with_strictly_higher_score`: equal score → equal rank, next ordinal skipped. Daily, weekly and the last five archived weeks with filters All/Easy/Medium/Hard.
- Real player interaction accepted by server refreshes 300s inactivity; **automatic heartbeat does not**. At expiry the **entire** incomplete daily series is irrevocably forfeited; claim remains spent. No ranked score.
- UTC day boundary is 00:00. Sunday→Monday week rollover is Monday 00:00. Ordinary in-flight previous-day series maximum completion window is 15 min after its midnight; Sunday→Monday previous-week in-flight series maximum 1 h after midnight, superseding 15 min on Monday. The five-minute inactivity limit remains concurrent. An unclaimed earlier date within the **current** UTC week may be played retroactively; an unclaimed date of the previous week may not be newly claimed after Monday 00:00.
- If **no legal move remains**, the subgame successfully ends at accumulated server-replayed score and the six-game series progresses to the next ordinal (new ruleset contract, not a retroactive reinterpretation of `core-001.v2`).
- Tournament gameplay displays a six-step E1 E2 E3 M1 M2 H1 progress bar with verified done/current/upcoming states; top/bottom placement is UAT choice.

## 2. Critical ambiguity and proposed resolution: 15-minute daily close versus retroactive days

**REAL CONFLICT IN EARLIER PROPOSAL:** It simultaneously says Monday's leaderboard is immutable Tuesday 00:15 **and** a player may start an unplayed Monday series as late as Sunday of that same week. Both cannot hold. Likewise an assertion "no new old-day starts after midnight" is **false** for still-open-week retroactive dates; only no new **old-week** starts at Monday rollover is approved.

**Proposed resolution R-01 (requires explicit owner sign-off):**
1. **15 minutes limits only a series that was already in progress across an ordinary day boundary**. A Monday session claimed Monday 23:59 must finish by Tuesday 00:15 (or 300s idle earlier), otherwise forfeits. It does not block **new** Monday-backfill claims created on Tuesday–Sunday of the same open UTC week. For a backfilled Monday game claimed Tuesday 10:00, the day-specific 00:15 deadline has already elapsed and **must not** be applied retroactively; its eligibility instead ends on Monday of the *following* UTC week (subject to the 300s inactivity and weekly rollover window only if claimed before the next Monday 00:00). This applies to all dates of the week consistently.
2. Daily ranking for a date is **LIVE/PROVISIONAL during the whole enclosing UTC week** and may change when completed backfill series post. The 00:15 deadline **settles only the over-midnight in-flight cohort**, NOT the date's final leaderboard. A date's **FINAL immutable rank snapshot** is taken only after the enclosing week settles. Any daily “closed for On-Time” indicator must not be misrepresented as “final ranking.”
3. Monday 00:00 weekly cutoff forbids **new claims for every previous-week date**. It permits all already-claimed old-week series to finish by Monday 01:00 (Türkiye 04:00), provided none has idled for 300s. All daily category scores and the weekly aggregation for that week finalize together after the last accepted write at/before that hard deadline has settled.
4. Boundary policy proposal: `server_received_at < hard_deadline` (strict), `server_received_at < last_valid_activity_at + 300s` (strict). Exact boundary (00:15:00.000 and 01:00:00.000) is **expired**, not eligible. The old claim must exist before Monday 00:00; claim at exactly Monday 00:00 belongs to a new-week date only.
5. Example: UTC Monday Nov 16 23:58 → Tuesday Nov 17 00:03 completion valid for Nov 16; at Tuesday 00:16 an **already-running** Nov 16 claim cannot finish, but a *new* never-claimed Nov 16 backfill can still be started on Tuesday and successfully scored into Nov 16. Previous week's Monday after following Monday 00:00 can **never** receive a new claim.

**Do not Accept ADR-T01 until R-01 is explicitly approved**: the older language calling a normal daily ranking immutable at 00:15 must be superseded and cross-repo UI/API expectations reconciled. This is a product-observable behavior, not an invisible implementation detail.

## 3. Proposed canonical data model and consistency

PostgreSQL 18, UTC timestamps (`timestamptz`), immutable challenge/version metadata:

```text
players(player_id PK, state, created_at, deleted_at)
provider_identities(provider, provider_subject, player_id,
  UNIQUE(provider,provider_subject)); prove ownership before linking
tournament_days(utc_date PK, utc_week_start, published_manifest_hash, state)
tournament_challenges(utc_date, ordinal[1..6], challenge_id,
  difficulty, seed_u32, generator_version, rules_version,
  config_hash, initial_state_hash, ordered_supply_hash,
  UNIQUE(utc_date,ordinal), UNIQUE(challenge_id))
daily_series(series_id PK, player_id, utc_date, utc_week_start,
  started_at, last_valid_activity_at, status,
  current_ordinal, revision, forfeited_reason, finalized_at,
  UNIQUE(player_id,utc_date))
series_games(series_id,ordinal,challenge_id,status,
  move_cursor, canonical_state_hash, verified_score, ended_reason,
  PRIMARY KEY(series_id,ordinal))
move_ledger(series_id,ordinal,sequence,idempotency_key,
  request_payload_hash, canonical_move, response_hash,
  accepted_at, UNIQUE(series_id,ordinal,sequence),
  UNIQUE(series_id,idempotency_key))
daily_results(player_id,utc_date,series_id, easy,medium,hard,all_score,
  on_time, completed_at, PRIMARY KEY(player_id,utc_date),
  UNIQUE(series_id))
weekly_results(player_id,utc_week_start,easy,medium,hard,all_score,
  PRIMARY KEY(player_id,utc_week_start))
week_finalizations(utc_week_start PK, cutoff_at, finalized_at,
  source_revision, snapshot_hash, state)
weekly_rank_snapshot(utc_week_start,category,player_id,score,rank,sort_key,
  PRIMARY KEY(utc_week_start,category,player_id))
```

Normative proposed invariants:
- `daily_series` is **one attempt per (player, UTC date)** for all six ordinals. A unique violation returns the same existing attempt or explicit conflict; never creates a second attempt. Retaining forfeited tombstones is mandatory.
- Claimed series points to an immutable, server-published manifest and each subgame's pinned rules/generator version and canonical hashes. An already published day manifest cannot mutate or be regenerated under a new version.
- Each legal move is fully verified under pinned ruleset; server advances `move_cursor` and persists the canonical resulting state + event atomically. Never accept a client-supplied score, end flag, time, or snapshot as ranking truth.
- Once the sixth game is successfully verified, update `daily_results` and `weekly_results` in **one transaction** with a compare-and-set of series status; duplicate completion produces byte-for-byte equivalent response; partial/double/forfeited series cannot publish a result.
- Store a verified, stable `player_id` identity distinct from provider credentials, prevent blind email-based merges, prevent unlinking the last usable method without explicit recovery flow, and never duplicate tournament rights on links.
- All externally visible timestamps originate from server-side database/transaction clock. User-provided device UTC and UI animation time are never authority.

## 4. Proposed HTTP and state machine contract (endpoint names not yet approved)

Transport names below are candidates, not assertions about existing implemented routes.

| Route | Method | Intent / authoritative behavior |
| --- | --- | --- |
| `/v1/tournament/calendar?week=...` | GET | Server UTC date/week, available/backfill/in_progress/forfeited/completed states, manifest references, deadlines, read-only |
| `/v1/tournament/days/{date}/start` | POST | Start E1 and atomically consume single entry; authenticated, idempotency key, server side date/week constraint |
| `/v1/tournament/series/{id}` | GET | Canonical series state, current ordinal and six-step progress, true server deadline(s), no side effect / does NOT reset idle clock |
| `/v1/tournament/series/{id}/moves` | POST | Idempotent canonical legal move with ordinal + expected revision/sequence; actor and state checked |
| `/v1/tournament/series/{id}/interactions` | POST | **Only if a narrowly approved genuine UI interaction allowlist exists**; server validates, rate-limits and audits. Never accept anonymous “alive” or heartbeat as activity |
| `/v1/tournament/series/{id}/advance` | POST | Advance after server-verified successful terminal, no new entry |
| `/v1/tournament/leaderboard/days/{date}` | GET | category, status provisional/final, server snapshot/asOf, score and competition rank |
| `/v1/tournament/leaderboard/weeks/{start}` | GET | category, status settling/final, authoritative rank and stable pagination |

Suggested state transitions:
```text
NOT_CLAIMED --authenticated atomic E1 start--> ACTIVE[ordinal=1]
ACTIVE --verified move / genuine accepted interaction--> ACTIVE (idle clock moves)
ACTIVE --verified natural/normal terminal--> AWAIT_ADVANCE or ACTIVE[next ordinal]
ACTIVE[ordinal=6] --verified terminal + atomic four-category publish--> COMPLETED
ACTIVE/AWAIT_ADVANCE --300s idle OR applicable crossover hard deadline--> FORFEITED
COMPLETED / FORFEITED --any further mutation--> REJECT (terminal)
```
`GET`, visual animation, app foregrounding, token refresh, sign-in callback, reconnect, network ping and background heartbeat **never** extend liveness. An explicit, authenticated user interaction may extend only if it passes §5 anti-abuse rules. Completion is never client-declared.

## 5. Proposed T-06B / T-08C liveness, concurrency and recovery contract

**Recommendation S-01 (requires acceptance):** Define **gameplay legal move** (successfully replayed and committed) as the baseline activity, plus a **small finite set of purposeful UI actions** (such as manual "inspect rules" or "open pause menu") that are individually authenticated, tied to the active series, server-accepted, and rate-limited. Mere arbitrary taps, invalid move spam, move attempts against occupied/blocked squares, automatic replay, held-down gestures, polling and network keepalive do not qualify. To avoid indefinite “tap to stay alive”, **UI-only events must have a bounded per-series extension budget** (recommended at most one 60-second extension total; the exact numbers require owner/engineering review). This preserves a fair allowance for thinking without allowing infinite ranked attempt preservation. If the owner wants unrestricted deliberate UI actions to refresh indefinitely, that is a separate policy decision.

**Recommendation S-02:** Use one authoritative server receipt timestamp per transaction, coupled with `SELECT ... FOR UPDATE` on `daily_series` and optimistic expected revision/ordinal/sequence. For each mutation:
1. Authenticate token and map provider to immutable `player_id`; validate series ownership.
2. Acquire DB row lock and read `server_received_at`, last accepted activity, current rules/step, deadline and status.
3. If terminal status, return stable terminal response or reject (never reopen).
4. If request crossed weekly hard end, day-crossing hard end for already-running prior-day series, or 300s idle threshold, **persist FORFEITED before considering the action**.
5. Else validate anti-abuse/legality, sequence and idempotency; execute pure replay outside the client trust boundary; persist canonical move + state + new last_valid_activity_at and revision.
6. If successful last game terminal, persist one daily result, update weekly totals and finalize badge atomically in the same transaction.
7. Concurrent retries: same idempotency key and identical request hash => same result; same key different payload => conflict; stale sequence => explicit conflict with current state (never double score).

**Important security caveat:** A pure server-receive-time clock and client moves cannot guarantee an action occurred on-device before cutoff when the network was down. **Fail closed** rather than accept spoofable device timestamps. Receipt-vs-transaction-start semantics and delayed queue effects must have a fixed test oracle before release.

**Recommendation S-03 (reconnect):** Reconnecting to an already active series via read-only GET is allowed **only before** the 300s idle deadline and the applicable crossover deadline; recovery returns the **same six-game claim** and canonical verified step/move cursor. Reconnect/read itself does not extend the idle window. A crash at t=299s followed by a *server-accepted legal move* before t=300s may continue; at t>=300s the claim is terminal FORFEITED. Multiple devices may inspect but only one serialized and authenticated writer proceeds; second device must refresh canonical state after revision conflict. No extra entitlement is created.
**Operational warning:** If auto-generated UI events rather than moves reset idle, the above contract must supply an abuse-resistant proof and finite budget; otherwise accept moves only. Device-touch "genuineness" is not cryptographically provable by client claims alone.

## 6. Proposed identity adapter and launch gates (T-04)

- **One** internal player account, one verified provider subject per provider identity; linking requires both currently authenticated player session and a fresh verified authorization proving possession of the linked provider account. Email/name/avatar never proves ownership.
- Apple/Google/Facebook/TikTok/X/Instagram are **product-target providers**, not an assertion all currently support universal end-user sign-in or are approved for every platform. Provider buttons only activate after real consent/redirect/API credentials and end-to-end tests.
- Prefer authorization code + PKCE and state checks where supported, OIDC nonce/issuer/audience/expiry verification where applicable; backend handles token exchange and securely stores only necessary provider claims. Request least-privilege scopes, no social-content or contact access for login.
- Instagram personal-account sign-in is **blocked pending a compliant, currently supported consumer login route**; Meta's Instagram Login API is oriented toward professional accounts. Do not treat Instagram professional API tokens as a universal login solution and do not ship a dead button.
- X (Twitter) requires current developer access/OAuth validation and costs review; TikTok Login Kit requires registered app and scope review. Platforms may differ in eligibility and web support. Define fallback enabled-provider set **only after product sign-off** if one target provider cannot ship; never bypass the mandatory verified-login rule.
- Account linking conflict must fail closed; explicit merge approval and transactional ownership transfer required. Deleted players' PII retention, dispute prevention and archive anonymization require privacy/legal review.
- Apple App Review sign-in parity and in-app account deletion, privacy disclosures, sign-out, revocation, provider outage, and device migration are release checks.

## 7. Proposed T-05B / T-07B rank, archive and settlement

- Compute each category rank server-side using competition ranking `RANK() OVER (ORDER BY verified_score DESC)` (not `DENSE_RANK` and not `ROW_NUMBER`). Tied players have identical numeric ranks.
- **Deterministic row display** within ties: `score DESC, player_id ASC` (internal stable identifier only as sorting key, not as extra ranking/tie breaker). Cursor must include period revision/version and `score,player_id`, so changes to live leaderboard cannot silently produce skips/duplicates; if revision differs return `snapshot_changed` and require a fresh first page. Proposed initial page size 50, hard maximum 100, otherwise configurable.
- Current weekly and in-week daily scores may change after **valid retroactive backfill**; expose `provisional` and `as_of` publicly. No permanent daily/weekly winner announcement until the containing week is finally settled.
- Weekly state: OPEN → SETTLING at Monday 00:00 UTC → FINAL when previous-week legal in-flight series all reach terminal or pass Monday 01:00 and **all pre-deadline accepted score writes are committed**. Worker retries must be idempotent. Deadline controls eligibility, not how quickly the worker runs.
- **No post-final mutation** of weekly or historical daily snapshots through normal gameplay APIs. Administrative repair, if ever required, needs audit, owner-approved incident protocol and distinct snapshot revision; do not quietly rewrite a published podium.
- Five previous weekly snapshots visible in UI. Longer data retention is **not approved** by that UI limit; propose a separate privacy/storage retention ADR. Archive results not derived from live tables once finalized.
- Score crossing the precise boundary: **proposal** successful replay accepted and durably authorized while server clock is strictly before deadline; a later worker may materialize it without reopening eligibility. Need one consistent DB ordering/transaction model and race fixtures.
- When zero accepted activity exists for 300s, forfeit even if a client heartbeat says “connected.” A round that naturally ended during a valid series may advance but still cannot post a partial category score to a board.

## 8. Proposed T-10B explicit ruleset version and replay parity

The client `PZD-20-RESOLUTION.md` explicitly documents `core-001.v2` **fail closed** for `early_board_end_empty_stream`, and that v2 null tray slot is only valid on the final move budget. The owner-approved T-10 natural finish **cannot** be implemented by quietly changing v2 semantics.

**Recommendation E-01:** add new version **`core-001.v3`** for early board-full/finite-supply terminal representation, with an independent fixture suite and checkers. Keep `core-001.v1` and `core-001.v2` state parsing/replay byte-for-byte in their own dispatch branches. `gen-001.v1` (Accepted) stays unchanged unless challenge constraints require a separately reviewed generator version. New tournament manifests explicitly pin `rulesVersion=core-001.v3` after parity acceptance; practice may elect v3 in separately versioned migration but saved sessions retain their original version.

**Normative v3 target, pending ADR**:
1. Resolve all legal clear/shift/cascade waves fully; do not prematurely claim the board is terminal before cascades.
2. Compute remaining move budget and board legal placements from the canonical resolved state, offered pieces and remaining immutable finite piece stream. Terminate successfully if no move can be legally made or move budget is exhausted. **An exhausted stream alone is not automatically terminal if already-offered pieces remain playable**; distinguish no future replacements from no possible current move. The policy for null/spent offers when future supply is empty **before** move limit needs a specified new v3 state representation.
3. Preserve accumulated `score`, canonical end reason and immutable proof hash; do not award artificial points for being stuck and do not forfeit the six-game series.
4. Fail closed for corrupted offer trays, nonterminating cascades, illegal moves or impossible initial states; successful natural terminal is not a catch-all for replay failures.
5. Add golden vectors: early board-full+empty future stream, partial non-empty offers+empty stream, zero legal placement with empty cells, reopen-after-cascade, last-budget empty stream, early zero supply, negative tampered terminal proof, v1/v2 backward compatibility, duplicate finalization; run same vectors in Dart and standalone pure TypeScript. Compare exact result, end reason, score, stream, null slots, terminal proof and state hash. CI must fail for **SKIP/NOT_RUN**, not mistake reference-checker PASS for product-engine parity.

**Remaining normative design item:** select the exact v3 terminal tray JSON schema and legality predicate *before* engine implementation. This document recommends a new version but does not invent the exact approved representation. Therefore T-10B remains pending owner review of a dedicated small ruleset ADR, not Accepted here.

## 9. Cross-repository Blueprint migration (T-09B)

Current **both** `BLUEPRINT.md` files are unchanged **DRAFT v1.0** and currently say tournament post-MVP and describe the old single-board Daily Challenge. Do not silently set either to Accepted. Proposed migration:
1. Create **versioned Product Blueprint v1.1 candidate** in both client/backend PRs, preserving a historical v1.0 record and explicit change log of PD-01/02/03 vs T-01–T-10. One feature's acceptance must not accidentally approve unrelated open advertising/monetization decisions.
2. Update primary navigation, daily series entitlement, offline practice, six-game tournament, leaderboard calendar, badges, and user consent. Mark old independent Daily Challenge **superseded for future competitive use**, not deleted history.
3. Contract- and task-inventory: map existing source, branches, Jira tickets, API proposals, fixtures, potential persisted ranked data. Migration only after an actual inventory shows which old endpoints/data exist; do not assert the backend has live users or data (the inspected `src` contained generator code only).
4. Rollout gate with rollback, manifest immutability, versioned endpoints and verified scores. No automatic transformation of legacy one-board scores into six-game daily results; retain or archive separately if any exist.
5. Shared cross-repo source-of-truth: product v1.1 and accepted ADRs commit separately to their respective branches; pair release commits and lock known contract hashes. Implementation tickets only begin after owner approves this proposed gate and branch strategy.

## 10. Acceptance test catalogue — minimum gates

| ID | Expected result |
| --- | --- |
| G01 | Concurrent E1 start x2 on same (player,date) yields one claim, same series ID, one spent right |
| G02 | Same provider account via two devices or linked Apple+Google is still a single `player_id` and one entitlement |
| G03 | Six games complete normally; only final game publishes exactly 4 scores; repeat completion idempotent |
| G04 | Failed/incomplete/forfeited series never adds category score to any daily/weekly/archive leaderboard |
| G05 | Valid move at t=299.999s survives; t=300.000s forfeits; automatic heartbeat at t=299s cannot extend; spam taps do not extend |
| G06 | Crash/GET reconnect at t=299s does not reset clock; legal move under deadline resumes same cursor; after deadline is terminal |
| G07 | Two devices submit same/stale move concurrently: one canonical transition, no lost revision, no double points |
| G08 | Ordinary day crossing: prior-date in-flight 00:14:59 valid; 00:15:00 expired; later new prior-date backfill **within same UTC week** is permitted under R-01 (if accepted) |
| G09 | Monday 00:00 prohibits new old-week claim; already claimed Sunday or any old-week date completes by 00:59:59; at 01:00:00 expires |
| G10 | Monday 00:15 daily limit does not override approved weekly 01:00 previous-week completion deadline |
| G11 | Backfilled day completion modifies original UTC day and enclosing provisional week, not today's scores; archived final data unchanged |
| G12 | Daily provisional remains open to backfill until week settlement; after finalization scores/ranks frozen, snapshot hash stable |
| G13 | Two equal scores produce 1,1,3 across all filters; badge, completion timestamp do not alter rank |
| G14 | Pagination across equal ranks remains stable under unchanged snapshot; new provisional revision demands refresh |
| G15 | On-Time badge awarded only for E1-start on owning UTC day AND fully verified six-game completion; retroactive start doesn't qualify |
| G16 | v3 no-legal-move board terminal keeps accumulated score and advances one ordinal; v1/v2 historical fixtures unchanged |
| G17 | Dart and TypeScript frozen golden vectors match for generator, every move, cascade, final end reason and proof |
| G18 | Malformed/untrusted client score, client timestamp, invented end state, switched rules version, unauthorized player are rejected |
| G19 | Six-step UI reads canonical done/current/upcoming and accurately signals forfeit, partial results and final 6/6 |
| G20 | Provider unavailable, unlink conflict, deleted user, revocation, cancelled login, account-link spoof: ranked APIs fail closed |
| G21 | Last submitted valid score accepted pre-cutoff but settlement worker delayed remains included once; post-cutoff arrival rejected |
| G22 | Ad/privacy policy in DRAFT v1.0 is not accidentally accepted by Tournament V1 sign-off |

**Execution status: NOT_RUN.** These are specified expected outcomes, not a claim that tests were implemented or passed.

## 11. Explicit decisions still requiring review

| ID | Proposed resolution / next artifact | Approval owner |
| --- | --- | --- |
| **R-01** | 15m = in-flight midnight crossover only; day ranking provisional until enclosing weekly close because backfill remains allowed | **Product owner (material behavior)** |
| **S-01** | Limit valid activity to legal moves + reviewed purposeful UI actions with finite anti-spam extension allowance | Product owner + security |
| **S-02/S-03** | Strict server-received deadlines; locked atomic verification; identical retry response; reconnect only while active | Architecture/security gate |
| **L-01** | `RANK()`, stable internal ID display ordering, revision-bound cursor, page 50/max100 | Architecture gate |
| **A-01** | Immutable weekly/daily final snapshots, provisional daily before week closes, bounded retry settlement | Product owner for UX + architecture |
| **E-01** | New `core-001.v3` version, exact terminal tray schema to be specified, frozen parity vectors | Engine/ruleset ADR approval |
| **B-01** | Two-repo v1.1 Blueprint proposal and compatibility/migration matrix | Product owner / release gate |
| **I-01** | Provider-by-provider validation and release fallback when Instagram or X cannot ship | Product owner / security / legal |

Do **not** mark ADR-T01 Accepted or alter `BLUEPRINT.md` without review of the normative decisions above. Implementing test harnesses and design prototypes may later be authorized separately; this document alone grants no code, merge, or deploy permission.

## 12. Suggested implementation-ready work packages, after approval

1. Engine rules v3 schema + cross-runtime parity fixtures and CI hard gate (E-01).
2. Identity adapters, sign-in linking conflict handling, authenticated player model, privacy (I-01).
3. Daily manifest publication, atomic E1 claim, serialized move/terminal ledger, inactivity + reconnect state machine (S-01/02/03).
4. UTC period boundaries and backfill semantics R-01; transactional daily/weekly projections; immutable archive L-01/A-01.
5. Flutter Practice/ Tournament/ Leaderboard UI, six-step progress bar, accessible error/forfeit states.
6. End-to-end adversarial, load, clock-boundary, multi-device tests G01–G22; on-device UAT; release/runbook only after infrastructure PZD-12 host decision.

**Owner's current authorization:** prepare documentation and decision gate for review. **Not authorized:** merging, deploying, silently accepting unresolved ADRs, promising six login providers in production, or converting reference-checker outcomes into gameplay parity PASS.

# PZD-26/27 — Unified provider continue (staging contract addendum)

Status: implemented on `feature/PZD-26-27-unified-provider-continue`.  
Extends `PZD-26-PROVIDER-AUTH-CONTRACT.md`. Legacy `login` / `link` / `recover` remain compatible.

## Product intent

One Apple button and one Google button. Backend resolves whether the verified
`(provider, subject)` is new or already linked. Clients must not choose
login vs link locally.

## HTTP surface (additive)

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/auth/providers/challenge` | New `purpose=continue`. Guest Bearer optional. With valid guest → binding `continue:{playerId}:{familyId}` returned. Without guest → high-entropy `binding` like login. |
| POST | `/v1/auth/providers/continue` | Body `{ provider, idToken, nonce, binding, localProgressProtected? }`. Optional guest Bearer. |
| POST | `/v1/auth/providers/continue/confirm` | Body `{ continuationToken }` — single-use switch commit. No provider token. |

### Success (201)

Same credential fields as login/link, plus `resolution`:

- `link_guest` — new provider linked to current guest (`player_id` preserved)
- `existing_account` — authenticated previously linked player
- `created_account` — new verified player (no guest session)
- `same_account` — provider already linked to this guest

### Confirmation required (409)

```json
{
  "error": "ACCOUNT_SWITCH_CONFIRMATION_REQUIRED",
  "continuationToken": "<opaque>",
  "expiresAt": "<iso>"
}
```

No credential mutation until `/continue/confirm`. Cancel = do nothing.

## Guest progression predicate

**Server meaningful progression** (any true ⇒ protect):

- Row in `tournament_daily_claim` for guest `player_id`, or
- Row in `tournament_on_time_badge`, or
- Row in `tournament_daily_series_completion`

Tables absent ⇒ treated as no server progression.

**Client** may set `localProgressProtected: true` when local Practice has
completed games or personal bests. If either side flags protection, confirmation
is required. Never trust a client claim that server progression is empty.

## Continuation security

- Short-lived (5 minutes), single-use, server-stored digest.
- Bound to provider subject, target player, optional source guest + family.
- Confirm re-locks identity subject, re-checks immutable link → target.
- No nonce reuse; no provider token persistence; never log continuation secrets.

## Migration

- `0008_provider_continue` — purpose CHECK includes `continue`; `pzd_provider_continuations`.
- Apply only with owner approval on staging (`pzd_staging`).

## Rollout

1. Apply `0008` on staging (owner).
2. Deploy backend with continue routes.
3. Deploy client that calls continue (two-button sheet).
4. Legacy endpoints stay for older builds.

## Compatibility

Existing `/login`, `/link`, `/recover`, `/refresh`, `/logout` contracts unchanged.

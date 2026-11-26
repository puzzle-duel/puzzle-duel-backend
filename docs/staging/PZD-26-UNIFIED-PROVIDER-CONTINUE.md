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
| POST | `/v1/auth/providers/challenge` | New `purpose=continue`. **Absent** Authorization → guestless binding. **Valid guest** → `continue:{playerId}:{familyId}`. **Present but invalid/revoked** Authorization → `401 GUEST_PROOF_REQUIRED` (never guestless). |
| POST | `/v1/auth/providers/continue` | Body `{ provider, idToken, nonce, binding, localProgressProtected? }`. Guest-bound binding requires matching active guest; invalid Authorization never downgrades to account creation. |
| POST | `/v1/auth/providers/continue/confirm` | Body `{ continuationToken }` — single-use switch commit. Revalidates source guest family when present. No provider token. |
| POST | `/v1/auth/providers/recover` | Legacy: `{ …, expectedPlayerId }`. Unified lost-response: `{ …, recoveryKind: "provider_linked" }` — create-forbidden resolve by verified `(provider, subject)` only. |

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
  "expiresAt": "<iso>",
  "targetPlayerId": "<uuid>"
}
```

`targetPlayerId` is an opaque recovery hint (not proof). No credential mutation until
`/continue/confirm`. Cancel = do nothing.

### Confirm authorization

Before consume: lock `source_family_id` (when set), `#requireActiveGuest` (class,
revocation, active refresh), re-check `expires_at`, then single-use consume + issue.
Logout/revoke of the source guest fails closed with `GUEST_PROOF_REQUIRED` and does
**not** consume the continuation (transaction rolls back).

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

## Lost-response recovery

Client must persist a durable unified pending marker **before** the first mutating
`continue` / `confirm` request. Recovery uses `recoveryKind=provider_linked`
(create-forbidden) and requires a **server auth receipt** proving the mutating
operation committed. An existing identity link alone is insufficient — unconfirmed
or cancelled account switches leave no receipt (`RECOVERY_OPERATION_INCOMPLETE`).

Client pending kinds:
- `continue|…` — mutating continue in flight
- `awaiting|…` — confirmation required; user has **not** approved (recovery clears, keeps guest)
- `confirm|…` — user approved; confirm mutate may be in flight (receipt-backed recovery only)

Never treat the source guest id as the expected target for an account switch.

## Migration

- `0008_provider_continue` (+ verify) — purpose CHECK includes `continue`;
  `pzd_provider_continuations`; least-privilege runtime grants.
- `0009_provider_auth_receipts` (+ verify) — upserted on credential-issuing
  continue/confirm; required by `recoverLinked`.
- Apply only with owner approval: `0008` then `0009` on `pzd_staging`.
- Prerequisites: `0005` → `0006` → `0007` already applied.

## Rollout

1. Apply `0008` on staging (owner).
2. Deploy backend with continue routes.
3. Deploy client that calls continue (two-button sheet) with durable pending recovery.
4. Legacy endpoints stay for older builds.

## Compatibility

Existing `/login`, `/link`, `/recover` (expectedPlayerId), `/refresh`, `/logout`
contracts unchanged. `recoveryKind=provider_linked` is additive.

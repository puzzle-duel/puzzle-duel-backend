# PZD-26/27 — Unified provider continue (staging contract addendum)

Status: implemented on `feature/PZD-26-43-auth-lifecycle-stabilization`.  
Extends `PZD-26-PROVIDER-AUTH-CONTRACT.md`. Legacy `login` / `link` / `recover` remain compatible.

## Product intent

One Apple button and one Google button. Backend resolves whether the verified
`(provider, subject)` is new or already linked. Clients must not choose
login vs link locally.

### Phase-1 owner decision (direct existing-account login)

When the verified provider subject already belongs to an existing Puzzle Duel
account, **authenticate that account directly**:

- Preserve the original immutable player ID.
- Do **not** emit `ACCOUNT_SWITCH_CONFIRMATION_REQUIRED` for normal continue.
- Do **not** require a second provider authentication.
- Do **not** display a guest-account decision dialog for returning users.
- Applies even when a different guest scope (with or without progression) is active.

Guest-scoped rows remain under the original guest `player_id` — they are **not**
deleted and **not** merged into the verified account. Local Practice for that
guest stays isolated under the guest Practice scope.

If the provider subject is **new** and a valid guest is present: link that guest
player ID (preserve associated legitimate progression) per existing security
rules. Never merge two existing verified identities.

Recovery-specific flows remain separate from normal authentication.

## HTTP surface (additive)

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/auth/providers/challenge` | New `purpose=continue`. **Absent** Authorization → guestless binding. **Valid guest** → `continue:{playerId}:{familyId}`. **Present but invalid/revoked** Authorization → `401 GUEST_PROOF_REQUIRED` (never guestless). |
| POST | `/v1/auth/providers/continue` | Body `{ provider, idToken, nonce, binding, localProgressProtected? }`. Guest-bound binding requires matching active guest; invalid Authorization never downgrades to account creation. Existing provider → direct `existing_account`. |
| POST | `/v1/auth/providers/continue/confirm` | **Legacy** — Body `{ continuationToken }` — single-use switch commit for older clients that still hold a continuation. Normal continue no longer issues confirmation. |
| POST | `/v1/auth/providers/recover` | Legacy: `{ …, expectedPlayerId }`. Unified lost-response: `{ …, recoveryKind: "provider_linked" }` — create-forbidden resolve by verified `(provider, subject)` only. |

### Success (201)

Same credential fields as login/link, plus `resolution`:

- `link_guest` — new provider linked to current guest (`player_id` preserved)
- `existing_account` — authenticated previously linked player
- `created_account` — new verified player (no guest session)
- `same_account` — provider already linked to this guest

### Confirmation required (409) — legacy only

Older backends/clients may still observe:

```json
{
  "error": "ACCOUNT_SWITCH_CONFIRMATION_REQUIRED",
  "continuationToken": "<opaque>",
  "expiresAt": "<iso>",
  "targetPlayerId": "<uuid>"
}
```

Current continue no longer emits this for normal returning-user login.
`/continue/confirm` remains for tokens already issued.

## Guest progression isolation

Server meaningful progression on a guest (claims, completions, badges joined via
completion) does **not** gate confirmation after Phase-1. Guest rows stay under
the guest `player_id`.

`localProgressProtected` remains on the wire for compatibility and is **ignored**
for confirmation gating.

## Continuation security (legacy confirm)

- Short-lived (5 minutes), single-use, server-stored digest.
- Bound to provider subject, target player, optional source guest + family.
- Confirm re-locks identity subject, re-checks immutable link → target.
- No nonce reuse; no provider token persistence; never log continuation secrets.

## Lost-response recovery

Client must persist a durable unified pending marker **before** the first mutating
`continue` / `confirm` request. Recovery uses `recoveryKind=provider_linked`
(create-forbidden) and requires a **server auth receipt** proving the mutating
operation committed. An existing identity link alone is insufficient.

## Migration

- `0008_provider_continue` (+ verify) — purpose CHECK includes `continue`;
  `pzd_provider_continuations`; least-privilege runtime grants.
- `0009_provider_auth_receipts` (+ verify) — insert-once per `operation_id`.
- Already applied on staging — **do not modify contents/checksums**.

## Compatibility

Existing `/login`, `/link`, `/recover` (expectedPlayerId), `/refresh`, `/logout`
contracts unchanged. `recoveryKind=provider_linked` is additive.

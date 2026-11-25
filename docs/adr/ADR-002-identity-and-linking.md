# ADR-002 — Player identity and external providers
Status: Proposed
Internal immutable player ID; linked providers stored with unique (provider, provider-subject). Verify Apple and Google assertions on server including issuer, audience, expiry, nonce where appropriate; do not accept bare client IDs. A guest-to-account upgrade must be explicitly consented and transactionally reconciled. Avoid merges based only on email; plan conflicts/multi-device recoverability and age/privacy requirements.

## PZD-26 implementation direction (owner decisions, 2026-11-24)
Status remains Proposed; this amendment records the scoped implementation direction, not blanket ADR acceptance. Jira PZD-26 comment 10597 and PZD-27 comment 10598.

- Verify Apple and Google assertions directly on the backend; Firebase Auth is not an identity broker. Crashlytics remains independent.
- Guest launch and Practice remain available. Verified Apple or Google identity is mandatory before official ranked tournament entry, including staging. Reject guest claims before attempt consumption with RANKED_AUTH_REQUIRED.
- Explicit guest linking preserves the immutable player ID. Existing provider ownership conflicts fail without merging. Unknown provider subject on explicit login creates a new player.
- Use the existing shared refresh endpoint with secure rotation and revocation. Provider verification and backend session issuance are distinct trust boundaries.
- No production activation or changes to gameplay, scoring, writer fencing or historical records are authorized by this amendment.

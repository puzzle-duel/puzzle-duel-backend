# ADR-002 — Player identity and external providers
Status: Proposed
Internal immutable player ID; linked providers stored with unique (provider, provider-subject). Verify Apple and Google assertions on server including issuer, audience, expiry, nonce where appropriate; do not accept bare client IDs. A guest-to-account upgrade must be explicitly consented and transactionally reconciled. Avoid merges based only on email; plan conflicts/multi-device recoverability and age/privacy requirements.

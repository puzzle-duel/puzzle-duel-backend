# Backend quality gates
1. Format/lint/types/tests and migration validation on PR once app scaffolding exists.
2. Canonical replay fixtures shared with client (same results, direction, blocked cells, overlap and wave score).
3. Integration tests with DB: unique identities, concurrent first attempts, idempotent retry, race on score submit.
4. Adversarial tests: forged provider JWT, invalid token audience/issuer, tampered move list, impossible score, replay, DoS-sized payload.
5. Operational checks: isolate SportsDash, verify backup/restore and secret hygiene. Report tests NOT_RUN honestly until runnable.

# AGENTS.md — Puzzle Duel Backend (binding for coding agents)
## Authority
Read `BLUEPRINT.md`, `docs/features/`, applicable `docs/adr/` and relevant contracts before changes. Backend owns ranked truth; do not modify client repo as side effect.
Accepted ADRs are binding; Proposed ones require owner decision. When unclear STOP and raise an explicit question, never add speculative endpoints or product behaviors.

## Invariants
- Keep a distinct Puzzle Duel service, database/schema, credentials, logs and deploy units from SportsDash; shared host does not mean shared trust/data boundary.
- Server-issued versioned board + piece stream + blocked coordinates; verify all submitted moves by deterministic replay, **never trust a client score**.
- Validate game version and challenge ID; atomic one-official-attempt rule, idempotent retries, no duplicate ranking by replay, handle races and account linking carefully.
- Principal is an internal player ID. External Apple/Google IDs are provider-scoped, verified server-side. Guest identity upgrade never blindly merges identities; never trust email alone.
- Partition leaderboards per challenge/ruleset/difficulty; define all-time ranking math explicitly before implementation.
- Use transactional limits, rate limiting, safe request size constraints, structured logging without raw credentials/tokens, minimal personal data; no fake competitors.
- No paid boosts impacting ranking, no tournament or Monster rollout in MVP.

## Security and deployment
No secrets or live config in public repo, fixtures, actions logs or PRs. Do not change SportsDash services, network bindings, DB or secrets without approved infrastructure ADR. Feature flags for risky changes, safe migrations, backups/restore and health checks required before production.
Require API contract tests, replay vectors matching client, concurrency/idempotency/security tests, error path tests and migrations with rollback guidance. Format/lint/test reports must state what actually ran.
Work on branch/PR only. Never merge, deploy, change infra or provision paid resources without explicit approval.

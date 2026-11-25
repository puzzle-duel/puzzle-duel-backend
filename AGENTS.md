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

## Mandatory staging observability reading gate — EVERY backend task
Before any endpoint, auth/session, request, diagnostics, staging/CD or logging change, read the [client canonical staging observability release gate](https://github.com/puzzle-duel/puzzle-duel-client/blob/version/0.0.2/docs/staging/STAGING-OBSERVABILITY-RELEASE-GATE.md) and backend `.github/workflows/staging-diagnostic-status.yml`, `src/diagnostics/http-correlation.mts`, `src/diagnostics/report-store.mts`, `src/staging/staging-server.mts`. Preserve the same 32-lowercase-hex `x-request-id` from the client, safe route/status/duration/error-code logging and Report ID/Request ID correlation. Keep all event/schema allowlists and privacy constraints synchronized across client, backend and Inspector. Never claim end-to-end verification from passing CI alone; identify NOT_RUN UAT. The named Gökhan/Serap test-player provisioning/enrollment was reverted; do not restore it for logging work. No gameplay or animation changes.

## Security and deployment
No secrets or live config in public repo, fixtures, actions logs or PRs. Do not change SportsDash services, network bindings, DB or secrets without approved infrastructure ADR. Feature flags for risky changes, safe migrations, backups/restore and health checks required before production.
Require API contract tests, replay vectors matching client, concurrency/idempotency/security tests, error path tests and migrations with rollback guidance. Format/lint/test reports must state what actually ran.
Work on branch/PR only. Never merge, deploy, change infra or provision paid resources without explicit approval.

## Mandatory post-development summary (GOLDEN RULE)
After every meaningful milestone, implementation, bug fix, refactor, or review remediation, deliver a development summary to the owner **in Turkish** (keep file names and technical identifiers in English) and record the same summary on the corresponding Jira issue. The summary must cover: what changed, why, how it works, files, impact, decisions, executed tests with actual results, GitHub branch/SHA/PR/CI, Jira status/comments, remaining work, next step, and whether owner action is required. Do not treat a milestone as complete until this summary is delivered. Providing a summary does not by itself require stopping for approval unless a real approval gate was reached.

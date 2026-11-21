# PZD-49 staging runtime bootstrap (not ranked API)

This entrypoint intentionally exposes only GET /healthz, with live DB connectivity.
All other paths return 404. No UAT token issuance, no migration execution, no
ranked HTTP, no gameplay/animation changes. It is **not** a complete tournament
staging API. Never enable the GitHub CD gate or expose it publicly on this basis.

Preconditions: PostgreSQL 18 on localhost, dedicated pzd_staging database and
unprivileged pzd_staging_app credentials, Node 26 in /opt/pzd-node26.

Create the private %h/pzd-staging/staging.env file (mode 0600) with:
PZD_RUNTIME_PROFILE=staging
PZD_RANKED_HTTP_ENABLED=false
PZD_STAGING_DATABASE_URL=postgresql://pzd_staging_app:<secret>@127.0.0.1:5432/pzd_staging

The sample systemd user unit uses the isolated Node 26 binary. Do not install
it or enable CD until the runtime, migration/role model, and secrets are reviewed.
The existing deployment script requires a separate explicit CD approval sentinel.

Next gate: replace bootstrap-only handler with an independently reviewed staging
tournament HTTP composition using real auth, least-privilege DB roles, preflight
schema validation and no implicit DDL. Verify migrations, backup/restore,
rollback, security and end-to-end tests before external exposure.

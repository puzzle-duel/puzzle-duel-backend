# PZD-49 — Isolated staging CD (Forest Dash shared host)

> **CURRENT CONFIGURATION (2026-11-22):** Read [docs/staging/SERVER-CONFIG.md](../../docs/staging/SERVER-CONFIG.md) first. This older PZD-49 plan retains historical, superseded gates/status. **Oracle IP is 84.13.66.211**, backend CD is deployed on `version/**` pushes; the public HTTPS staging endpoint remains **unverified/broken**. Do not rely on the old “not deployed” text or `APPROVED_FOR_CD` instructions below.

## Status
Pipeline code prepared on PZD-49 branch. **Not deployed or end-to-end validated.** The existing Forest Dash service is not a deployment target. Production will use a separate server and remains subject to PZD-45.

## GitHub Actions
`.github/workflows/staging-cd.yml` verifies Node 26 typecheck, Stage F1 auth tests, Stage F2 tests and shell syntax on PR. On main push, deploy is additionally gated by repository variable `PZD_STAGING_CD_ENABLED=true`, the protected `pzd-staging` GitHub environment and successful verification. Keep the variable **unset/false** until initial host setup and owner approval.

The `pzd-staging` environment must be created with restricted deployment branches, required reviewers and these dedicated secrets:
- `PZD_STAGING_HOST` — Oracle VM host (not a URL).
- `PZD_STAGING_USER` — dedicated unprivileged Puzzle Duel deploy account.
- `PZD_STAGING_SSH_PRIVATE_KEY` — dedicated SSH private key, **not** the Forest Dash production deploy key.
- `PZD_STAGING_SSH_KNOWN_HOSTS` — verified pinned SSH host key.

Never copy Forest Dash secret values to source, PR text, or logs. Repository secrets are not shared automatically.

## Host provisioning prerequisites — explicit owner approval required
1. Inspect VM memory/disk/CPU, PostgreSQL 18 support, firewall, DNS/TLS and existing Forest Dash/Caddy/service resources **read-only**.
2. Provision isolated `pzd-staging` Linux user, HOME-owned `~/pzd-staging/releases` and `~/pzd-staging/APPROVED_FOR_CD` approval sentinel. Use separate DB `pzd_staging`, roles, backup/restore and secrets. Do not use `pzd_ingress`, Forest Dash DB or production DB.
3. Install Node 26, npm, curl, systemd user-service with lingering as approved. Create a dedicated `pzd-staging.service` that runs the **approved non-production** server from `~/pzd-staging/current`. Keep it loopback-only on 127.0.0.1:8787 with a safe `GET /healthz` returning 2xx without auth; validate health route does not bypass ranked feature gates.
4. Explicitly approve migrations and initial DB provisioning separately; **deployment script never runs migrations**. Run verified migrations and `pg_dump/pg_restore` checks using least-privilege role, with a recovery plan.
5. Test a manual staging rollout, confirm Forest Dash service unaffected, test rollback and log correlation, then set GitHub environment/reviewers and enable variable `PZD_STAGING_CD_ENABLED=true`.

## Deploy semantics
The workflow archives source at the triggering SHA, copies it by pinned-host SSH, and invokes `ops/staging/deploy-remote.sh` as dedicated account. The remote script rejects unprovisioned hosts and absent approval sentinel, extracts into a new SHA-named release, installs production dependencies, switches the `current` symlink, restarts **only** the `pzd-staging.service` user unit, and probes `http://127.0.0.1:8787/healthz`. On restart/health failure it restores the previous release symlink and restarts that service (or stops on first install). **No database rollback.** No privileged sudo commands or Caddy/Forest Dash modifications are performed.

## Outstanding hard gates
The current backend UAT entrypoint is explicitly test-only and not proven suitable for remote staging. A secure staging runtime, verified health endpoint, environment secrets, isolated DB provisioning, VM access and live smoke test are **NOT_RUN**. Do not enable CD variable or create approval sentinel before these are reviewed. No production ranked HTTP, production migration, production provisioning or production deploy is authorized.

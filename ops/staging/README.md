# PZD-49 — Puzzle Duel staging deployment boundary

Status: READINESS ONLY — no server mutation, secrets provisioning, migration, or deployment authorized.

## Environments
- STAGING: existing Forest Dash Oracle VM, but Puzzle Duel must have its own unprivileged deployment identity, working directory, systemd service/container, PostgreSQL 18 database and least-privilege roles, persistent data, logs, network binding, and secrets. Do not restart or modify Forest Dash.
- PRODUCTION: a newly provisioned independent host in a later task. Never use the Forest Dash VM for Puzzle Duel production.

## Before enabling a real deployment job
1. Read AGENTS.md, BLUEPRINT.md, applicable Accepted ADRs, and docs/process/PZD-OPS-001-continuous-review.md. Confirm infrastructure ADR approval where required.
2. Read-only audit VM architecture, free disk/RAM, firewall, Caddy config, service ownership, DNS/TLS, PostgreSQL compatibility, and backup/restore policy.
3. Define a dedicated staging runtime entrypoint and explicit /healthz + smoke contract. Do not infer production readiness from the UAT server.
4. Create GitHub **staging** environment and dedicated scoped secrets for host, user, pinned SSH known_hosts, and private key. Never copy secret values into source or logs. A Forest Dash repo secret is not shared across repositories.
5. Confirm migration/rollback plan with backup and pg_dump/pg_restore evidence. Application rollback does not imply database rollback.
6. Require CI PASS, immutable commit/artifact identity, concurrency lock, health check, audit log and manual approval for initial host changes.
7. Verify Forest Dash remains operational before/after the isolated staging deployment.

## Current workflow
`.github/workflows/staging-cd.yml` intentionally performs **readiness validation only** on PR or manual dispatch. It does not connect to SSH, read deployment secrets, run migrations, or deploy. This is not a completed CD pipeline.

## Explicit prohibitions
No production deploy, production ranked HTTP, production database changes, automatic DB rollback, or host provisioning. PZD-45 remains the independent production release gate.

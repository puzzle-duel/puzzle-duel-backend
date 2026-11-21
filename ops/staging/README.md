# PZD-49 staging CD — version branch gate

## Implementation status
Code prepared on feature branch; NOT deployed or end-to-end verified. Production ranked HTTP remains disabled. Only pushes to version/* (after merge) may deploy when PZD_STAGING_CD_ENABLED=true and protected pzd-staging environment permits it. PRs verify only. No staging deployment from development/main/master.

## Existing Oracle staging host requirements
The deployed pzd-staging.service is a **system-level** service, not a systemd user unit. Dedicated SSH account must own /home/pzd-staging/pzd-staging/releases, current symlink, and staging release archive; no unrelated app access. Pre-provision a narrow sudoers rule for **only** /usr/bin/systemctl restart pzd-staging.service and /usr/bin/systemctl stop pzd-staging.service. Confirm the exact binary path and account before enabling CD. Do not grant generic systemctl or unrestricted sudo. Existing staging service configuration, runtime env, and loopback port 8787 must remain unchanged.

## Database gate (fail closed)
Apply versioned migrations through a separately authorized migration owner on the isolated pzd_staging database; verify schema migration ledger through 0012 and ensure rollback/backup plan. Apply ops/staging/staging-runtime-grants.sql with migration-owner privileges to fix PostgreSQL FOR SHARE UPDATE requirement and grant migration-ledger SELECT to app role. The SQL refuses any database other than pzd_staging. Only after these checks, an authorized operator/provisioner creates /home/pzd-staging/pzd-staging/SCHEMA_READY_FOR_CD. This sentinel is a *provisioning gate*, NOT proof that later schema changes are compatible. Any new migration must invalidate and revalidate the gate; add automated per-release migration orchestration before claiming hands-free CD.

## GitHub configuration
Protected environment pzd-staging, restricted to version/*, plus repository variable PZD_STAGING_CD_ENABLED=true only after host provisioning and a dry run. Required environment secrets: PZD_STAGING_HOST, PZD_STAGING_USER, PZD_STAGING_SSH_PRIVATE_KEY, PZD_STAGING_SSH_KNOWN_HOSTS (pinned, independently verified). No credentials in source or logs.

## Deploy behavior and remaining blockers
Deploy script creates immutable SHA release, installs Node 26 production deps, checks schema gate, atomically swaps current, restarts only the staging system service, checks /healthz, and restores prior application symlink on failed restart/health. Database rollback is NOT attempted. Must still add authenticated guest/session/claim smoke tests, safe migration automation per release, deployment audit correlation, and backend-client SHA manifest/Firebase distribution dependency. Existing workflow does not yet provide full hands-free CD. Never enable production ranked HTTP or modify game mechanics/animations.

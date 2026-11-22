# PZD-50 — Staging-only same-device recovery rollout

**Status:** NOT DEPLOYED / NOT ENABLED. Do not use as a production or UAT approval.

## Why two separate gates?

The backend's staging composition currently omits `sameDeviceRecovery`, and the existing original writer claims were created without a pinned device credential. The client therefore sees `404 NOT_FOUND` from device-registration / recovery endpoints and may later receive `409 WRITER_NOT_AUTHORIZED` when sending a command from a new session.

Both behaviors must be investigated without weakening writer fencing or overwriting existing claims. The recovery credential anchor is immutable: **only new, original claims can acquire it during the original session**. An old series with a NULL anchor stays blocked. No silent backfill.

## Phase 1 — Read-only Oracle preflight (no schema changes)

Run [PZD Staging Writer Recovery DB Preflight](https://github.com/puzzle-duel/puzzle-duel-backend/actions/workflows/staging-recovery-preflight.yml) on `version/0.0.2`. The job connects to the existing `pzd_staging` database on Oracle with pinned SSH host key and the dedicated staging environment. It outputs only booleans for PostgreSQL 18, required tables/columns, and whether active unanchored historical claims exist. No credentials, player IDs, series IDs or raw sessions leave the Oracle machine.

If the action cannot read the environment or connect read-only, stop. Do not grant the CI user broad database admin rights or copy secrets into logs.

## Phase 2 — Operator backup and staging schema migration (separate approval)

**Do not merge/enable recovery without an operator-approved transaction and verified backup.** The file `migrations/staging/0001_same_device_writer_recovery.sql` is explicitly **NOT** a Stage F2 migration. It must never run on production or `pzd_ingress` and refuses databases other than `pzd_staging`. It requires the guest auth and verified-session schema to already exist.

Execute with an authorized migration role using a locally secured connection to the isolated DB. Do not use the app's runtime credentials for DDL. Confirm the migration is idempotent, has the expected migration-owner permissions, and verify the backup/restore plan. It adds a device credential table, an authenticated-session credential column, an original-writer credential column and a recovery challenge table. It does not update prior claim/writer/session data.

Run the read-only preflight again; schema completeness must be true. Independently verify least privilege and no unintended changes to existing claims, writers, fence states or leaderboard rows.

## Phase 3 — Release staging code, then opt in explicitly

Only after CI/independent security review and database readiness, merge the backend feature branch to `version/0.0.2`. This deploys code with recovery **disabled by default**. When operational readiness is independently confirmed, the staging operator can enable `PZD_STAGING_SAME_DEVICE_RECOVERY_ENABLED=true` in the private server environment and restart **only** `pzd-staging.service`. No production config, Caddy or Forest Dash changes.

The startup guard refuses recovery if required tables/columns are missing; the server's existing Stage F2 migration guard remains mandatory. To roll back feature activation, remove/disable the recovery flag and restart only staging. Never delete data or try to reverse the forward-only schema migration as a quick rollback.

## Phase 4 — Proof-of-possession regression and iPhone UAT

- Launch the new staging iOS build, register a device key on the verified session, claim a NEW UTC daily manifest and verify that the original writer credential is pinned.
- Relaunch with the same live session: GET session 200, same writer, resume board; no new session or handoff.
- If the old session expires, prove same-device key is registered and challenge/signature/session identity all match. Recovery may proceed only after old writer expiry and while series deadlines allow; exactly the same signed retry is idempotent.
- A foreign device key, different player, still-active original writer, expired challenge, changed generation, or unanchored old series MUST deny without changing scores, board revision or writer.
- Check Firebase breadcrumbs and the safe GitHub Log Inspector by x-request-id; verify HTTP route category, 409 reason and client response agree.
- Home startup `NOT_FOUND` must NOT be localized as “Hamle kabul edilmedi”; game-board rejection messages remain unchanged.

**Important:** An existing pre-feature daily manifest with a NULL original credential anchor **cannot** be recovered through this new protocol. Preserve its data and record the UAT as blocked for that series rather than silently seizing the writer.

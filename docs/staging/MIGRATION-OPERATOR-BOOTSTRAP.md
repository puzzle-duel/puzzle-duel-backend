# PZD-50 — One-time operator bootstrap for the reusable staging migration Action

This setup **does not execute any database migration**. It establishes the required independent GitHub approval and PostgreSQL roles while keeping credentials outside ChatGPT and the GitHub repository.

## 1. GitHub environment (on operator Mac)

Prerequisites: `gh auth login`, repo **Admin** rights, a *different* GitHub user with read access to the repository who can review deployment requests, and the previously pinned Oracle SSH host key at `~/.ssh/known_hosts`.

```bash
cd ~/Desktop/workspace/puzzle-duel-backend
git fetch origin
git switch version/0.0.2
git pull --ff-only origin version/0.0.2
# After this setup PR has been merged:
bash ops/staging/migrations/setup-github-environment.sh OTHER_REVIEWER_GITHUB_LOGIN
```

The script creates `pzd-staging-migrations` with **required reviewers**, **prevent_self_review=true**, and an **exact `version/0.0.2` deployment branch policy**. It refuses if the environment already exists, if you are the reviewer, the branch policy cannot be verified, or permissions are insufficient. It generates a new SSH key `~/.ssh/pzd-staging-migrations` if absent and uploads the private key and pinned known-host entry as **environment secrets**, not as repository secrets. It never prints the key.

**GitHub admin warning:** If the environment already exists, review it through [GitHub Environments](https://github.com/puzzle-duel/puzzle-duel-backend/settings/environments); do not overwrite existing protection rules blindly. If GitHub denies required reviewers under your repository plan, stop; do not replace them with self-approval. The deployment workflow contains an independent hard `version/0.0.2` branch check, but that is not a substitute for deployment review.

## 2. Install new *public* SSH key on Oracle (operator action)

The generated public key must be added to the `pzd-staging` account's authorized keys after verifying Oracle host identity:

```bash
ssh-copy-id -i ~/.ssh/pzd-staging-migrations.pub pzd-staging@84.13.66.211
ssh -i ~/.ssh/pzd-staging-migrations -o IdentitiesOnly=yes pzd-staging@84.13.66.211 'whoami'
```

Expected username: `pzd-staging`. Do not share the private key. **Caveat:** This workflow uses a *dedicated key* but currently the same staging Unix identity; true OS-user isolation would require separate permissions on the migration workspace and is a future hardening task. Do not claim Unix-account separation that has not been provisioned.

## 3. Provision PostgreSQL migration/backup identities (Oracle admin action)

Sign in with an Oracle administrator account that is authorized to use the local postgres OS account. With the reviewed repo checked out on the VM or SQL copied from the repo, run:

```bash
# On the Oracle VM; supply the reviewed SQL through stdin if its path is private:
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d pzd_staging \
  < /path/to/reviewed/ops/staging/migrations/provision-db-roles.sql
sudo -u postgres psql -X -d pzd_staging
```

Inside the *interactive* psql console:

```text
\password pzd_staging_migrator
\password pzd_staging_backup
\q
```

The SQL checks the `pzd_staging` database and PostgreSQL 18, creates or updates two **non-superuser** login roles, grants `SET ROLE pzd_migration_owner` to the migrator only, and grants `pg_read_all_data` to the backup login. It never grants owner DDL to `pzd_app_runtime`. Passwords are set interactively to avoid command-line, history and PR exposure.

The backup role's full-database dump ability and the migration login's privilege must be reviewed independently; PostgreSQL admin privileges must not be passed to Actions.

## 4. Private libpq service configuration (Oracle staging Unix account)

Create a regular mode-`0600` file on Oracle:

`/home/pzd-staging/pzd-staging/migration-services.conf`

Enter the two `pzd_staging_migrate` and `pzd_staging_backup` sections shown in [REUSABLE-MIGRATIONS.md](REUSABLE-MIGRATIONS.md). Use the freshly set passwords locally. Avoid sending them in a chat, copying them into screenshots or recording them in your shell history.

Required on Oracle:

```bash
stat -c '%a %U %n' /home/pzd-staging/pzd-staging/migration-services.conf
# Expected: 600 pzd-staging ...
psql --version
pg_dump --version
pg_restore --version
```

All three PostgreSQL binaries must support PostgreSQL 18; check disk space for a full database archive and conduct a restore rehearsal before authorizing `apply`.

## 5. Plan only

[Open reusable Staging Database Migration Action](https://github.com/puzzle-duel/puzzle-duel-backend/actions/workflows/staging-db-migrations.yml) → Run workflow:

- Branch: `version/0.0.2`
- Migration: `0001_same_device_writer_recovery`
- Mode: `plan`
- Confirmation: empty

After required environment approval, expect `Staging PostgreSQL 18 and separate migration/backup roles: PASS`, `History: NOT APPLIED`, `PLAN ONLY`.

**STOP if this fails.** A PLAN success is not a backup or restore test.

## 6. Apply only after operator approval and restore readiness

Separate Action run, same migration, `apply`, confirmation exactly:

`APPLY pzd_staging 0001_same_device_writer_recovery`

The action performs a local-only dump, archive list check, one transaction, migration checksum history and post-commit verification. Independently rerun the [read-only recovery schema preflight](https://github.com/puzzle-duel/puzzle-duel-backend/actions/workflows/staging-recovery-preflight.yml). Only then can recovery be enabled in the staging service separately and tested from a *new* iPhone claim. **The existing unanchored manifest will never be forcibly migrated or recovered.**

**Current state:** GitHub environment, Oracle passworded DB roles/service file, action `plan` and `apply` must be individually verified. Code/PR preparation alone does not prove they exist.

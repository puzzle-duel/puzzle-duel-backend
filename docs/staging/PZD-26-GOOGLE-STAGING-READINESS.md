# PZD-26 — Google staging readiness (2026-11-25)

Evidence collected from live Oracle staging. **No migrations applied and no `staging.env` mutation performed by this task.**

## Verified facts

| Item | Evidence |
|---|---|
| Public HTTPS origin | `https://84-13-66-211.sslip.io` — `/healthz` HTTP 200 (trusted TLS) |
| Deployed release SHA | `b340f7d1cc63bab2cbdc96dd1c5907f267a697ec` (`current` → `releases/b340f7d…`) |
| CD run | https://github.com/puzzle-duel/puzzle-duel-backend/actions/runs/45605645083 (PR #74 merge) |
| Guest auth | `POST /v1/auth/guest` → **201** (compatible) |
| Provider challenge | `POST /v1/auth/providers/challenge` → **404 NOT_FOUND** (routes unmounted) |
| `PZD_STAGING_GOOGLE_AUDIENCES` | **MISSING** in `/home/pzd-staging/pzd-staging/staging.env` |
| `PZD_STAGING_APPLE_AUDIENCES` | **MISSING** (OK for Google-only UAT) |
| `pzd_provider_challenges` | **absent** |
| `pzd_identity_links` | **absent** |
| `pzd_guest_accounts.account_class` | **absent** |
| Guest tables / refresh retry column | present |
| Last applied staging migrations (GH Actions) | through `0004_named_device_enrollment` (2026-11-23). **0005/0006/0007 never applied.** |

Provider HTTP mounts only when migrations 0005–0007 readiness checks pass (`detectProviderSchemaReady` + `detectIdentityImmutabilityReady`). Missing schema → routes absent → 404 (not a client bug).

## Required audience list (narrow)

Google ID tokens issued with `serverClientId` use:

- `aud` = Web / Server Client ID
- `azp` = iOS Client ID

Verifier rejects when `azp` is present but not in the audience allow-list. Therefore set:

```bash
PZD_STAGING_GOOGLE_AUDIENCES=450107669068-a4l8vrgas78rqdm8aou7kvnhsldkafbi.apps.googleusercontent.com,450107669068-b0l835r1cv1mfga7h3ovdd1hjte0tfse.apps.googleusercontent.com
```

Do **not** add the Android debug client ID for this Google-iOS UAT. Leave `PZD_STAGING_APPLE_AUDIENCES` unset; Google operates independently when Apple audiences are empty (per-provider audience check).

These are OAuth client identifiers, not secrets. No Google client secret. No Firebase Auth.

## Owner-executable plan (approval required before apply)

### A. Plan migrations (read-only)

From GitHub Actions → [PZD Reusable Staging Database Migration](https://github.com/puzzle-duel/puzzle-duel-backend/actions/workflows/staging-db-migrations.yml) on branch `version/0.0.2`, run **plan** (empty confirmation) for each:

1. `0005_provider_challenges`
2. `0006_provider_identity`
3. `0007_identity_immutability`

### B. Apply migrations (mutating; separate approvals)

For each ID, run **apply** with exact confirmation `APPLY pzd_staging <id>` and environment reviewers. Order is mandatory: 0005 → 0006 → 0007. Never reset/delete `pzd_staging`.

### C. Configure Google audiences + restart (Oracle)

```sh
ssh -i ~/.ssh/pzd-staging-migrations -o IdentitiesOnly=yes pzd-staging@84.13.66.211
# Edit private env (mode 0600). Do not paste secrets into chat/git.
umask 077
ENV=/home/pzd-staging/pzd-staging/staging.env
grep -q '^PZD_STAGING_GOOGLE_AUDIENCES=' "$ENV" \
  && sed -i.bak 's|^PZD_STAGING_GOOGLE_AUDIENCES=.*|PZD_STAGING_GOOGLE_AUDIENCES=450107669068-a4l8vrgas78rqdm8aou7kvnhsldkafbi.apps.googleusercontent.com,450107669068-b0l835r1cv1mfga7h3ovdd1hjte0tfse.apps.googleusercontent.com|' "$ENV" \
  || printf '\nPZD_STAGING_GOOGLE_AUDIENCES=450107669068-a4l8vrgas78rqdm8aou7kvnhsldkafbi.apps.googleusercontent.com,450107669068-b0l835r1cv1mfga7h3ovdd1hjte0tfse.apps.googleusercontent.com\n' >> "$ENV"
chmod 600 "$ENV"
systemctl --user restart pzd-staging.service 2>/dev/null || systemctl restart pzd-staging.service
curl -sS --max-time 5 http://127.0.0.1:8787/healthz
curl -sS -i --max-time 5 -X POST http://127.0.0.1:8787/v1/auth/providers/challenge \
  -H 'Content-Type: application/json' -H 'X-Forwarded-Proto: https' \
  -d '{"provider":"google","purpose":"login"}'
# Expect HTTP 201 with nonce (never log the nonce value into Jira/git).
```

If the unit is system-managed rather than user-managed, use the existing operator restart path for `pzd-staging.service` only. Do not touch Forest Dash / Caddy.

### D. External smoke (Mac)

```sh
curl -fsS https://84-13-66-211.sslip.io/healthz
curl -sS -i -X POST https://84-13-66-211.sslip.io/v1/auth/providers/challenge \
  -H 'Content-Type: application/json' \
  -d '{"provider":"google","purpose":"login"}'
# Expect 201. 404 = schema not ready. 503 AUTH_UNAVAILABLE = audiences missing.
```

## Non-goals

- No live migration/apply from this document alone without owner approval.
- No production deploy.
- No weakening of nonce / signature / issuer / audience / azp / expiry checks.
- No Apple enrollment requirement for Google-only staging UAT.


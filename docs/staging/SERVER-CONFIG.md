# Puzzle Duel — Oracle staging server configuration (source of truth)

**Updated:** 2026-11-22  
**Environment:** staging only — not production  
**Canonical file:** `puzzle-duel-backend/docs/staging/SERVER-CONFIG.md`  
**Release branch currently in use:** `version/0.0.2`

> READ THIS FIRST before asking for the staging server/IP/domain, issuing an iOS build command, or changing the staging deployment. Never guess a hostname. The configured name `staging.puzzle-duel.app` is **NOT a working public endpoint** at the last verified check.

## 1. Fixed server inventory

| Item | Recorded value | Evidence / caveat |
| --- | --- | --- |
| Cloud | Oracle Cloud Infrastructure (OCI), ARM A1.Flex VM | Existing operator environment |
| VM hostname | `forest-dash-vnic` | Observed Oracle SSH prompt |
| Public IPv4 | **`84.13.66.211`** | Reached on TCP/443 from Mac; IP can change if OCI networking changes |
| OS | Ubuntu 24.04 | Existing provisioning context; verify after OS changes |
| Dedicated Linux account | `pzd-staging` | Separate from Forest Dash |
| Account home | `/home/pzd-staging` | Deployment script |
| Root deployment directory | `/home/pzd-staging/pzd-staging` | Deployment script |
| Active code symlink | `/home/pzd-staging/pzd-staging/current` | Deployment script |
| Immutable releases | `/home/pzd-staging/pzd-staging/releases/<full-commit-sha>` | Deployment script |
| Deployment archive | `/home/pzd-staging/pzd-staging-release.tgz` | Deployment script |
| Runtime env file | `/home/pzd-staging/pzd-staging/staging.env` (private; mode 0600) | Do not print or commit secret values |
| Node executable | `/opt/pzd-node26/bin/node` (Node 26) | systemd and deploy scripts |
| systemd unit | `pzd-staging.service` | Dedicated staging service |
| Node binding | **`127.0.0.1:8787`** — loopback only | `src/staging/staging-server.mts` |
| Database | Local PostgreSQL 18, database **`pzd_staging`** | Isolated; actual credentials private |
| DB URL config name | `PZD_STAGING_DATABASE_URL` | Must refer to localhost and DB `pzd_staging` |
| Forest Dash | Separate co-resident application | **DO NOT** restart/change its service, DB, Caddy routing, or files as part of a Puzzle Duel deploy |

**Mac vs Oracle:** `127.0.0.1:8787` works **only on the Oracle VM**, not in macOS/iPhone. `systemctl`, `/etc/caddy/Caddyfile`, `journalctl` are Linux-server commands. Execute them inside the Oracle SSH session, not in the Mac shell.

## 2. Network and HTTPS: CURRENT BLOCKER

- **Actual server address:** `84.13.66.211`. This is the fixed reference for the present VM; do not ask for it again.
- **`staging.puzzle-duel.app` is a proposed/configured hostname, not a deployed/verified domain.** The Mac test `curl https://staging.puzzle-duel.app/healthz` returned `Could not resolve host` on 2026-11-22.
- Mac test `curl -vk https://84.13.66.211/healthz`: TCP/443 connected, **TLS handshake failed** with `tlsv1 alert internal error`.
- Mac test `curl --resolve staging.puzzle-duel.app:443:84.13.66.211 https://staging.puzzle-duel.app/healthz`: same TLS handshake failure. DNS-only bypass did **not** fix TLS.
- A live Caddy hostname was found later in this same revision; see section 2A. Public HTTPS health/TLS has not yet been verified. **Do not use `https://staging.puzzle-duel.app` or `https://84.13.66.211` as if it worked.**
- Existing `ops/staging/Caddyfile.example` is a **template**, not evidence that the live `/etc/caddy/Caddyfile` includes that site. Existing HTTPS/Forest Dash routing must be inspected read-only on the VM before changes.
- The Flutter `GuestAuthClient` **requires HTTPS**. It also checks the JWT `iss` claim `https://staging.puzzle-duel.app`, matching backend staging guest issuer. If adopting a real IP-based or alternate-domain HTTPS origin, explicitly review trusted TLS certificate, public ingress, and issuer config/contract; changing a `--dart-define` alone is not sufficient.
- Never bind port 8787 to the public interface or expose it directly to the internet as a workaround.
- **Decision outstanding:** configure a secure public HTTPS ingress for this Oracle IP, without modifying Forest Dash routes. When functional, record the verified public origin here AND in the client companion document.

## 2A. LIVE CADDYFILE FOUND — 2026-11-22 (operator output)

The operator read **`/etc/caddy/Caddyfile`** on `forest-dash-vnic`; this is the **actual live hostname** rather than the earlier unverified sample:

```caddyfile
:80 {
    root * /var/www/forest-dash

    handle /ws {
        reverse_proxy 127.0.0.1:3001
    }

    handle {
        try_files {path} /index.html
        file_server
    }
}

84-13-66-211.sslip.io {
    reverse_proxy 127.0.0.1:8787
}
```

- **Configured Puzzle Duel staging public hostname:** `84-13-66-211.sslip.io`
- **Verified HTTPS API origin:** `https://84-13-66-211.sslip.io` — Mac external /healthz passed with trusted TLS on 2026-11-22.
- `staging.puzzle-duel.app` is **NOT** the live Caddy hostname. It appears in app/backend code as a **JWT issuer identifier**, which can remain independent of the HTTPS connection origin as long as both sides expect the same issuer.
- **Do not replace or erase the `:80` Forest Dash block**. Its HTTP paths and websocket proxy target `127.0.0.1:3001` are separate from Puzzle Duel.
- DNS/HTTP/TLS smoke test on the Mac (not Oracle): `curl -i --connect-timeout 5 --max-time 12 https://84-13-66-211.sslip.io/healthz`. Expect `200` with a trusted certificate. Do not use `-k` as evidence that iOS will trust TLS.
- That Mac test succeeded on 2026-11-22; see external verification below.

### External HTTPS verification — PASS (2026-11-22, Mac)

The operator ran `curl -i --connect-timeout 5 --max-time 12 https://84-13-66-211.sslip.io/healthz` **without `-k`** and obtained:

```text
HTTP/2 200
server: Caddy
content-type: application/json
x-request-id: 65fafbc00cb4ff3dc4c14bf2eeeaa713
{"status":"ok","service":"pzd-staging-bootstrap"}
```

**VERIFIED PUBLIC STAGING HTTPS ORIGIN: `https://84-13-66-211.sslip.io`**. TLS validation and the public `/healthz` route pass from Mac. This does not by itself verify guest auth, tournament endpoints, iPhone TLS, or a full cold-start UAT.

## 3. Server runtime configuration — names, not secret values

`src/staging/staging-server.mts` validates:
- `PZD_RUNTIME_PROFILE=staging`
- `PZD_RANKED_HTTP_ENABLED` must **not** be `true` (global production ranked mode is forbidden in staging)
- `PZD_STAGING_HOST=127.0.0.1` (or unset, defaults to loopback)
- `PZD_STAGING_PORT=8787` (or unset)
- `PZD_STAGING_DATABASE_URL` must exist and target local `pzd_staging`
- `PZD_STAGING_GUEST_AUTH_ENABLED=true` required when `PZD_STAGING_TOURNAMENT_ENABLED=true`
- `PZD_STAGING_GUEST_SIGNING_KEY_FILE` and `PZD_STAGING_GUEST_SIGNING_KID` are staging guest signer configuration; values must remain private where appropriate
- `PZD_F2B_PROVENANCE_KEY` is tournament provenance configuration; do not expose value
- `PZD_UAT_APPLY_MIGRATIONS=1` is forbidden: migrations are NEVER automatic on startup/deployment

The last observed local route test on the Oracle VM:
```text
POST http://127.0.0.1:8787/v1/diagnostics/reports
(no Authorization or session secret)
HTTP/1.1 401 Unauthorized
{"error":"UNAUTHENTICATED"}
```
This proves the endpoint was mounted/reached, **not** that authenticated report submission or public HTTPS works. Staging tournament leaderboards and profile require authenticated session/access.

## 4. GitHub deployment — backend only

| Item | Value |
| --- | --- |
| Repository | `puzzle-duel/puzzle-duel-backend` |
| Automatic deployment branches | Every backend `version/**` **push** |
| Workflow | `.github/workflows/staging-cd.yml` |
| GitHub environment | `pzd-staging` |
| Predeploy gate | Node 26 typecheck, staging tests, shell checks |
| Deploy target | OCI via pinned-host SSH and dedicated `pzd-staging` |
| Secret **names** (values never committed) | `PZD_STAGING_HOST`, `PZD_STAGING_USER`, `PZD_STAGING_SSH_PRIVATE_KEY`, `PZD_STAGING_SSH_KNOWN_HOSTS` |
| Deploy operation | SHA-keyed release → `current` symlink → restart only `pzd-staging.service` → local `/healthz` |
| Failure handling | Roll back symlink and restart staging service; **database migrations are not rolled back** |
| CD approvals | The workflow and remote script no longer require the old repository variable/approval sentinel; verify GitHub environment settings independently |
| Confirmed successful CD | `version/0.0.2` SHA `a3b0d34b685c73e582c2a7ebd945d935c1c9f574`; Actions run `45003923513` |
| Last documented backend diagnostic change | Request-ID correlation to `/home/pzd-staging/pzd-staging/http-diagnostics.log` |

Workflow URL: https://github.com/puzzle-duel/puzzle-duel-backend/actions/workflows/staging-cd.yml

**Important:** A push to the CLIENT repository does not automatically trigger backend staging CD. A backend `version/**` push triggers backend CD. Documentation-only backend version-branch pushes also currently trigger deployment.

## 5. Server checks: run ON ORACLE (not on Mac)

Connect from the Mac using the existing SSH key/account configuration:
```sh
ssh pzd-staging@84.13.66.211
```
Then check:
```sh
hostname
systemctl status pzd-staging.service --no-pager -l
readlink -f /home/pzd-staging/pzd-staging/current
curl -i --max-time 5 http://127.0.0.1:8787/healthz
curl -sS -i -X POST http://127.0.0.1:8787/v1/diagnostics/reports -H 'Content-Type: application/json' -d '{}'
tail -n 50 /home/pzd-staging/pzd-staging/http-diagnostics.log
```
No-auth `/v1/diagnostics/reports` returning `401` is expected; `201` needs valid auth, writer/session secret, and valid events payload.

With an **authorized VM administrator** (not the unprivileged Mac shell):
```sh
sudo systemctl status caddy --no-pager -l
sudo caddy validate --config /etc/caddy/Caddyfile
sudo grep -nE 'staging|84\.13\.66\.211|reverse_proxy|tls' /etc/caddy/Caddyfile
```
Read-only checks first; do **not** restart Caddy or change Forest Dash without evaluating shared-host impact. The `pzd-staging` account may lack permission to read `journalctl -u`, which does not mean service failure. The private log file above is an alternative.

## 6. Client/iOS staging counterpart

See `puzzle-duel-client/docs/staging/SERVER-CONFIG.md` on `version/0.0.2`.

- Flutter staging startup must always use the **TournamentUatApp** with backend-backed leaderboard.
- The historical Easy/Medium/Hard standalone offline home has been removed from the `version/0.0.2` release entrypoint; **never** direct owner to build the old offline-only shell.
- `PZD_STAGING_BASE_URL` must be a **verified HTTPS origin**, not just this VM's public IP and not a hostname whose DNS/TLS is broken.
- iOS builds are **local on the owner's Mac** and run on physical device `00008160-001C5C993E80000A`.
- Client iOS CI is separate from a local signed on-device build.

## 7. Safety, restrictions, and unknowns

- No passwords, tokens, TLS private keys, SSH keys, DSNs, signing keys, or session secrets in Git.
- Production ranked mode stays off; do not run migrations/reset staging data casually.
- No changes to board mechanics, game engine, animations, or established tournament look and feel to fix infrastructure.
- Do not call this setup externally healthy until real DNS/IP HTTPS TLS, iOS guest auth, and tournament/leaderboard requests are verified end-to-end.
- **Still unverified from repo/observed outputs:** live `/etc/caddy/Caddyfile`, TLS certificate/SNI configuration, public domain ownership, OCI inbound firewall rules, configured HTTPS external origin, and exact secret values. Inspect on Oracle; do not invent.

## 8. Provider auth / Google staging (2026-11-25)

- Deployed code SHA **`b340f7d1cc63bab2cbdc96dd1c5907f267a697ec`** (PR #74 CD run `45605645083`) — **verified** via `readlink` on Oracle.
- Guest auth remains healthy (`POST /v1/auth/guest` → 201).
- Provider routes **not mounted**: migrations `0005`/`0006`/`0007` not applied; `PZD_STAGING_GOOGLE_AUDIENCES` missing → challenge returns **404**.
- Exact owner plan: `docs/staging/PZD-26-GOOGLE-STAGING-READINESS.md`. Do not apply migrations or edit `staging.env` without owner approval.

## 9. Change log

- **2026-11-25:** PZD-26/27 Google staging readiness inspection; provider schema + audiences still pending owner apply.
- **2026-11-22:** `version/0.0.1` backend Oracle CD success: SHA `1508771188487802d7e9ec53c22dfb6eece0bdad`, run `45003330165`.
- **2026-11-22:** `version/0.0.2` backend Oracle CD success: SHA `a3b0d34b685c73e582c2a7ebd945d935c1c9f574`, run `45003923513`.
- **2026-11-22:** Client Mac DNS failure and Oracle public HTTPS TLS handshake failure observed; ingress unresolved.

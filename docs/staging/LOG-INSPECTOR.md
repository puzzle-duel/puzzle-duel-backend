# Staging diagnostic status inspector (manual GitHub Action)

## Access without Oracle SSH

Open [PZD Staging Diagnostic Report Status](https://github.com/puzzle-duel/puzzle-duel-backend/actions/workflows/staging-diagnostic-status.yml), choose **Run workflow**, select branch **version/0.0.2**, and run it. **Do not select main**: the protected `pzd-staging` environment only permits the release branch. The workflow file is present on `version/0.0.2`.

The Action uses the existing protected `pzd-staging` GitHub environment and pinned staging SSH host identity. It reads `/home/pzd-staging/pzd-staging/http-diagnostics.log` and optional rotated `.1` on Oracle **without changing any files**. The backend remains bound to `127.0.0.1:8787` and Forest Dash is never touched.

Find the result in the run **Summary** (or the sanitized step output). You will see the number of latest diagnostic HTTP submissions, counts per response status, the ordered sequence of the last 15 statuses, and (after version/0.0.2 deployment) sanitized recent tournament failures.

Common outcomes:
- **2xx**: endpoint accepted the report.
- **400**: report payload invalid.
- **401**: authentication problem.
- **404**: route/proxy mismatch.
- **429**: report rate limit (server currently allows only one successful report per player every 60 seconds).
- **5xx**: backend failure.

## Public repository safety

This GitHub repository is PUBLIC and GitHub Actions output is externally visible. For that reason, this workflow **does not print or export raw diagnostic logs, request IDs, player IDs, IPs, tokens, session secrets or exact timestamps**. It only prints an allowlisted HTTP status summary. Do not add `cat`, raw `tail`, `ssh -v`, `set -x`, or upload artifacts containing raw logs.

This Action **cannot retrieve report event contents**: the current diagnostic report store is in memory (one-hour retention) and exposes no read endpoint. A future secure operator-only diagnostics system is required to view actual submitted events. Never expose those through public Actions logs.

## Limitations

- The workflow uses credentials scoped to the GitHub environment `pzd-staging`. The environment **rejects main** (`Branch "main" is not allowed to deploy to pzd-staging`). Use **version/0.0.2** instead. The workflow was copied to that branch with a `[skip ci]` documentation/workflow-only commit to avoid starting the automatic backend CD. Do not broaden the environment's deployment branch restrictions.
- If the server metadata file is absent or empty, the run may show zero diagnostic requests; this is not proof no reports were submitted historically.
- The Action does not deploy, restart, migrate, rotate logs, or run when application code is pushed. Only a manual workflow dispatch starts it.

## Writer/session rejection correlation (2026-11-22 enhancement)

The updated workflow on `version/0.0.2` has an optional `request_id` input. When Firebase Crashlytics shows a row such as `tournament_session:: writerBindingRejected requestId=<32 hex> status=409 errorCode=WRITER_NOT_AUTHORIZED`, run the [Inspector](https://github.com/puzzle-duel/puzzle-duel-backend/actions/workflows/staging-diagnostic-status.yml) on **version/0.0.2** with the **exact 32-character lowercase hex request ID** entered in `request_id`. The run returns only the matched HTTP status, static route category and allowlisted backend error code; the ID itself is never printed by the script. Without a request ID, it shows the 20 latest failed tournament calls by sanitized category and reason.

Currently supported writer reasons: `STALE_WRITER`, `WRITER_NOT_AUTHORIZED`, `WRITER_STILL_ACTIVE`. The backend deliberately stores no player identity, device secret, bearer token, request payload, exception text or series UUID in the HTTP metadata file. This is **diagnostic enrichment only**, not a writer recovery/bypass feature.

**Limitations:** Older log entries have no `route` or `errorCode`, so their exact root cause cannot be reconstructed retroactively. The file rolls at 5 MiB; the Action inspects only the current file and `.1`. No raw uploaded report content is retrievable through this public Action. Every reported `errorCode` is chosen from a fixed allowlist.

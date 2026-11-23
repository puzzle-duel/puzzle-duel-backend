# Named staging test players — Gökhan Aydın and Serap Nazlı Aydın

These are staging-only guest-backed test identities, **not** Apple/Google verified accounts. No production access or production auth bypass is added.

After PR merge and successful `version/0.0.2` deployment, run the GitHub Actions **Provision named staging test players** workflow once. It uses the existing pinned staging SSH secrets and the private Oracle `staging.env`; the owner need not access Oracle. The workflow creates two independent player IDs and refresh families and stores credential material in separate 0600 files on the VM. Re-runs skip existing files; no existing Guest is modified.

The credential file contains the requested display name as metadata. **It is not yet a persisted tournament profile name**; that requires a separate profile schema/read-model integration. The Flutter app does not automatically import these identities, and a secure account provisioning/linking mechanism is still needed for selectable Gökhan/Serap builds. Do not put tokens in GitHub secrets, logs, build flags, or chat.

The script is not an HTTP endpoint. It refuses production DB, non-staging profile, missing signing key, or absent explicit approval. It fsyncs credentials before committing DB identity; failed file writes roll back the account. A process crash between file persistence and DB commit can leave a credential file with no account: in that case the workflow fails closed and requires an operator recovery procedure, never silent replacement. It does not reset existing players.

Staging CD packages the script but **does not run it**. The separate workflow is intentionally manual and auditable.

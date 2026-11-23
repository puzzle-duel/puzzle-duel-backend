# Staging-only named test players

Gökhan Aydın and Serap Nazlı Aydın are distinct staging guest-backed accounts, not Apple/Google-verified identities. They are not production identities.

## One-time setup without Oracle terminal access

1. Merge this PR into version/0.0.2 and allow staging CD to deploy the provisioning script.
2. Apply reviewed migration `0003_named_test_players` through the existing **PZD Reusable Staging Database Migration** workflow in the `pzd-staging-migrations` environment. The migration uses a separate DB owner and backup; it is never run automatically by the app or CD.
3. Run **Provision named staging test players** workflow from the deployed version branch. Existing staging SSH secrets are used; no operator SSH commands or credentials are pasted into Actions.

The provisioning script inserts `slug`, `player_id`, and `display_name` into `pzd_staging_test_players` in the same transaction as the guest account and refresh token. Credential files remain mode 0600 on the Oracle VM. On retry, the script checks the DB account and unspent refresh-token digest before treating a file as a completed identity. An orphan file from a pre-commit crash can be recreated only after proving neither the named profile nor its token digest exists. If evidence is ambiguous, provisioning stops without overwriting or rotating credentials.

This creates persistent profile names in the staging DB, but does not yet integrate them into leaderboard read models or provide Flutter secure credential import. Those are separate tasks. No game mechanics, graphics, or animations change.

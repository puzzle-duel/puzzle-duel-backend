# One-shot staging test player (operator only)

This script creates **one** staging guest-backed test identity labeled **Gökhan Aydın**. It is NOT an Apple/Google authenticated account and does not change production authorization. The label is stored in the operator credential file only, not in the player profile database. No HTTP token issuance route is exposed.

Run **on Oracle as pzd-staging** after the code has been deployed, with the existing private staging environment already loaded. Do not print the environment file, token, or credential file.

```sh
cd /home/pzd-staging/pzd-staging/current
umask 077
PZD_TEST_PLAYER_CREATE=YES /opt/pzd-node26/bin/node --experimental-strip-types ops/staging/create-test-player.mts
```

The script requires PZD_RUNTIME_PROFILE=staging, a localhost pzd_staging database, and existing staging signer settings. It exclusively creates `/home/pzd-staging/pzd-staging/gokhan-test-player.credentials.json` with mode 0600; rerunning fails rather than overwriting the identity. Do not run automatically from CD. No database reset or existing guest account mutation.

**Important:** The generated access token expires after 15 minutes. The refresh token must be handled through the normal authenticated refresh flow. The current Flutter staging app uses its own secure guest credential store and does not automatically import this operator-created identity. Connecting it to the app requires a separate, explicitly designed and tested secure provisioning path; do not embed tokens in dart-defines, shell history, CI, or logs. The existing guest-based staging backend does not enforce the future Apple/Google-only tournament policy.

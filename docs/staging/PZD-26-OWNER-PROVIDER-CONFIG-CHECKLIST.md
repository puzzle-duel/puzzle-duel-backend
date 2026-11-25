# PZD-26 owner checklist — Apple / Google configuration

Do **not** paste private keys, client secrets, or `.p8` contents into Jira, git, or logs.

## Staging (required before real-device UAT)
1. Apple Developer: enable Sign in with Apple for the iOS App ID / bundle ID used by staging builds.
2. Provide staging Apple audience values (Services ID and/or bundle ID) for `PZD_STAGING_APPLE_AUDIENCES`.
3. Google Cloud: OAuth client IDs for iOS and Android staging package/bundle; SHA-1/256 for Android.
4. Provide staging Google audiences for `PZD_STAGING_GOOGLE_AUDIENCES`.
5. Confirm Firebase remains Crashlytics-only (Auth provider disabled / unused).
6. Apply staging migrations `0005` and `0006` with the operator migrator (not runtime DDL).
7. Restart staging bootstrap after env audiences are set.

## Production (later; not authorized by this checklist alone)
- Separate production audiences and signing material.
- Account deletion + Apple revocation endpoint readiness.
- Independent review + owner merge/deploy approval.

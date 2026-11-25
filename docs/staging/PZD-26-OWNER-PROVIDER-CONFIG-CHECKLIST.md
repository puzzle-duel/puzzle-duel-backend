# PZD-26 owner checklist — Apple / Google configuration

Do **not** paste private keys, client secrets, or `.p8` contents into Jira, git, or logs.

## Staging (required before real-device UAT)
1. Apple Developer: enable Sign in with Apple for the iOS App ID / bundle ID used by staging builds. *(Optional for Google-only staging UAT; Apple remains fail-closed when audiences unset.)*
2. Provide staging Apple audience values (Services ID and/or bundle ID) for `PZD_STAGING_APPLE_AUDIENCES` *(defer until Apple enrollment)*.
3. Google Cloud: OAuth client IDs for iOS (and later Android) staging package/bundle; SHA-1/256 for Android.
4. Provide staging Google audiences for `PZD_STAGING_GOOGLE_AUDIENCES` — **required for Google iOS UAT**:
   `450107669068-a4l8vrgas78rqdm8aou7kvnhsldkafbi.apps.googleusercontent.com,450107669068-b0l835r1cv1mfga7h3ovdd1hjte0tfse.apps.googleusercontent.com`
   (Web/Server + iOS only; omit Android debug client until Android UAT).
5. Confirm Firebase remains Crashlytics-only (Auth provider disabled / unused).
6. Apply staging migrations `0005_provider_challenges`, `0006_provider_identity`, then `0007_identity_immutability` with the operator migrator (not runtime DDL). See `PZD-26-GOOGLE-STAGING-READINESS.md`.
7. Restart staging service after env audiences are set.
8. Confirm `POST /v1/auth/providers/challenge` with `{provider:google,purpose:login}` returns **201** over HTTPS.

## Production (later; not authorized by this checklist alone)
- Separate production audiences and signing material.
- Account deletion + Apple revocation endpoint readiness.
- Independent review + owner merge/deploy approval.

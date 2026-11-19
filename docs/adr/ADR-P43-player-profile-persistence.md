# ADR-P43 — Player profile practice persistence and badge reads

Status: **Proposed** (PZD-43 implementation candidate; owner freeze required before production enablement)

Mirror of the client ADR for cross-repo review. See also
`puzzle-duel-client/docs/adr/ADR-P43-player-profile-persistence.md`.

## Decision summary

1. Practice personal bests remain **device-local**, player-scoped, version-aware, and never enter ranked publication.
2. Candidate badge collection read: `GET /v1/tournament/me/badges`, authenticated session only, no client-authored counts, no new grant rules.
3. On-Time is repeatable across series/days; `earnedCount` is the number of `awarded=true` immutable rows for the caller.
4. No production migration for practice cloud sync. No Nest scaffolding. Ranked HTTP feature gate unchanged (off by default / denied in production).

## Endpoint (candidate)

```
GET /v1/tournament/me/badges?grantLimit=50
Authorization: Bearer <verified JWT>
x-pzd-session-secret: <session secret>
```

Response:

```json
{
  "playerScoped": true,
  "catalogVersion": 1,
  "badges": [
    {
      "badgeId": "on_time",
      "earnedCount": 2,
      "lastEarnedAt": "2026-11-17",
      "repeatable": true,
      "provenance": "f2b_publication",
      "grants": [
        {
          "seriesId": "...",
          "originalUtcDate": "2026-11-17",
          "awarded": true,
          "claimStartedAtMs": 0
        }
      ]
    }
  ]
}
```

Errors: `401 UNAUTHENTICATED`, `400 MALFORMED_REQUEST`, `503 RANKED_HTTP_DISABLED`.

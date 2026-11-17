# Stage E — PZD-38 Phase A controlled import

**Not a merge of Draft PR #13.** Files copied into `feature/PZD-39-core001v3-tournament-integration` from Phase A worktree at `4473a39a39def068701b2a0c8f633b2dfcc38dd2`.

## Required imports
- `src/tournament/ingress/*`
- `test/tournament/ingress/*`
- `docker-compose.ingress-test.yml`
- `docs/architecture/PZD-38-PHASE-A-INGRESS-EVIDENCE.md` (historical)

## Intentionally not copied wholesale
- Phase A `package.json` / lockfile (would drop Stage D scripts)
- Client-trusted `scoreDelta` / `completesSeries` authority (removed in Stage E trust boundary)

## Stage E amendments
- Untrusted client commands cannot authorize score, completion, or checkpoints.
- Gameplay score/terminal derived via Stage C `replayCore001V3` / `applyMove`.
- Accepted move ledger + trusted challenge binding added under `src/tournament/adjudication/`.

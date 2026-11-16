# Puzzle Duel Backend

NestJS backend for shared leaderboard and score verification is planned but **not yet scaffolded**. No deploy is authorized.

## PZD-21 TypeScript generator parity (isolated module)

`src/generator.mts` ports Accepted GEN-01–GEN-07, `gen-001.v1` and ranked `core-001.v2`. This is a pure TypeScript implementation, **not an HTTP endpoint or a live NestJS service**.

`test/generator.test.mts` reads all 15 independent Python/Dart golden fixtures from the client PR #14 HEAD `236caf50564a03c1cf82b8a52b36a693509b7b08`. GitHub Actions checks out that exact SHA. Missing fixture directory or wrong fixture count must fail.

To run in a workspace with backend and client sibling folders:

```bash
cd backend
PZD_GENERATOR_FIXTURES=../client/docs/contracts/generator/gen-001.v1/fixtures \
  node --experimental-strip-types --test test/generator.test.mts
```

Requires Node.js 22.23+. No host RNG, UTC-to-seed mapping, ranked persistence, routing, deploy, or Blueprint change. Merge and Jira Done remain out of scope.

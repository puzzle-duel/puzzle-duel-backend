# PZD-39 Stage C — Independent TypeScript CORE-001.v3 verification

Status: **READY FOR INDEPENDENT RE-REVIEW** (not ranked production ready; Stage D / PZD-38 wiring NOT_RUN)
Date: 2026-11-17
Jira: [PZD-39](https://puzzle-duel-app.atlassian.net/browse/PZD-39)
Branch: `feature/PZD-39-core001v3-ts-replay`
Base: `docs/core-001-v3-ruleset-design` @ `727e1b48738531f8675df3628037e5509e2df7bb`
Prior reviewed HEAD: `8bfce2724c0d9ba17f85f2a4ecab501377a2cbb2`
Accepted design: ADR-E01 D1–D10

## P1 security remediation (PR review comment 6941826065)

### P1-01 — Prototype-safe JSON parser

**Reproduction:** `JSON.parse('… "__proto__":{"injected":true} …')` yields an own `__proto__` key. Cloning into `{}` via `result[key]=entry` mutates the clone prototype; `Object.keys` then omits `__proto__`, so closed-schema checks miss the forbidden field.

**Fix:** `asObject` now copies own property names into `Object.create(null)`. `closed` and field presence checks use own-property semantics (`Object.getOwnPropertyNames` / `hasOwn`). ADR-E01 schema unchanged.

**Tests:** `test/engine/core001v3/proto_safety.test.mts` — state/move/piece/offer `__proto__`, inherited required fields, `constructor`, deterministic `ValidationFailure` (no crashes).

### P1-02 — Fail-closed client report comparison

**Reproduction:** `compareReplayToClientReport({ replayed, client: {} })` previously returned `{ ok: true }` with zero comparisons.

**Fix:**
- `compareReplayToClientReport` is strict **full** verification (`mode: 'full'`). Requires score, board, offers, turnsUsed, status, terminalReason, stateHash. Missing/malformed → fail closed (`missing_report_field` / `malformed_report_field`).
- `diagnoseClientReportFields` is partial diagnostic only (`mode: 'partial'`, **never** `ok: true`).
- Board/offer equality uses `canonicalJsonV3` (`structuralEqual`) so key insertion order does not false-mismatch.
- Matching hash still never ranked authority without trusted replay.

**Tests:** `test/engine/core001v3/compare_report.test.mts`.

### Trust-boundary follow-up

`replayCore001V3` documents that `initialState` is never authenticated by Stage C. Non-initial snapshots require explicit `allowNonInitialTrustedSnapshot` (or deprecated `requireInitialChallenge: false`) and still do **not** prove checkpoint authenticity — PZD-38 must bind trust out-of-band.

## Architecture

Pure TypeScript module (no Nest, DB, HTTP, clock, Flutter/Dart):

| Path | Role |
| --- | --- |
| `src/engine/core001v3/types.mts` | Immutable v3 state / offers / moves |
| `src/engine/core001v3/failure.mts` | Validation + gameplay/safety codes |
| `src/engine/core001v3/checked_int.mts` | JSON-safe checked add/mul |
| `src/engine/core001v3/parse.mts` | Strict v3 snapshot / initial / move parse (null-prototype) |
| `src/engine/core001v3/placement.mts` | PZD-18 + `hasLegalPlacement` / `deriveTerminalExpectation` |
| `src/engine/core001v3/match_shift.mts` | PZD-19 match/clear/shift |
| `src/engine/core001v3/resolution.mts` | PZD-20 cascades, score, spent commit, terminal |
| `src/engine/core001v3/canonical.mts` | `canonical_json_v3` + SHA-256 |
| `src/engine/core001v3/replay.mts` | Transition replay (caller-authenticated start) |
| `src/engine/core001v3/compare.mts` | Full vs partial client-report comparison |
| `src/engine/core001v3/index.mts` | Public exports |

Historical `src/generator.mts` (`gen-001.v1` → `core-001.v2`) unchanged.

## Public APIs

- `parseGameState` / `parseInitialGameState` / `parseMove` / `tryParseGameState`
- `applyPlacement` / `applyMove` / `hasLegalPlacement` / `hasLegalMove` / `deriveTerminalExpectation`
- `findMatches` / `clearMatches` / `applyShift`
- `canonicalJsonV3` / `stateHashV3` / `sha256HexOfUtf8`
- `replayCore001V3({ initialState, moves, rulesVersion })`
- `compareReplayToClientReport` (full) / `diagnoseClientReportFields` (partial) / `structuralEqual`

## Trust boundaries

| Layer | Stage C |
| --- | --- |
| Schema / §5.3 validation | Implemented (own-property closed schema) |
| Transition replay from caller-trusted start + ledger | Implemented (pure) |
| Checkpoint / challenge authentication | **NOT_RUN** (PZD-38) |
| Tournament admission / identity / time / LB | **NOT_RUN** (PZD-38) |
| Client `stateHash` as ranked authority | **Never** |

## Checked integers

All v3 score/turn intermediates use `checkedNonNegAdd` / `checkedNonNegMul` against `Number.MAX_SAFE_INTEGER`. Overflow → `MoveUnsafe` / parse `integer_out_of_range`. Documented transport limit: once JSON.parse has already rounded an unsafe token, validation cannot recover the original bytes.

## Resource fences

`REPLAY_HARD_MOVE_CEILING = 10000` rejects absurd move ledgers. Accepted profiles use far smaller `moveLimit`. Broader board-size DoS policy remains a security design question (not invented here).

## Quality gate (executed after P1 remediation)

Node `v26.13.1`. Commands:

```bash
npm run typecheck
npm run test:core001v3
```

| Test group | Executed | PASS | FAIL | SKIP | NOT_RUN |
| --- | --- | ---: | ---: | ---: | --- |
| TS typecheck (`src/engine/core001v3`) | Yes | exit 0 | 0 | 0 | |
| TS engine unit suite | Yes | **75** | 0 | 0 | |
| State parser / terminal | Yes | included | 0 | 0 | |
| Prototype / closed-schema (P1-01) | Yes | 6 | 0 | 0 | |
| Client report compare (P1-02) | Yes | 9 | 0 | 0 | |
| Placement / match / shift | Yes | included | 0 | 0 | |
| Cascades / scoring / offers | Yes | included | 0 | 0 | |
| Natural terminal | Yes | included | 0 | 0 | |
| Replay | Yes | included | 0 | 0 | |
| Canonical CV-01…09 | Yes | 9/9 | 0 | 0 | |
| Security negatives | Yes | included | 0 | 0 | |
| Historical v1/v2 checksums | Yes | 27+8 | 0 | 0 | |
| v1/v2 `validate.mjs` + `reference_check.py` | Yes | PASS | 0 | 0 | |
| Generator regression (`gen-001.v1`) | Yes | PASS (15 fixtures) | 0 | 0 | |
| Dart/TS golden parity | No | | | | **Yes — Stage D** |
| Tournament E2E | No | | | | **Yes** |

**Test count:** 75 node:test cases (not assertion count). No GitHub Actions PASS claimed without workflow logs.

## Defects

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| P1-01 | P1 | `__proto__` own-key lost on `{}` clone | Null-prototype own-key parse + tests |
| P1-02 | P1 | Empty client report returned `{ok:true}` | Strict full compare + partial diagnostic |
| C-1 | P1 (prior) | Unsafe number → `malformed_score` only | `integer_out_of_range` distinction |
| C-2 | P2 | Generator fails strict indexed access | Scoped `tsconfig` to Stage C engine |
| F-1 | P2 | Board/stream size DoS policy unspecified | Documented; deferred to admission design |

No unresolved P0/P1 after this remediation.

## Known limitations

- Full GameState hash freeze **PENDING_FREEZE** (Stage D).
- Engine is v3-only; historical v1/v2 gameplay remains checker-preserved.
- Stage C does not authenticate challenges/checkpoints.
- Independence ≠ dual-engine correctness proof.

## Stage D prerequisites

Compare Dart Stage B vs this TS module on hand-checkable boards, scores, trays, terminals, CV atoms, then full GameState digests under freeze protocol. Do not start Stage D in this PR.

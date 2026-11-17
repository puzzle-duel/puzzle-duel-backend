# PZD-39 Stage C — Independent TypeScript CORE-001.v3 verification

Status: **READY FOR INDEPENDENT REVIEW** (not ranked production ready; Stage D / PZD-38 wiring NOT_RUN)
Date: 2026-11-17
Jira: [PZD-39](https://puzzle-duel-app.atlassian.net/browse/PZD-39)
Branch: `feature/PZD-39-core001v3-ts-replay`
Base: `docs/core-001-v3-ruleset-design` @ `727e1b48738531f8675df3628037e5509e2df7bb`
Accepted design: ADR-E01 D1–D10

## Architecture

Pure TypeScript module (no Nest, DB, HTTP, clock, Flutter/Dart):

| Path | Role |
| --- | --- |
| `src/engine/core001v3/types.mts` | Immutable v3 state / offers / moves |
| `src/engine/core001v3/failure.mts` | Validation + gameplay/safety codes |
| `src/engine/core001v3/checked_int.mts` | JSON-safe checked add/mul |
| `src/engine/core001v3/parse.mts` | Strict v3 snapshot / initial / move parse |
| `src/engine/core001v3/placement.mts` | PZD-18 + `hasLegalPlacement` / `deriveTerminalExpectation` |
| `src/engine/core001v3/match_shift.mts` | PZD-19 match/clear/shift |
| `src/engine/core001v3/resolution.mts` | PZD-20 cascades, score, spent commit, terminal |
| `src/engine/core001v3/canonical.mts` | `canonical_json_v3` + SHA-256 |
| `src/engine/core001v3/replay.mts` | Trusted-challenge replay |
| `src/engine/core001v3/compare.mts` | Client-report mismatch classification |
| `src/engine/core001v3/index.mts` | Public exports |

Historical `src/generator.mts` (`gen-001.v1` → `core-001.v2`) unchanged.

## Public APIs

- `parseGameState` / `parseInitialGameState` / `parseMove` / `tryParseGameState`
- `applyPlacement` / `applyMove` / `hasLegalPlacement` / `hasLegalMove` / `deriveTerminalExpectation`
- `findMatches` / `clearMatches` / `applyShift`
- `canonicalJsonV3` / `stateHashV3` / `sha256HexOfUtf8`
- `replayCore001V3({ initialState, moves, rulesVersion })`
- `compareReplayToClientReport`

## Trust boundaries

| Layer | Stage C |
| --- | --- |
| Schema / §5.3 validation | Implemented |
| Transition replay from trusted initial + ledger | Implemented (pure) |
| Tournament admission / identity / time / LB | **NOT_RUN** (PZD-38) |
| Client `stateHash` as ranked authority | **Never** |

Caller must supply an authenticated trusted challenge. Parser acceptance of a spent slot is structural only — provenance requires replay.

## Checked integers

All v3 score/turn intermediates use `checkedNonNegAdd` / `checkedNonNegMul` against `Number.MAX_SAFE_INTEGER`. Overflow → `MoveUnsafe` / parse `integer_out_of_range`. Documented transport limit: once JSON.parse has already rounded an unsafe token, validation cannot recover the original bytes.

## Resource fences

`REPLAY_HARD_MOVE_CEILING = 10000` rejects absurd move ledgers. Accepted profiles use far smaller `moveLimit`. Broader board-size DoS policy remains a security design question (not invented here).

## Quality gate (executed)

Node `v26.13.1`. Commands:

```bash
npm install
npm run typecheck
npm run test:core001v3
```

| Test group | Executed | PASS | FAIL | SKIP | NOT_RUN |
| --- | --- | ---: | ---: | ---: | --- |
| TS typecheck (`src/engine/core001v3`) | Yes | exit 0 | 0 | 0 | |
| TS engine unit suite | Yes | **60** | 0 | 0 | |
| State parser / terminal | Yes | included | 0 | 0 | |
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
| Nest lint (no Nest on design branch) | No | | | | N/A |

**Test count:** 60 node:test cases (not assertion count). No GitHub Actions PASS claimed without workflow logs.

## Defects during Stage C

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| C-1 | P1 | Unsafe JS number scored as `malformed_score` only | Distinguish `integer_out_of_range` vs type errors |
| C-2 | P2 | Pre-existing `generator.mts` fails strict `noUncheckedIndexedAccess` | Scoped `tsconfig.json` to Stage C engine paths |

No unresolved P0/P1.

## Known limitations

- Full GameState hash freeze **PENDING_FREEZE** (Stage D).
- Engine is v3-only; does not re-execute v1/v2 gameplay (historical checkers preserved).
- No Nest packaging / ranked ingress wiring.
- Independence means separate implementation; agreement with Dart is necessary but not sufficiency for correctness.

## Stage D prerequisites

Compare Dart Stage B (`946f015` tip / engine `03be672`) vs this TS module on:

1. Identical hand-checkable boards (placement, one-wave, cascade reopen).
2. Score deltas, wave lists, offer trays, terminals.
3. Canonical atom digests (already CV-01…09).
4. Full GameState digests after freeze protocol.
5. Shared negative vectors (forged score/board/terminal, spent provenance).

Do not start Stage D in this PR.

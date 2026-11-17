# PZD-39 Stage D — Independent golden fixtures and Dart–TS parity

Status: **STAGE D — BLOCKED** (executable subset verified; full catalogue freeze incomplete)
Date: 2026-11-17
Jira: [PZD-39](https://puzzle-duel-app.atlassian.net/browse/PZD-39)
Branch: `feature/PZD-39-core001v3-golden-parity`
Stage D HEAD: `3c90532b5247bd7ec168cc432ba880bb27cecb76`
Base: `feature/PZD-39-core001v3-ts-replay` @ `25efb2473f3517027769ee978b31ab6e3dc41030`

## Engine / toolchain pins

| Item | Value |
| --- | --- |
| Backend Stage C tip | `25efb2473f3517027769ee978b31ab6e3dc41030` |
| Backend Stage C tested impl | `f3eab0b64bad7f3679a853e01a78d0b082063ecd` |
| Client Stage B | `946f015a5124d1a9dfd6f3440cc916b9eb1789f8` |
| Dart SDK | 3.14.0 (`puzzle-duel-client-core001v3-dart/.dart-sdk`) |
| Node | v26.13.1 |
| Oracle | `tools/stage_d/oracle/core001v3_oracle.py` (`stage-d-python-stdlib-1`) |
| Hash | SHA-256 over UTF-8 canonical JSON / fixture file bytes |
| Rules | `core-001.v3` / ADR-E01 D1–D10 |

## Oracle architecture

Independent Python 3 stdlib oracle implementing placement, match/clear/shift, cascade scoring, spent offers, terminal derivation, and `canonical_json_v3`.

Does **not** import Dart or TypeScript engines. Expected fixture fields are authored by this oracle (`build_fixtures.py`), then verified by running both product engines.

Dual-engine agreement alone is never treated as sufficiency.

## Catalogue audit

Full inventory: `docs/contracts/gameplay/v3/CATALOGUE-AUDIT.md` (V3-01…V3-52).

Definitions recovered from design history (`b5dc911`, `c64bd57`) plus current V3-36…V3-52.

### Freeze blockers for overall PASS

| ID | Blocker |
| --- | --- |
| V3-03 | Multi-wave cascade concrete hand-checked board still **PENDING_FREEZE** (prose definition recovered; executable board not independently authored yet) |
| V3-48 | Tournament checkpoint overwrite — **NOT_RUN** at pure-engine layer (PZD-38) |

## Executable subset results

Parity suite: `python3 tools/stage_d/parity/run_parity.py`

| Gate | Result |
| --- | ---: |
| Fixtures executed | 31 |
| Oracle ↔ Dart | 31 PASS |
| Oracle ↔ TypeScript | 31 PASS |
| Dart ↔ TypeScript | 31 PASS |
| Failures | 0 |
| Repeated second run | identical PASS counts |

Includes positives (placement, single-wave 300, board-full, cascade reopen, spent/stream, move-limit), parse negatives, replay-security classes (V3-42/45/46), overflow (V3-49), and CV atoms (V3-51).

Checksum ledger: `docs/contracts/gameplay/v3/CHECKSUMS-STAGE-D.txt` (31 entries).  
Verify: `python3 tools/stage_d/parity/verify_checksums.py` (read-only).  
Owner freeze regen: `python3 tools/stage_d/parity/freeze_checksums.py`.

## Runners

| Runner | Path |
| --- | --- |
| Dart | `tools/stage_d/dart_runner` path-depends on client `puzzle_duel_rules` @ Stage B SHA |
| TypeScript | `tools/stage_d/ts_runner/run_fixture.mts` uses Stage C `src/engine/core001v3` |
| Comparator | `tools/stage_d/parity/run_parity.py` |

Client Stage B and Backend Stage C source trees were not modified.

## Historical regression

| Gate | Result |
| --- | --- |
| v1 CHECKSUMS (27) | OK |
| v2 CHECKSUMS (8) | OK |
| v1/v2 `reference_check.py` | PASS |
| `gen-001.v1` generator tests | 17 PASS |
| Stage C `npm run test:core001v3` | 75 PASS |
| Stage C `tsc --noEmit` | exit 0 |
| Dart `dart analyze` + `dart test` (rules package) | 140 PASS |

## Quality matrix

| Gate | PASS | FAIL | SKIP | NOT_RUN |
| --- | ---: | ---: | ---: | ---: |
| Independent oracle (executable subset) | 31 | 0 | 0 | |
| Dart full engine (via runner) | 31 | 0 | 0 | |
| TypeScript full engine (via runner) | 31 | 0 | 0 | |
| Dart ↔ TS parity | 31 | 0 | 0 | |
| Positive fixtures (authored) | included | 0 | 0 | |
| Negative fixtures (authored) | included | 0 | 0 | |
| State hash freeze (subset ledger) | 31 files | 0 | 0 | |
| Historical v1 | PASS | 0 | 0 | |
| Historical v2 | PASS | 0 | 0 | |
| Generator regression | PASS | 0 | 0 | |
| Checksum integrity | PASS | 0 | 0 | |
| Repeatability (2 runs) | PASS | 0 | 0 | |
| V3-03 multi-wave freeze | | | | **PENDING_FREEZE** |
| Tournament E2E / V3-48 | | | | **NOT_RUN** |

## P0/P1/P2

| ID | Sev | Finding | Action |
| --- | --- | --- | --- |
| D-1 | P1 | Full catalogue cannot be marked FROZEN while V3-03 pending | Author independent two-wave board |
| D-2 | P2 | Dart multi-version parser emits extra codes vs TS v3-only on some rejects | Comparator requires shared required codes |
| D-3 | Info | V3-48 is tournament admission | Remain NOT_RUN until PZD-38 |

No engine defect requiring Stage B/C code change was found in the executable subset.

## NOT_RUN

- Full GameState freeze of entire V3-01…V3-52 set
- V3-03 multi-wave executable freeze
- V3-48 tournament checkpoint authorization
- Nest e2e / ranked production pin
- Merge / deploy / Jira Done

## Final Stage D decision

**STAGE D — BLOCKED**

Executable oracle↔Dart↔TS parity **PASS** for 31 authored fixtures with immutable Stage D checksum ledger and historical regressions green.

Overall catalogue freeze is blocked primarily by **V3-03 PENDING_FREEZE** and **V3-48 tournament NOT_RUN**.

### Minimum unblock

1. Independently hand-check and freeze a two-wave cascade board as V3-03.
2. Keep V3-48 classified as PZD-38 (do not fake engine PASS).
3. Re-run parity + checksum freeze + update this report.
4. Then re-evaluate for **FROZEN / PARITY PASS**.

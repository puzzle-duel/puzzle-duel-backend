# PZD-39 Stage D — Independent golden fixtures and Dart–TS parity

Status: **STAGE D ENGINE PARITY — FROZEN / PASS**  
Overall ranked / PZD-39 release readiness: **BLOCKED** (V3-48 tournament NOT_RUN + no production pin)  
Date: 2026-11-17  
Jira: [PZD-39](https://puzzle-duel-app.atlassian.net/browse/PZD-39)  
Branch: `feature/PZD-39-core001v3-golden-parity`  
Draft PR: https://github.com/puzzle-duel/puzzle-duel-backend/pull/16  

| Item | Value |
| --- | --- |
| Starting HEAD (pre gap-closure) | `d0f12659d1b336fa83ae4d89d431dbb8d38a8a38` |
| Prior Stage D implementation commit | `3c90532b5247bd7ec168cc432ba880bb27cecb76` |
| Gap-closure content commit | `a0c26b63b70d85e1a83af75c641b5fc42139abd7` |
| Final tip HEAD | `af4e0236e947d336de83e17b1a66fa31e1cc8dc3` |

## Engine / toolchain pins

| Item | Value |
| --- | --- |
| Backend Stage C | `25efb2473f3517027769ee978b31ab6e3dc41030` |
| Client Stage B | `946f015a5124d1a9dfd6f3440cc916b9eb1789f8` |
| Dart SDK | 3.14.0 (`puzzle-duel-client-core001v3-dart/.dart-sdk`) |
| Node | v26.13.1 |
| Python | 3.14.0 stdlib oracle |
| Oracle | `tools/stage_d/oracle/core001v3_oracle.py` (`stage-d-python-stdlib-1`) |
| Hash | SHA-256 over UTF-8 canonical JSON / fixture file bytes |
| Rules | `core-001.v3` / ADR-E01 D1–D10 |

Stage B client and Stage C backend engines were **not** modified in this gap closure.

## Gap closure delivered

### V3-03 multi-wave golden

- Fixture: `docs/contracts/gameplay/v3/fixtures/V3-03-multi-wave.json`
- Hand derivation: `docs/engine/PZD-39-STAGE-D-V3-03-DERIVATION.md`
- Provenance: historical PZD-11 `10-two-wave-cascade` geometry adapted to tagged v3 offers; expectations from independent Python oracle + handwritten arithmetic (not Dart/TS copy).
- Wave 1: clear `[0,0][0,1][0,2]` → `3×100×1=300`; shift diamond `[4,3]→[4,2]`
- Wave 2: clear `[4,0][4,1][4,2]` → `3×100×2=600`
- Total `scoreDelta=900`; final state hash `ba90da3fc85df0527510e290375ee66993e5e77d05ef0bb9630bd14c85fbeabc`
- Fixture file SHA-256: `9f49d79d564ab787987ae39351d883790c0ef6509f2bd1f0612c82cb4ce1c048`

### V3-43 forged-board security

- Fixture: `docs/contracts/gameplay/v3/fixtures/V3-43-forged-board.json`
- Trusted initial + accepted move ledger replayed; client reports empty forged board with self-consistent forged hash.
- Outcomes: `replayOk=true`, `fullCompareOk=false`, mismatches include `board_mismatch` + `state_hash_mismatch`.
- Authentic hash `b0ecee3d68d889fe…` ≠ forged hash `c625c1903fcaa2b8…`.
- Matching attacker hash alone is never ranked success.
- Fixture file SHA-256: `6129ed1304c1d26e6540aa88e8a7eb0342eacb5ab973326cbe3c64b348fca47d`

### Comparator remediation

`tools/stage_d/parity/run_parity.py` `replaySecurity` now enforces:

1. Oracle ↔ Dart  
2. Oracle ↔ TypeScript  
3. Dart ↔ TypeScript  

for all normative security fields. Mismatch code arrays compared as sets (order non-normative). Missing fields reject. First-divergence path preserved.

Mutation tests: `python3 tools/stage_d/parity/test_comparator_mutations.py` — 9 injected defects each FORCE FAIL; positive control PASS.

## Executable fixture counts

| Metric | Before | After |
| --- | ---: | ---: |
| Executable Stage D JSON fixtures | 31 | **33** |
| Checksum ledger entries | 31 | **33** |
| Historical fixture bytes changed | — | **0** (ledger diff = +2 lines only) |

Ledger: `docs/contracts/gameplay/v3/CHECKSUMS-STAGE-D.txt`  
Verify: `python3 tools/stage_d/parity/verify_checksums.py` → `verified 33; fail 0`

## Catalogue

Full V3-01…V3-52 audit: `docs/contracts/gameplay/v3/CATALOGUE-AUDIT.md`.

Aliases are not counted as independent executions. Aggregate 33 PASS does not claim every catalogue ID was independently executed.

## Exact commands and results

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit 0 |
| Stage C engine tests | `npm run test:core001v3` | **75 PASS** / 0 fail |
| Parity run 1 | `python3 tools/stage_d/parity/run_parity.py` | **33 PASS** / 0 fail / exit 0 |
| Parity run 2 | same | **33 PASS** / 0 fail / exit 0 |
| Parity reproducibility | byte-compare `results[]` run1 vs run2 | **identical** |
| Checksums | `python3 tools/stage_d/parity/verify_checksums.py` | 33 OK |
| Comparator mutations | `python3 tools/stage_d/parity/test_comparator_mutations.py` | 9/9 force FAIL + positive PASS |
| Dart format | `dart format --output=none --set-exit-if-changed .` | exit 0 |
| Dart analyzer | `dart analyze` | No issues |
| Dart package tests | `dart test` (puzzle_duel_rules) | **140 PASS** |
| Historical v1/v2 | `test/engine/core001v3/historical_regression.test.mts` | 6 PASS |
| v1 `reference_check.py` | PASS | exit 0 |
| v2 `reference_check.py` | PASS | exit 0 |
| gen-001.v1 | `PZD_GENERATOR_FIXTURES=… node --test test/generator.test.mts` | **17 PASS** |

## Quality matrix

| Gate | PASS | FAIL | SKIP | NOT_RUN |
| --- | ---: | ---: | ---: | ---: |
| Independent oracle (executable fixtures) | 33 | 0 | 0 | |
| Dart full engine (via runner) | 33 | 0 | 0 | |
| TypeScript full engine (via runner) | 33 | 0 | 0 | |
| Dart ↔ TS parity | 33 | 0 | 0 | |
| State hash freeze (ledger) | 33 files | 0 | 0 | |
| Historical v1/v2 | PASS | 0 | 0 | |
| Generator regression | 17 | 0 | 0 | |
| Comparator mutations | 9 forced FAIL | 0 miss | 0 | |
| Repeatability (2 runs) | PASS | 0 | 0 | |
| V3-03 multi-wave | PASS | 0 | 0 | |
| V3-43 forged board | PASS | 0 | 0 | |
| V3-48 tournament checkpoint auth | | | | **NOT_RUN (PZD-38)** |
| Production v3 manifest pin / deploy | | | | **NOT_RUN** |

## Remaining P0/P1/P2

| ID | Sev | Finding | Action |
| --- | --- | --- | --- |
| D-3 | P1 (ranked) | V3-48 client overwrite of trusted tournament checkpoint | Own under **PZD-38**; do not simulate auth in pure engine |
| D-2 | P2 | Dart multi-version parser may emit extra reject codes vs TS | Comparator already requires shared required codes |
| D-4 | Info | Ranked release still needs owner pin + deploy gates | Outside Stage D engine freeze |

No Stage B/C engine defect requiring product-engine change was found.

## V3-48 scope / owner

V3-48 is **tournament admission / trusted checkpoint authentication** (PZD-38).  
Stage D must **not** implement or simulate authentication inside the pure gameplay engine and must **not** mark V3-48 PASS.

Accepted ADR-E01 / Stage D fixture-freeze intent: engine golden parity is separable from tournament security. Therefore:

- **Engine fixture parity** may be **FROZEN / PASS** without V3-48.
- **Overall ranked integration / production readiness** remains **BLOCKED** until PZD-38 covers V3-48 (and other release gates).

This does **not** invent owner approval to redefine Accepted overall acceptance; it preserves the tournament gate as NOT_RUN rather than falsely closing it at the engine layer.

## Final decisions

### Engine fixture parity

**FROZEN / PASS**

33/33 executable Stage D fixtures; three-way oracle↔Dart↔TS; frozen checksum ledger; V3-03 hand-verified; V3-43 forged-board security proven; comparator hardened with mutation tests; historical regressions green.

### Overall PZD-39 / ranked integration

**BLOCKED**

V3-48 tournament security remains NOT_RUN (PZD-38). No production v3 manifest pin, merge, or deploy authorized by this Stage D freeze.

## NOT_RUN / stop line

- V3-48 tournament checkpoint authorization (PZD-38)
- Nest e2e / ranked production pin
- Merge of Draft PR #16
- Deploy / Jira Done

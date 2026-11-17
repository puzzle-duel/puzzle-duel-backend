# CORE-001.v3 fixture catalogue audit (Stage D)

Status: Stage D engine inventory after gap closure (V3-03 + V3-43 authored).  
Sources:
- `b5dc911` FIXTURE-SPEC (V3-01…V3-25 initial)
- `c64bd57` FIXTURE-SPEC remediation (V3-21…V3-35 refined; V3-26…V3-35 added)
- Current FIXTURE-SPEC V3-36…V3-52 (ADR P0/P1 remediation)
- `canonical-v3-test-vectors.md` (CV-01…09 / V3-51)

Engine pins for this audit:
- Backend Stage C tip: `25efb2473f3517027769ee978b31ab6e3dc41030`
- Client Stage B: `946f015a5124d1a9dfd6f3440cc916b9eb1789f8`
- Stage D oracle: `stage-d-python-stdlib-1`

Layer legend:
- **Engine** — pure CORE-001.v3 gameplay / parse / hash / replay-compare
- **Historical** — immutable v1/v2 regression gates
- **Tournament (PZD-38)** — authenticated checkpoint / series admission (not Stage D engine)

Checksum ledger: `CHECKSUMS-STAGE-D.txt` — **33** entries ↔ **33** executable JSON files under `fixtures/` + `invalid/` (exactly once each).

## Inventory V3-01…V3-52

| Fixture ID | Normative definition | Executable fixture / coverage alias | Oracle | Dart | TS | Hash/checksum | Owning layer | Remaining blocker |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V3-01 | Normal legal placement | `fixtures/V3-01-legal-placement.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-02 | Single-wave clear (`3×100×1=300`) | `fixtures/V3-02-single-wave.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-03 | Multi-wave cascade (≥2 waves / one move) | `fixtures/V3-03-multi-wave.json` + `docs/engine/PZD-39-STAGE-D-V3-03-DERIVATION.md` | PASS (hand+stdlib) | PASS | PASS | FROZEN | Engine | — |
| V3-04 | Board becomes full → `no_legal_moves` | `fixtures/V3-04-board-full.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-05 | Cascade reopens space | `fixtures/V3-05-cascade-reopen.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-06 | Empty stream, live offers | `fixtures/V3-06-empty-stream-live.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-07 | All spent + empty cells → `no_legal_moves` | `fixtures/V3-07-all-spent.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-08 | Consumed offer → spent | `fixtures/V3-08-offer-spent.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-09 | Move budget exhausted | `fixtures/V3-09-move-limit.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-10 | No available offers | **Alias → V3-07** (not independently executed) | Covered | Covered | Covered | via V3-07 | Engine | — |
| V3-11 | Illegal placement | `fixtures/V3-11-illegal-tap.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-12 | Corrupted terminal proof | `invalid/V3-12-false-ended.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-13 | Malformed tray / bare null | `invalid/V3-13-bare-null-offer.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-14 | Corrupt / impossible initial | `invalid/V3-14-impossible-initial.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-15 | Idempotent terminal re-eval | `fixtures/V3-15-terminal-idempotent.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-16 | Serialize/parse round-trip | Covered by positive finals + canonical | Covered | Covered | Covered | via positives | Engine | — |
| V3-17 | Historical v1 fixtures | `../v1/` + `CHECKSUMS.txt` | reference_check PASS | N/A | N/A | Historical OK | Historical | — |
| V3-18 | Historical v2 fixtures | `../v2/` + `CHECKSUMS.txt` | reference_check PASS | N/A | N/A | Historical OK | Historical | — |
| V3-19 | v2 early-board-end-empty-stream | `../v2/invalid/` | reference_check PASS | N/A | N/A | Historical OK | Historical | — |
| V3-20 | v3 early natural terminal | **Alias family → V3-04** | Covered | Covered | Covered | via V3-04 | Engine | — |
| V3-21 | Pre-move unresolved match | `fixtures/V3-21-premove-match.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-22 | Select spent slot | `fixtures/V3-22-select-spent.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-23 | Ended then in-bounds tap | `fixtures/V3-23-post-terminal.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-24 | Multiple spent mid-game still playable | `fixtures/V3-24-partial-spent.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-25 | Last playable offer consumed ends | **Alias family → V3-04/08** | Covered | Covered | Covered | via family | Engine | — |
| V3-26 | Simultaneous budget+no-legal → `move_limit` | `fixtures/V3-26-dual-terminal.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-27 | Malformed piece / extra props | `invalid/V3-27-extra-piece-prop.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-28 | Duplicate/invalid blocked | `invalid/V3-28-duplicate-blocked.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-29 | Unsafe integer score | `invalid/V3-29-unsafe-score.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-30 | Key-order independence | `fixtures/V3-30-key-order.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-31 | Wrong rulesVersion | `invalid/V3-31-wrong-version.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-32 | Forged terminalReason | **Alias family → V3-12** | Covered | Covered | Covered | via V3-12 | Engine | — |
| V3-33 | Spent + non-empty stream | `invalid/V3-33-spent-with-future.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-34 | Repeated terminal evaluation | **Alias → V3-15** | Covered | Covered | Covered | via V3-15 | Engine | — |
| V3-35 | Cross-language hash parity | Meta-gate over frozen positives | Comparator | Comparator | Comparator | Meta | Engine | — |
| V3-36 | Playable falsely ended | `invalid/V3-36-false-ended.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-37 | Budget exhausted falsely active | `invalid/V3-37-false-active.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-38 | No placement falsely active | **Alias family → V3-07** | Covered | Covered | Covered | via V3-07 | Engine | — |
| V3-39 | No placement → ended/`no_legal` | **Alias → V3-07** | Covered | Covered | Covered | via V3-07 | Engine | — |
| V3-40 | Budget + no placement | **Alias → V3-26** | Covered | Covered | Covered | via V3-26 | Engine | — |
| V3-41 | Valid ended; hasLegalMove false | **Alias family → V3-07/15** | Covered | Covered | Covered | via family | Engine | — |
| V3-42 | Forged score + matching hash | `fixtures/V3-42-forged-score.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-43 | Forged board + self-consistent hash | `fixtures/V3-43-forged-board.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-44 | Forged terminal | **Alias family → V3-12/36** | Covered | Covered | Covered | via family | Engine | — |
| V3-45 | Unreachable spent history | `fixtures/V3-45-unreachable-spent.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-46 | Reordered moves | `fixtures/V3-46-reorder-moves.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-47 | Wrong rulesVersion pin | **Alias → V3-31** | Covered | Covered | Covered | via V3-31 | Engine | — |
| V3-48 | Client overwrites trusted tournament checkpoint | Stage E `test/tournament/adjudication/v3-48-checkpoint.test.mts` (not a pure-engine fixture) | Service PASS | N/A | N/A | N/A | **Tournament (PZD-38/Stage E)** | Auth HTTP E2E + publish still NOT_RUN |
| V3-49 | Cascade arithmetic overflow | `fixtures/V3-49-score-overflow.json` | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-50 | Impossible initial | **Alias → V3-14** | Covered | Covered | Covered | via V3-14 | Engine | — |
| V3-51 | CV-01…09 atom digests | `fixtures/V3-51-atoms.json` + vectors doc | PASS | PASS | PASS | FROZEN | Engine | — |
| V3-52 | Full-state key-order independence | **Alias → V3-30** | Covered | Covered | Covered | via V3-30 | Engine | — |

### Classification (do not conflate)

| Gate | Outcome |
| --- | --- |
| **Stage D engine fixture parity** | **FROZEN / PASS** — 33/33 executable fixtures; oracle↔Dart↔TS; ledger frozen |
| **V3-48 tournament security** | **NOT_RUN** — belongs to PZD-38; never marked engine PASS |
| **Ranked production / overall PZD-39 release readiness** | **BLOCKED** — V3-48 + ranked pin/deploy gates remain |

### Notes

- IDs are not renamed. Coverage aliases are explicit and **not** counted as independent executions.
- Aggregate `33 PASS` does **not** imply every catalogue ID was independently executed.
- No catalogue row references a nonexistent fixture file.
- V3-03 expectations come from independent hand derivation + Python stdlib oracle (not product-engine copy).
- V3-43 proves forged board + attacker self-hash fails strict full compare (`board_mismatch`, `state_hash_mismatch`) while legitimate replay remains `replayOk: true`.

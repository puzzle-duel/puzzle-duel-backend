# CORE-001.v3 fixture catalogue audit (Stage D)

Status: Stage D inventory — definitions recovered from Accepted design history.
Sources:
- `b5dc911` FIXTURE-SPEC (V3-01…V3-25 initial)
- `c64bd57` FIXTURE-SPEC remediation (V3-21…V3-35 refined; V3-26…V3-35 added)
- Current FIXTURE-SPEC V3-36…V3-52 (ADR P0/P1 remediation)
- `canonical-v3-test-vectors.md` (CV-01…09 / V3-51)

Engine pins for this audit:
- Backend Stage C tip: `25efb2473f3517027769ee978b31ab6e3dc41030`
- Backend Stage C tested: `f3eab0b64bad7f3679a853e01a78d0b082063ecd`
- Client Stage B: `946f015a5124d1a9dfd6f3440cc916b9eb1789f8`

## Inventory V3-01…V3-52

| Fixture ID | Normative scenario | Concrete input (Stage D) | Independent oracle | Dart | TS | Freeze eligibility |
| --- | --- | --- | --- | --- | --- | --- |
| V3-01 | Normal legal placement | `fixtures/V3-01-legal-placement.json` | Yes | Runner | Runner | Eligible |
| V3-02 | Single-wave clear | `fixtures/V3-02-single-wave.json` | Hand 3×100×1=300 | Runner | Runner | Eligible |
| V3-03 | Multi-wave cascade | Deferred (needs hand board) | Pending | — | — | PENDING_FREEZE |
| V3-04 | Board becomes full → no_legal_moves | `fixtures/V3-04-board-full.json` | Yes | Runner | Runner | Eligible |
| V3-05 | Cascade reopens space | `fixtures/V3-05-cascade-reopen.json` | Hand 300 | Runner | Runner | Eligible |
| V3-06 | Empty stream, live offers | `fixtures/V3-06-empty-stream-live.json` | Yes | Runner | Runner | Eligible |
| V3-07 | All spent + empty cells → no_legal_moves | `fixtures/V3-07-all-spent.json` | Parse-only | Runner | Runner | Eligible |
| V3-08 | Consumed offer → spent | `fixtures/V3-08-offer-spent.json` | Yes | Runner | Runner | Eligible |
| V3-09 | Move budget exhausted | `fixtures/V3-09-move-limit.json` | Yes | Runner | Runner | Eligible |
| V3-10 | No available offers (alias V3-07) | Links V3-07 | Same | Same | Same | Covered by V3-07 |
| V3-11 | Illegal placement | `fixtures/V3-11-illegal-tap.json` | Yes | Runner | Runner | Eligible |
| V3-12 | Corrupted terminal proof | `invalid/V3-12-false-ended.json` | Parse reject | Runner | Runner | Eligible |
| V3-13 | Malformed tray / bare null | `invalid/V3-13-bare-null-offer.json` | Parse reject | Runner | Runner | Eligible |
| V3-14 | Corrupt / impossible initial | `invalid/V3-14-impossible-initial.json` | ParseInitial reject | Runner | Runner | Eligible |
| V3-15 | Idempotent terminal re-eval | `fixtures/V3-15-terminal-idempotent.json` | Parse-only | Runner | Runner | Eligible |
| V3-16 | Serialize/parse round-trip | Covered by positive finals | Canonical | Runner | Runner | Eligible |
| V3-17 | Historical v1 fixtures | `../v1/` + CHECKSUMS | reference_check | N/A | N/A | Historical PASS gate |
| V3-18 | Historical v2 fixtures | `../v2/` + CHECKSUMS | reference_check | N/A | N/A | Historical PASS gate |
| V3-19 | v2 early-board-end-empty-stream | `../v2/invalid/` | reference_check | N/A | N/A | Historical PASS gate |
| V3-20 | v3 early natural terminal | Same family as V3-04 | Yes | Runner | Runner | Covered by V3-04 |
| V3-21 | Pre-move unresolved match | `fixtures/V3-21-premove-match.json` | Unsafe | Runner | Runner | Eligible |
| V3-22 | Select spent slot | `fixtures/V3-22-select-spent.json` | Unsafe | Runner | Runner | Eligible |
| V3-23 | Ended then in-bounds tap | `fixtures/V3-23-post-terminal.json` | Rejected | Runner | Runner | Eligible |
| V3-24 | Multiple spent mid-game still playable | `fixtures/V3-24-partial-spent.json` | Yes | Runner | Runner | Eligible |
| V3-25 | Last playable offer consumed ends | Covered by V3-04/08 family | Yes | Runner | Runner | Covered |
| V3-26 | Simultaneous budget+no-legal → move_limit | `fixtures/V3-26-dual-terminal.json` | deriveTerminal | Runner | Runner | Eligible |
| V3-27 | Malformed piece / extra props | `invalid/V3-27-extra-piece-prop.json` | Parse | Runner | Runner | Eligible |
| V3-28 | Duplicate/invalid blocked | `invalid/V3-28-duplicate-blocked.json` | Parse | Runner | Runner | Eligible |
| V3-29 | Unsafe integer score | `invalid/V3-29-unsafe-score.json` | Parse | Runner | Runner | Eligible |
| V3-30 | Key-order independence | `fixtures/V3-30-key-order.json` | Canonical | Runner | Runner | Eligible |
| V3-31 | Wrong rulesVersion | `invalid/V3-31-wrong-version.json` | Parse/replay | Runner | Runner | Eligible |
| V3-32 | Forged terminalReason | Covered by V3-12 family | Parse | Runner | Runner | Covered |
| V3-33 | Spent + non-empty stream | `invalid/V3-33-spent-with-future.json` | Parse | Runner | Runner | Eligible |
| V3-34 | Repeated terminal evaluation | Covered by V3-15 | Parse | Runner | Runner | Covered |
| V3-35 | Cross-language hash parity | All frozen positives | Comparator | Runner | Runner | Meta-gate |
| V3-36 | Playable falsely ended | `invalid/V3-36-false-ended.json` | Parse | Runner | Runner | Eligible |
| V3-37 | Budget exhausted falsely active | `invalid/V3-37-false-active.json` | Parse | Runner | Runner | Eligible |
| V3-38 | No placement falsely active | Covered by V3-07 false active | Parse | Runner | Runner | Covered |
| V3-39 | No placement → ended/no_legal | Covered by V3-07 | Parse | Runner | Runner | Covered |
| V3-40 | Budget + no placement | Covered by V3-26 | deriveTerminal | Runner | Runner | Covered |
| V3-41 | Valid ended; hasLegalMove false | Covered by V3-07/15 | Predicate | Runner | Runner | Covered |
| V3-42 | Forged score + matching hash | `fixtures/V3-42-forged-score.json` | Replay compare | Runner | Runner | Eligible |
| V3-43 | Forged board + matching hash | `fixtures/V3-43-forged-board.json` | Replay compare | Runner | Runner | Eligible |
| V3-44 | Forged terminal | Covered by V3-12/36 | Parse | Runner | Runner | Covered |
| V3-45 | Unreachable spent history | `fixtures/V3-45-unreachable-spent.json` | Replay diverge | Runner | Runner | Eligible |
| V3-46 | Reordered moves | `fixtures/V3-46-reorder-moves.json` | Replay diverge | Runner | Runner | Eligible |
| V3-47 | Wrong rulesVersion pin | Covered by V3-31 | Replay | Runner | Runner | Covered |
| V3-48 | Client overwrites trusted checkpoint | **Tournament layer** | N/A Stage D engine | — | — | **NOT_RUN (PZD-38)** |
| V3-49 | Cascade arithmetic overflow | `fixtures/V3-49-score-overflow.json` | Unsafe | Runner | Runner | Eligible |
| V3-50 | Impossible initial | Covered by V3-14 | ParseInitial | Runner | Runner | Covered |
| V3-51 | CV-01…09 atom digests | `canonical-v3-test-vectors.md` + `fixtures/V3-51-atoms.json` | Python SHA | Both | Both | **FROZEN candidate** |
| V3-52 | Full state key-order independence | Covered by V3-30 | Canonical | Runner | Runner | Covered |

### Notes

- IDs are not renamed. Coverage aliases are explicit.
- V3-03 multi-wave remains **PENDING_FREEZE** until an independently hand-checked two-wave board is authored without deriving expectations from product engines.
- V3-48 must never be reported as pure-engine PASS.

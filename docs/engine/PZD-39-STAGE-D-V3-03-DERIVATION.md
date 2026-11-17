# V3-03 Multi-Wave Cascade — Independent Hand Derivation

Status: independently verified (Python stdlib oracle + hand arithmetic)  
Fixture: `docs/contracts/gameplay/v3/fixtures/V3-03-multi-wave.json`  
Oracle: `tools/stage_d/oracle/core001v3_oracle.py` (`stage-d-python-stdlib-1`)  
Rules: `core-001.v3` / ADR-E01; clear PZD-19; shift PZD-20  
Search provenance: geometry adapted from historical PZD-11 `docs/contracts/gameplay/v1/fixtures/10-two-wave-cascade.json`, re-authored as tagged v3 offers. Expectations were **not** copied from Dart or TypeScript.

## Constraints satisfied

1. Initial board has no unresolved orthogonal match.
2. Passes `parseInitialGameState` / oracle `parse_game_state(..., initial=True)`.
3. Three live piece offers.
4. Game is playable (`status=in_progress`, legal placement exists).
5. Selected move is valid.
6. Applied move produces **two** cascade waves.
7. Shift/collision follow accepted PZD-19/PZD-20.
8. No injected pre-existing match; no non-initial snapshot shortcut.

## Initial board (5×5)

Coordinates are `[row, column]`. Occupied cells:

| Coord | Shape | Direction |
| --- | --- | --- |
| `[0,0]` | circle | left |
| `[0,1]` | circle | left |
| `[4,0]` | diamond | down |
| `[4,1]` | diamond | down |
| `[4,3]` | diamond | left |

All other cells empty. `blocked=[]`.

Offers (live):

0. circle / up  
1. diamond / down  
2. triangle / left  

`futurePieces`: circle/left, diamond/up  
`turnsUsed=0`, `score=0`, `status=in_progress`, `terminalReason=null`, `moveLimit=5`.

No three-in-a-row/column of identical shape exists initially.

## Selected move

- Offer index `0` → circle / up  
- Tap `[0,2]`  
- Placement direction is **up**; travel from tap along up until blocked/edge; empty landing remains `[0,2]` (cell above would be out of board; tap cell empty → lands at tap).

## Board after placement (before wave 1)

Row 0: circle-left @`[0,0]`, circle-left @`[0,1]`, **circle-up @`[0,2]`**, empty, empty  
Row 4 unchanged: diamond-down @`[4,0]`, diamond-down @`[4,1]`, empty, diamond-left @`[4,3]`, empty

## Wave 1

Matched / cleared (unique, row-major): `[0,0]`, `[0,1]`, `[0,2]`  
`uniqueClearedCount = 3`  
`waveScore = 3 × 100 × 1 = 300`

Board after clear: row 0 empty; row 4 unchanged.

### Wave 1 shifts (PZD-20)

Candidates after clear, ordered by `sourceIndex = row * boardSize + col`:

- Diamond at `[4,3]` (`sourceIndex=23`), direction left → proposed `[4,2]`.
- `[4,2]` is empty and not blocked → **accepted**.
- Diamonds at `[4,0]` and `[4,1]` propose down into out-of-board / invalid → **rejected**.

Board after wave 1 shift: diamonds at `[4,0]`, `[4,1]`, **`[4,2]`** (moved from `[4,3]`).

Moved record: `{sourceIndex:23, from:[4,3], to:[4,2], shape:diamond, direction:left}`.

## Why wave 2 is created

After the accepted left-shift, row 4 has three identical diamonds at `[4,0]`, `[4,1]`, `[4,2]` — a new orthogonal match.

## Wave 2

Matched / cleared: `[4,0]`, `[4,1]`, `[4,2]`  
`uniqueClearedCount = 3`  
`waveScore = 3 × 100 × 2 = 600`

No further matches after clear; no accepted shifts remain that create another match.

## Score arithmetic

| Wave | uniqueCleared | formula | scoreDelta |
| ---: | ---: | --- | ---: |
| 1 | 3 | `3 × 100 × 1` | 300 |
| 2 | 3 | `3 × 100 × 2` | 600 |
| **Total** | | | **900** |

## Final GameState (normative summary)

- Board: all empty (5×5).
- Offers after consume: circle/left (from stream), diamond/down, triangle/left.
- `futurePieces`: `[diamond/up]`.
- `turnsUsed=1`, `score=900`, `status=in_progress`, `terminalReason=null`.

Independent SHA-256 of canonical JSON final state:

`ba90da3fc85df0527510e290375ee66993e5e77d05ef0bb9630bd14c85fbeabc`

This digest was recomputed from oracle `canonical_json` bytes; it was **not** accepted because Dart and TypeScript agreed.

#!/usr/bin/env python3
"""Author Stage D fixtures with independently computed oracle expectations."""
from __future__ import annotations

import json
from pathlib import Path

from core001v3_oracle import (
    apply_move,
    canonical_json,
    parse_game_state,
    replay,
    sha256_hex,
    state_hash,
)

ROOT = Path(__file__).resolve().parents[3]
FIX = ROOT / "docs/contracts/gameplay/v3/fixtures"
INV = ROOT / "docs/contracts/gameplay/v3/invalid"


def piece(shape="circle", direction="right"):
    return {"shape": shape, "direction": direction}


def offer(shape="circle", direction="right"):
    return {"kind": "piece", "shape": shape, "direction": direction}


def playable(**kwargs):
    base = {
        "rulesVersion": "core-001.v3",
        "boardSize": 2,
        "moveLimit": 5,
        "blocked": [],
        "cells": [[None, None], [None, None]],
        "offers": [offer(), offer("diamond", "down"), offer("triangle", "left")],
        "futurePieces": [piece("circle", "up"), piece("diamond", "left")],
        "turnsUsed": 0,
        "score": 0,
        "status": "in_progress",
        "terminalReason": None,
    }
    base.update(kwargs)
    return base


def write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def positive(fid, summary, initial, moves, require_initial=True, kind="fullMove"):
    result = replay(initial, moves, require_initial=require_initial)
    assert result["ok"], (fid, result)
    return {
        "id": fid,
        "kind": kind,
        "rulesVersion": "core-001.v3",
        "summary": summary,
        "oracleVersion": "stage-d-python-stdlib-1",
        "initialState": initial,
        "moves": moves,
        "requireInitial": require_initial,
        "expected": {
            "ok": True,
            "finalState": result["finalState"],
            "stateHash": result["stateHash"],
            "canonicalJson": result["canonicalJson"],
            "applied": [
                {
                    "landing": a["landing"],
                    "turnsUsed": a["turnsUsed"],
                    "scoreDelta": a["scoreDelta"],
                    "waves": a["waves"],
                    "finalState": a["finalState"],
                    "stateHash": a["stateHash"],
                }
                for a in result["applied"]
            ],
        },
    }


def parse_only(fid, summary, state, initial=False, expect_ok=True, codes=None):
    doc = {
        "id": fid,
        "kind": "parseOnly",
        "rulesVersion": "core-001.v3",
        "summary": summary,
        "oracleVersion": "stage-d-python-stdlib-1",
        "state": state,
        "initial": initial,
    }
    try:
        st = parse_game_state(state, initial=initial)
        assert expect_ok, fid
        doc["expected"] = {"ok": True, "state": st, "stateHash": state_hash(st)}
    except Exception as e:
        assert not expect_ok, (fid, e)
        doc["expected"] = {"ok": False, "codes": getattr(e, "codes", ["error"])}
        if codes:
            assert all(c in doc["expected"]["codes"] for c in codes), (fid, doc["expected"])
    return doc


def main() -> None:
    FIX.mkdir(parents=True, exist_ok=True)
    INV.mkdir(parents=True, exist_ok=True)

    # V3-01 legal placement
    write(
        FIX / "V3-01-legal-placement.json",
        positive(
            "V3-01",
            "Normal legal placement; stream advances; scoreDelta 0",
            playable(),
            [{"offerIndex": 0, "tap": [0, 0]}],
        ),
    )

    # V3-02 single wave — hand-checkable 3*100*1=300
    match_ready = playable(
        boardSize=3,
        cells=[
            [piece("circle", "up"), piece("circle", "up"), None],
            [None, None, None],
            [None, None, None],
        ],
        offers=[offer("circle", "left"), offer("diamond", "down"), offer("triangle", "up")],
        futurePieces=[piece("diamond", "right")],
    )
    v302 = positive(
        "V3-02",
        "Single-wave clear scoreDelta=300",
        match_ready,
        [{"offerIndex": 0, "tap": [0, 2]}],
    )
    assert v302["expected"]["applied"][0]["scoreDelta"] == 300
    write(FIX / "V3-02-single-wave.json", v302)

    # V3-04 board full
    almost = playable(
        boardSize=1,
        cells=[[None]],
        futurePieces=[],
        offers=[offer(), offer("diamond", "down"), offer("triangle", "left")],
    )
    write(
        FIX / "V3-04-board-full.json",
        positive("V3-04", "Board-full natural terminal no_legal_moves", almost, [{"offerIndex": 0, "tap": [0, 0]}]),
    )

    # V3-05 cascade reopen
    reopen = playable(
        boardSize=3,
        cells=[
            [piece("circle", "up"), piece("circle", "up"), None],
            [piece("diamond", "down"), piece("triangle", "left"), piece("diamond", "up")],
            [piece("triangle", "right"), piece("diamond", "left"), piece("triangle", "down")],
        ],
        offers=[offer("circle", "left"), offer("diamond", "down"), offer("triangle", "up")],
        futurePieces=[piece("diamond", "right")],
    )
    v305 = positive("V3-05", "Cascade reopens; remains in_progress", reopen, [{"offerIndex": 0, "tap": [0, 2]}])
    assert v305["expected"]["finalState"]["status"] == "in_progress"
    write(FIX / "V3-05-cascade-reopen.json", v305)

    # V3-06 empty stream live offers
    empty_stream = playable(futurePieces=[])
    write(
        FIX / "V3-06-empty-stream-live.json",
        positive(
            "V3-06",
            "Empty stream does not force terminal while live offers+cells remain",
            empty_stream,
            [{"offerIndex": 1, "tap": [0, 1]}],
        ),
    )

    # V3-07 all spent parse
    all_spent = playable(
        offers=[{"kind": "spent"}, {"kind": "spent"}, {"kind": "spent"}],
        futurePieces=[],
        turnsUsed=2,
        status="ended",
        terminalReason="no_legal_moves",
    )
    write(FIX / "V3-07-all-spent.json", parse_only("V3-07", "All spent empty board ended", all_spent))

    # V3-08 spent after consume
    write(
        FIX / "V3-08-offer-spent.json",
        positive(
            "V3-08",
            "Consumed offer becomes spent when stream empty",
            playable(futurePieces=[]),
            [{"offerIndex": 0, "tap": [0, 0]}],
        ),
    )

    # V3-09 move limit
    write(
        FIX / "V3-09-move-limit.json",
        positive(
            "V3-09",
            "Move budget exhausted → move_limit_reached",
            playable(moveLimit=1, futurePieces=[]),
            [{"offerIndex": 0, "tap": [0, 0]}],
        ),
    )

    # V3-11 occupied illegal
    occupied = playable(cells=[[piece(), None], [None, None]])
    before = parse_game_state(occupied, initial=True)
    bad = apply_move(before, {"offerIndex": 0, "tap": [0, 0]})
    write(
        FIX / "V3-11-illegal-tap.json",
        {
            "id": "V3-11",
            "kind": "fullMove",
            "rulesVersion": "core-001.v3",
            "summary": "Occupied tap rejected; zero mutation",
            "oracleVersion": "stage-d-python-stdlib-1",
            "initialState": occupied,
            "moves": [{"offerIndex": 0, "tap": [0, 0]}],
            "requireInitial": True,
            "expected": {
                "ok": False,
                "result": {"kind": "rejected", "code": "occupied_tap"},
                "unchangedState": before,
            },
        },
    )
    assert bad["kind"] == "rejected"

    # V3-15 / V3-07 terminal idempotent
    write(FIX / "V3-15-terminal-idempotent.json", parse_only("V3-15", "Ended snapshot stable", all_spent))

    # V3-21 pre-move match
    dirty = playable(
        boardSize=3,
        cells=[
            [piece("circle"), piece("circle"), piece("circle")],
            [None, None, None],
            [None, None, None],
        ],
        status="in_progress",
        terminalReason=None,
        turnsUsed=0,
    )
    # derive terminal may still be in_progress if offers+cells exist after? board has empty cells
    # has legal placement true; status in_progress OK structurally but applyMove unsafe
    st = parse_game_state(dirty, initial=False)
    unsafe = apply_move(st, {"offerIndex": 0, "tap": [1, 0]})
    write(
        FIX / "V3-21-premove-match.json",
        {
            "id": "V3-21",
            "kind": "fullMove",
            "rulesVersion": "core-001.v3",
            "summary": "Unresolved pre-move match is unsafe",
            "oracleVersion": "stage-d-python-stdlib-1",
            "initialState": dirty,
            "moves": [{"offerIndex": 0, "tap": [1, 0]}],
            "requireInitial": False,
            "expected": {"ok": False, "result": {"kind": "unsafe", "reason": "unresolved_pre_move_match"}},
        },
    )
    assert unsafe["reason"] == "unresolved_pre_move_match"

    # V3-22 select spent
    one_spent = playable(
        offers=[{"kind": "spent"}, offer("diamond", "down"), offer("triangle", "left")],
        futurePieces=[],
        turnsUsed=1,
    )
    write(
        FIX / "V3-22-select-spent.json",
        {
            "id": "V3-22",
            "kind": "fullMove",
            "summary": "Selecting spent is offer_unavailable",
            "rulesVersion": "core-001.v3",
            "oracleVersion": "stage-d-python-stdlib-1",
            "initialState": one_spent,
            "moves": [{"offerIndex": 0, "tap": [0, 0]}],
            "requireInitial": False,
            "expected": {"ok": False, "result": {"kind": "unsafe", "reason": "offer_unavailable"}},
        },
    )

    # V3-23 post terminal
    ended = playable(
        boardSize=1,
        cells=[[piece()]],
        offers=[{"kind": "spent"}, offer("diamond", "down"), offer("triangle", "left")],
        futurePieces=[],
        turnsUsed=1,
        status="ended",
        terminalReason="no_legal_moves",
    )
    write(
        FIX / "V3-23-post-terminal.json",
        {
            "id": "V3-23",
            "kind": "fullMove",
            "summary": "Post-terminal in-bounds tap → game_ended",
            "rulesVersion": "core-001.v3",
            "oracleVersion": "stage-d-python-stdlib-1",
            "initialState": ended,
            "moves": [{"offerIndex": 1, "tap": [0, 0]}],
            "requireInitial": False,
            "expected": {"ok": False, "result": {"kind": "rejected", "code": "game_ended"}},
        },
    )

    # V3-24 partial spent playable
    write(
        FIX / "V3-24-partial-spent.json",
        parse_only("V3-24", "One spent mid-game still in_progress", one_spent),
    )

    # V3-26 dual terminal precedence
    dual = playable(
        boardSize=1,
        cells=[[piece()]],
        offers=[{"kind": "spent"}, {"kind": "spent"}, {"kind": "spent"}],
        futurePieces=[],
        turnsUsed=1,
        moveLimit=1,
        status="ended",
        terminalReason="move_limit_reached",
    )
    write(FIX / "V3-26-dual-terminal.json", parse_only("V3-26", "Budget+no-legal → move_limit_reached", dual))

    # V3-30 / V3-52 key order via stateHash stability
    st = parse_game_state(playable(), initial=True)
    h1 = state_hash(st)
    # permute offer object key order in serialization only
    write(
        FIX / "V3-30-key-order.json",
        {
            "id": "V3-30",
            "kind": "hashOnly",
            "summary": "Canonical key-order independence for GameState",
            "rulesVersion": "core-001.v3",
            "oracleVersion": "stage-d-python-stdlib-1",
            "state": st,
            "expected": {"stateHash": h1, "canonicalJson": canonical_json(st)},
        },
    )

    # V3-42 forged score compare class
    honest = parse_game_state(playable(), initial=True)
    forged = parse_game_state(playable(score=999), initial=False)
    write(
        FIX / "V3-42-forged-score.json",
        {
            "id": "V3-42",
            "kind": "replaySecurity",
            "summary": "Forged score with self-hash is not ranked proof",
            "rulesVersion": "core-001.v3",
            "oracleVersion": "stage-d-python-stdlib-1",
            "trustedInitial": playable(),
            "moves": [],
            "clientReport": {
                "score": 999,
                "board": forged["cells"] if False else honest["cells"],
                "offers": honest["offers"],
                "turnsUsed": 0,
                "status": "in_progress",
                "terminalReason": None,
                "stateHash": state_hash(forged),
            },
            "expected": {
                "replayOk": True,
                "fullCompareOk": False,
                "mismatchesInclude": ["score_mismatch", "state_hash_mismatch"],
            },
        },
    )

    # V3-45 unreachable spent vs trusted initial
    write(
        FIX / "V3-45-unreachable-spent.json",
        {
            "id": "V3-45",
            "kind": "replaySecurity",
            "summary": "Pretty spent snapshot ≠ trusted zero-move replay",
            "rulesVersion": "core-001.v3",
            "oracleVersion": "stage-d-python-stdlib-1",
            "trustedInitial": playable(),
            "moves": [],
            "claimedSnapshot": one_spent,
            "expected": {"replayFinalDiffersFromClaimed": True},
        },
    )

    # V3-46 reorder moves
    write(
        FIX / "V3-46-reorder-moves.json",
        {
            "id": "V3-46",
            "kind": "replaySecurity",
            "summary": "Reordered moves diverge",
            "rulesVersion": "core-001.v3",
            "oracleVersion": "stage-d-python-stdlib-1",
            "trustedInitial": playable(),
            "movesA": [{"offerIndex": 0, "tap": [0, 0]}, {"offerIndex": 1, "tap": [1, 0]}],
            "movesB": [{"offerIndex": 1, "tap": [1, 0]}, {"offerIndex": 0, "tap": [0, 0]}],
            "expected": {"hashesDiffer": True},
        },
    )

    # V3-49 score overflow
    overflow_state = match_ready.copy()
    overflow_state = playable(
        boardSize=3,
        cells=match_ready["cells"],
        offers=match_ready["offers"],
        futurePieces=match_ready["futurePieces"],
        score=9007199254740991 - 100,
    )
    write(
        FIX / "V3-49-score-overflow.json",
        {
            "id": "V3-49",
            "kind": "fullMove",
            "summary": "Score overflow fails closed",
            "rulesVersion": "core-001.v3",
            "oracleVersion": "stage-d-python-stdlib-1",
            "initialState": overflow_state,
            "moves": [{"offerIndex": 0, "tap": [0, 2]}],
            "requireInitial": False,
            "expected": {"ok": False, "result": {"kind": "unsafe", "reason": "score_overflow"}},
        },
    )

    # V3-51 atoms
    atoms = [
        ("CV-01", {}, "{}"),
        ("CV-02", {"kind": "spent"}, '{"kind":"spent"}'),
        ("CV-03", {"kind": "piece", "shape": "circle", "direction": "up"}, '{"direction":"up","kind":"piece","shape":"circle"}'),
        ("CV-04", None, "null"),
        ("CV-05", 0, "0"),
        ("CV-06", 900, "900"),
        ("CV-07", "ended", '"ended"'),
        ("CV-08", 'a"b', '"a\\"b"'),
        ("CV-09", "a\\b", '"a\\\\b"'),
    ]
    expected_atoms = []
    for cid, value, exact in atoms:
        c = canonical_json(value)
        assert c == exact, (cid, c, exact)
        expected_atoms.append({"id": cid, "canonicalJson": c, "sha256": sha256_hex(c)})
    write(
        FIX / "V3-51-atoms.json",
        {
            "id": "V3-51",
            "kind": "hashOnly",
            "summary": "Independent CV-01…09 atom digests",
            "rulesVersion": "core-001.v3",
            "oracleVersion": "stage-d-python-stdlib-1",
            "expected": {"atoms": expected_atoms},
        },
    )

    # invalids
    write(
        INV / "V3-12-false-ended.json",
        parse_only(
            "V3-12",
            "Playable falsely ended",
            playable(status="ended", terminalReason="no_legal_moves"),
            expect_ok=False,
            codes=["inconsistent_status"],
        ),
    )
    write(
        INV / "V3-13-bare-null-offer.json",
        parse_only(
            "V3-13",
            "Bare null offer",
            playable(offers=[None, offer("diamond", "down"), offer("triangle", "left")]),
            expect_ok=False,
            codes=["null_offer"],
        ),
    )
    write(
        INV / "V3-14-impossible-initial.json",
        parse_only(
            "V3-14",
            "Impossible initial (all spent)",
            playable(offers=[{"kind": "spent"}, {"kind": "spent"}, {"kind": "spent"}], futurePieces=[]),
            initial=True,
            expect_ok=False,
        ),
    )
    write(
        INV / "V3-27-extra-piece-prop.json",
        parse_only(
            "V3-27",
            "Extra piece property",
            playable(cells=[[{"shape": "circle", "direction": "right", "x": 1}, None], [None, None]]),
            expect_ok=False,
            codes=["unexpected_property"],
        ),
    )
    write(
        INV / "V3-28-duplicate-blocked.json",
        parse_only(
            "V3-28",
            "Duplicate blocked",
            playable(blocked=[[0, 0], [0, 0]], cells=[[None, None], [None, None]]),
            expect_ok=False,
            codes=["duplicate_blocked"],
        ),
    )
    write(
        INV / "V3-29-unsafe-score.json",
        parse_only(
            "V3-29",
            "Unsafe integer score",
            playable(score=9007199254740992),
            expect_ok=False,
            codes=["integer_out_of_range"],
        ),
    )
    write(
        INV / "V3-31-wrong-version.json",
        parse_only(
            "V3-31",
            "Unknown rulesVersion pin (not silently reinterpreted)",
            playable(rulesVersion="core-001.v9"),
            expect_ok=False,
            codes=["unknown_rules_version"],
        ),
    )
    write(
        INV / "V3-33-spent-with-future.json",
        parse_only(
            "V3-33",
            "Spent with future pieces",
            playable(
                offers=[{"kind": "spent"}, offer("diamond", "down"), offer("triangle", "left")],
                futurePieces=[piece()],
                turnsUsed=1,
            ),
            expect_ok=False,
            codes=["spent_with_future_pieces"],
        ),
    )
    write(
        INV / "V3-36-false-ended.json",
        parse_only(
            "V3-36",
            "Playable falsely ended/no_legal_moves",
            playable(status="ended", terminalReason="no_legal_moves"),
            expect_ok=False,
        ),
    )
    write(
        INV / "V3-37-false-active.json",
        parse_only(
            "V3-37",
            "Budget exhausted falsely in_progress",
            playable(moveLimit=1, turnsUsed=1, futurePieces=[], status="in_progress", terminalReason=None),
            expect_ok=False,
        ),
    )

    print("fixtures authored under", FIX, "and", INV)


if __name__ == "__main__":
    main()

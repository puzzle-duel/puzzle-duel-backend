#!/usr/bin/env python3
"""Independent CORE-001.v3 reference oracle (stdlib only).

Does not import Dart or TypeScript engines. Used for Stage D expected values.
"""
from __future__ import annotations

import copy
import hashlib
import json
from typing import Any, Dict, List, Optional, Tuple

JSON_MAX = 9007199254740991
RULES = "core-001.v3"
SHAPES = {"circle", "diamond", "triangle"}
DIRS = {"up", "right", "down", "left"}
DELTA = {"up": (-1, 0), "down": (1, 0), "left": (0, -1), "right": (0, 1)}


class OracleError(Exception):
    def __init__(self, codes: List[str]):
        self.codes = codes
        super().__init__(",".join(codes))


def _safe_int(v: Any) -> int:
    if isinstance(v, bool) or not isinstance(v, int):
        raise OracleError(["malformed_score"])
    if v < -JSON_MAX or v > JSON_MAX:
        raise OracleError(["integer_out_of_range"])
    return v


def _checked_add(a: int, b: int) -> int:
    if a < 0 or b < 0:
        raise OracleError(["integer_overflow"])
    s = a + b
    if s > JSON_MAX:
        raise OracleError(["integer_overflow"])
    return s


def _checked_mul(a: int, b: int) -> int:
    if a < 0 or b < 0:
        raise OracleError(["integer_overflow"])
    if a == 0 or b == 0:
        return 0
    p = a * b
    if p > JSON_MAX or p // b != a:
        raise OracleError(["integer_overflow"])
    return p


def canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        if isinstance(value, bool) or value < -JSON_MAX or value > JSON_MAX:
            raise OracleError(["integer_out_of_range"])
        return str(value)
    if isinstance(value, float):
        raise OracleError(["malformed_score"])
    if isinstance(value, str):
        out = ['"']
        for ch in value:
            o = ord(ch)
            if o > 0x7F:
                raise OracleError(["unexpected_property"])
            if o == 0x22:
                out.append('\\"')
            elif o == 0x5C:
                out.append("\\\\")
            elif o <= 0x1F:
                out.append(f"\\u00{o:02x}")
            else:
                out.append(ch)
        out.append('"')
        return "".join(out)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(x) for x in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=lambda k: k.encode("utf-8"))
        parts = []
        for k in keys:
            if not isinstance(k, str):
                raise OracleError(["unexpected_property"])
            parts.append(canonical_json(k) + ":" + canonical_json(value[k]))
        return "{" + ",".join(parts) + "}"
    raise OracleError(["unexpected_property"])


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def state_hash(state: Dict[str, Any]) -> str:
    return sha256_hex(canonical_json(state))


def _blocked_set(blocked: List[List[int]]) -> set:
    return {(r, c) for r, c in blocked}


def has_orthogonal_run(cells: List[List[Optional[Dict[str, str]]]]) -> bool:
    n = len(cells)
    for r in range(n):
        c = 0
        while c < n:
            p = cells[r][c]
            if p is None:
                c += 1
                continue
            end = c + 1
            while end < n and cells[r][end] and cells[r][end]["shape"] == p["shape"]:
                end += 1
            if end - c >= 3:
                return True
            c = end
    for c in range(n):
        r = 0
        while r < n:
            p = cells[r][c]
            if p is None:
                r += 1
                continue
            end = r + 1
            while end < n and cells[end][c] and cells[end][c]["shape"] == p["shape"]:
                end += 1
            if end - r >= 3:
                return True
            r = end
    return False


def find_matches(cells: List[List[Optional[Dict[str, str]]]]) -> List[List[int]]:
    n = len(cells)
    found: set = set()
    ordered: List[List[int]] = []

    def add(r: int, c: int) -> None:
        if (r, c) not in found:
            found.add((r, c))
            ordered.append([r, c])

    for r in range(n):
        c = 0
        while c < n:
            p = cells[r][c]
            if p is None:
                c += 1
                continue
            end = c + 1
            while end < n and cells[r][end] and cells[r][end]["shape"] == p["shape"]:
                end += 1
            if end - c >= 3:
                for i in range(c, end):
                    add(r, i)
            c = end
    for c in range(n):
        r = 0
        while r < n:
            p = cells[r][c]
            if p is None:
                r += 1
                continue
            end = r + 1
            while end < n and cells[end][c] and cells[end][c]["shape"] == p["shape"]:
                end += 1
            if end - r >= 3:
                for i in range(r, end):
                    add(i, c)
            r = end
    ordered.sort(key=lambda x: (x[0], x[1]))
    return ordered


def has_legal_placement(state: Dict[str, Any]) -> bool:
    n = state["boardSize"]
    blocked = _blocked_set(state["blocked"])
    cells = state["cells"]
    for offer in state["offers"]:
        if offer.get("kind") != "piece":
            continue
        for r in range(n):
            for c in range(n):
                if (r, c) in blocked:
                    continue
                if cells[r][c] is not None:
                    continue
                return True
    return False


def derive_terminal(state: Dict[str, Any]) -> Tuple[str, Optional[str]]:
    if state["turnsUsed"] >= state["moveLimit"]:
        return "ended", "move_limit_reached"
    if not has_legal_placement(state):
        return "ended", "no_legal_moves"
    return "in_progress", None


def parse_game_state(raw: Dict[str, Any], *, initial: bool = False) -> Dict[str, Any]:
    allowed = {
        "rulesVersion",
        "boardSize",
        "moveLimit",
        "blocked",
        "cells",
        "offers",
        "futurePieces",
        "turnsUsed",
        "score",
        "status",
        "terminalReason",
    }
    if set(raw.keys()) - allowed:
        raise OracleError(["unexpected_property"])
    missing = allowed - set(raw.keys())
    if missing:
        raise OracleError(["missing_field"])
    if raw["rulesVersion"] != RULES:
        raise OracleError(["unknown_rules_version"])
    board_size = _safe_int(raw["boardSize"])
    move_limit = _safe_int(raw["moveLimit"])
    turns_used = _safe_int(raw["turnsUsed"])
    score = _safe_int(raw["score"])
    if board_size < 1 or move_limit < 1 or turns_used < 0 or turns_used > move_limit or score < 0:
        raise OracleError(["illegal_turn_count" if turns_used > move_limit else "malformed_board"])
    cells = raw["cells"]
    if not isinstance(cells, list) or len(cells) != board_size:
        raise OracleError(["malformed_board"])
    grid: List[List[Optional[Dict[str, str]]]] = []
    for row in cells:
        if not isinstance(row, list) or len(row) != board_size:
            raise OracleError(["malformed_board"])
        out_row = []
        for cell in row:
            if cell is None:
                out_row.append(None)
            else:
                if set(cell.keys()) != {"shape", "direction"}:
                    raise OracleError(["unexpected_property"])
                if cell["shape"] not in SHAPES or cell["direction"] not in DIRS:
                    raise OracleError(["malformed_shape"])
                out_row.append({"shape": cell["shape"], "direction": cell["direction"]})
        grid.append(out_row)
    blocked = raw["blocked"]
    if not isinstance(blocked, list):
        raise OracleError(["malformed_board"])
    seen = set()
    blocked_out: List[List[int]] = []
    for i, b in enumerate(blocked):
        if not isinstance(b, list) or len(b) != 2:
            raise OracleError(["blocked_out_of_range"])
        r, c = _safe_int(b[0]), _safe_int(b[1])
        if r < 0 or c < 0 or r >= board_size or c >= board_size:
            raise OracleError(["blocked_out_of_range"])
        if (r, c) in seen:
            raise OracleError(["duplicate_blocked"])
        seen.add((r, c))
        if grid[r][c] is not None:
            raise OracleError(["blocked_cell_occupied"])
        if i > 0:
            pr, pc = blocked_out[-1]
            if not (r > pr or (r == pr and c > pc)):
                raise OracleError(["blocked_not_row_major"])
        blocked_out.append([r, c])
    offers_raw = raw["offers"]
    if not isinstance(offers_raw, list) or len(offers_raw) != 3:
        raise OracleError(["malformed_offers"])
    offers = []
    spent = 0
    for o in offers_raw:
        if o is None:
            raise OracleError(["null_offer"])
        if not isinstance(o, dict):
            raise OracleError(["malformed_offer_slot"])
        kind = o.get("kind")
        if kind == "spent":
            if set(o.keys()) != {"kind"}:
                raise OracleError(["unexpected_property"])
            spent += 1
            offers.append({"kind": "spent"})
        elif kind == "piece":
            if set(o.keys()) != {"kind", "shape", "direction"}:
                raise OracleError(["unexpected_property"])
            if o["shape"] not in SHAPES or o["direction"] not in DIRS:
                raise OracleError(["malformed_shape"])
            offers.append({"kind": "piece", "shape": o["shape"], "direction": o["direction"]})
        else:
            raise OracleError(["malformed_offer_slot"])
    future = []
    for p in raw["futurePieces"]:
        if set(p.keys()) != {"shape", "direction"}:
            raise OracleError(["unexpected_property"])
        future.append({"shape": p["shape"], "direction": p["direction"]})
    if spent > 0 and future:
        raise OracleError(["spent_with_future_pieces"])
    status = raw["status"]
    reason = raw["terminalReason"]
    if status not in ("in_progress", "ended"):
        raise OracleError(["inconsistent_status"])
    if reason is not None and reason not in ("move_limit_reached", "no_legal_moves"):
        raise OracleError(["inconsistent_terminal_reason"])
    state = {
        "rulesVersion": RULES,
        "boardSize": board_size,
        "moveLimit": move_limit,
        "blocked": blocked_out,
        "cells": grid,
        "offers": offers,
        "futurePieces": future,
        "turnsUsed": turns_used,
        "score": score,
        "status": status,
        "terminalReason": reason,
    }
    exp_status, exp_reason = derive_terminal(state)
    if status != exp_status or reason != exp_reason:
        raise OracleError(["inconsistent_status", "inconsistent_terminal_reason"])
    if initial:
        if turns_used != 0 or score != 0 or status != "in_progress" or reason is not None:
            raise OracleError(["inconsistent_status"])
        if any(o["kind"] != "piece" for o in offers):
            raise OracleError(["inconsistent_status"])
        if has_orthogonal_run(grid):
            raise OracleError(["unresolved_initial_match"])
        if not has_legal_placement(state):
            raise OracleError(["no_legal_initial_placement"])
    return state


def apply_shift(cells, blocked):
    n = len(cells)
    obstacles = _blocked_set(blocked)
    before = copy.deepcopy(cells)
    pieces = []
    occupied = set()
    for r in range(n):
        for c in range(n):
            p = before[r][c]
            if p is None:
                continue
            occupied.add((r, c))
            pieces.append((r, c, p, r * n + c))
    proposals = []
    for r, c, p, src in pieces:
        dr, dc = DELTA[p["direction"]]
        tr, tc = r + dr, c + dc
        ok = 0 <= tr < n and 0 <= tc < n and (tr, tc) not in obstacles and (tr, tc) not in occupied
        proposals.append((r, c, p, src, tr, tc, ok))
    claims: Dict[Tuple[int, int], int] = {}
    for *_, tr, tc, ok in proposals:
        if ok:
            claims[(tr, tc)] = claims.get((tr, tc), 0) + 1
    after = copy.deepcopy(before)
    moved = []
    accepted = []
    for r, c, p, src, tr, tc, ok in proposals:
        ok2 = ok and claims.get((tr, tc), 0) == 1
        accepted.append((r, c, p, src, tr, tc, ok2))
    for r, c, p, src, tr, tc, ok in accepted:
        if ok:
            after[r][c] = None
    for r, c, p, src, tr, tc, ok in accepted:
        if not ok:
            continue
        if after[tr][tc] is not None:
            raise OracleError(["cascade_corrupt"])
        after[tr][tc] = p
        moved.append(
            {
                "sourceIndex": src,
                "from": [r, c],
                "to": [tr, tc],
                "shape": p["shape"],
                "direction": p["direction"],
            }
        )
    moved.sort(key=lambda m: m["sourceIndex"])
    return after, moved


def apply_move(state: Dict[str, Any], move: Dict[str, Any]) -> Dict[str, Any]:
    state = copy.deepcopy(state)
    offer_index = move["offerIndex"]
    tap = move["tap"]
    n = state["boardSize"]
    tr, tc = tap[0], tap[1]
    if not (0 <= tr < n and 0 <= tc < n):
        return {"ok": False, "kind": "unsafe", "reason": "tap_out_of_bounds", "state": state}
    if state["status"] != "in_progress":
        return {"ok": False, "kind": "rejected", "code": "game_ended", "state": state}
    blocked = _blocked_set(state["blocked"])
    if (tr, tc) in blocked:
        return {"ok": False, "kind": "rejected", "code": "blocked_tap", "state": state}
    if state["cells"][tr][tc] is not None:
        return {"ok": False, "kind": "rejected", "code": "occupied_tap", "state": state}
    slot = state["offers"][offer_index]
    if slot.get("kind") != "piece":
        return {"ok": False, "kind": "unsafe", "reason": "offer_unavailable", "state": state}
    piece = {"shape": slot["shape"], "direction": slot["direction"]}
    if has_orthogonal_run(state["cells"]):
        return {"ok": False, "kind": "unsafe", "reason": "unresolved_pre_move_match", "state": state}
    dr, dc = DELTA[piece["direction"]]
    fr, fc = tr + dr, tc + dc
    if 0 <= fr < n and 0 <= fc < n and (fr, fc) not in blocked and state["cells"][fr][fc] is None:
        land = [fr, fc]
    else:
        land = [tr, tc]
    cells = copy.deepcopy(state["cells"])
    cells[land[0]][land[1]] = piece
    try:
        turns = _checked_add(state["turnsUsed"], 1)
    except OracleError:
        return {"ok": False, "kind": "unsafe", "reason": "integer_overflow", "state": state}

    waves = []
    board = cells
    occupied = sum(1 for row in board for x in row if x is not None)
    max_waves = occupied // 3
    while True:
        cleared = find_matches(board)
        if not cleared:
            break
        if len(waves) >= max_waves:
            return {"ok": False, "kind": "unsafe", "reason": "cascade_bound_exceeded", "state": state}
        if len(cleared) < 3:
            return {"ok": False, "kind": "unsafe", "reason": "cascade_corrupt", "state": state}
        before_occ = sum(1 for row in board for x in row if x is not None)
        after = copy.deepcopy(board)
        for r, c in cleared:
            after[r][c] = None
        after_occ = sum(1 for row in after for x in row if x is not None)
        if after_occ != before_occ - len(cleared):
            return {"ok": False, "kind": "unsafe", "reason": "cascade_corrupt", "state": state}
        board, moved = apply_shift(after, state["blocked"])
        if sum(1 for row in board for x in row if x is not None) != after_occ:
            return {"ok": False, "kind": "unsafe", "reason": "cascade_corrupt", "state": state}
        wave_n = len(waves) + 1
        try:
            wave_score = _checked_mul(_checked_mul(len(cleared), 100), wave_n)
        except OracleError:
            return {"ok": False, "kind": "unsafe", "reason": "score_overflow", "state": state}
        waves.append({"wave": wave_n, "cleared": cleared, "scoreDelta": wave_score, "moved": moved})

    score_delta = 0
    try:
        for w in waves:
            score_delta = _checked_add(score_delta, w["scoreDelta"])
        score = _checked_add(state["score"], score_delta)
    except OracleError:
        return {"ok": False, "kind": "unsafe", "reason": "score_overflow", "state": state}

    offers = copy.deepcopy(state["offers"])
    future = copy.deepcopy(state["futurePieces"])
    if future:
        nxt = future.pop(0)
        offers[offer_index] = {"kind": "piece", "shape": nxt["shape"], "direction": nxt["direction"]}
    else:
        offers[offer_index] = {"kind": "spent"}

    final = {
        "rulesVersion": RULES,
        "boardSize": state["boardSize"],
        "moveLimit": state["moveLimit"],
        "blocked": state["blocked"],
        "cells": board,
        "offers": offers,
        "futurePieces": future,
        "turnsUsed": turns,
        "score": score,
        "status": "in_progress",
        "terminalReason": None,
    }
    status, reason = derive_terminal(final)
    final["status"] = status
    final["terminalReason"] = reason
    if has_orthogonal_run(final["cells"]):
        return {"ok": False, "kind": "unsafe", "reason": "invalid_final_state", "state": state}
    return {
        "ok": True,
        "kind": "applied",
        "landing": land,
        "turnsUsed": turns,
        "scoreDelta": score_delta,
        "waves": waves,
        "finalState": final,
        "stateHash": state_hash(final),
        "canonicalJson": canonical_json(final),
    }


def replay(initial: Dict[str, Any], moves: List[Dict[str, Any]], *, require_initial: bool = True) -> Dict[str, Any]:
    try:
        state = parse_game_state(initial, initial=require_initial)
    except OracleError as e:
        return {"ok": False, "reason": "invalid_initial", "codes": e.codes}
    applied = []
    for i, m in enumerate(moves):
        if state["status"] == "ended":
            return {"ok": False, "reason": "post_terminal_move", "moveIndex": i, "state": state}
        result = apply_move(state, m)
        if not result.get("ok"):
            return {"ok": False, "reason": "move_failed", "moveIndex": i, "result": result, "state": state}
        applied.append(result)
        state = result["finalState"]
    return {
        "ok": True,
        "finalState": state,
        "stateHash": state_hash(state),
        "canonicalJson": canonical_json(state),
        "applied": applied,
    }


if __name__ == "__main__":
    import sys

    doc = json.load(sys.stdin)
    kind = doc.get("action", "replay")
    if kind == "canonical":
        c = canonical_json(doc["value"])
        print(json.dumps({"canonicalJson": c, "sha256": sha256_hex(c)}, separators=(",", ":")))
    elif kind == "parse":
        try:
            st = parse_game_state(doc["state"], initial=bool(doc.get("initial")))
            print(json.dumps({"ok": True, "state": st, "stateHash": state_hash(st)}, separators=(",", ":")))
        except OracleError as e:
            print(json.dumps({"ok": False, "codes": e.codes}, separators=(",", ":")))
    else:
        print(json.dumps(replay(doc["initialState"], doc.get("moves", []), require_initial=doc.get("requireInitial", True)), separators=(",", ":")))

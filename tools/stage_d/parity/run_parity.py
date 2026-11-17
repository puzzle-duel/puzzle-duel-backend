#!/usr/bin/env python3
"""Stage D parity: oracle expectations vs Dart vs TypeScript."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FIX_DIRS = [
    ROOT / "docs/contracts/gameplay/v3/fixtures",
    ROOT / "docs/contracts/gameplay/v3/invalid",
]
OUT = ROOT / "tools/stage_d/out"
DART = Path(os.environ.get("STAGE_D_DART", str(Path.home() / "Developer/flutter-sdks/flutter-3.50.0/bin/dart")))
# Prefer portable dart-sdk from client if present
PORTABLE = ROOT.parent / "puzzle-duel-client-core001v3-dart" / ".dart-sdk" / "bin" / "dart"
if PORTABLE.exists():
    DART = PORTABLE
NODE = os.environ.get("STAGE_D_NODE", "node")
TS_RUNNER = ROOT / "tools/stage_d/ts_runner/run_fixture.mts"
DART_RUNNER = ROOT / "tools/stage_d/dart_runner/bin/run_fixture.dart"


def deep_get(obj, path: str):
    cur = obj
    for part in path.strip("$.").replace("[", ".").replace("]", "").split("."):
        if part == "" or part == "$":
            continue
        if isinstance(cur, list):
            cur = cur[int(part)]
        else:
            cur = cur[part]
    return cur


def first_diff(a, b, path="$"):
    if type(a) != type(b) and not (isinstance(a, (int, float)) and isinstance(b, (int, float))):
        # allow list landing vs {row,col}
        pass
    if isinstance(a, dict) and isinstance(b, dict):
        keys = sorted(set(a) | set(b))
        for k in keys:
            if k not in a:
                return f"{path}.{k}", None, b[k]
            if k not in b:
                return f"{path}.{k}", a[k], None
            d = first_diff(a[k], b[k], f"{path}.{k}")
            if d:
                return d
        return None
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return f"{path}.length", len(a), len(b)
        for i, (x, y) in enumerate(zip(a, b)):
            d = first_diff(x, y, f"{path}[{i}]")
            if d:
                return d
        return None
    # normalize landing maps
    if isinstance(a, dict) and set(a.keys()) == {"row", "column"} and isinstance(b, list) and len(b) == 2:
        return first_diff([a["row"], a["column"]], b, path)
    if isinstance(b, dict) and set(b.keys()) == {"row", "column"} and isinstance(a, list) and len(a) == 2:
        return first_diff(a, [b["row"], b["column"]], path)
    if a != b:
        return path, a, b
    return None


def normative_security_fields(fid: str, expected: dict) -> list[str]:
    if fid in ("V3-42", "V3-43"):
        return ["ok", "replayOk", "fullCompareOk", "mismatches"]
    if fid == "V3-45":
        return ["ok", "replayFinalDiffersFromClaimed"]
    if fid == "V3-46":
        return ["ok", "hashesDiffer", "hashA", "hashB"]
    return list(expected.keys())


def evaluate_replay_security(doc: dict) -> dict:
    """Independent Python oracle evaluation for replay-security fixtures."""
    sys.path.insert(0, str(ROOT / "tools/stage_d/oracle"))
    from core001v3_oracle import parse_game_state, replay, state_hash  # type: ignore

    fid = doc["id"]
    if fid in ("V3-42", "V3-43"):
        moves = doc.get("moves") or []
        result = replay(doc["trustedInitial"], moves, require_initial=True)
        if not result.get("ok"):
            return {"ok": False, "replayOk": False, "reason": result}
        authentic = result["finalState"]
        client = dict(doc["clientReport"])
        if fid == "V3-42":
            # Mirror runner: force forged score/hash onto authentic board/offers.
            client = {
                **client,
                "board": authentic["cells"],
                "offers": authentic["offers"],
                "turnsUsed": authentic["turnsUsed"],
                "status": authentic["status"],
                "terminalReason": authentic["terminalReason"],
                "score": doc["clientReport"]["score"],
                "stateHash": doc["clientReport"]["stateHash"],
            }
        mismatches: list[str] = []
        if client.get("score") != authentic["score"]:
            mismatches.append("score_mismatch")
        if client.get("turnsUsed") != authentic["turnsUsed"]:
            mismatches.append("turn_mismatch")
        if client.get("status") != authentic["status"] or client.get("terminalReason") != authentic[
            "terminalReason"
        ]:
            mismatches.append("terminal_mismatch")
        if client.get("board") != authentic["cells"]:
            mismatches.append("board_mismatch")
        if client.get("offers") != authentic["offers"]:
            mismatches.append("offer_mismatch")
        if client.get("stateHash") != result["stateHash"]:
            mismatches.append("state_hash_mismatch")
        return {
            "ok": True,
            "replayOk": True,
            "fullCompareOk": len(mismatches) == 0,
            "mismatches": mismatches,
            "authenticStateHash": result["stateHash"],
        }
    if fid == "V3-45":
        result = replay(doc["trustedInitial"], [], require_initial=True)
        claimed = parse_game_state(doc["claimedSnapshot"], initial=False)
        return {
            "ok": True,
            "replayFinalDiffersFromClaimed": result["finalState"] != claimed,
        }
    if fid == "V3-46":
        a = replay(doc["trustedInitial"], doc["movesA"], require_initial=True)
        b = replay(doc["trustedInitial"], doc["movesB"], require_initial=True)
        return {
            "ok": True,
            "hashA": a.get("stateHash"),
            "hashB": b.get("stateHash"),
            "hashesDiffer": a.get("stateHash") != b.get("stateHash"),
        }
    return {"ok": False, "reason": "unsupported_replay_security_id"}


def compare_replay_security_outputs(
    *,
    fid: str,
    expected: dict,
    oracle: dict,
    dart: dict,
    ts: dict,
    report: dict | None = None,
) -> dict:
    """Three-way replay-security compare: oracle↔dart, oracle↔ts, dart↔ts.

    Exposed for Stage D comparator mutation tests. Preserves first-divergence
    reporting via ordered `diffs` entries.
    """
    if report is None:
        report = {
            "id": fid,
            "kind": "replaySecurity",
            "oracle_vs_dart": "PASS",
            "oracle_vs_ts": "PASS",
            "dart_vs_ts": "PASS",
            "status": "PASS",
            "diffs": [],
        }

    def fail(channel, path_s, exp, act):
        report[channel] = "FAIL"
        report["status"] = "FAIL"
        report["diffs"].append({"channel": channel, "path": path_s, "expected": exp, "actual": act})

    def check_security(channel: str, actual: dict) -> None:
        for field in normative_security_fields(fid, expected):
            if field not in actual:
                fail(channel, f"$.{field}", expected.get(field, "<required>"), "<missing>")
                return
        if fid in ("V3-42", "V3-43"):
            if actual.get("replayOk") is not True:
                fail(channel, "$.replayOk", True, actual.get("replayOk"))
            if actual.get("fullCompareOk") is not False:
                fail(channel, "$.fullCompareOk", False, actual.get("fullCompareOk"))
            actual_mismatches = actual.get("mismatches")
            if not isinstance(actual_mismatches, list):
                fail(channel, "$.mismatches", expected.get("mismatchesInclude"), actual_mismatches)
                return
            # Mismatch code order is non-normative; compare as sets.
            required = set(expected.get("mismatchesInclude", []))
            got = set(actual_mismatches)
            if not required.issubset(got):
                fail(channel, "$.mismatches", sorted(required), sorted(got))
            if oracle.get("authenticStateHash") and actual.get("authenticStateHash"):
                if actual.get("authenticStateHash") != oracle["authenticStateHash"]:
                    fail(
                        channel,
                        "$.authenticStateHash",
                        oracle["authenticStateHash"],
                        actual.get("authenticStateHash"),
                    )
        elif fid == "V3-45":
            if actual.get("replayFinalDiffersFromClaimed") is not True:
                fail(channel, "$.replayFinalDiffersFromClaimed", True, actual.get("replayFinalDiffersFromClaimed"))
        elif fid == "V3-46":
            if actual.get("hashesDiffer") is not True:
                fail(channel, "$.hashesDiffer", True, actual.get("hashesDiffer"))

    if oracle.get("ok") is not True:
        fail("oracle_vs_dart", "$.oracle.ok", True, oracle)
        fail("oracle_vs_ts", "$.oracle.ok", True, oracle)
    else:
        for channel, actual in ("oracle_vs_dart", dart), ("oracle_vs_ts", ts):
            check_security(channel, actual)
            if fid in ("V3-42", "V3-43"):
                for field in ("replayOk", "fullCompareOk"):
                    if actual.get(field) != oracle.get(field):
                        fail(channel, f"$.{field}", oracle.get(field), actual.get(field))
                if not set(oracle.get("mismatches", [])).issubset(set(actual.get("mismatches") or [])):
                    fail(
                        channel,
                        "$.mismatches",
                        sorted(oracle.get("mismatches", [])),
                        sorted(actual.get("mismatches") or []),
                    )

    if fid in ("V3-42", "V3-43"):
        for field in ("ok", "replayOk", "fullCompareOk"):
            if dart.get(field) != ts.get(field):
                fail("dart_vs_ts", f"$.{field}", dart.get(field), ts.get(field))
        d_set = set(dart.get("mismatches") or [])
        t_set = set(ts.get("mismatches") or [])
        required = set(expected.get("mismatchesInclude", []))
        if not required.issubset(d_set) or not required.issubset(t_set):
            fail("dart_vs_ts", "$.mismatches", sorted(d_set), sorted(t_set))
        if dart.get("authenticStateHash") != ts.get("authenticStateHash"):
            fail(
                "dart_vs_ts",
                "$.authenticStateHash",
                dart.get("authenticStateHash"),
                ts.get("authenticStateHash"),
            )
    elif fid == "V3-45":
        if dart.get("replayFinalDiffersFromClaimed") != ts.get("replayFinalDiffersFromClaimed"):
            fail(
                "dart_vs_ts",
                "$.replayFinalDiffersFromClaimed",
                dart.get("replayFinalDiffersFromClaimed"),
                ts.get("replayFinalDiffersFromClaimed"),
            )
    elif fid == "V3-46":
        if dart.get("hashesDiffer") != ts.get("hashesDiffer"):
            fail("dart_vs_ts", "$.hashesDiffer", dart.get("hashesDiffer"), ts.get("hashesDiffer"))
        d = first_diff(
            {"hashA": dart.get("hashA"), "hashB": dart.get("hashB")},
            {"hashA": ts.get("hashA"), "hashB": ts.get("hashB")},
        )
        if d:
            fail("dart_vs_ts", d[0], d[1], d[2])
    return report


def run_dart(fixture: Path) -> dict:
    cmd = [str(DART), "run", str(DART_RUNNER), str(fixture)]
    p = subprocess.run(cmd, cwd=str(DART_RUNNER.parent.parent), capture_output=True, text=True)
    if p.returncode != 0:
        return {"ok": False, "engine": "dart", "stderr": p.stderr, "stdout": p.stdout, "exit": p.returncode}
    return json.loads(p.stdout)


def run_ts(fixture: Path) -> dict:
    cmd = [NODE, "--experimental-strip-types", str(TS_RUNNER), str(fixture)]
    p = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True)
    if p.returncode != 0:
        return {"ok": False, "engine": "typescript", "stderr": p.stderr, "stdout": p.stdout, "exit": p.returncode}
    return json.loads(p.stdout)


def compare_fixture(path: Path) -> dict:
    doc = json.loads(path.read_text(encoding="utf-8"))
    fid = doc["id"]
    kind = doc.get("kind", "fullMove")
    expected = doc["expected"]
    dart = run_dart(path)
    ts = run_ts(path)
    report = {
        "id": fid,
        "file": str(path.relative_to(ROOT)),
        "kind": kind,
        "oracle_vs_dart": "PASS",
        "oracle_vs_ts": "PASS",
        "dart_vs_ts": "PASS",
        "status": "PASS",
        "diffs": [],
    }

    def fail(channel, path_s, exp, act):
        report[channel] = "FAIL"
        report["status"] = "FAIL"
        report["diffs"].append({"channel": channel, "path": path_s, "expected": exp, "actual": act})

    # Oracle vs engines
    if kind == "hashOnly" and fid == "V3-51":
        exp_atoms = {a["id"]: a for a in expected["atoms"]}
        for engine_name, actual in ("oracle_vs_dart", dart), ("oracle_vs_ts", ts):
            if not actual.get("ok"):
                fail(engine_name, "$.ok", True, actual)
                continue
            for atom in actual.get("atoms", []):
                e = exp_atoms[atom["id"]]
                if atom["canonicalJson"] != e["canonicalJson"] or atom["sha256"] != e["sha256"]:
                    fail(engine_name, f"$.atoms.{atom['id']}", e, atom)
        d = first_diff(dart.get("atoms"), ts.get("atoms"))
        if d:
            fail("dart_vs_ts", d[0], d[1], d[2])
        return report

    if kind == "parseOnly":
        for channel, actual in ("oracle_vs_dart", dart), ("oracle_vs_ts", ts):
            if bool(actual.get("ok")) != bool(expected.get("ok")):
                fail(channel, "$.ok", expected.get("ok"), actual.get("ok"))
                continue
            if expected.get("ok"):
                d = first_diff(expected.get("stateHash"), actual.get("stateHash"), "$.stateHash")
                if d:
                    fail(channel, d[0], d[1], d[2])
            else:
                codes = actual.get("codes") or []
                for c in expected.get("codes", []):
                    if c not in codes:
                        fail(channel, "$.codes", expected.get("codes"), codes)
        # Both must agree on accept/reject. Negative code sets may be supersets
        # across engines; require shared required codes from the oracle when present.
        if bool(dart.get("ok")) != bool(ts.get("ok")):
            fail("dart_vs_ts", "$.ok", dart.get("ok"), ts.get("ok"))
        elif expected.get("ok"):
            d = first_diff(dart.get("stateHash"), ts.get("stateHash"), "$.stateHash")
            if d:
                fail("dart_vs_ts", d[0], d[1], d[2])
        else:
            required = expected.get("codes") or []
            dc = set(dart.get("codes") or [])
            tc = set(ts.get("codes") or [])
            for c in required:
                if c not in dc or c not in tc:
                    fail("dart_vs_ts", "$.codes", required, {"dart": sorted(dc), "ts": sorted(tc)})
                    break
        return report

    if kind == "replaySecurity":
        oracle = evaluate_replay_security(doc)
        return compare_replay_security_outputs(
            fid=fid,
            expected=expected,
            oracle=oracle,
            dart=dart,
            ts=ts,
            report=report,
        )

    # fullMove
    for channel, actual in ("oracle_vs_dart", dart), ("oracle_vs_ts", ts):
        if expected.get("ok") is False:
            if actual.get("ok") is not False:
                fail(channel, "$.ok", False, actual.get("ok"))
                continue
            er = expected.get("result", {})
            ar = actual.get("result", {})
            d = first_diff(er, ar, "$.result")
            if d:
                fail(channel, d[0], d[1], d[2])
        else:
            if actual.get("ok") is not True:
                fail(channel, "$.ok", True, actual)
                continue
            d = first_diff(expected.get("stateHash"), actual.get("stateHash"), "$.stateHash")
            if d:
                fail(channel, d[0], d[1], d[2])
            d = first_diff(expected.get("finalState"), actual.get("finalState"), "$.finalState")
            if d:
                fail(channel, d[0], d[1], d[2])
            # compare applied score deltas / landings
            d = first_diff(
                [
                    {"landing": a["landing"], "scoreDelta": a["scoreDelta"], "turnsUsed": a["turnsUsed"], "waves": a["waves"]}
                    for a in expected.get("applied", [])
                ],
                [
                    {
                        "landing": a.get("landing"),
                        "scoreDelta": a.get("scoreDelta"),
                        "turnsUsed": a.get("turnsUsed"),
                        "waves": a.get("waves"),
                    }
                    for a in actual.get("applied", [])
                ],
                "$.applied",
            )
            if d:
                fail(channel, d[0], d[1], d[2])

    d = first_diff(
        {"ok": dart.get("ok"), "stateHash": dart.get("stateHash"), "result": dart.get("result"), "finalState": dart.get("finalState")},
        {"ok": ts.get("ok"), "stateHash": ts.get("stateHash"), "result": ts.get("result"), "finalState": ts.get("finalState")},
    )
    if d:
        fail("dart_vs_ts", d[0], d[1], d[2])
    return report


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    fixtures = sorted([p for d in FIX_DIRS for p in d.glob("*.json")])
    results = []
    for f in fixtures:
        print(f"== {f.name}", flush=True)
        results.append(compare_fixture(f))
    summary = {
        "enginePins": {
            "backendStageC": "25efb2473f3517027769ee978b31ab6e3dc41030",
            "clientStageB": "946f015a5124d1a9dfd6f3440cc916b9eb1789f8",
            "dart": subprocess.check_output([str(DART), "--version"], text=True).strip(),
            "node": subprocess.check_output([NODE, "--version"], text=True).strip(),
        },
        "total": len(results),
        "pass": sum(1 for r in results if r["status"] == "PASS"),
        "fail": sum(1 for r in results if r["status"] == "FAIL"),
        "results": results,
    }
    out_path = OUT / "parity-report.json"
    out_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"pass": summary["pass"], "fail": summary["fail"], "total": summary["total"]}, indent=2))
    return 0 if summary["fail"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

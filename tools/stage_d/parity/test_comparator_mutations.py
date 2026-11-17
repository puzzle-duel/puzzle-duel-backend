#!/usr/bin/env python3
"""Comparator mutation tests for replay-security three-way parity.

Each injected defect must force FAIL. Does not weaken positive assertions.
"""
from __future__ import annotations

import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_parity import compare_replay_security_outputs  # noqa: E402


BASE_EXPECTED = {
    "replayOk": True,
    "fullCompareOk": False,
    "mismatchesInclude": ["board_mismatch", "state_hash_mismatch"],
}

AUTH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
FORGED = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

BASE_ORACLE = {
    "ok": True,
    "replayOk": True,
    "fullCompareOk": False,
    "mismatches": ["board_mismatch", "state_hash_mismatch"],
    "authenticStateHash": AUTH,
}

BASE_ENGINE = {
    "ok": True,
    "replayOk": True,
    "fullCompareOk": False,
    "mismatches": ["board_mismatch", "state_hash_mismatch"],
    "authenticStateHash": AUTH,
}


def run_case(name: str, mutate) -> None:
    oracle = copy.deepcopy(BASE_ORACLE)
    dart = copy.deepcopy(BASE_ENGINE)
    ts = copy.deepcopy(BASE_ENGINE)
    expected = copy.deepcopy(BASE_EXPECTED)
    mutate(oracle, dart, ts, expected)
    report = compare_replay_security_outputs(
        fid="V3-43",
        expected=expected,
        oracle=oracle,
        dart=dart,
        ts=ts,
    )
    if report["status"] != "FAIL":
        raise SystemExit(f"MUTATION_MISS: {name} did not FAIL\n{report}")
    print(f"PASS mutation -> FAIL: {name} ({report['diffs'][0]['path']})")


def main() -> int:
    cases = [
        (
            "wrong_score_classification",
            lambda o, d, t, e: d.__setitem__("fullCompareOk", True),
        ),
        (
            "missing_mismatch_code",
            lambda o, d, t, e: d.__setitem__("mismatches", ["state_hash_mismatch"]),
        ),
        (
            "wrong_board_signal_absent",
            lambda o, d, t, e: t.__setitem__("mismatches", ["score_mismatch", "state_hash_mismatch"]),
        ),
        (
            "wrong_hash",
            lambda o, d, t, e: d.__setitem__("authenticStateHash", FORGED),
        ),
        (
            "success_failure_classification",
            lambda o, d, t, e: (
                d.__setitem__("fullCompareOk", True),
                d.__setitem__("mismatches", []),
            ),
        ),
        (
            "missing_replay_result",
            lambda o, d, t, e: d.pop("replayOk", None),
        ),
        (
            "one_engine_correct_one_corrupted",
            lambda o, d, t, e: t.__setitem__("fullCompareOk", True),
        ),
        (
            "missing_mismatches_field",
            lambda o, d, t, e: d.pop("mismatches", None),
        ),
        (
            "dart_ts_hash_divergence",
            lambda o, d, t, e: t.__setitem__("authenticStateHash", FORGED),
        ),
    ]
    for name, mut in cases:
        run_case(name, mut)

    # Positive control: uncorrupted triplet must PASS.
    good = compare_replay_security_outputs(
        fid="V3-43",
        expected=BASE_EXPECTED,
        oracle=BASE_ORACLE,
        dart=BASE_ENGINE,
        ts=BASE_ENGINE,
    )
    if good["status"] != "PASS":
        raise SystemExit(f"POSITIVE_CONTROL_FAIL: {good}")
    print("PASS positive control")
    print(f"mutations={len(cases)} all_forced_fail=true")
    return 0


if __name__ == "__main__":
    sys.exit(main())

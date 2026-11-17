#!/usr/bin/env python3
"""Read-only verification of Stage D frozen fixture checksum ledger."""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LEDGER = ROOT / "docs/contracts/gameplay/v3/CHECKSUMS-STAGE-D.txt"


def main() -> int:
    if not LEDGER.exists():
        print("MISSING ledger", LEDGER)
        return 1
    failed = 0
    count = 0
    for line in LEDGER.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        digest, rel = line.split("  ", 1)
        path = ROOT / rel
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        count += 1
        if actual != digest:
            print(f"FAIL {rel}")
            failed += 1
        else:
            print(f"OK {rel}")
    print(f"verified {count}; fail {failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

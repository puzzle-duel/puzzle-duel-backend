#!/usr/bin/env python3
"""Owner-controlled regeneration of Stage D checksum ledger. Not used by routine tests."""
from __future__ import annotations

import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LEDGER = ROOT / "docs/contracts/gameplay/v3/CHECKSUMS-STAGE-D.txt"
DIRS = [
    ROOT / "docs/contracts/gameplay/v3/fixtures",
    ROOT / "docs/contracts/gameplay/v3/invalid",
]


def main() -> None:
    files = sorted(p for d in DIRS for p in d.glob("*.json"))
    lines = []
    for f in files:
        rel = f.relative_to(ROOT).as_posix()
        lines.append(f"{hashlib.sha256(f.read_bytes()).hexdigest()}  {rel}")
    LEDGER.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"froze {len(lines)} files -> {LEDGER.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

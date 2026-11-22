#!/usr/bin/env python3
"""Fail closed on transaction control and psql metacommands in staging SQL.

Only top-level SQL is inspected; dollar-quoted PL/pgSQL bodies are treated as
opaque literals. This is a guard, not a general PostgreSQL parser.
"""
import re
import sys
from pathlib import Path

FORBIDDEN = re.compile(
    r"^\s*(?:BEGIN|COMMIT|ROLLBACK|ABORT|END|SAVEPOINT|RELEASE|"
    r"START\s+TRANSACTION|PREPARE\s+TRANSACTION|"
    r"COMMIT\s+PREPARED|ROLLBACK\s+PREPARED|SET\s+TRANSACTION)\b",
    re.I,
)
DOLLAR = re.compile(r"\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$")

def validate(sql: str) -> None:
    # Blanking quoted text preserves newlines for psql command detection.
    output = []
    i = 0
    n = len(sql)
    block_depth = 0
    while i < n:
        c = sql[i]
        if sql.startswith("--", i):
            end = sql.find("\n", i)
            if end < 0:
                end = n
            output.extend(" " * (end-i))
            i = end
        elif sql.startswith("/*", i):
            block_depth = 1
            start = i
            i += 2
            while i < n and block_depth:
                if sql.startswith("/*", i):
                    block_depth += 1
                    i += 2
                elif sql.startswith("*/", i):
                    block_depth -= 1
                    i += 2
                else:
                    i += 1
            if block_depth:
                raise ValueError("unterminated block comment")
            output.extend("\n" if ch == "\n" else " " for ch in sql[start:i])
        elif c in ("'", '"'):
            quote = c
            start = i
            i += 1
            while i < n:
                if sql[i] == quote:
                    if i + 1 < n and sql[i+1] == quote:
                        i += 2
                        continue
                    i += 1
                    break
                # PostgreSQL escape strings can use backslash escapes.
                if sql[i] == "\\" and quote == "'" and start > 0 and sql[start-1] in "Ee":
                    i += 2
                else:
                    i += 1
            else:
                raise ValueError("unterminated quoted string")
            output.extend("\n" if ch == "\n" else " " for ch in sql[start:i])
        elif c == "$" and (match := DOLLAR.match(sql, i)):
            marker = match.group()
            end = sql.find(marker, match.end())
            if end < 0:
                raise ValueError("unterminated dollar-quoted block")
            stop = end + len(marker)
            output.extend("\n" if ch == "\n" else " " for ch in sql[i:stop])
            i = stop
        else:
            output.append(c)
            i += 1
    stripped = "".join(output)
    # A psql meta-command may follow a SQL semicolon on the same line.
    # Outside quoted SQL and comments, any backslash is unsafe for -f input.
    if "\\" in stripped:
        raise ValueError("psql metacommand refused")
    for statement in stripped.split(";"):
        if FORBIDDEN.match(statement):
            raise ValueError("transaction command refused")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("SQL validation BLOCKED", file=sys.stderr)
        sys.exit(2)
    try:
        validate(Path(sys.argv[1]).read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        print(f"SQL validation BLOCKED: {err}", file=sys.stderr)
        sys.exit(1)

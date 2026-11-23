"""Regression tests for the read-only staging diagnostic report selection."""
import ast
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/staging-diagnostic-status.yml"


def load_selector():
    source = WORKFLOW.read_text(encoding="utf-8")
    match = re.search(r"^          def newest_report_names\(.*?\n(?=          report_files=\[\])", source, re.M | re.S)
    if match is None:
        raise AssertionError("Workflow's report selector is missing")
    import textwrap
    code = textwrap.dedent(match.group(0))
    namespace = {"os": os, "stat": __import__("stat"),
                 "uid": re.compile(r"^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$")}
    exec(compile(ast.parse(code), str(WORKFLOW), "exec"), namespace)
    return namespace["newest_report_names"]


class LatestReportsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.select = load_selector()

    def populate(self, count):
        names = []
        for i in range(count):
            # Reverse timestamp relative to lexical order.
            name = f"00000000-0000-0000-0000-{i:012x}.json"
            path = self.folder / name
            path.write_text("{}", encoding="utf-8")
            os.utime(path, ns=(1_000_000_000 + (count-i)*1000,)*2)
            names.append(name)
        return names

    def test_zero_one_hundred_and_one_hundred_fifty(self):
        for count in (0, 1, 100, 150):
            with self.subTest(count=count):
                names = self.populate(count)
                self.assertEqual(self.select(self.folder), names[:100])
                for name in names:
                    (self.folder / name).unlink()

    def test_timestamp_ties_are_deterministic(self):
        names = self.populate(3)
        for name in names:
            os.utime(self.folder / name, ns=(2_000_000_000,)*2)
        self.assertEqual(self.select(self.folder), sorted(names))

    def test_ignores_symlinks_invalid_names_and_directories(self):
        names = self.populate(1)
        (self.folder / "not-a-uuid.json").write_text("{}")
        (self.folder / "00000000-0000-0000-0000-ffffffffffff.json").symlink_to(self.folder / names[0])
        (self.folder / "00000000-0000-0000-0000-eeeeeeeeeeee.json").mkdir()
        self.assertEqual(self.select(self.folder), names)


if __name__ == "__main__":
    unittest.main()

import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from archive import verify


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "src").mkdir()
        (self.root / "src/main.py").write_bytes(b"print('source')\n")
        self.archive = self.root / "src.zip"

    def make(self, entries):
        with zipfile.ZipFile(self.archive, "w") as archive:
            for name, content in entries:
                archive.writestr(name, content)

    def test_genuine_native_root_and_same_source(self):
        self.make([("home/runner/work/repo/repo/src/main.py", b"print('source')\n")])
        result = verify(self.archive, self.root, ["src/main.py"])
        self.assertEqual(result["files"], 1)
        self.assertEqual(len(result["sourceDigest"]), 64)
        json.dumps(result)

    def test_changed_archived_bytes_rejected(self):
        self.make([("src/main.py", b"other revision\n")])
        with self.assertRaisesRegex(ValueError, "differs"):
            verify(self.archive, self.root, ["src/main.py"])

    def test_capability_counts_only_include_genuinely_archived_source(self):
        (self.root / "src/one.js").write_bytes(b"const one = 1;\n")
        (self.root / "src/two.ts").write_bytes(b"const two: number = 2;\n")
        (self.root / "src/absent.js").write_bytes(b"const absent = 3;\n")
        self.make([("native/src/one.js", b"const one = 1;\n"),
                   ("native/src/two.ts", b"const two: number = 2;\n")])
        result = verify(self.archive, self.root,
                        ["src/one.js", "src/two.ts", "src/absent.js"], "javascript-typescript")
        self.assertEqual(result["files"], 2)
        self.assertEqual(result["sourceCoverage"], {"javascript": 1, "typescript": 1})

    def test_missing_selected_capability_remains_zero_not_estimated(self):
        (self.root / "src/one.js").write_bytes(b"const one = 1;\n")
        (self.root / "src/two.ts").write_bytes(b"const two: number = 2;\n")
        self.make([("native/src/one.js", b"const one = 1;\n")])
        result = verify(self.archive, self.root, ["src/one.js", "src/two.ts"], "javascript-typescript")
        self.assertEqual(result["sourceCoverage"], {"javascript": 1, "typescript": 0})

    def test_non_javascript_capability_and_unknown_language(self):
        self.make([("native/src/main.py", b"print('source')\n")])
        self.assertEqual(verify(self.archive, self.root, ["src/main.py"], "python")["sourceCoverage"],
                         {"python": 1})
        with self.assertRaisesRegex(ValueError, "Unknown native"):
            verify(self.archive, self.root, ["src/main.py"], "invented")

    def test_no_source_is_not_success(self):
        self.make([("unrelated.py", b"print('source')\n")])
        with self.assertRaisesRegex(ValueError, "No selected"):
            verify(self.archive, self.root, ["src/main.py"])

    def test_multiple_matching_native_roots_rejected(self):
        self.make([("root/src/main.py", b"print('source')\n"),
                   ("foreign/src/main.py", b"print('source')\n")])
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            verify(self.archive, self.root, ["src/main.py"])

    def test_traversal_candidate_rejected(self):
        self.make([("src/main.py", b"print('source')\n")])
        with self.assertRaisesRegex(ValueError, "escapes"):
            verify(self.archive, self.root, ["../src/main.py"])

    def test_different_candidates_cannot_borrow_different_native_roots(self):
        (self.root / "src/other.py").write_bytes(b"print('other')\n")
        self.make([("one/src/main.py", b"print('source')\n"),
                   ("two/src/other.py", b"print('other')\n")])
        with self.assertRaisesRegex(ValueError, "multiple archive roots"):
            verify(self.archive, self.root, ["src/main.py", "src/other.py"])

    def test_different_candidates_share_one_genuine_native_root(self):
        (self.root / "src/other.py").write_bytes(b"print('other')\n")
        self.make([("one/src/main.py", b"print('source')\n"),
                   ("one/src/other.py", b"print('other')\n")])
        self.assertEqual(verify(self.archive, self.root, ["src/main.py", "src/other.py"])["files"], 2)

    def test_overlapping_repository_suffixes_use_the_longest_candidate(self):
        (self.root / "main.py").write_bytes(b"print('root')\n")
        self.make([("native/main.py", b"print('root')\n"),
                   ("native/src/main.py", b"print('source')\n")])
        for candidates in [["main.py", "src/main.py"], ["src/main.py", "main.py"]]:
            self.assertEqual(verify(self.archive, self.root, candidates)["files"], 2)

    def test_overlapping_candidates_do_not_hide_multiple_roots_or_duplicates(self):
        (self.root / "main.py").write_bytes(b"print('root')\n")
        self.make([("one/main.py", b"print('root')\n"),
                   ("two/src/main.py", b"print('source')\n")])
        with self.assertRaisesRegex(ValueError, "multiple archive roots"):
            verify(self.archive, self.root, ["main.py", "src/main.py"])
        self.make([("native/main.py", b"print('root')\n"),
                   ("native/src/main.py", b"print('source')\n"),
                   ("foreign/src/main.py", b"print('source')\n")])
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            verify(self.archive, self.root, ["main.py", "src/main.py"])


if __name__ == "__main__":
    unittest.main()

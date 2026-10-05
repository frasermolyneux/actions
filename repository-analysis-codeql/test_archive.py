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


if __name__ == "__main__":
    unittest.main()

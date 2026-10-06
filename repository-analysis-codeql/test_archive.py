import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from archive import JAVASCRIPT_TYPES, verify


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

    def container(self, filename, content):
        (self.root / filename).write_bytes(content)
        self.make([("native/" + filename, content)])
        return verify(self.archive, self.root, [filename], "javascript-typescript")

    def test_vue_only_source_is_classified_from_verified_native_script_bytes(self):
        for script, expected in [
            (b"<script>const source = 1;</script>", {"javascript": 1, "typescript": 0}),
            (b'<script setup lang="ts">const source: number = 1;</script>',
             {"javascript": 0, "typescript": 1}),
            (b'<script lang="tsx" type="module">const source = <div/>;</script>',
             {"javascript": 0, "typescript": 1}),
            (b"<script>const js = 1;</script><script lang='typescript'>const ts: number = 2;</script>",
             {"javascript": 1, "typescript": 1}),
        ]:
            with self.subTest(script=script):
                result = self.container("src/App.vue", script)
                self.assertEqual(result["files"], 1)
                self.assertEqual(result["sourceCoverage"], expected)

    def test_html_variants_preserve_module_and_explicit_typescript_metadata(self):
        for suffix in (".html", ".htm", ".xhtm", ".xhtml"):
            with self.subTest(suffix=suffix):
                result = self.container("src/page" + suffix,
                                        b'<script type="module">const js = 1;</script>'
                                        b'<script type="text/typescript">const ts: number = 2;</script>')
                self.assertEqual(result["sourceCoverage"], {"javascript": 1, "typescript": 1})

    def test_data_external_empty_template_and_unsupported_scripts_are_not_invented_capabilities(self):
        for content in [
            b'<script type="application/json">{"value":1}</script>',
            b'<script type="text/plain">const not_a_program = 1;</script>',
            b'<script src="elsewhere.js"></script>',
            b'<script src="elsewhere.js">ignored fallback</script>',
            b'<script src="javascript:run()"></script>',
            b'<script src="javascript:run()">ignored fallback</script>',
            b'<script lang="ts" src="javascript:run()">ignored fallback</script>',
            b'<script>  </script>',
            b'<template><p>No embedded program</p></template>',
            b'<script lang="coffee">square = (x) -> x * x</script>',
            b'<div only="metadata" once="metadata">Not a script</div>',
        ]:
            with self.subTest(content=content):
                result = self.container("src/App.vue", content)
                self.assertEqual(result["sourceCoverage"], {"javascript": 0, "typescript": 0})

    def test_multiple_script_sections_count_unique_files_per_capability(self):
        result = self.container("src/App.vue",
                                b'<script>const one = 1;</script><script>const two = 2;</script>')
        self.assertEqual(result["sourceCoverage"], {"javascript": 1, "typescript": 0})

    def test_html_inline_handlers_and_javascript_urls_identify_real_inline_programs(self):
        for content in [b'<button onclick="run()">Go</button>',
                        b'<a href="javascript:run()">Go</a>']:
            with self.subTest(content=content):
                self.assertEqual(self.container("src/page.html", content)["sourceCoverage"],
                                 {"javascript": 1, "typescript": 0})

    def test_ambiguous_container_metadata_fails_explicitly(self):
        with self.assertRaisesRegex(ValueError, "Ambiguous embedded"):
            self.container("src/App.vue", b'<script lang="js" lang="ts">const source = 1;</script>')
        with self.assertRaisesRegex(ValueError, "Ambiguous embedded"):
            self.container("src/page.html", b'<button onclick="" onclick="run()">Go</button>')
        with self.assertRaisesRegex(ValueError, "Conflicting embedded"):
            self.container("src/App.vue",
                           b'<script lang="js" type="text/typescript">const source: number = 1;</script>')
        for mime in JAVASCRIPT_TYPES - {"", "module"}:
            for language in ("ts", "typescript", "tsx"):
                with self.subTest(mime=mime, language=language), self.assertRaisesRegex(ValueError, "Conflicting embedded"):
                    self.container("src/page.html",
                                   f'<script lang="{language}" type="{mime}">const source = 1;</script>'.encode())

    def test_language_aliases_cannot_override_conflicting_language_metadata(self):
        for attributes in ('lang="js" language="ts"', 'lang="ts" language="javascript"',
                           'lang="" language="ts"', 'lang="js" language="coffee"'):
            with self.subTest(attributes=attributes), self.assertRaisesRegex(ValueError, "Conflicting embedded"):
                self.container("src/App.vue", f'<script {attributes}>const source = 1;</script>'.encode())
        for attributes, expected in [
            ('lang="js" language="ecmascript"', {"javascript": 1, "typescript": 0}),
            ('lang="ts" language="typescript" type="module"', {"javascript": 0, "typescript": 1}),
        ]:
            with self.subTest(attributes=attributes):
                result = self.container("src/App.vue", f'<script {attributes}>const source = 1;</script>'.encode())
                self.assertEqual(result["sourceCoverage"], expected)

    def test_json_and_yaml_archive_presence_does_not_fabricate_program_language(self):
        for filename, content in [("src/config.json", b'{"source":"metadata"}'),
                                  ("src/config.yml", b"source: metadata\n")]:
            with self.subTest(filename=filename):
                self.assertEqual(self.container(filename, content)["sourceCoverage"],
                                 {"javascript": 0, "typescript": 0})

    def test_container_classification_still_rejects_different_archived_bytes(self):
        (self.root / "src/App.vue").write_bytes(b'<script lang="ts">const source: number = 1;</script>')
        self.make([("native/src/App.vue", b"<script>const source = 1;</script>")])
        with self.assertRaisesRegex(ValueError, "differs"):
            verify(self.archive, self.root, ["src/App.vue"], "javascript-typescript")

    def test_utf16_native_container_bytes_retain_script_language_metadata(self):
        result = self.container("src/page.xhtml",
                                '<script lang="ts">const source: number = 1;</script>'.encode("utf-16"))
        self.assertEqual(result["sourceCoverage"], {"javascript": 0, "typescript": 1})

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

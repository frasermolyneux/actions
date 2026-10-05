import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from actionlint_compat import lint_copy, prepare_copy, run


WORKFLOW = """name: Fixture
on: push
permissions: {}
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: $/helper
        with:
          required: value
"""


class SyntaxTests(unittest.TestCase):
    def test_only_actual_uses_values_change_without_moving_diagnostics(self):
        original = """# uses: $/comment
on: push
env:
  uses: $/environment
jobs:
  call:
    uses: "$/.github/workflows/callee.yml"
    with:
      uses: $/input
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: '$/helper'
      - uses: ./workspace-helper
      - uses: owner/action@1234
      - run: |
          echo 'uses: $/script'
"""
        actual = lint_copy(original, True)
        expected = original.replace('"$/.github', '"./.github').replace("'$/helper'", "'./helper'")
        self.assertEqual(actual, expected)
        self.assertEqual(len(actual), len(original))
        self.assertEqual(actual.count("\n"), original.count("\n"))
        self.assertEqual(lint_copy(actual, True), actual)

    def test_composite_and_yaml_suffix(self):
        original = "runs:\n  using: composite\n  steps:\n    - uses: $/helper\n"
        self.assertEqual(lint_copy(original, False), original.replace("$/helper", "./helper"))
        call = "jobs:\n  call:\n    uses: $/.github/workflows/callee.yaml\n"
        self.assertIn("./.github/workflows/callee.yaml", lint_copy(call, True))

    def test_malformed_and_nonworkflow_job_references_fail_closed(self):
        for reference in ("$", "$/../helper", "$/helper/../other", "$/./helper",
                          "$/helper@main", "$/helper/", "$/helper//other",
                          "$/helper\\other", "$/helper:${{ inputs.ref }}"):
            with self.subTest(reference=reference), self.assertRaises(ValueError):
                lint_copy(WORKFLOW.replace("$/helper", reference), True)
        for reference in ("$/helper", "$/.github/workflows/nested/callee.yml",
                          "$/.github/workflows/callee.txt"):
            with self.subTest(reference=reference), self.assertRaises(ValueError):
                lint_copy(f"jobs:\n  call:\n    uses: {reference}\n", True)

    def test_anchored_or_escaped_self_references_fail_closed(self):
        for reference in ("&helper $/helper", '"\\u0024/helper"'):
            with self.subTest(reference=reference), self.assertRaises(ValueError):
                lint_copy(WORKFLOW.replace("$/helper", reference), True)
        with self.assertRaises(ValueError):
            lint_copy("env:\n  helper: &helper $/helper\njobs:\n  call:\n    uses: *helper\n", True)

    def test_multiple_yaml_documents_fail(self):
        with self.assertRaises(ValueError):
            lint_copy(WORKFLOW + "---\nname: another\n", True)


class RealLinterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.executable = Path(os.environ["ACTIONLINT"]).resolve(strict=True)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="actionlint-fixture-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True)
        self.write(".github/workflows/test.yml", WORKFLOW)
        self.write("helper/action.yml", """name: Fixture
description: Fixture
inputs:
  required:
    required: true
runs:
  using: composite
  steps:
    - shell: bash
      run: echo fixture
""")

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_native_released_parser_rejects_self_syntax_but_adapter_preserves_source(self):
        self.assertNotEqual(subprocess.run(
            [str(self.executable), "-color"], cwd=self.root,
        ).returncode, 0)
        before = (self.root / ".github/workflows/test.yml").read_bytes()
        self.assertEqual(run(self.executable, self.root), 0)
        self.assertEqual((self.root / ".github/workflows/test.yml").read_bytes(), before)

    def test_reusable_workflow_inputs_are_still_type_checked(self):
        self.write(".github/workflows/test.yml", """on: push
jobs:
  call:
    uses: $/.github/workflows/callee.yaml
    with:
      count: 4
""")
        self.write(".github/workflows/callee.yaml", """on:
  workflow_call:
    inputs:
      count:
        required: true
        type: number
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: $/helper
        with:
          required: value
""")
        self.assertEqual(run(self.executable, self.root), 0)
        path = self.root / ".github/workflows/test.yml"
        path.write_text(path.read_text().replace("count: 4", "count: not-a-number"))
        self.assertNotEqual(run(self.executable, self.root), 0)
        for invalid in ("      other: 4", "      count: ${{ nonexisting.value }}", ""):
            self.write(".github/workflows/test.yml", """on: push
jobs:
  call:
    uses: $/.github/workflows/callee.yaml
    with:
""" + invalid + "\n")
            self.assertNotEqual(run(self.executable, self.root), 0)

    def test_missing_actions_unknown_inputs_and_invalid_expressions_still_fail(self):
        self.write(".github/workflows/test.yml", WORKFLOW.replace("$/helper", "$/missing"))
        with self.assertRaisesRegex(ValueError, "target metadata is missing"):
            run(self.executable, self.root)
        for invalid in (
                WORKFLOW.replace("$/helper", "actions/checkout@v4")
                .replace("required: value", "unknown: value"),
                WORKFLOW.replace("required: value", "required: ${{ nonexisting.value }}")):
            self.write(".github/workflows/test.yml", invalid)
            self.assertNotEqual(run(self.executable, self.root), 0)

    def test_embedded_shellcheck_remains_enabled_on_hosted_runner(self):
        if os.name == "nt":
            self.skipTest("ShellCheck is supplied by the hosted Linux runner")
        subprocess.run(["shellcheck", "--version"], check=True, capture_output=True)
        self.write(".github/workflows/test.yml", WORKFLOW + "      - run: echo $unassigned\n")
        self.assertNotEqual(run(self.executable, self.root), 0)

    def test_existing_configuration_and_metadata_are_preserved(self):
        self.write(".github/actionlint.yaml", "self-hosted-runner:\n  labels:\n    - custom-fixture\n")
        self.write(".github/workflows/test.yml", WORKFLOW.replace("ubuntu-latest", "custom-fixture"))
        self.assertEqual(run(self.executable, self.root), 0)
        with tempfile.TemporaryDirectory(prefix="actionlint-copy-") as directory:
            destination = Path(directory)
            prepare_copy(self.root, destination)
            self.assertEqual((destination / ".github/actionlint.yaml").read_text(),
                             (self.root / ".github/actionlint.yaml").read_text())
            self.assertTrue((destination / "helper/action.yml").is_file())


if __name__ == "__main__":
    unittest.main()

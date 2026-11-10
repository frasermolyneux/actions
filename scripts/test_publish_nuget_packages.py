import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

from test_template_arguments import ROOT, bash_executable, step_script


ACTION = ROOT / "publish-nuget-packages" / "action.yml"
LOGIN_SHA = "8d196754b4036150537f80ac539e15c2f1028841"


class NuGetPublisherTests(unittest.TestCase):
    def test_oidc_only_contract_and_preparation_order(self):
        manifest = ACTION.read_text(encoding="utf-8")
        blocks = manifest.split("    - name: ")[1:]
        self.assertEqual(len(blocks), 5)
        self.assertTrue(blocks[0].startswith("Checkout repository\n"))
        self.assertIn("if: inputs.perform-checkout == 'true'", blocks[0])
        self.assertIn("fetch-depth: 0", blocks[0])
        for block, condition in zip(blocks[1:3], ("==", "!=")):
            self.assertIn(f"if: inputs.artifact-run-id {condition} ''", block)
            self.assertIn("uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", block)
            self.assertIn("name: ${{ inputs.artifact-name }}", block)
            self.assertIn("path: ${{ inputs.artifact-output-path }}", block)
        self.assertIn("run-id: ${{ inputs.artifact-run-id }}", blocks[2])
        self.assertIn("github-token: ${{ inputs.github-token }}", blocks[2])
        self.assertTrue(blocks[3].startswith("Log in to NuGet.org using OIDC\n"))
        self.assertIn("id: nuget-login\n", blocks[3])
        self.assertIn(f"uses: NuGet/login@{LOGIN_SHA}", blocks[3])
        self.assertIn("user: ${{ inputs.nuget-user }}", blocks[3])
        self.assertNotIn("token-service-url:", manifest)
        self.assertNotIn("audience:", manifest)
        self.assertTrue(blocks[4].startswith("Publish to NuGet.org\n"))
        for block in blocks[3:]:
            self.assertNotRegex(block, r"\n\s+(if|continue-on-error):")
        self.assertIn("NUGET_API_KEY: ${{ steps.nuget-login.outputs.NUGET_API_KEY }}", blocks[4])
        self.assertIn("ARTIFACT_OUTPUT_PATH: ${{ inputs.artifact-output-path }}", blocks[4])
        self.assertNotIn("${{", step_script("publish-nuget-packages/action.yml", "Publish to NuGet.org"))
        self.assertNotRegex(manifest, r"secrets\.|GITHUB_ENV|GITHUB_OUTPUT")
        self.assertNotRegex(manifest, r"(?m)^outputs:")
        inputs = manifest.split("\ninputs:\n", 1)[1].split("\nruns:", 1)[0]
        self.assertEqual(re.findall(r"^  ([a-z-]+):$", inputs, re.MULTILINE), [
            "nuget-user", "artifact-name", "artifact-run-id", "github-token",
            "artifact-output-path", "perform-checkout",
        ])
        self.assertRegex(inputs, r"nuget-user:\n\s+description: [^\n]+\n\s+required: true")
        for name, default in (("artifact-run-id", ""), ("github-token", ""),
                              ("artifact-output-path", "."), ("perform-checkout", "true")):
            block = re.search(
                rf"^  {name}:\n((?:    [^\n]*\n?)+)", inputs, re.MULTILINE
            ).group(1)
            self.assertIn(f'default: "{default}"', block)
        version = json.loads((ACTION.parent / "version.json").read_text(encoding="utf-8"))
        self.assertEqual(version["version"], "3.0")

    def run_publish(self, case="success", symbols=True, key="ephemeral-test-key", missing_path=False):
        script = step_script("publish-nuget-packages/action.yml", "Publish to NuGet.org")
        # Isolate the existing fixed log path; all command and gating logic stays unchanged.
        self.assertEqual(script.count("NUGET_LOG=/tmp/nuget-push.log"), 1)
        script = script.replace("NUGET_LOG=/tmp/nuget-push.log", 'NUGET_LOG="$TEST_LOG"')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            packages = root / "packages 'quoted' $(touch injected); literal"
            packages.mkdir()
            (packages / "package.nupkg").touch()
            if symbols:
                (packages / "package.snupkg").touch()
            harness = textwrap.dedent(r"""
                function dotnet {
                  python -c 'import json,os,sys; f=open(os.environ["TEST_TRACE"],"a"); f.write(json.dumps(sys.argv[1:])+"\n"); f.close()' "$@"
                  if [[ "$3" == "**/*.nupkg" ]]; then
                    case "$TEST_CASE" in
                      duplicate) echo "Package already exists (Conflict)";;
                      package-error) echo "package push failed" >&2; return 17;;
                      partial-error) echo "Successfully published package"; return 17;;
                      *) echo "Successfully published package";;
                    esac
                  elif [[ "$TEST_CASE" == symbol-error ]]; then
                    echo "symbol push failed" >&2
                    return 19
                  fi
                }
            """)
            trace = root / "trace.jsonl"
            environment = {
                **os.environ,
                "ARTIFACT_OUTPUT_PATH": (packages / "missing").as_posix() if missing_path else packages.as_posix(),
                "NUGET_API_KEY": key,
                "TEST_CASE": case,
                "TEST_TRACE": str(trace),
                "TEST_LOG": (root / "nuget.log").as_posix(),
            }
            # Execute only the checked-out action script and test-local fake dotnet.
            result = subprocess.run(  # nosec B603
                [bash_executable(), "-c", harness + script], cwd=root,
                env=environment, capture_output=True, text=True,
            )
            calls = [json.loads(line) for line in trace.read_text(encoding="utf-8").splitlines()] if trace.exists() else []
            self.assertFalse((packages / "injected").exists())
            self.assertFalse((root / "injected").exists())
            return result, calls

    def assert_push(self, call, extension, key):
        self.assertEqual(call, [
            "nuget", "push", f"**/*.{extension}", "--source",
            "https://api.nuget.org/v3/index.json", "--api-key", key, "--skip-duplicate",
        ])

    def test_packages_then_symbols_with_literal_path_and_key(self):
        key = "ephemeral 'quoted' $(touch injected); $HOME\nsecond-line"
        result, calls = self.run_publish(key=key)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(calls), 2)
        self.assert_push(calls[0], "nupkg", key)
        self.assert_push(calls[1], "snupkg", key)

    def test_duplicate_packages_skip_symbols(self):
        result, calls = self.run_publish(case="duplicate")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 1)
        self.assertIn("skipping symbol publish", result.stdout)

    def test_success_without_symbols(self):
        result, calls = self.run_publish(symbols=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 1)
        self.assertIn("No symbol packages detected", result.stdout)

    def test_package_and_partial_push_failure_stop_symbols(self):
        for case in ("package-error", "partial-error"):
            with self.subTest(case=case):
                result, calls = self.run_publish(case=case)
                self.assertEqual(result.returncode, 17, result.stdout + result.stderr)
                self.assertEqual(len(calls), 1)

    def test_symbol_failure_propagates(self):
        result, calls = self.run_publish(case="symbol-error")
        self.assertEqual(result.returncode, 19, result.stdout + result.stderr)
        self.assertEqual(len(calls), 2)

    def test_empty_login_output_fails_before_push(self):
        result, calls = self.run_publish(key="")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("NuGet OIDC login did not return an API key", result.stderr)
        self.assertEqual(calls, [])

    def test_missing_artifact_path_fails_before_push(self):
        result, calls = self.run_publish(missing_path=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()

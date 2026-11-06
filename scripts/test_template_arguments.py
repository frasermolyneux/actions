import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parent.parent


def bash_executable():
    if os.name == "nt":
        git_bash = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Git" / "bin" / "bash.exe"
        if git_bash.is_file():
            return str(git_bash)
    return required_executable("bash")


def required_executable(name):
    executable = shutil.which(name)
    if not executable:
        raise FileNotFoundError(f"Required executable not found on PATH: {name}")
    return executable


def step_script(path, name, indentation=4):
    text = (ROOT / path).read_text(encoding="utf-8")
    prefix = " " * indentation + "- name: "
    block = text.split(prefix + name + "\n", 1)[1].split("\n" + prefix, 1)[0]
    script = block.split(" " * (indentation + 2) + "run: |\n", 1)[1]
    script = script.split("\n" + " " * (indentation + 2) + "env:", 1)[0]
    return textwrap.dedent(script)


def run_step(script, environment, cwd):
    harness = """
        function terraform { printf 'TRACE:'; python -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@"; }
        function cmake { printf 'TRACE:'; python -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@"; }
        function ctest { printf 'TRACE:'; python -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@"; }
        function dotnet { printf 'TRACE:'; python -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@"; }
        function az { printf 'TRACE:'; python -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@"; }
        function sleep { :; }
    """
    result = subprocess.run(
        [bash_executable(), "-c", textwrap.dedent(harness) + script],
        cwd=cwd,
        env={**os.environ, **environment},
        text=True,
        capture_output=True,
    )
    traces = [json.loads(line[6:]) for line in result.stdout.splitlines() if line.startswith("TRACE:")]
    return result, traces


class ArgumentTests(unittest.TestCase):
    def test_cmake_steps_preserve_arguments_and_reject_bad_quotes(self):
        steps = (
            ("cmake-ci/action.yml", "Configure CMake", 4, ["-S", "source dir", "-B", "build dir"]),
            ("cmake-ci/action.yml", "Build", 4, ["--build", "build dir"]),
            ("cmake-ci/action.yml", "Test", 4, ["--test-dir", "build dir"]),
            (".github/workflows/codequality.yml", "Configure CMake", 6, ["-S", "source dir", "-B", "build dir"]),
            (".github/workflows/codequality.yml", "Build (CMake)", 6, ["--build", "build dir"]),
            (".github/workflows/codequality.yml", "Test (CMake)", 6, ["--test-dir", "build dir"]),
        )
        with tempfile.TemporaryDirectory() as temporary:
            for path, name, indentation, expected in steps:
                script = step_script(path, name, indentation)
                environment = {
                    "CMAKE_SOURCE_DIR": "source dir",
                    "CMAKE_BUILD_DIR": "build dir",
                    "CMAKE_ADDITIONAL_ARGS": """-DNAME='two words' '$(touch injected)' "" 'semi;colon'""",
                }
                with self.subTest(path=path, step=name):
                    result, traces = run_step(script, environment, temporary)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(traces, [expected + ["-DNAME=two words", "$(touch injected)", "", "semi;colon"]])
                    self.assertFalse((Path(temporary) / "injected").exists())
                    environment["CMAKE_ADDITIONAL_ARGS"] = "'unterminated"
                    result, traces = run_step(script, environment, temporary)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(traces, [])

    def test_terraform_steps_keep_argument_and_address_boundaries(self):
        steps = (
            ("terraform-apply/action.yml", "Terraform Apply (from plan)", "apply"),
            ("terraform-destroy/action.yml", "Terraform Destroy", "destroy"),
            ("terraform-destroy-resources/action.yml", "Terraform Destroy", "destroy"),
            ("terraform-import/action.yml", "Terraform Import", "import"),
            ("terraform-plan/action.yml", "Terraform Plan", "plan"),
            ("terraform-plan-readonly/action.yml", "Terraform Plan", "plan"),
            ("terraform-plan-and-apply/action.yml", "Terraform Plan", "plan"),
            ("terraform-plan-and-apply/action.yml", "Terraform Apply", "apply"),
            ("terraform-state-rm/action.yml", "Parse and remove state addresses", "state"),
        )
        addresses = ["module.x[\"space and ' quote\"]", "second\nline"]
        with tempfile.TemporaryDirectory() as temporary:
            Path(temporary, "plan with spaces").touch()
            environment = {
                "RUNNER_TEMP": Path(temporary).as_posix(),
                "TF_PLAN_FILE": "plan with spaces",
                "TF_VAR_FILE": "var file'$(touch injected)",
                "TF_IMPORT_ADDRESS": addresses[0],
                "TF_IMPORT_ID": "id with spaces",
                "TF_ADDITIONAL_ARGS": "-var='hello world' '$(touch injected)' \"\"",
                "TF_RESOURCES": json.dumps(addresses),
                "TF_STATE_ADDRESSES": json.dumps(addresses),
            }
            for path, name, operation in steps:
                with self.subTest(path=path, step=name):
                    script = step_script(path, name)
                    result, traces = run_step(script, environment, temporary)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    commands = [trace for trace in traces if trace and trace[0] == operation]
                    self.assertEqual(len(commands), 2 if name in ("Parse and remove state addresses",) or path.startswith("terraform-destroy-resources") else 1)
                    for command in commands:
                        self.assertIn("-var=hello world", command)
                        self.assertIn("$(touch injected)", command)
                        self.assertIn("", command)
                    if path.startswith("terraform-destroy-resources"):
                        self.assertEqual([x[2] for x in commands], ["-target=" + x for x in addresses])
                    if path.startswith("terraform-state-rm"):
                        self.assertEqual([x[-1] for x in commands], addresses)
                    if path.startswith("terraform-import"):
                        self.assertEqual(commands[0][-2:], [addresses[0], "id with spaces"])
                    self.assertFalse(Path(temporary, "injected").exists())
                    bad = {**environment, "TF_ADDITIONAL_ARGS": "'unterminated"}
                    result, traces = run_step(script, bad, temporary)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(traces, [])
                    if path.startswith(("terraform-state-rm", "terraform-destroy-resources")):
                        key = "TF_STATE_ADDRESSES" if path.startswith("terraform-state-rm") else "TF_RESOURCES"
                        result, traces = run_step(script, {**environment, key: '["valid", 1]'}, temporary)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertEqual(traces, [])
                        result, traces = run_step(script, {**environment, key: "[]"}, temporary)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(traces, [])

    def test_api_import_passes_untrusted_values_literally(self):
        malicious = "value with 'quotes' $(touch injected)\nnext"
        environment = dict.fromkeys((
            "APIM_RESOURCE_GROUP", "APIM_NAME", "API_ID", "API_DISPLAY_NAME",
            "API_PATH", "API_VERSION", "API_VERSION_SET_ID", "SPECIFICATION_FORMAT",
            "SPECIFICATION_URL", "SERVICE_URL", "SUBSCRIPTION_REQUIRED", "PRODUCT_ID",
        ), malicious)
        with tempfile.TemporaryDirectory() as temporary:
            for name in ("Import OpenAPI spec for ${{ inputs.api-id }}", "Add ${{ inputs.api-id }} to product"):
                with self.subTest(step=name):
                    result, traces = run_step(step_script("apim-api-import/action.yml", name), environment, temporary)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(len(traces), 1)
                    self.assertGreater(traces[0].count(malicious), 3)
                    self.assertFalse(Path(temporary, "injected").exists())

    def test_web_publish_rejects_traversal_and_preserves_project_name(self):
        script = step_script("dotnet-web-ci/action.yml", "dotnet publish ${{ inputs.dotnet-project }}")
        with tempfile.TemporaryDirectory() as temporary:
            sentinel = Path(temporary, "sentinel")
            sentinel.write_text("unchanged", encoding="utf-8")
            environment = {
                "RUNNER_TEMP": Path(temporary).as_posix(),
                "SRC_FOLDER": ".",
                "DOTNET_PROJECT": "../sentinel",
                "DOTNET_PUBLISH_FRAMEWORKS": "",
            }
            result, traces = run_step(script, environment, temporary)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(traces, [])
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "unchanged")
            environment["DOTNET_PROJECT"] = "project $(touch injected)"
            result, traces = run_step(script, environment, temporary)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(traces[0][1], "project $(touch injected)/project $(touch injected).csproj")
            self.assertFalse(Path(temporary, "injected").exists())

    def test_dotnet_version_output_uses_unpredictable_delimiter(self):
        script = step_script("dotnet-sdk-setup/action.yml", "Resolve .NET SDK versions")
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary, "output")
            output.touch()
            environment = {
                **os.environ,
                "DOTNET_VERSIONS": '9.0.x\nEOF\nFORGED=1\n$(throw "injected")',
                "GITHUB_OUTPUT": str(output),
            }
            result = subprocess.run(
                [required_executable("pwsh"), "-NoProfile", "-NonInteractive", "-Command", script],
                env=environment,
                text=True,
                capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            lines = output.read_text(encoding="utf-8-sig").splitlines()
            key, delimiter = lines[0].split("<<", 1)
            self.assertEqual(key, "stable_versions")
            self.assertNotEqual(delimiter, "EOF")
            self.assertEqual(lines[1:5], ["9.0.x", "EOF", "FORGED=1", '$(throw "injected")'])
            self.assertEqual(lines[5], delimiter)

    def test_dotnet_restore_uses_source_as_one_literal_path(self):
        names = ("dotnet-ci", "dotnet-func-ci", "dotnet-web-ci", "dotnet-playwright-tests", "run-api-integration-tests")
        with tempfile.TemporaryDirectory() as temporary:
            folder = "source folder $(touch injected)"
            Path(temporary, folder).mkdir()
            for name in names:
                with self.subTest(action=name):
                    result, traces = run_step(
                        step_script(name + "/action.yml", "Restore Dependencies"),
                        {"SRC_FOLDER": folder},
                        temporary,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(traces, [["restore"]])
                    self.assertFalse(Path(temporary, "injected").exists())

    def test_bicep_directory_is_literal_powershell_data(self):
        script = step_script("bicep-lint-code/action.yml", "RunBicepBuild")
        harness = 'function bicep { & node -e "console.log(JSON.stringify(process.argv.slice(1)))" @args }\n'
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary, "folder'$(throw injected)")
            directory.mkdir()
            (directory / "main.bicep").touch()
            result = subprocess.run(
                [required_executable("pwsh"), "-NoProfile", "-NonInteractive", "-Command", harness + script],
                env={**os.environ, "BICEP_DIRECTORY": str(directory)},
                text=True,
                capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            commands = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("[")]
            self.assertEqual([command[0] for command in commands], ["restore", "build"])
            self.assertTrue(all(os.path.samefile(command[1], directory / "main.bicep") for command in commands))


if __name__ == "__main__":
    unittest.main()

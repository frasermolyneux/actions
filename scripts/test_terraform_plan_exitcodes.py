import os
from pathlib import Path
import re
import shutil
# Test harness intentionally executes checked-out scripts and the local Terraform wrapper.
import subprocess  # nosec B404
import tempfile
import unittest

from test_template_arguments import ROOT, bash_executable, step_script


ACTIONS = ("terraform-plan", "terraform-plan-readonly", "terraform-plan-and-apply")


def exitcode(output):
    matches = re.findall(r"^exitcode<<[^\n]+\n(\d+)\n", output, re.MULTILINE)
    if not matches:
        raise AssertionError(f"Wrapper exitcode missing: {output}")
    return matches[-1]


class PlanExitCodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        wrapper = os.environ.get("TERRAFORM_WRAPPER_JS")
        cli_path = os.environ.get("TERRAFORM_CLI_PATH")
        if not wrapper or not cli_path:
            raise RuntimeError("Set TERRAFORM_WRAPPER_JS and TERRAFORM_CLI_PATH to the pinned setup-terraform wrapper and its CLI directory")
        cls.wrapper = wrapper
        cls.cli_path = cli_path
        binary = Path(cli_path) / ("terraform-bin.exe" if os.name == "nt" else "terraform-bin")
        if not binary.is_file() or not Path(wrapper).is_file():
            raise RuntimeError("The pinned wrapper or terraform-bin is missing")
        cls.binary = str(binary)

    def run_script(self, script, root, env, output):
        output.write_text("", encoding="utf-8")
        environment = {
            **os.environ,
            "TERRAFORM_WRAPPER_JS": self.wrapper,
            "TERRAFORM_CLI_PATH": self.cli_path,
            "GITHUB_OUTPUT": str(output),
            "RUNNER_TEMP": root.as_posix(),
            "TF_PLAN_FILE": "plan.tfplan",
            "ACTION_TF_VARS_PATH": "empty.tfvars",
            "TF_ADDITIONAL_ARGS": "",
        }
        for key in list(environment):
            if key == "TF_CLI_ARGS" or key.startswith("TF_CLI_ARGS_") or key in ("TF_DATA_DIR", "TF_WORKSPACE"):
                environment.pop(key)
        environment.update(env)
        harness = '''
            function terraform {
              if [ "${FAIL_SECOND_SHOW:-}" = 1 ] && [ "$1" = show ] && [ "${2:-}" = -no-color ]; then
                node "$TERRAFORM_WRAPPER_JS" show -no-color missing.tfplan
              else
                node "$TERRAFORM_WRAPPER_JS" "$@"
              fi
            }
        '''
        # Test-only: the script is extracted from the checked-out action; run only in a trusted, isolated test environment.
        result = subprocess.run(  # nosec B603
            [bash_executable(), "-c", harness + script], cwd=root,
            env=environment, capture_output=True, text=True,
        )
        return result, output.read_text(encoding="utf-8")

    def test_pinned_wrapper_and_action_step_contracts(self):
        for action in ACTIONS:
            manifest = (ROOT / action / "action.yml").read_text(encoding="utf-8")
            plan = step_script(f"{action}/action.yml", "Terraform Plan")
            show = step_script(f"{action}/action.yml", "Show Terraform plan")
            self.assertNotIn("terraform show", plan)
            self.assertEqual(show.count("terraform show "), 2)
            self.assertIn("value: ${{ steps.plan.outputs.exitcode }}", manifest)
            gate = "steps.plan.outcome == 'success' && steps.plan.outputs.exitcode == '0'"
            for name in ("Show Terraform plan", "Bind saved plan to source and toolchain", "Store Terraform plan"):
                block = manifest.split(f"    - name: {name}\n", 1)[1].split("\n    - name:", 1)[0]
                expected = gate if name == "Show Terraform plan" else gate + " && steps.show.outcome == 'success'"
                self.assertIn(f"      if: {expected}\n", block)
            self.assertLess(manifest.index("    - name: Fail if "), manifest.index("    - name: Store Terraform plan"))
            fail_block = manifest.split("    - name: Fail if ", 1)[1].split("\n    - name:", 1)[0]
            failure = "steps.plan.outcome != 'success' || steps.plan.outputs.exitcode != '0' || steps.show.outcome != 'success'"
            if action != "terraform-plan-and-apply":
                failure = "steps.validate.outcome != 'success' || steps.validate.outputs.exitcode != '0' || " + failure
            self.assertIn(f"      if: {failure}\n", fail_block)
            self.assertIn("        exit 1", fail_block)
            self.assertIn("operation: upload", manifest)
            self.assertIn("uses: $/terraform-plan-storage", manifest)
            if action == "terraform-plan-and-apply":
                apply = manifest.split("    - name: Terraform Apply\n", 1)[1].split("\n    - name:", 1)[0]
                self.assertIn(f"      if: {gate} && steps.show.outcome == 'success'\n", apply)
                self.assertIn("-detailed-exitcode|--detailed-exitcode|-detailed-exitcode=*|--detailed-exitcode=*", apply)
            for case, config, args, extra_env, varfile, expected_shell, expected_code, should_show in (
                ("no changes", "", "-detailed-exitcode", {}, "empty.tfvars", 0, "0", True),
                ("changes gated", 'resource "terraform_data" "example" {}\n', "-detailed-exitcode", {}, "empty.tfvars", 0, "2", False),
                ("changes gated by environment", 'resource "terraform_data" "example" {}\n', "", {"TF_CLI_ARGS_plan": "-detailed-exitcode"}, "empty.tfvars", 0, "2", False),
                ("changes ordinary", 'resource "terraform_data" "example" {}\n', "", {}, "empty.tfvars", 0, "0", True),
                ("plan error", "", "-detailed-exitcode", {}, "missing.tfvars", 1, "1", False),
            ):
                with self.subTest(action=action, case=case), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    (root / "main.tf").write_text(config, encoding="utf-8")
                    (root / "empty.tfvars").write_text("", encoding="utf-8")
                    # The executable is the test-supplied Terraform binary; arguments and fixture are local and fixed.
                    init = subprocess.run(  # nosec B603
                        [self.binary, "init", "-backend=false", "-input=false"],
                        cwd=root, capture_output=True, text=True,
                        env={k: v for k, v in os.environ.items() if not k.startswith("TF_CLI_ARGS") and k not in ("TF_DATA_DIR", "TF_WORKSPACE")},
                    )
                    self.assertEqual(init.returncode, 0, init.stdout + init.stderr)
                    result, plan_output = self.run_script(
                        plan, root, {"TF_ADDITIONAL_ARGS": args, "ACTION_TF_VARS_PATH": varfile, **extra_env}, root / "plan-output",
                    )
                    self.assertEqual(result.returncode, expected_shell, result.stdout + result.stderr)
                    self.assertEqual(exitcode(plan_output), expected_code)
                    if should_show:
                        result, show_output = self.run_script(show, root, {}, root / "show-output")
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        self.assertEqual(exitcode(show_output), "0")
                        self.assertEqual(exitcode(plan_output), expected_code)
                        self.assertTrue((root / "tf-plan-output.txt").is_file())
                        result, _ = self.run_script(show, root, {"TF_PLAN_FILE": "missing.tfplan"}, root / "failed-show")
                        self.assertNotEqual(result.returncode, 0)
                        result, _ = self.run_script(show, root, {"FAIL_SECOND_SHOW": "1"}, root / "failed-second-show")
                        self.assertNotEqual(result.returncode, 0)
                        if action == "terraform-plan-and-apply":
                            apply_script = step_script(f"{action}/action.yml", "Terraform Apply")
                            result, apply_output = self.run_script(
                                apply_script, root, {"TF_ADDITIONAL_ARGS": args}, root / "apply-output",
                            )
                            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                            self.assertEqual(exitcode(apply_output), "0")
                    else:
                        self.assertFalse((root / "tf-plan-output.txt").exists())

    def test_combined_action_accepts_detailed_exitcode_flag_forms(self):
        plan = step_script("terraform-plan-and-apply/action.yml", "Terraform Plan")
        apply = step_script("terraform-plan-and-apply/action.yml", "Terraform Apply")
        for flag, has_change in (
            ("--detailed-exitcode", False),
            ("-detailed-exitcode=true", False),
            ("--detailed-exitcode=true", False),
            ("-detailed-exitcode=false", True),
            ("--detailed-exitcode=false", True),
        ):
            with self.subTest(flag=flag), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "main.tf").write_text(
                    'resource "terraform_data" "example" {}\n' if has_change else "", encoding="utf-8"
                )
                (root / "empty.tfvars").write_text("", encoding="utf-8")
                # The executable is the test-supplied Terraform binary; arguments and fixture are local and fixed.
                init = subprocess.run(  # nosec B603
                    [self.binary, "init", "-backend=false", "-input=false"],
                    cwd=root, capture_output=True, text=True,
                    env={k: v for k, v in os.environ.items() if not k.startswith("TF_CLI_ARGS") and k not in ("TF_DATA_DIR", "TF_WORKSPACE")},
                )
                self.assertEqual(init.returncode, 0, init.stdout + init.stderr)
                result, output = self.run_script(plan, root, {"TF_ADDITIONAL_ARGS": flag}, root / "plan-output")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(exitcode(output), "0")
                result, output = self.run_script(apply, root, {"TF_ADDITIONAL_ARGS": flag}, root / "apply-output")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(exitcode(output), "0")

    def test_post_import_plan_gates_before_storage(self):
        manifest = (ROOT / "terraform-import" / "action.yml").read_text(encoding="utf-8")
        plan = step_script("terraform-import/action.yml", "Terraform Plan (post-import)")
        self.assertIn("value: ${{ steps.plan.outputs.exitcode }}", manifest)
        gate = "steps.plan.outcome == 'success' && steps.plan.outputs.exitcode == '0'"
        for name in ("Bind saved plan to source and toolchain", "Store Terraform plan"):
            block = manifest.split(f"    - name: {name}\n", 1)[1].split("\n    - name:", 1)[0]
            self.assertIn(f"      if: {gate}\n", block)
        fail = manifest.split("    - name: Fail if validate or plan failed\n", 1)[1].split("\n    - name:", 1)[0]
        self.assertIn("steps.validate.outcome != 'success' || steps.validate.outputs.exitcode != '0' || steps.plan.outcome != 'success' || steps.plan.outputs.exitcode != '0'", fail)
        self.assertIn("        exit 1", fail)
        self.assertLess(manifest.index("    - name: Fail if validate or plan failed"), manifest.index("    - name: Store Terraform plan"))
        for case, config, args, varfile, expected_shell, expected_code in (
            ("no changes", "", "-detailed-exitcode", "empty.tfvars", 0, "0"),
            ("changes gated", 'resource "terraform_data" "example" {}\n', "-detailed-exitcode", "empty.tfvars", 0, "2"),
            ("changes ordinary", 'resource "terraform_data" "example" {}\n', "", "empty.tfvars", 0, "0"),
            ("plan error", "", "-detailed-exitcode", "missing.tfvars", 1, "1"),
        ):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "main.tf").write_text(config, encoding="utf-8")
                (root / "empty.tfvars").write_text("", encoding="utf-8")
                # The executable is the test-supplied Terraform binary; arguments and fixture are local and fixed.
                init = subprocess.run(  # nosec B603
                    [self.binary, "init", "-backend=false", "-input=false"],
                    cwd=root, capture_output=True, text=True,
                    env={k: v for k, v in os.environ.items() if not k.startswith("TF_CLI_ARGS") and k not in ("TF_DATA_DIR", "TF_WORKSPACE")},
                )
                self.assertEqual(init.returncode, 0, init.stdout + init.stderr)
                result, output = self.run_script(
                    plan, root, {"TF_CLI_ARGS_plan": args, "ACTION_TF_VARS_PATH": varfile}, root / "plan-output",
                )
                self.assertEqual(result.returncode, expected_shell, result.stdout + result.stderr)
                self.assertEqual(exitcode(output), expected_code)


if __name__ == "__main__":
    unittest.main()

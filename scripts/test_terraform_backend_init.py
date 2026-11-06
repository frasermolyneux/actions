import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parent.parent
ACTIONS = (
    "terraform-apply",
    "terraform-destroy",
    "terraform-destroy-resources",
    "terraform-import",
    "terraform-output",
    "terraform-plan-and-apply",
    "terraform-plan-readonly",
    "terraform-plan",
    "terraform-state-check",
    "terraform-state-rm",
)
FIELDS = (
    ("terraform-backend-file", "TERRAFORM_BACKEND_FILE", ""),
    ("backend-subscription-id", "BACKEND_SUBSCRIPTION_ID", "subscription_id="),
    ("backend-resource-group-name", "BACKEND_RESOURCE_GROUP_NAME", "resource_group_name="),
    ("backend-storage-account-name", "BACKEND_STORAGE_ACCOUNT_NAME", "storage_account_name="),
    ("backend-container-name", "BACKEND_CONTAINER_NAME", "container_name="),
    ("backend-key", "BACKEND_KEY", "key="),
    ("backend-tags", "BACKEND_TAGS", "tags="),
)


class BackendInitTests(unittest.TestCase):
    def test_literal_backend_values_reach_native_command(self):
        pwsh = shutil.which("pwsh")
        if not pwsh:
            raise FileNotFoundError("Required executable not found on PATH: pwsh")
        for action in ACTIONS:
            text = (ROOT / action / "action.yml").read_text(encoding="utf-8")
            step = text.split("    - name: Terraform Init\n", 1)[1].split("\n    - name:", 1)[0]
            script = re.search(r"      run: \|\n(.*?)      env:\n", step, re.DOTALL).group(1)
            for some_empty in (False, True):
                with self.subTest(action=action, some_empty=some_empty):
                    environment = os.environ.copy()
                    expected = ["init", "-input=false", "-lockfile=readonly"]
                    for index, (input_name, variable, prefix) in enumerate(FIELDS):
                        key = "TF_BACKEND_" + variable
                        self.assertIn(f"{key}: ${{{{ inputs.{input_name} }}}}", step)
                        value = "" if some_empty and index % 2 else (
                            f'value {index} "quotes" \'apostrophe\' $(throw "injected")\nsecond line'
                        )
                        environment[key] = value
                        if value:
                            expected.append("-backend-config=" + prefix + value)
                    harness = (
                        'function terraform { & node -e "console.log(JSON.stringify(process.argv.slice(1)))" '
                        '@args; $global:LASTEXITCODE = $LASTEXITCODE }\n'
                    )
                    result = subprocess.run(
                        [pwsh, "-NoProfile", "-NonInteractive", "-Command", harness + script],
                        env=environment,
                        text=True,
                        capture_output=True,
                        check=True,
                    )
                    self.assertEqual(json.loads(result.stdout), expected)


if __name__ == "__main__":
    unittest.main()

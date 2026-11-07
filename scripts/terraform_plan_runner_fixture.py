"""Generate a no-cloud composite from the production plan steps for runner testing."""

import os
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent.parent
ACTIONS = {"terraform-plan", "terraform-plan-readonly", "terraform-plan-and-apply", "terraform-import"}
CASES = {"no-change", "plan-error", "gated-change", "ordinary-change", "show-error"}


def block(manifest, name):
    marker = f"    - name: {name}\n"
    parts = manifest.split(marker)
    if len(parts) != 2:
        raise ValueError(f"Expected exactly one {name!r} step")
    return marker + parts[1].split("\n    - name: ", 1)[0].rstrip() + "\n"


def marker_step(manifest, name, marker):
    original = block(manifest, name)
    conditions = [line for line in original.splitlines() if line.startswith("      if: ")]
    if len(conditions) != 1:
        raise ValueError(f"Expected one condition for {name}")
    return (
        f"    - name: {name}\n{conditions[0]}\n"
        "      shell: bash\n"
        f'      run: echo {marker} >> "$RUNNER_PLAN_MARKERS"\n'
    )


def prepare(action, case):
    manifest = (ROOT / action / "action.yml").read_text(encoding="utf-8").replace("\r\n", "\n")
    header = manifest.split("runs:\n", 1)[0] + "runs:\n  using: composite\n  steps:\n"
    parts = [header]
    if action != "terraform-plan-and-apply":
        parts.append(block(manifest, "Terraform Validate"))
    plan_name = "Terraform Plan (post-import)" if action == "terraform-import" else "Terraform Plan"
    parts.append(block(manifest, plan_name))
    if action != "terraform-import":
        parts.append("""    - name: Simulate an unreadable saved plan
      if: inputs.test-case == 'show-error' && steps.plan.outcome == 'success'
      shell: bash
      working-directory: ${{ inputs.terraform-folder }}
      env:
        TF_TEST_PLAN: ${{ inputs.plan-file-name }}
      run: rm -- "$TF_TEST_PLAN"
""")
        parts.append(block(manifest, "Show Terraform plan"))
    fail_name = (
        "Fail if validate or plan failed" if action == "terraform-import"
        else "Fail if plan or show failed" if action == "terraform-plan-and-apply"
        else "Fail if validate, plan, or show failed"
    )
    parts.append(block(manifest, fail_name))
    parts.append(marker_step(manifest, "Bind saved plan to source and toolchain", "bind"))
    parts.append(marker_step(manifest, "Store Terraform plan", "store"))
    if action == "terraform-plan-and-apply":
        parts.append(marker_step(manifest, "Terraform Apply", "apply"))
    parts.append("""    - name: Record actual runner step results
      if: always()
      shell: bash
      env:
        PLAN_CODE: ${{ steps.plan.outputs.exitcode }}
        PLAN_OUTCOME: ${{ steps.plan.outcome }}
        SHOW_CODE: ${{ steps.show.outputs.exitcode }}
        SHOW_OUTCOME: ${{ steps.show.outcome }}
      run: |
        printf '%s\\n%s\\n%s\\n%s\\n' "$PLAN_CODE" "$PLAN_OUTCOME" "$SHOW_CODE" "$SHOW_OUTCOME" > "$RUNNER_PLAN_TRACE"
""")
    # This fixture-only input controls the fault injection, not production behavior.
    parts[0] = parts[0].replace("outputs:\n", "  test-case:\n    description: Fixture scenario\n    default: ''\noutputs:\n", 1)
    destination = ROOT / ".runner-plan-contract"
    destination.mkdir(exist_ok=True)
    (destination / "action.yml").write_text("".join(parts), encoding="utf-8")
    fixture = Path(os.environ["RUNNER_PLAN_ROOT"])
    fixture.mkdir()
    (fixture / "empty.tfvars").write_text("", encoding="utf-8")
    config = 'resource "terraform_data" "example" {}\n' if case in {"gated-change", "ordinary-change"} else ""
    (fixture / "main.tf").write_text(config, encoding="utf-8")


def verify(action, case):
    trace = Path(os.environ["RUNNER_PLAN_TRACE"]).read_text(encoding="utf-8").splitlines()
    markers_path = Path(os.environ["RUNNER_PLAN_MARKERS"])
    markers = markers_path.read_text(encoding="utf-8").splitlines() if markers_path.exists() else []
    expected_code = {"no-change": "0", "plan-error": "1", "gated-change": "2", "ordinary-change": "0", "show-error": "0"}[case]
    expected_outcome = "failure" if case == "plan-error" else "success"
    expected_result = "failure" if case in {"plan-error", "gated-change", "show-error"} else "success"
    expected_show = ("failure" if case == "show-error" else "skipped" if case in {"plan-error", "gated-change"} else "success")
    expected_markers = [] if expected_result == "failure" else ["bind", "store"] + (["apply"] if action == "terraform-plan-and-apply" else [])
    assert trace[0:2] == [expected_code, expected_outcome], f"Wrong plan result: {trace}"
    if action != "terraform-import":
        assert trace[3] == expected_show, f"Wrong show outcome: {trace}"
        if expected_show == "success":
            assert trace[2] == "0", f"Wrong show exitcode: {trace}"
    assert os.environ["RUNNER_ACTION_OUTCOME"] == expected_result, f"Wrong composite outcome: {os.environ['RUNNER_ACTION_OUTCOME']}"
    assert markers == expected_markers, f"Wrong gated side effects: {markers}"
    print(f"{action} {case}: plan={trace[0]} outcome={expected_result} markers={markers}")


if __name__ == "__main__":
    operation, action, case = sys.argv[1:]
    if action not in ACTIONS or case not in CASES or (action == "terraform-import" and case == "show-error"):
        raise ValueError("Invalid runner fixture scenario")
    {"prepare": prepare, "verify": verify}[operation](action, case)

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from terraform_plan_runner_fixture import verify


class RunnerFixtureTests(unittest.TestCase):
    def test_verifier_rejects_bad_results_even_with_optimization(self):
        cases = (
            ("valid", "0\nsuccess\n0\nsuccess\n", "success", "bind\nstore\napply\n", None),
            ("plan", "2\nsuccess\n0\nsuccess\n", "success", "bind\nstore\napply\n", "Wrong plan result"),
            ("show outcome", "0\nsuccess\n0\nfailure\n", "success", "bind\nstore\napply\n", "Wrong show outcome"),
            ("show exit", "0\nsuccess\n1\nsuccess\n", "success", "bind\nstore\napply\n", "Wrong show exitcode"),
            ("composite outcome", "0\nsuccess\n0\nsuccess\n", "failure", "bind\nstore\napply\n", "Wrong composite outcome"),
            ("side effects", "0\nsuccess\n0\nsuccess\n", "success", "bind\n", "Wrong gated side effects"),
            ("missing show", "0\nsuccess\n", "success", "bind\nstore\napply\n", "Wrong show outcome"),
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trace = root / "trace"
            markers = root / "markers"
            for name, result, outcome, recorded, error in cases:
                with self.subTest(name=name):
                    trace.write_text(result, encoding="utf-8")
                    markers.write_text(recorded, encoding="utf-8")
                    with patch.dict(os.environ, {
                        "RUNNER_PLAN_TRACE": str(trace),
                        "RUNNER_PLAN_MARKERS": str(markers),
                        "RUNNER_ACTION_OUTCOME": outcome,
                    }):
                        if error:
                            with self.assertRaisesRegex(AssertionError, error):
                                verify("terraform-plan-and-apply", "no-change")
                        else:
                            verify("terraform-plan-and-apply", "no-change")


if __name__ == "__main__":
    unittest.main()

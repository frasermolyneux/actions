import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

import firewall


class FirewallTests(unittest.TestCase):
    def test_extracts_only_sql_firewall_address(self):
        error = ("credential error contacting 169.254.169.254\n"
                 "Client with IP address '3.42.157.109' is not allowed to access the server.")
        with patch.object(firewall.subprocess, "run", return_value=SimpleNamespace(
                returncode=1, stdout=error, stderr="")):
            self.assertEqual(firewall.probe("sqlcmd", "server", "master"), ("3.42.157.109", None))

    def test_unrelated_ip_does_not_create_rule(self):
        with patch.object(firewall.subprocess, "run", return_value=SimpleNamespace(
                returncode=1, stdout="", stderr="Could not connect to 169.254.169.254")):
            self.assertEqual(firewall.probe("sqlcmd", "server", "master"),
                             (None, "\nCould not connect to 169.254.169.254"))

    def test_rejects_invalid_reported_address(self):
        error = "Client with IP address '999.1.1.1' is not allowed to access the server."
        with patch.object(firewall.subprocess, "run", return_value=SimpleNamespace(
                returncode=1, stdout=error, stderr="")):
            with self.assertRaises(ValueError):
                firewall.probe("sqlcmd", "server", "master")

    def test_connectivity_fallback_does_not_create_rule(self):
        with patch.dict(os.environ, {"SQL_SERVER_FQDN": "server", "SQL_DATABASE_NAME": "db"}), \
                patch.object(firewall, "install_sqlcmd", return_value="sqlcmd"), \
                patch.object(firewall, "probe", side_effect=[(None, "master denied"), (None, None)]) as probe, \
                patch.object(firewall, "run") as run:
            firewall.create()
            self.assertEqual(probe.call_count, 2)
            run.assert_not_called()

    def test_rule_uses_sql_reported_address_and_records_cleanup_before_create(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            environment = {"SQL_SERVER_FQDN": "server.example", "SQL_DATABASE_NAME": "db",
                           "GITHUB_OUTPUT": str(output), "RUNNER_TEMP": directory}
            servers = json.dumps([{"fullyQualifiedDomainName": "server.example",
                                   "name": "server", "resourceGroup": "group"}])

            def az(args):
                if "list" in args:
                    return servers
                self.assertIn("rule-name=GitHubActions_", output.read_text())
                self.assertEqual(args[args.index("--start-ip-address") + 1], "3.42.157.109")
                self.assertEqual(args[args.index("--end-ip-address") + 1], "3.42.157.109")
                return ""

            with patch.dict(os.environ, environment), \
                    patch.object(firewall, "install_sqlcmd", return_value="sqlcmd"), \
                    patch.object(firewall, "probe", return_value=("3.42.157.109", None)), \
                    patch.object(firewall, "run", side_effect=az):
                firewall.create()
                self.assertIn("resource-group=group\n", output.read_text())

    def test_non_firewall_error_is_not_suppressed(self):
        with patch.dict(os.environ, {"SQL_SERVER_FQDN": "server", "SQL_DATABASE_NAME": "db"}), \
                patch.object(firewall, "install_sqlcmd", return_value="sqlcmd"), \
                patch.object(firewall, "probe", side_effect=[(None, "first"), (None, "second")]), \
                patch.object(firewall, "probe_sqlpackage", return_value=(None, "extract failed")), \
                patch.object(firewall, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "extract failed"):
                firewall.create()
            run.assert_not_called()

    def test_sqlpackage_fallback_can_report_the_runner_ip(self):
        error = ("credential error contacting 169.254.169.254\n"
                 "Client with IP address '3.42.157.109' is not allowed to access the server.")
        with patch.object(firewall.subprocess, "run", return_value=SimpleNamespace(
                returncode=1, stdout=error, stderr="")):
            self.assertEqual(firewall.probe_sqlpackage("server", "db", "temp"), ("3.42.157.109", None))

    def test_delete_uses_recorded_rule(self):
        environment = {"SQL_FIREWALL_RESOURCE_GROUP": "group", "SQL_FIREWALL_SERVER": "server",
                       "SQL_FIREWALL_RULE_NAME": "rule"}
        with patch.dict(os.environ, environment), patch.object(firewall, "run") as run:
            firewall.delete()
            run.assert_called_once_with(["az", "sql", "server", "firewall-rule", "delete",
                                         "--resource-group", "group", "--server", "server", "--name", "rule"])


if __name__ == "__main__":
    unittest.main()

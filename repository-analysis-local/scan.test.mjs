import assert from "node:assert/strict";
import test from "node:test";
import { command, scannerEnvironment, selectTool } from "./scan.mjs";
import { validateReport } from "./reports.mjs";
import { selectAnalysis } from "../repository-analysis-context/policy.mjs";

const context = selectAnalysis({
  version: "repository-analysis-v1",
  languages: ["actions", "php", "python", "powershell", "shell", "terraform"], sonar: false,
}, {
  id: 123, full_name: "fixture/sandbox", visibility: "private", private: true,
  archived: false, fork: false, owner: { type: "User" },
}, "fixture/sandbox");

test("only a selected local analyzer and an intact policy context can execute", () => {
  assert.deepEqual(selectTool(context, "bandit"), { tool: "bandit", languages: ["python"] });
  assert.throws(() => selectTool(context, "codeql"), /supported local/);
  assert.throws(() => selectTool({ ...context, visibility: "public" }, "bandit"), /digest/);
  assert.throws(() => selectTool({ ...context, localTools: [] }, "bandit"), /not selected/);
});

test("scanner processes inherit neither credentials nor provider publishing settings", () => {
  const safe = scannerEnvironment({
    PATH: "/trusted/bin", HOME: "/original", GH_TOKEN: "secret", SONAR_TOKEN: "secret",
    BC_API_KEY: "secret", SEMGREP_APP_TOKEN: "secret", ACTIONS_RUNTIME_TOKEN: "secret",
    ZIZMOR_GITHUB_TOKEN: "secret", PYTHONPATH: "/target-controlled",
  }, "/isolated");
  assert.equal(safe.PATH, "/trusted/bin");
  assert.equal(safe.HOME, "/isolated");
  assert.equal(safe.SEMGREP_SEND_METRICS, "off");
  assert.equal(safe.ZIZMOR_OFFLINE, "1");
  assert.doesNotMatch(JSON.stringify(safe), /secret|target-controlled/);
});

test("commands force offline/local behavior without autofix or cloud execution", () => {
  const commands = [
    command("zizmor", "1", ["ci.yml"], [], {}),
    command("semgrep-ce", "1", ["main.php"], ["rules.yaml"], {}),
    command("checkov", "1", ["main.tf"], [], { languages: ["terraform"] }),
  ];
  assert.ok(commands[0][1].includes("--offline"));
  assert.ok(commands[0][1].includes("--strict-collection"));
  assert.ok(commands[1][1].includes("--metrics=off"));
  assert.ok(commands[1][1].includes("--disable-version-check"));
  assert.ok(commands[2][1].includes("--skip-download"));
  assert.doesNotMatch(JSON.stringify(commands), /autofix|semgrep ci|bc-api-key/);
});

test("missing, malformed, parsing-error and incomplete source reports cannot become clean", () => {
  for (const tool of ["zizmor", "semgrep-ce", "checkov", "bandit", "shellcheck", "psscriptanalyzer"]) {
    assert.throws(() => validateReport(tool, {}, "1", ["source"]));
    assert.throws(() => validateReport(tool, {}, "1", []), /source coverage/);
  }
  assert.throws(() => validateReport("semgrep-ce", {
    version: "1", errors: [], results: [], paths: { scanned: [] },
  }, "1", ["main.php"]), /every selected/);
  assert.throws(() => validateReport("bandit", { errors: ["parse"], metrics: {}, results: [] },
    "1", ["main.py"]), /prevents complete/);
  assert.throws(() => validateReport("shellcheck", { comments: [{ code: 1072 }] },
    "1", ["main.sh"]), /parsing errors/);
});

test("completed zero findings remain distinguishable from incomplete results", () => {
  assert.deepEqual(validateReport("semgrep-ce", {
    version: "1", errors: [], results: [], paths: { scanned: ["main.php"] },
  }, "1", ["main.php"]), []);
  assert.deepEqual(validateReport("bandit", {
    errors: [], results: [], metrics: { "main.py": { loc: 1 } },
  }, "1", ["main.py"]), []);
  assert.deepEqual(validateReport("shellcheck", { comments: [] }, "1", ["main.sh"]), []);
  assert.deepEqual(validateReport("psscriptanalyzer", {
    version: "1", errors: [], results: [], scanned: ["main.ps1"],
  }, "1", ["main.ps1"]), []);
});

test("Checkov consistency and real policy evaluation are mandatory", () => {
  const report = {
    check_type: "terraform", summary: { passed: 1, failed: 1, skipped: 0, parsing_errors: 0 },
    results: { passed_checks: [{}], failed_checks: [{ check_id: "fixture" }], skipped_checks: [], parsing_errors: [] },
  };
  assert.equal(validateReport("checkov", report, "1", ["main.tf"]).length, 1);
  assert.throws(() => validateReport("checkov", { ...report, summary: { ...report.summary, failed: 0 } },
    "1", ["main.tf"]), /Inconsistent/);
  assert.throws(() => validateReport("checkov", { ...report, summary: { ...report.summary, parsing_errors: 1 } },
    "1", ["main.tf"]), /parsing errors/);
  assert.throws(() => validateReport("checkov", report, "1", ["main.tf", "Dockerfile"],
    ["terraform", "dockerfile"]), /every selected framework/);
});

test("native SARIF failures do not pass even when they contain an empty result list", () => {
  const report = { version: "2.1.0", runs: [{
    tool: { driver: { name: "zizmor" } }, results: [],
  }] };
  assert.deepEqual(validateReport("zizmor", report, "1", ["ci.yml"]), []);
  assert.throws(() => validateReport("zizmor", {
    ...report, runs: [{ ...report.runs[0], invocations: [{ executionSuccessful: false }] }],
  }, "1", ["ci.yml"]), /Incomplete/);
});

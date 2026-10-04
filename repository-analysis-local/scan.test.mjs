import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkovFrameworks, command, copySource, scannerEnvironment, selectTool } from "./scan.mjs";
import { validateReport } from "./reports.mjs";
import { selectAnalysis } from "../repository-analysis-context/policy.mjs";

const context = selectAnalysis({
  version: "repository-analysis-v1",
  languages: ["actions", "php", "python", "powershell", "shell", "terraform"], sonar: false,
}, {
  id: 123, full_name: "fixture/sandbox", visibility: "private", private: true,
  archived: false, fork: false, owner: { type: "User" },
}, "fixture/sandbox");

test("tracked Terraform JSON and supported extensionless scripts enter the real source snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "analysis-source-test-"));
  const destination = path.join(root, "snapshot");
  const fixtures = [
    ["main.tf.json", '{"resource":{}}', ["terraform"]],
    ["config.tfvars.json", '{"fixture":true}', ["terraform"]],
    ["operations/health", "#!/bin/sh\necho fixture\n", ["shell"]],
    ["verify", "#!/usr/bin/env python3\nprint('fixture')\n", ["python"]],
    ["tools/validate", "#!/usr/bin/env node\nconsole.log('fixture');\n", ["javascript"]],
    ["maintenance/check", "#!/usr/bin/env php\n<?php echo 'fixture';\n", ["php"]],
    ["automation/check", "#!/usr/bin/env pwsh\nWrite-Output 'fixture'\n", ["powershell"]],
    ["README", "This is not an executable script.\n", []],
    ["vendor/verify", "#!/bin/sh\necho excluded\n", []],
    ["node_modules/check", "#!/bin/sh\necho excluded\n", []],
  ];
  const languages = ["terraform", "shell", "python", "javascript", "php", "powershell"];
  try {
    for (const [filename, content, expected] of fixtures) {
      await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
      await writeFile(path.join(root, filename), content);
      assert.deepEqual(await copySource(root, destination, filename, languages), expected, filename);
      if (expected.length) assert.equal(await readFile(path.join(destination, filename), "utf8"), content);
      else await assert.rejects(readFile(path.join(destination, filename)), { code: "ENOENT" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Terraform JSON selects its native Checkov runner and cannot pass without that framework", () => {
  assert.deepEqual(checkovFrameworks(["terraform"], ["main.tf.json"]), ["terraform_json"]);
  assert.deepEqual(checkovFrameworks(["terraform", "bicep"], ["main.tf", "main.tf.json", "main.bicep"]),
    ["terraform", "terraform_json", "bicep"]);
  assert.deepEqual(checkovFrameworks(["terraform"], ["main.tfvars.json"]), ["terraform"]);
  const args = command("checkov", "1", ["main.tf.json"], [], { languages: ["terraform"] })[1];
  assert.ok(args.includes("terraform_json"));
  assert.ok(!args.includes("terraform"));
  const report = {
    check_type: "terraform", summary: { passed: 1, failed: 0, skipped: 0, parsing_errors: 0 },
    results: { passed_checks: [{}], failed_checks: [], skipped_checks: [], parsing_errors: [] },
  };
  assert.throws(() => validateReport("checkov", report, "1", ["main.tf.json"], ["terraform_json"]),
    /every selected framework/);
});

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
  assert.throws(() => validateReport("psscriptanalyzer", {
    version: "1", errors: [], results: [], scanned: ["other.ps1"],
  }, "1", ["main.ps1"]), /coverage is incomplete/);
  assert.throws(() => validateReport("psscriptanalyzer", {
    version: "1", errors: [], results: [], scanned: ["main.ps1", "main.ps1"],
  }, "1", ["main.ps1", "automation/check"]), /coverage is incomplete/);
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

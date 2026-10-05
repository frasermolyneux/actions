import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { batchFiles, checkovFrameworks, command, copySource, engineDigest, ownedSourceFiles, scanGroups, scannerEnvironment, selectTool } from "./scan.mjs";
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
    ["packages/app/src/main.mts", "export const fixture = true;\n", ["typescript"]],
    ["packages/app/src/main.cts", "export const fixture = true;\n", ["typescript"]],
    ["include/main.hh", "void fixture();\n", ["cpp"]],
    ["include/main.hxx", "void fixture();\n", ["cpp"]],
    ["operations/check.bash", "#!/bin/bash\necho fixture\n", ["shell"]],
    ["operations/check.dash", "#!/bin/dash\necho fixture\n", ["shell"]],
    ["operations/check.ksh", "#!/bin/ksh\necho fixture\n", ["shell"]],
    ["README", "This is not an executable script.\n", []],
    ["vendor/verify", "#!/bin/sh\necho excluded\n", []],
    ["node_modules/check", "#!/bin/sh\necho excluded\n", []],
    ["wwwroot/lib/app/main.mts", "export const excluded = true;\n", []],
    ["src/site/wwwroot/lib/app/main.cts", "export const excluded = true;\n", []],
  ];
  const languages = ["terraform", "shell", "python", "javascript", "typescript", "cpp", "php", "powershell"];
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
  for (const variables of ["terraform.tfvars", "terraform.tfvars.json"]) {
    assert.throws(() => checkovFrameworks(["terraform"], ["json/main.tf.json", `json/${variables}`]),
      /cannot bind Terraform JSON variable files/);
  }
  assert.deepEqual(checkovFrameworks(["terraform"], ["main.tf", "terraform.tfvars", "json/main.tf.json"]),
    ["terraform", "terraform_json"]);
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

test("source inventory excludes gitlinks but rejects selected symlinks and malformed index records", () => {
  const sha = "a".repeat(40);
  const record = (mode, filename, stage = 0) => `${mode} ${sha} ${stage}\t${filename}\0`;
  const index = record("100644", "main.py") + record("100755", "operations/health") +
    record("160000", "uninitialized-dependency") + record("160000", "external.py") +
    record("100644", "scripts/tab\tname.py") + record("100644", "scripts/new\nline.py") +
    record("100644", "vendor/excluded.py") + record("120000", "docs/reference.txt");
  assert.deepEqual(ownedSourceFiles(index, ["python", "shell"]),
    ["main.py", "operations/health", "scripts/tab\tname.py", "scripts/new\nline.py"]);
  assert.throws(() => ownedSourceFiles(record("120000", "linked.py"), ["python"]), /not links/);
  assert.throws(() => ownedSourceFiles(record("100644", "main.py", 2), ["python"]), /unmerged/);
  assert.throws(() => ownedSourceFiles("invalid\0", ["python"]), /malformed/);
});

test("only a selected local analyzer and an intact policy context can execute", () => {
  assert.deepEqual(selectTool(context, "bandit"), { tool: "bandit", languages: ["python"] });
  assert.throws(() => selectTool(context, "codeql"), /supported local/);
  assert.throws(() => selectTool({ ...context, visibility: "public" }, "bandit"), /digest/);
  assert.throws(() => selectTool({ ...context, localTools: [] }, "bandit"), /not selected/);
  const legacyCpp = { ...context, localTools: [{ tool: "semgrep-ce", languages: ["cpp"] }] };
  assert.throws(() => selectTool(legacyCpp, "semgrep-ce"), /Local C\+\+ analysis is unavailable/);
});

test("Semgrep files and rules are scoped to one selected language at a time", () => {
  const selected = { tool: "semgrep-ce", languages: ["csharp", "typescript"] };
  const inventory = {
    files: ["Main.cs", "main.cts", "packages/app/src/main.mts"],
    languageFiles: { csharp: ["Main.cs"], typescript: ["main.cts", "packages/app/src/main.mts"] },
  };
  assert.deepEqual(scanGroups("semgrep-ce", selected, inventory), [
    { selected: { tool: "semgrep-ce", languages: ["csharp"] }, files: ["Main.cs"] },
    { selected: { tool: "semgrep-ce", languages: ["typescript"] }, files: ["main.cts", "packages/app/src/main.mts"] },
  ]);
  const reports = [
    { version: "1", errors: [], results: [], paths: { scanned: ["Main.cs"] } },
    { version: "1", errors: [], results: [{ path: "main.cts" }], paths: { scanned: inventory.languageFiles.typescript } },
  ];
  assert.equal(validateReport("semgrep-ce", reports, "1", inventory.files).length, 1);
  assert.throws(() => validateReport("semgrep-ce", reports.slice(0, 1), "1", inventory.files), /every selected source file/);
  assert.throws(() => validateReport("semgrep-ce", [
    reports[0], { ...reports[1], errors: ["partial parse"] },
  ], "1", inventory.files), /Semgrep errors/);
});

test("tracked filenames cannot inject options into positional-input analyzers", () => {
  for (const tool of ["zizmor", "semgrep-ce", "bandit", "shellcheck"]) {
    const args = command(tool, "1", ["--exclude=SC2086"], ["rules.yaml"], {})[1];
    assert.equal(args[args.indexOf("--") + 1], "--exclude=SC2086");
  }
});

test("Bandit cannot silently exclude selected GitHub automation through its .git substring default", () => {
  const files = [".github/scripts/fixture.py", "src/main.py"];
  const args = command("bandit", "1", files, [], {})[1];
  assert.equal(args[args.indexOf("--exclude") + 1], "");
  assert.deepEqual(args.slice(args.indexOf("--") + 1), files);
  assert.throws(() => validateReport("bandit", {
    errors: [], results: [], metrics: { _totals: { loc: 0 } },
  }, "1", files), /every selected source file/);
});

test("argument batches cover every input within a byte bound, including rule options", () => {
  const files = Array.from({ length: 6000 }, (_, index) => `packages/app-${index}/src/${"x".repeat(100)}.ts`);
  const base = command("semgrep-ce", "1", [], ["rules.yaml"], {});
  const batches = batchFiles(base, files);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), files);
  for (const batch of batches) {
    const args = command("semgrep-ce", "1", batch, ["rules.yaml"], {}).flat();
    assert.ok(args.reduce((bytes, value) => bytes + Buffer.byteLength(value) + 1, 0) <= 128 * 1024);
  }
  assert.throws(() => batchFiles(["tool", ["x".repeat(128 * 1024)]], ["file"]), /options exceed/);
  assert.throws(() => batchFiles(["tool", []], ["x".repeat(128 * 1024)]), /Source path exceeds/);
});

test("engine identity hashes a filename and length delimited manifest including the composite", async () => {
  const manifest = await Promise.all(["action.yml", "scan.mjs", "reports.mjs", "sarif.mjs", "tools.json", "powershell-scan.ps1",
    "../repository-analysis-context/action.yml", "../repository-analysis-context/policy.mjs"]
    .map(async (filename) => {
      const content = await readFile(new URL(filename, import.meta.url));
      return { filename, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
    }));
  const expected = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  assert.equal(await engineDigest(), expected);
  assert.notEqual(await engineDigest(), createHash("sha256").update(JSON.stringify(manifest.slice(1))).digest("hex"));
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
    tool: { driver: { name: "zizmor" } }, results: [], invocations: [{ executionSuccessful: true }],
  }] };
  assert.deepEqual(validateReport("zizmor", report, "1", ["ci.yml"]), []);
  assert.throws(() => validateReport("zizmor", {
    ...report, runs: [{ ...report.runs[0], invocations: [{ executionSuccessful: false }] }],
  }, "1", ["ci.yml"]), /Incomplete/);
});

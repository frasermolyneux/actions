import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { install, scan } from "./scan.mjs";
import { selectAnalysis } from "../repository-analysis-context/policy.mjs";

const tool = process.argv[2];
const root = await mkdtemp(path.join(process.env.RUNNER_TEMP, "local-scan-fixture-"));
const files = {
  ".github/workflows/ci.yml": "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo \"${{ github.event.pull_request.title }}\"\n",
  "main.php": "<?php\nfunction run_command($value) { return shell_exec($value); }\n",
  "main.js": "export function run(value) { return eval(value); }\n",
  "main.ts": "export function run(value: string) { return eval(value); }\n",
  "Main.cs": "using System.Diagnostics;\nclass Fixture {\n public static void Run(string value) { Process.Start(value); }\n}\n",
  "main.py": "import subprocess\n\ndef run_command(value):\n    return subprocess.run(value, shell=True)\n",
  "main.ps1": "Write-Host 'fixture'\n",
  "automation/check": "#!/usr/bin/env pwsh\nWrite-Host 'extensionless fixture'\n",
  "operations/health": "#!/bin/sh\necho $FIXTURE_VALUE\n",
  "main.tf": "resource \"azurerm_storage_account\" \"fixture\" {\n  name = \"fixture\"\n  resource_group_name = \"fixture\"\n  location = \"uksouth\"\n  account_tier = \"Standard\"\n  account_replication_type = \"LRS\"\n  min_tls_version = \"TLS1_0\"\n}\n",
  "json/main.tf.json": JSON.stringify({ resource: { azurerm_storage_account: { fixture: {
    name: "jsonfixture", resource_group_name: "fixture", location: "uksouth",
    account_tier: "Standard", account_replication_type: "LRS", min_tls_version: "TLS1_0",
  } } } }),
  "Dockerfile": "FROM alpine:3.23\nRUN echo fixture\n",
  "main.bicep": "param location string = resourceGroup().location\nresource fixture 'Microsoft.Storage/storageAccounts@2023-05-01' = {\n  name: 'fixturestorage'\n  location: location\n  kind: 'StorageV2'\n  sku: { name: 'Standard_LRS' }\n  properties: { supportsHttpsTrafficOnly: false }\n}\n",
  "roles/fixture/tasks/main.yml": "- name: Install a fixture package\n  yum:\n    name: fixture\n    state: present\n    validate_certs: false\n",
  "ansible/playbook.yml": "- name: Fixture playbook\n  hosts: all\n  tasks:\n    - name: Install a fixture package\n      yum:\n        name: fixture\n        state: present\n        validate_certs: false\n",
};
await Promise.all(Object.entries(files).map(async ([filename, content]) => {
  const destination = path.join(root, filename);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
}));
execFileSync("/usr/bin/git", ["init", "--quiet", root]);
execFileSync("/usr/bin/git", ["-C", root, "add", "."]);
execFileSync("/usr/bin/git", ["-C", root, "-c", "user.name=Scanner Fixture", "-c", "user.email=fixture@example.invalid",
  "commit", "--quiet", "-m", "Scanner fixtures"]);
const sha = execFileSync("/usr/bin/git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const context = selectAnalysis({
  version: "repository-analysis-v1",
  languages: ["actions", "csharp", "javascript", "typescript", "php", "python", "powershell",
    "shell", "terraform", "bicep", "dockerfile", "ansible"],
  sonar: false,
}, {
  id: 123, full_name: "fixture/sandbox", visibility: "private", private: true,
  archived: false, fork: false, owner: { type: "User" },
}, "fixture/sandbox");
const environment = {
  ...process.env, GITHUB_WORKSPACE: root, GITHUB_REPOSITORY: "fixture/sandbox", GITHUB_REPOSITORY_ID: "123",
  ANALYSIS_CONTEXT: JSON.stringify(context), ANALYSIS_TOOL: tool, ANALYSIS_EXPECTED_SHA: sha,
  GITHUB_OUTPUT: path.join(root, "outputs"), GITHUB_STEP_SUMMARY: path.join(root, "summary"),
  GH_TOKEN: "fixture-credential-must-never-reach-scanners",
};
const installed = await install(environment);
let report;
try {
  report = await scan({
  ...environment,
  PATH: installed.bin ? installed.bin + path.delimiter + process.env.PATH : process.env.PATH,
  ANALYSIS_RULES: installed.rules, ANALYSIS_PS_MODULE_ROOT: installed.modules,
  ANALYSIS_SCANNER_BIN: installed.bin,
  });
} catch (error) {
  const output = await readFile(environment.GITHUB_OUTPUT, "utf8");
  const diagnostics = output.split("\n").find((line) => line.startsWith("diagnostic-directory="));
  if (diagnostics) {
    const location = diagnostics.slice("diagnostic-directory=".length);
    console.error(await readFile(path.join(location, "execution.json"), "utf8"));
    console.error(await readFile(path.join(location, "stdout.txt"), "utf8"));
    console.error(await readFile(path.join(location, "stderr.txt"), "utf8"));
  }
  throw error;
}
assert.equal(report.status, "completed");
assert.equal(report.sourceSha, sha);
assert.equal(report.visibility, "private");
assert.ok(Object.values(report.sourceCoverage).every((count) => count > 0));
assert.ok(report.findingCount > 0, "The deliberately insecure fixture must produce a real finding");
const outputs = await readFile(environment.GITHUB_OUTPUT, "utf8");
const result = outputs.split("\n").find((line) => line.startsWith("report-directory="));
const native = JSON.parse(await readFile(path.join(result.slice("report-directory=".length), "native.json"), "utf8"));
if (tool === "checkov") {
  assert.ok(native.every((entry) => entry.summary.failed > 0), "Each IaC framework fixture must detect a real finding");
}
if (tool === "psscriptanalyzer") {
  assert.ok(native.results.some((entry) => entry.ScriptPath.endsWith("/automation/check")),
    "The extensionless PowerShell fixture must actually be analyzed");
}
assert.doesNotMatch(JSON.stringify(report), /fixture-credential/);
assert.doesNotMatch(await readFile(environment.GITHUB_STEP_SUMMARY, "utf8"), /fixture-credential/);
console.log(JSON.stringify({ tool, fixture: true, sourceCoverage: report.sourceCoverage, findings: report.findingCount }));

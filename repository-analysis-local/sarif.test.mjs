import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { toSarif } from "./sarif.mjs";

const root = path.resolve("actual-source");
const version = "1.2.3";
const uri = "src/a%20%25%23%09%0A.py";
const file = "src/a %#\t\n.py";
const rule = { id: "real-rule" };
const location = (filename = file) => ({ physicalLocation: {
  artifactLocation: { uri: filename.split("/").map(encodeURIComponent).join("/") },
  region: { startLine: 2, endLine: 3 },
} });
const finding = {
  ruleId: rule.id, ruleIndex: 0, message: { text: "Actual native message" },
  level: "warning", locations: [location()],
};
const fixtures = {
  zizmor: { version: "2.1.0", runs: [{
    tool: { driver: { name: "zizmor", version, rules: [rule] } },
    results: [finding], invocations: [{ executionSuccessful: true }],
  }] },
  "semgrep-ce": {
    version, errors: [], paths: { scanned: [file] },
    results: [{ check_id: rule.id, path: file, start: { line: 2, col: 1 }, end: { line: 3, col: 2 },
      extra: { message: "Actual native message", severity: "WARNING" } }],
  },
  checkov: {
    check_type: "terraform", summary: { passed: 0, failed: 1, skipped: 0, parsing_errors: 0 },
    results: { passed_checks: [], skipped_checks: [], parsing_errors: [], failed_checks: [{
      check_id: rule.id, check_name: "Actual native message", file_path: `/${file}`, file_line_range: [2, 3],
    }] },
  },
  bandit: { errors: [], metrics: { [file]: { loc: 3 } }, results: [{
    test_id: rule.id, filename: `./${file}`, issue_text: "Actual native message", issue_severity: "HIGH", line_number: 2,
  }] },
  shellcheck: { comments: [{
    code: 2086, file, message: "Actual native message", level: "info",
    line: 2, endLine: 3, column: 1, endColumn: 2,
  }] },
  psscriptanalyzer: { version, errors: [], scanned: [file], results: [{
    RuleName: rule.id, ScriptPath: path.join(root, file), Message: "Actual native message",
    Severity: "Warning", Line: 2, Column: 1,
  }] },
};
function convert(tool, report = fixtures[tool], files = [file], executions) {
  return toSarif(tool, report, version, executions ?? [{ files, frameworks: ["terraform"] }], root);
}

for (const tool of Object.keys(fixtures)) {
  test(`${tool} retains actual finding, message, version and source identity`, () => {
    const converted = convert(tool);
    assert.equal(converted.version, "2.1.0");
    assert.equal(converted.runs.length, 1);
    const run = converted.runs[0];
    assert.equal(run.tool.driver.version, version);
    assert.equal(run.automationDetails.id, `/tool:${tool}/`);
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].message.text, "Actual native message");
    assert.equal(run.results[0].ruleId, tool === "shellcheck" ? "SC2086" : rule.id);
    assert.equal(run.results[0].locations[0].physicalLocation.artifactLocation.uri, uri);
    assert.equal(run.results[0].locations[0].physicalLocation.region.startLine, 2);
    assert.equal(run.invocations[0].executionSuccessful, true);
  });
  test(`${tool} cannot convert incomplete execution or an unanalysed finding`, () => {
    assert.throws(() => convert(tool, {}));
    const report = structuredClone(fixtures[tool]);
    if (tool === "zizmor") report.runs[0].results[0].locations = [location("not-scanned.py")];
    if (tool === "semgrep-ce") report.results[0].path = "not-scanned.py";
    if (tool === "checkov") report.results.failed_checks[0].file_path = "/not-scanned.py";
    if (tool === "bandit") report.results[0].filename = "not-scanned.py";
    if (tool === "shellcheck") report.comments[0].file = "not-scanned.py";
    if (tool === "psscriptanalyzer") report.results[0].ScriptPath = path.join(root, "not-scanned.py");
    assert.throws(() => convert(tool, report), /outside the actual analyzed source/);
  });
}

test("all absolute paths bind to the actual root, and Checkov's root-relative convention remains explicit", () => {
  for (const value of [path.join(root, file), pathToFileURL(path.join(root, file)).href]) {
    const report = structuredClone(fixtures.bandit);
    report.results[0].filename = value;
    assert.equal(convert("bandit", report).runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, uri);
  }
  const report = structuredClone(fixtures.bandit);
  report.results[0].filename = path.resolve("outside", file);
  assert.throws(() => convert("bandit", report), /outside the actual/);
  report.results[0].filename = `/${file}`;
  assert.throws(() => convert("bandit", report), /outside the actual/);
});

test("valid file-level diagnostics do not fabricate line one", () => {
  const report = structuredClone(fixtures.psscriptanalyzer);
  report.results[0].Line = 0;
  report.results[0].Column = 0;
  const physical = convert("psscriptanalyzer", report).runs[0].results[0].locations[0].physicalLocation;
  assert.equal(physical.region, undefined);
});

test("actual PowerShell numeric diagnostic severity retains its original enum value", () => {
  for (const [severity, level] of [[0, "note"], [1, "warning"], [2, "error"]]) {
    const report = structuredClone(fixtures.psscriptanalyzer);
    report.results[0].Severity = severity;
    const result = convert("psscriptanalyzer", report).runs[0].results[0];
    assert.equal(result.level, level);
    assert.equal(result.properties.originalSeverity, severity);
  }
  for (const severity of [3, -1, 0.5, 4]) {
    const report = structuredClone(fixtures.psscriptanalyzer);
    report.results[0].Severity = severity;
    assert.throws(() => convert("psscriptanalyzer", report), /PowerShell parsing error or unknown/);
  }
});

test("invalid ranges and missing native identity fail without dropping a finding", () => {
  for (const patch of [
    { start: { line: -1 } }, { end: { line: 1 } }, { start: { line: 2, col: 0 } },
    { start: { line: 2, col: 5 }, end: { line: 2, col: 4 } },
    { check_id: "" }, { extra: { message: "" } },
  ]) {
    const report = structuredClone(fixtures["semgrep-ce"]);
    Object.assign(report.results[0], patch);
    assert.throws(() => convert("semgrep-ce", report), /invalid|lacks its actual/);
  }
});

test("zero findings still require valid completed native source coverage", () => {
  const report = structuredClone(fixtures["semgrep-ce"]);
  report.results = [];
  assert.deepEqual(convert("semgrep-ce", report).runs[0].results, []);
  report.paths.scanned = [];
  assert.throws(() => convert("semgrep-ce", report), /every selected/);
});

test("Checkov framework collections and multiple Semgrep executions preserve every finding", () => {
  assert.equal(convert("checkov", [fixtures.checkov, fixtures.checkov]).runs[0].results.length, 2);
  const report = fixtures["semgrep-ce"];
  assert.equal(convert("semgrep-ce", [report, report], [file], [
    { files: [file] }, { files: [file] },
  ]).runs[0].results.length, 2);
  assert.throws(() => convert("semgrep-ce", [report, report]), /do not match/);
});

test("native zizmor batches merge rule tables without stale indices or losing related locations", () => {
  const second = structuredClone(fixtures.zizmor);
  second.runs[0].tool.driver.rules = [{ id: "other-rule" }, structuredClone(rule)];
  second.runs[0].results[0].ruleIndex = 1;
  second.runs[0].results[0].relatedLocations = [{ id: 1, ...location() }];
  second.runs[0].results[0].codeFlows = [{ threadFlows: [{ locations: [{ location: location() }] }] }];
  const run = convert("zizmor", [fixtures.zizmor, second], [file], [{ files: [file] }, { files: [file] }]).runs[0];
  assert.equal(run.results.length, 2);
  assert.equal(run.tool.driver.rules.length, 2);
  assert.ok(run.results.every((result) => result.ruleIndex === undefined));
  assert.equal(run.results[1].relatedLocations[0].physicalLocation.artifactLocation.uri, uri);
  assert.equal(run.results[1].codeFlows[0].threadFlows[0].locations[0].location.physicalLocation.artifactLocation.uri, uri);
  second.runs[0].tool.driver.rules[1].name = "changed";
  assert.throws(() => convert("zizmor", [fixtures.zizmor, second], [file], [{ files: [file] }, { files: [file] }]),
    /disagree on rule/);
});

test("native zizmor cannot bind a batch result to a different batch's source", () => {
  const second = structuredClone(fixtures.zizmor);
  assert.throws(() => convert("zizmor", [fixtures.zizmor, second], [file], [
    { files: [file] }, { files: ["other.yml"] },
  ]), /outside the actual/);
});

test("zizmor preserves actual successful native invocations and never fabricates missing completion", () => {
  for (const invocations of [undefined, [], [{}], [{ executionSuccessful: false }],
    [{ executionSuccessful: true }, {}]]) {
    const report = structuredClone(fixtures.zizmor);
    if (invocations === undefined) delete report.runs[0].invocations;
    else report.runs[0].invocations = invocations;
    assert.throws(() => convert("zizmor", report), /invocation/i);
  }
  const first = structuredClone(fixtures.zizmor);
  first.runs[0].invocations[0].startTimeUtc = "2026-01-01T00:00:00Z";
  const second = structuredClone(fixtures.zizmor);
  second.runs[0].invocations[0].startTimeUtc = "2026-01-01T00:01:00Z";
  const actual = convert("zizmor", [first, second], [file], [{ files: [file] }, { files: [file] }]);
  assert.deepEqual(actual.runs[0].invocations, [
    ...first.runs[0].invocations, ...second.runs[0].invocations,
  ]);
});

test("observed engine identity is mandatory and native driver mismatches are rejected", () => {
  assert.throws(() => toSarif("bandit", fixtures.bandit, "", [{ files: [file] }], root), /actual version/);
  const report = structuredClone(fixtures.zizmor);
  report.runs[0].tool.driver.version = "9.9.9";
  assert.throws(() => convert("zizmor", report), /driver identity/);
});

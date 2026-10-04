import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { selectAnalysis } from "../repository-analysis-context/policy.mjs";
import {
  aggregateStatus, assemble, assessFreshness, main, RESULT_LIMIT, selectedTools, validateResult, WEEK_MS,
} from "./state.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(64);
const START = "2026-10-04T01:00:00.000Z";
const END = "2026-10-04T02:00:00.000Z";
const clone = (value) => structuredClone(value);

function context(visibility = "public", languages = ["actions", "javascript", "terraform"], sonar = true, exemption) {
  return selectAnalysis({
    version: "repository-analysis-v1", languages, sonar, ...(exemption ? { exemption } : {}),
  }, {
    id: 123, full_name: "fixture/source", visibility, private: visibility === "private",
    owner: { type: "User" }, archived: false, fork: false,
  }, "fixture/source");
}

function bundle(policy = context()) {
  const tools = selectedTools(policy);
  const pins = tools.map(({ id }) => ({ id, version: "1.2.3", ruleRevision: A, engineDigest: D }));
  return {
    engine: { release: "repository-analysis/v1.0.0", sourceSha: C, digest: D },
    source: { checkoutSha: A, logicalHeadSha: A, baseSha: null, headRepositoryId: 123, pullRequest: null },
    run: { id: 456, attempt: 1, event: "push", workflowPath: ".github/workflows/codequality.yml",
      workflowSha: B, startedAt: START, completedAt: END },
    pins,
    results: tools.map((tool) => ({
      ...pins.find(({ id }) => id === tool.id), status: "completed", sourceSha: A,
      sourceCoverage: Object.fromEntries(tool.capabilities.map((language) => [language, 2])),
      findingCount: 0, processing: { status: tool.destination === "originating-repository-artifact"
        ? "not-applicable" : "completed", id: tool.destination === "originating-repository-artifact" ? null : "task-123" },
      publication: { destination: tool.destination, status: "completed",
        id: tool.destination === "originating-repository-artifact" ? null : "analysis-123" },
      completedAt: END,
    })),
    coverage: [{
      suite: "Unit", status: "unavailable", format: null, sourceSha: A, reports: [], lines: null, tests: null,
      analysisId: null, reason: "Fixture declares no existing coverage import",
    }],
    finishedHeadSha: A,
  };
}

function request(input = bundle()) {
  return { engine: input.engine, pins: input.pins, headSha: A, expectedSha: null, force: false };
}

function coverage() {
  return {
    suite: "Unit", status: "imported", format: "opencover", sourceSha: A,
    reports: [{ path: "coverage/unit/coverage.opencover.xml", sha256: D }],
    lines: { total: 20, covered: 10 },
    tests: { executed: 10, passed: 10, failed: 0, skipped: 2 }, analysisId: "analysis-123",
  };
}

test("completed means exact selected tools, source and publication, not zero findings", () => {
  const input = bundle();
  input.results[0].findingCount = 17;
  const result = assemble(context(), input);
  assert.equal(result.completeness.status, "completed");
  assert.equal(result.results[0].findingCount, 17);
  assert.deepEqual(validateResult(result), result);
});

test("missing tools remain explicit and cannot be forged clean with completion flags", () => {
  const input = bundle();
  const missing = input.results.pop().id;
  const result = assemble(context(), input);
  assert.equal(result.completeness.status, "incomplete");
  assert.deepEqual(result.completeness.missing, [missing]);
  result.completeness.status = "completed";
  assert.throws(() => validateResult(result), /completion flags/);
});

for (const status of ["failed", "pending", "unavailable"]) {
  test(`${status} tool state never becomes zero findings or a current result`, () => {
    const input = bundle();
    Object.assign(input.results[0], { status, findingCount: null, completedAt: null, reason: "Explicit native failure state" });
    const result = assemble(context(), input);
    assert.equal(result.completeness.status, "incomplete");
    assert.equal(assessFreshness(context(), request(input), result, Date.parse(END)).action, "scan");
    input.results[0].findingCount = 0;
    assert.throws(() => assemble(context(), input), /zero-finding fallback/);
  });
}

for (const [label, change, message] of [
  ["duplicate result", (value) => { value.results[1] = clone(value.results[0]); }, /duplicate result/],
  ["foreign result category", (value) => { value.results[0].id = "codeql/cpp"; }, /Unexpected/],
  ["foreign source", (value) => { value.results[0].sourceSha = B; }, /revision/],
  ["different rule revision", (value) => { value.results[0].ruleRevision = B; }, /scanner\/rule/],
  ["different engine", (value) => { value.results[0].engineDigest = "e".repeat(64); }, /scanner\/rule/],
  ["missing source capability", (value) => { value.results[0].sourceCoverage = {}; }, /nonempty coverage/],
  ["zero source", (value) => { value.results[0].sourceCoverage.actions = 0; }, /nonempty coverage/],
  ["unfinished SARIF", (value) => { value.results[0].processing.status = "pending"; }, /processing/],
  ["missing SARIF processing identity", (value) => { value.results[0].processing.id = null; }, /upload identity/],
  ["failed publication", (value) => { value.results[0].publication.status = "failed"; }, /publication/],
  ["missing native publication identity", (value) => { value.results[0].publication.id = null; }, /provider identity/],
  ["unexpected excerpt", (value) => { value.results[0].sourceExcerpt = "not allowed"; }, /Unsupported/],
  ["older tool result", (value) => { value.results[0].completedAt = "2026-10-03T02:00:00Z"; }, /outside this/],
  ["floating release", (value) => { value.engine.release = "repository-analysis/v1"; }, /immutable/],
  ["floating scanner version", (value) => { value.pins[0].version = "latest"; }, /tool\/rule/],
  ["floating rule revision", (value) => { value.pins[0].ruleRevision = "main"; }, /tool\/rule/],
  ["wrong default checkout", (value) => { value.source.checkoutSha = B; }, /actual and logical/],
  ["foreign default source repository", (value) => { value.source.headRepositoryId = 999; }, /different repository/],
  ["duplicate tool pin", (value) => { value.pins[1] = clone(value.pins[0]); }, /duplicate tool pin/],
]) {
  test(`rejects ${label}`, () => {
    const input = bundle();
    change(input);
    assert.throws(() => assemble(context(), input), message);
  });
}

test("private personal-account results use only permitted local tools and originating artifacts", () => {
  const policy = context("private", ["actions", "csharp", "python", "terraform"], false);
  const result = assemble(policy, bundle(policy));
  assert.equal(result.completeness.status, "completed");
  assert.ok(result.results.every((tool) => tool.id.startsWith("local/")));
  assert.ok(result.results.every((tool) => tool.publication.destination === "originating-repository-artifact"));
  assert.ok(result.context.limitations.some((limitation) => limitation.includes("not provide CodeQL")));
});

test("private publication cannot be replaced with GitHub Security or Sonar", () => {
  const policy = context("private", ["actions", "csharp"], false);
  const input = bundle(policy);
  input.results[0].publication.destination = "github-security";
  assert.throws(() => assemble(policy, input), /live visibility/);
  input.results[0].publication.destination = "sonar-public";
  assert.throws(() => assemble(policy, input), /live visibility/);
});

test("private artifact staging cannot claim a provider publication or processing identity", () => {
  const policy = context("private", ["actions", "csharp"], false);
  for (const field of ["publication", "processing"]) {
    const input = bundle(policy);
    input.results[0][field].id = "fabricated-provider-id";
    assert.throws(() => assemble(policy, input), /Artifact staging has no provider/);
  }
  const input = bundle(policy);
  input.results[0].processing.status = "completed";
  assert.throws(() => assemble(policy, input), /no server-side provider processing/);
});

test("incomplete tools and unavailable coverage require non-whitespace explanations", () => {
  for (const reason of ["", "   ", "\t\r\n"]) {
    const input = bundle();
    Object.assign(input.results[0], { status: "failed", findingCount: null, completedAt: null, reason });
    assert.throws(() => assemble(context(), input), /explicit reason/);
    const missingCoverage = bundle();
    missingCoverage.coverage[0].reason = reason;
    assert.throws(() => assemble(context(), missingCoverage), /Unavailable coverage/);
  }
});

test("private C++ unavailable coverage and requested unavailable Sonar remain incomplete", () => {
  for (const policy of [context("private", ["actions", "cpp"], false), context("private", ["actions", "javascript"], true)]) {
    const result = assemble(policy, bundle(policy));
    assert.equal(result.completeness.status, "incomplete");
    assert.ok(result.completeness.unavailable.length > 0);
  }
});

test("Sonar accepted upload without compute completion is not completed", () => {
  const input = bundle();
  input.results.find(({ id }) => id === "sonar").processing.status = "pending";
  assert.throws(() => assemble(context(), input), /compute task/);
});

for (const format of ["opencover", "vscoveragexml", "cobertura", "lcov", "gcov"]) {
  test(`actual ${format} import binds reports, tests, source and this Sonar analysis`, () => {
    const input = bundle();
    input.coverage = [{ ...coverage(), format }];
    assert.equal(assemble(context(), input).completeness.status, "completed");
  });
}

for (const [label, change] of [
  ["foreign revision", (entry) => { entry.sourceSha = B; }],
  ["foreign provider analysis", (entry) => { entry.analysisId = "foreign"; }],
  ["absent report", (entry) => { entry.reports = []; }],
  ["zero tests", (entry) => { entry.tests.executed = 0; entry.tests.passed = 0; }],
  ["failed tests", (entry) => { entry.tests.failed = 1; entry.tests.passed = 9; }],
  ["empty instrumentation", (entry) => { entry.lines.total = 0; }],
  ["invalid line counts", (entry) => { entry.lines.covered = 100; }],
  ["report traversal", (entry) => { entry.reports[0].path = "../coverage.xml"; }],
  ["Windows absolute report", (entry) => { entry.reports[0].path = "C:/coverage.xml"; }],
  ["lowercase Windows absolute report", (entry) => { entry.reports[0].path = "c:/coverage.xml"; }],
  ["Windows drive-relative report", (entry) => { entry.reports[0].path = "C:coverage.xml"; }],
  ["Windows backslash report", (entry) => { entry.reports[0].path = "C:\\coverage.xml"; }],
  ["UNC report", (entry) => { entry.reports[0].path = "//server/share/coverage.xml"; }],
  ["Windows alternate data stream", (entry) => { entry.reports[0].path = "coverage/report.xml:stream"; }],
  ["missing report hash", (entry) => { entry.reports[0].sha256 = ""; }],
]) {
  test(`coverage rejects ${label}`, () => {
    const input = bundle();
    const entry = coverage();
    change(entry);
    input.coverage = [entry];
    assert.throws(() => assemble(context(), input));
  });
}

test("failed coverage collection is an incomplete result, not unavailable successful coverage", () => {
  const input = bundle();
  input.coverage[0].status = "failed";
  assert.equal(assemble(context(), input).completeness.status, "incomplete");
});

test("active profiles cannot omit coverage instead of declaring the actual gap", () => {
  for (const policy of [context(), context("public", ["actions"], false), context("private", ["actions", "csharp"], false)]) {
    const input = bundle(policy);
    input.coverage = [];
    assert.throws(() => assemble(policy, input), /Explicit bounded coverage suite/);
    input.coverage = [{
      ...bundle(policy).coverage[0], status: "not-applicable", reason: "No existing supported coverage provider for this profile",
    }];
    assert.equal(assemble(policy, input).completeness.status, "completed");
  }
});

test("explicit applicability exemptions do not invent a test or coverage suite", () => {
  const policy = context("public", [], false, {
    kind: "documentation-only", reason: "No executable source", reevaluate: "Executable content is added",
  });
  const input = bundle(policy);
  input.coverage = [];
  assert.equal(assemble(policy, input).completeness.status, "not-applicable");
});

test("source supersession preserves actual checkout and historical findings", () => {
  const input = bundle();
  input.finishedHeadSha = B;
  const result = assemble(context(), input);
  assert.equal(result.completeness.status, "superseded");
  assert.equal(result.source.checkoutSha, A);
  assert.equal(assessFreshness(context(), request(input), result, Date.parse(END)).action, "scan");
});

test("PR merge-ref provenance remains separate and never supplies main freshness", () => {
  const input = bundle();
  input.source = { checkoutSha: A, logicalHeadSha: B, baseSha: C, headRepositoryId: 999, pullRequest: 12 };
  input.run.event = "pull_request";
  input.finishedHeadSha = B;
  const result = assemble(context(), input);
  assert.equal(result.completeness.status, "completed");
  assert.equal(assessFreshness(context(), request(input), result, Date.parse(END)).action, "scan");
});

test("weekly rescan fires at the exact seven-day threshold, not only after it", () => {
  const input = bundle();
  const result = assemble(context(), input);
  assert.equal(assessFreshness(context(), request(input), result, Date.parse(END) + WEEK_MS - 1).action, "current");
  assert.equal(assessFreshness(context(), request(input), result, Date.parse(END) + WEEK_MS).action, "scan");
});

test("expected revision mismatch cannot be bypassed by force", () => {
  assert.equal(assessFreshness(context(), { ...request(), expectedSha: B, force: true }, null).action, "superseded");
  assert.equal(assessFreshness(context(), { ...request(), expectedSha: A, force: true }, null).action, "scan");
});

test("no result and changed source require scanning", () => {
  const input = bundle();
  assert.equal(assessFreshness(context(), request(input), null).action, "scan");
  const result = assemble(context(), input);
  assert.equal(assessFreshness(context(), { ...request(input), headSha: B }, result, Date.parse(END)).action, "scan");
});

test("scanner, rule, engine and live visibility changes invalidate previous completion", () => {
  const input = bundle();
  const result = assemble(context(), input);
  for (const mutate of [
    (value) => { value.pins[0].version = "1.2.4"; },
    (value) => { value.pins[0].ruleRevision = B; },
    (value) => { value.engine.digest = "e".repeat(64); },
    (value) => { value.engine.sourceSha = B; },
  ]) {
    const current = request(clone(input));
    mutate(current);
    assert.equal(assessFreshness(context(), current, result, Date.parse(END)).action, "scan");
  }
  const privateContext = context("private", ["actions", "javascript", "terraform"], true);
  assert.equal(assessFreshness(privateContext, request(bundle(privateContext)), result, Date.parse(END)).action, "scan");
});

test("validated engine, pin and completion property order does not change freshness", () => {
  const input = bundle();
  const result = assemble(context(), input);
  const reverseFields = (value) => Object.fromEntries(Object.entries(value).reverse());
  const current = request(clone(input));
  current.engine = reverseFields(current.engine);
  current.pins = current.pins.reverse().map(reverseFields);
  result.engine = reverseFields(result.engine);
  result.pins = result.pins.map(reverseFields);
  result.completeness = reverseFields(result.completeness);
  assert.deepEqual(validateResult(result).completeness, assemble(context(), input).completeness);
  assert.equal(assessFreshness(context(), current, result, Date.parse(END)).action, "current");
  current.pins[0].version = "1.2.4";
  assert.equal(assessFreshness(context(), current, result, Date.parse(END)).action, "scan");
});

test("foreign results, impossible timestamps and malformed schemas fail explicitly", () => {
  const result = assemble(context(), bundle());
  const foreign = context();
  foreign.repositoryId = 789;
  assert.throws(() => assessFreshness(foreign, request(), result), /context digest/);
  const other = selectAnalysis(foreign.profile, {
    id: 789, full_name: "fixture/source", visibility: "public", private: false,
    owner: { type: "User" }, archived: false, fork: false,
  }, "fixture/source");
  assert.throws(() => assessFreshness(other, request(), result), /Foreign/);
  assert.throws(() => assessFreshness(context(), request(), result, Date.parse(START)), /future/);
  assert.throws(() => validateResult({ ...result, schema: "legacy" }), /schema/);
  const input = bundle();
  input.run.startedAt = "2026-02-30T01:00:00Z";
  assert.throws(() => assemble(context(), input), /timestamp/);
});

test("explicit empty exemption needs no fabricated source head or scanner", () => {
  const policy = context("public", [], false, { kind: "empty", reason: "No commits", reevaluate: "First executable content" });
  const current = { ...request(bundle(policy)), headSha: null };
  assert.equal(assessFreshness(policy, current, null).action, "not-applicable");
});

test("estate aggregates do not carry source excerpts, private findings or report paths", () => {
  const policy = context("private", ["actions", "csharp"], false);
  const status = aggregateStatus(assemble(policy, bundle(policy)));
  assert.deepEqual(Object.keys(status), ["repository", "visibility", "status", "selectedTools",
    "missingTools", "unavailableCapabilities", "completedAt"]);
  assert.equal(JSON.stringify(status).includes("findingCount"), false);
});

test("CLI validates actual run identity and emits an originating-only cold freshness decision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "analysis-state-test-"));
  try {
    const input = path.join(root, "input.json");
    const output = path.join(root, "output");
    const summary = path.join(root, "summary");
    const env = {
      RUNNER_TEMP: root, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
      GITHUB_REPOSITORY: "fixture/source", GITHUB_REPOSITORY_ID: "123",
      GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_NAME: "push",
      GITHUB_WORKFLOW_REF: "fixture/source/.github/workflows/codequality.yml@refs/heads/main", GITHUB_WORKFLOW_SHA: B,
      ANALYSIS_CONTEXT: JSON.stringify(context()), ANALYSIS_INPUT: input, ANALYSIS_MODE: "assess",
    };
    await writeFile(input, JSON.stringify({ request: request(), previous: null }));
    assert.equal((await main(env)).action, "scan");
    assert.match(await readFile(output, "utf8"), /status=scan/);
    await writeFile(input, JSON.stringify(bundle()));
    assert.equal((await main({ ...env, ANALYSIS_MODE: "assemble" })).completeness.status, "completed");
    await assert.rejects(main({ ...env, ANALYSIS_MODE: "assemble", GITHUB_RUN_ATTEMPT: "2" }), /different run/);
    await assert.rejects(main({ ...env, ANALYSIS_MODE: "assemble", GITHUB_WORKFLOW_SHA: C }), /workflow definition/);
    await writeFile(input, " ".repeat(RESULT_LIMIT + 1));
    await assert.rejects(main(env), /bounded regular-file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version height uses the action's repository-root filter", async () => {
  const version = JSON.parse(await readFile(new URL("./version.json", import.meta.url), "utf8"));
  assert.equal(version.inherit, false);
  assert.deepEqual(version.pathFilters, [":/repository-analysis-state"]);
});

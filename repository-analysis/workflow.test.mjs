import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { selectAnalysis } from "../repository-analysis-context/policy.mjs";
import { engineDigest } from "../repository-analysis-local/scan.mjs";
import {
  ARTIFACT_SCHEMA, WORKFLOW_PATH, RELEASE_PATHS, definitionFromRun, definitionDigest, main,
  validateEnvelope, validateProcessing, validateReport,
} from "./workflow.mjs";

const sourceSha = "a".repeat(40);
const definitionSha = "b".repeat(40);
const runtime = {
  repository: "fixture/repository", repositoryId: 123, runId: 456, attempt: 2,
  sourceSha, logicalHeadSha: "c".repeat(40), workflowSha: "d".repeat(40),
  definitionSha, workflowPath: ".github/workflows/analysis.yml", event: "pull_request",
};
const profile = { version: "repository-analysis-v1", languages: ["shell"], sonar: false };
function context(visibility = "private") {
  return selectAnalysis(profile, {
    id: 123, full_name: runtime.repository, visibility, private: visibility === "private",
    archived: false, fork: false, owner: { type: "User" },
  }, runtime.repository);
}
function run(reference = "refs/tags/repository-analysis/v1.0.0") {
  return {
    id: 456, run_attempt: 2, repository: { id: 123, full_name: runtime.repository },
    head_sha: runtime.logicalHeadSha, event: runtime.event, path: runtime.workflowPath,
    referenced_workflows: [{ path: `frasermolyneux/actions/${WORKFLOW_PATH}@${reference}`, sha: definitionSha }],
  };
}
function report(selected = context(), digest = "e".repeat(64)) {
  return {
    schema: "repository-analysis-local-v1", status: "completed", repository: runtime.repository,
    repositoryId: 123, visibility: selected.visibility, sourceSha, policyDigest: selected.policyDigest,
    tool: "shellcheck", toolVersion: "0.11.0", packageVersion: "0.11.0.1",
    engineDigest: digest, ruleRevision: "0.11.0.1", sourceCoverage: { shell: 1 }, findingCount: 0,
    publication: "originating-repository-artifact-only", completedAt: "2026-01-01T00:00:00.000Z",
  };
}
function sarif() {
  return { version: "2.1.0", runs: [{
    tool: { driver: { name: "ShellCheck", version: "0.11.0", rules: [] } },
    results: [], automationDetails: { id: "/tool:shellcheck/" },
    invocations: [{ executionSuccessful: true }],
  }] };
}
function envelope(selected = context()) {
  return {
    schema: ARTIFACT_SCHEMA, repository: runtime.repository, repositoryId: 123,
    visibility: selected.visibility, sourceSha, policyDigest: selected.policyDigest, tool: "shellcheck",
    definition: { path: WORKFLOW_PATH, sha: definitionSha, digest: "e".repeat(64) },
    run: { id: 456, attempt: 2, workflowPath: runtime.workflowPath, workflowSha: runtime.workflowSha,
      logicalHeadSha: runtime.logicalHeadSha, job: "local" },
    files: { "report.json": "f".repeat(64), "native.json": "f".repeat(64), "analysis.sarif": "f".repeat(64) },
    completedAt: report(selected).completedAt,
  };
}
function proof(selected = context("public")) {
  return {
    schema: "repository-analysis-sarif-proof-v1", repository: runtime.repository, repositoryId: 123,
    visibility: "public", policyDigest: selected.policyDigest, toolId: "local/shellcheck",
    sourceSha, run: { id: 456, attempt: 2, workflowPath: runtime.workflowPath,
      workflowSha: runtime.workflowSha, logicalHeadSha: runtime.logicalHeadSha, job: "publish-public" },
    processing: { status: "completed" }, publication: { destination: "github-security", status: "completed", id: "789" },
    tool: { name: "ShellCheck", version: "0.11.0" }, category: "/tool:shellcheck", findingCount: 0, ruleCount: 0,
  };
}

test("only one exact authenticated workflow definition can be selected", () => {
  assert.equal(definitionFromRun(run(), runtime), definitionSha);
  for (const patch of [
    { run_attempt: 1 }, { head_sha: sourceSha }, { id: 1 }, { path: ".github/workflows/other.yml" },
    { event: "pull_request_target" }, { repository: { id: 999, full_name: runtime.repository } },
    { referenced_workflows: [] }, { referenced_workflows: [...run().referenced_workflows, ...run().referenced_workflows] },
  ]) assert.throws(() => definitionFromRun({ ...run(), ...patch }, runtime));
  for (const ref of ["main", "refs/heads/main", "repository-analysis/v1", "repository-analysis/v1.0"]) {
    assert.throws(() => definitionFromRun(run(ref), runtime), /immutable release/);
  }
  const fixtureRuntime = { ...runtime, repository: "frasermolyneux/actions" };
  const fixtureRun = run("refs/pull/44/merge");
  fixtureRun.repository.full_name = fixtureRuntime.repository;
  assert.equal(definitionFromRun(fixtureRun, fixtureRuntime), definitionSha);
  fixtureRun.referenced_workflows[0].path = `frasermolyneux/actions/${WORKFLOW_PATH}@${definitionSha}`;
  fixtureRun.referenced_workflows[0].ref = "refs/pull/44/merge";
  assert.equal(definitionFromRun(fixtureRun, fixtureRuntime), definitionSha);
  fixtureRun.referenced_workflows[0].path = `third-party/actions/${WORKFLOW_PATH}@refs/pull/44/merge`;
  assert.throws(() => definitionFromRun(fixtureRun, fixtureRuntime), /Missing or ambiguous/);
});

test("engine/package identities are distinct and every selected source capability is positive", () => {
  validateReport(report(), sarif(), context(), "shellcheck", runtime, "e".repeat(64));
  for (const patch of [
    { status: "failed" }, { sourceSha: definitionSha }, { visibility: "public" }, { policyDigest: "f".repeat(64) },
    { toolVersion: "0.11.0.1" }, { packageVersion: "0.11.0" }, { ruleRevision: "wrong" },
    { engineDigest: "f".repeat(64) }, { sourceCoverage: { shell: 0 } },
    { sourceCoverage: { shell: 1, python: 1 } }, { findingCount: 1 }, { completedAt: "unknown" },
  ]) assert.throws(() => validateReport({ ...report(), ...patch }, sarif(), context(), "shellcheck", runtime, "e".repeat(64)));
  const incomplete = sarif();
  incomplete.runs[0].invocations[0].executionSuccessful = false;
  assert.throws(() => validateReport(report(), incomplete, context(), "shellcheck", runtime, "e".repeat(64)));
});

test("artifact binding requires exact attempt, logical head, caller and called definition, and all content hashes", () => {
  const original = envelope();
  validateEnvelope(original, report(), context(), "shellcheck", runtime, "e".repeat(64), original.files);
  for (const mutate of [
    (value) => { value.run.attempt = 1; },
    (value) => { value.run.logicalHeadSha = sourceSha; },
    (value) => { value.run.job = "target-owned-job"; },
    (value) => { value.run.workflowSha = sourceSha; },
    (value) => { value.definition.sha = sourceSha; },
    (value) => { value.definition.digest = "f".repeat(64); },
    (value) => { value.sourceSha = definitionSha; },
    (value) => { value.files["analysis.sarif"] = "0".repeat(64); },
    (value) => { delete value.files["native.json"]; },
    (value) => { value.policyDigest = "0".repeat(64); },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(() => validateEnvelope(changed, report(), context(), "shellcheck", runtime, "e".repeat(64), original.files));
  }
});

test("native completion must be an exact public selected-tool producer proof", () => {
  const selected = context("public");
  validateProcessing(proof(selected), report(selected), selected, "shellcheck", runtime);
  for (const mutate of [
    (value) => { value.processing.status = "pending"; },
    (value) => { value.run.attempt = 1; },
    (value) => { value.run.job = "local"; },
    (value) => { value.publication.destination = "artifact"; },
    (value) => { value.visibility = "private"; },
    (value) => { value.tool.version = "0.11.0.1"; },
    (value) => { value.toolId = "local/bandit"; },
    (value) => { value.category = "/tool:bandit"; },
    (value) => { value.sourceSha = definitionSha; },
  ]) {
    const changed = structuredClone(proof(selected));
    mutate(changed);
    assert.throws(() => validateProcessing(changed, report(selected), selected, "shellcheck", runtime));
  }
});

test("workflow release and digest cover actual executable source dependencies", async () => {
  assert.match(await definitionDigest(), /^[a-f0-9]{64}$/);
  const workflow = await readFile(new URL("../.github/workflows/repository-analysis-local.yml", import.meta.url), "utf8");
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /source-directory: source/);
  assert.match(workflow, /if: needs\.plan\.outputs\.has-tools == 'true' && needs\.plan\.outputs\.publish == 'true'/);
  const version = JSON.parse(await readFile(new URL("./version.json", import.meta.url), "utf8"));
  const release = await readFile(new URL("../.github/workflows/actions-versioning.yml", import.meta.url), "utf8");
  const pattern = release.match(/PATTERN='([^']+)'/)[1];
  for (const prefix of RELEASE_PATHS) {
    const filename = prefix.endsWith("/") ? `${prefix}action.yml` : prefix;
    assert.ok(version.pathFilters.some((filter) => filter.endsWith("/**")
      ? filename.startsWith(filter.slice(0, -2)) : filename === filter), filename);
    assert.ok(new RegExp(pattern).test(filename), filename);
  }
  assert.ok(!new RegExp(pattern).test(".github/workflows/codequality.yml"));
});

test("actual bootstrap rejects a mutable external definition before any checkout or execution", async () => {
  const workflow = await readFile(new URL("../.github/workflows/repository-analysis-local.yml", import.meta.url), "utf8");
  const source = workflow.replace(/\r\n/g, "\n").split("          script: |\n")[1].split("      - uses:")[0]
    .split("\n").map((line) => line.slice(12)).join("\n");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const bootstrap = new AsyncFunction("github", "context", "core", "process", source);
  const environment = { EXPECTED_SHA: sourceSha, GITHUB_REPOSITORY: runtime.repository, GITHUB_RUN_ATTEMPT: "2" };
  const current = {
    sha: sourceSha, eventName: "pull_request", runId: 456,
    repo: { owner: "fixture", repo: "repository" },
    payload: { pull_request: { head: { sha: runtime.logicalHeadSha } } },
  };
  const outputs = {};
  const core = { setOutput: (key, value) => { outputs[key] = value; } };
  await bootstrap({ request: async () => ({ data: run() }) }, current, core, { env: environment });
  assert.equal(outputs.sha, definitionSha);
  for (const ref of ["refs/heads/main", "main", "repository-analysis/v1"]) {
    await assert.rejects(bootstrap({ request: async () => ({ data: run(ref) }) },
      current, core, { env: environment }), /unreviewed mutable/);
  }
  await assert.rejects(bootstrap({}, current, core, { env: { ...environment, EXPECTED_SHA: definitionSha } }),
    /exact supported workflow source/);
});

async function fixture(callback, selected = context()) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "analysis-workflow-test-"));
  const evidence = path.join(temporary, "evidence");
  await mkdir(evidence);
  const env = {
    RUNNER_TEMP: temporary, GITHUB_OUTPUT: path.join(temporary, "outputs"),
    GITHUB_STEP_SUMMARY: path.join(temporary, "summary"), GITHUB_EVENT_PATH: path.join(temporary, "event.json"),
    GITHUB_REPOSITORY: runtime.repository, GITHUB_REPOSITORY_ID: "123",
    GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: sourceSha,
    GITHUB_WORKFLOW_REF: `${runtime.repository}/${runtime.workflowPath}@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: runtime.workflowSha, GITHUB_EVENT_NAME: "pull_request",
    GITHUB_JOB: "local", ANALYSIS_LOGICAL_SHA: runtime.logicalHeadSha,
    ANALYSIS_DEFINITION_SHA: definitionSha, ANALYSIS_CONTEXT: JSON.stringify(selected),
    ANALYSIS_TOOL: "shellcheck", ANALYSIS_DIRECTORY: evidence,
  };
  const currentReport = report(selected, await engineDigest());
  await writeFile(path.join(evidence, "report.json"), JSON.stringify(currentReport));
  await writeFile(path.join(evidence, "native.json"), '{"comments":[]}');
  await writeFile(path.join(evidence, "analysis.sarif"), JSON.stringify(sarif()));
  await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify({ pull_request: { head: { repo: { full_name: runtime.repository } } } }));
  try { await callback(env, evidence, currentReport); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}

test("actual envelope creation and verification detect post-scan report mutation", async () => {
  await fixture(async (env, evidence) => {
    await main({ ...env, ANALYSIS_MODE: "attest" });
    await main({ ...env, ANALYSIS_MODE: "validate" });
    const current = JSON.parse(await readFile(path.join(evidence, "artifact.json")));
    const hash = createHash("sha256").update(await readFile(path.join(evidence, "analysis.sarif"))).digest("hex");
    assert.equal(current.files["analysis.sarif"], hash);
    await writeFile(path.join(evidence, "native.json"), '{"comments":["changed"]}');
    await assert.rejects(main({ ...env, ANALYSIS_MODE: "validate" }), /content hash mismatch/);
  });
});

test("private planning never requests native publication, and fork PRs retain local-only evidence", async () => {
  for (const visibility of ["private", "public"]) {
    await fixture(async (env) => {
      await main({ ...env, ANALYSIS_MODE: "plan", ANALYSIS_RUN: JSON.stringify(run()) });
      assert.match(await readFile(env.GITHUB_OUTPUT, "utf8"), new RegExp(`publish=${visibility === "public"}`));
      await writeFile(env.GITHUB_EVENT_PATH, '{"pull_request":{"head":{"repo":{"full_name":"third-party/fork"}}}}');
      await writeFile(env.GITHUB_OUTPUT, "");
      await main({ ...env, ANALYSIS_MODE: "plan", ANALYSIS_RUN: JSON.stringify(run()) });
      assert.match(await readFile(env.GITHUB_OUTPUT, "utf8"), /publish=false/);
    }, context(visibility));
  }
});

test("assembly requires the exact selected tool set and distinguishes backend completion from full-profile completion", async () => {
  await fixture(async (env, evidence) => {
    await main({ ...env, ANALYSIS_MODE: "attest" });
    const aggregate = path.join(env.RUNNER_TEMP, "aggregate");
    const local = path.join(aggregate, "local-shellcheck-2");
    await mkdir(local, { recursive: true });
    for (const filename of ["report.json", "native.json", "analysis.sarif", "artifact.json"]) {
      await writeFile(path.join(local, filename), await readFile(path.join(evidence, filename)));
    }
    await main({ ...env, ANALYSIS_MODE: "assemble", ANALYSIS_DIRECTORY: aggregate, ANALYSIS_NATIVE_PUBLICATION: "false" });
    const result = JSON.parse(await readFile(path.join(env.RUNNER_TEMP, "repository-analysis-local-set", "local-results.json")));
    assert.equal(result.status, "local-tools-completed");
    assert.equal(result.fullProfileEvidence, false);
    assert.equal(result.tools[0].nativeProcessing, null);
    assert.equal(result.publication, "originating-repository-artifact-only");
    await assert.rejects(main({ ...env, ANALYSIS_MODE: "assemble", ANALYSIS_DIRECTORY: aggregate,
      ANALYSIS_NATIVE_PUBLICATION: "true" }), /selected-tool artifact/);
    await mkdir(path.join(aggregate, "local-unexpected-2"));
    await assert.rejects(main({ ...env, ANALYSIS_MODE: "assemble", ANALYSIS_DIRECTORY: aggregate,
      ANALYSIS_NATIVE_PUBLICATION: "false" }), /selected-tool artifact/);
  });
});

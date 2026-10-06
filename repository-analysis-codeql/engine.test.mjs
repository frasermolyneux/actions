import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { selectAnalysis } from "../repository-analysis-context/policy.mjs";
import { assembleTools, plan, SCHEMA, sourceCoverage, validateArtifact, VERSION, WORKFLOW_PATH } from "./engine.mjs";

const sha = "a".repeat(40);
const logical = "b".repeat(40);
const definition = "c".repeat(40);
const digest = "d".repeat(64);
const repository = { id: 123, full_name: "frasermolyneux/example", visibility: "public",
  private: false, archived: false, fork: false, owner: { type: "User" } };
const profile = { version: "repository-analysis-v1", languages: ["actions", "javascript", "python"], sonar: false };
const runtime = { repository: repository.full_name, repositoryId: repository.id, sourceSha: sha,
  expectedSha: sha, workflowSha: sha, runId: 10, attempt: 2, event: "push",
  workflowPath: ".github/workflows/analysis.yml" };
const run = { id: 10, run_attempt: 2, repository, head_sha: sha, event: "push", path: runtime.workflowPath,
  referenced_workflows: [{ path: `frasermolyneux/actions/${WORKFLOW_PATH}@repository-analysis-codeql/v1.0.0`,
    ref: "refs/tags/repository-analysis-codeql/v1.0.0", sha: definition }] };
const sdk = { kind: "dotnet", sdk: ["9.0.x", "10.0.x"], globalJson: null,
  solution: ".", skipFormat: true, tests: true };
const contextFor = (languages = profile.languages, privateRepository = false) =>
  selectAnalysis({ ...profile, languages }, { ...repository,
    visibility: privateRepository ? "private" : "public", private: privateRepository }, repository.full_name);
const makePlan = (context = contextFor(), origin = run, actual = runtime, event = {}, build = null) =>
  plan(context, origin, actual, event, build, ".");

test("metadata plan selects all and only public native capabilities with pinned runner families", () => {
  const value = makePlan();
  assert.equal(value.hasLanguages, true);
  assert.deepEqual(value.matrix.include.map(({ language }) => language),
    ["actions", "javascript-typescript", "python"]);
  assert.ok(value.matrix.include.every(({ runner, bundle, buildMode }) =>
    runner === "ubuntu-latest" && bundle === "linux64" && buildMode === "none"));
  assert.equal(value.definitionSha, definition);
  assert.equal(value.build, null);
});

test("private and unsupported profiles emit an explicit empty selection, not licensed execution", () => {
  for (const context of [contextFor(profile.languages, true), contextFor(["shell"])]) {
    const value = makePlan(context);
    assert.equal(value.hasLanguages, false);
    assert.deepEqual(value.matrix.include, [{ language: "not-selected", runner: "ubuntu-latest" }]);
  }
});

test("exact repository, workflow, run, attempt, actual source and immutable definition are mandatory", () => {
  for (const key of ["repository", "repositoryId", "runId", "attempt", "sourceSha", "expectedSha",
    "workflowSha", "workflowPath", "event"]) {
    assert.throws(() => makePlan(contextFor(), run,
      { ...runtime, [key]: typeof runtime[key] === "number" ? 99 : "wrong" }),
    /exact originating/);
  }
  for (const changed of [
    { referenced_workflows: [] },
    { referenced_workflows: [...run.referenced_workflows, ...run.referenced_workflows] },
    { referenced_workflows: [{ ...run.referenced_workflows[0], sha: "wrong" }] },
    { referenced_workflows: [{ ...run.referenced_workflows[0], ref: "refs/heads/main" }] },
    { referenced_workflows: [{ ...run.referenced_workflows[0], ref: "refs/tags/repository-analysis/v1.0.0" }] },
    { head_sha: logical }, { run_attempt: 3 }, { path: ".github/workflows/wrong.yml" },
  ]) assert.throws(() => makePlan(contextFor(), { ...run, ...changed }),
    /exact originating|called CodeQL|immutable foreign/);
});

test("only the actual Actions producer can exercise its reviewed branch before a release", () => {
  const own = { ...repository, full_name: "frasermolyneux/actions" };
  const actual = { ...runtime, repository: own.full_name };
  const origin = { ...run, repository: own, referenced_workflows: [
    { ...run.referenced_workflows[0], ref: "refs/pull/48/merge" },
  ] };
  const context = selectAnalysis(profile, own, own.full_name);
  assert.equal(makePlan(context, origin, actual).definitionSha, definition);
  assert.throws(() => makePlan(contextFor(), { ...run, referenced_workflows: origin.referenced_workflows }),
    /immutable foreign/);
});

test("PR logical head is distinct and foreign, draft or superseded origins cannot plan publication", () => {
  const event = { pull_request: { number: 3, draft: false, head: { sha: logical, repo: repository } } };
  const origin = { ...run, event: "pull_request", head_sha: logical };
  const actual = { ...runtime, event: "pull_request" };
  assert.equal(makePlan(contextFor(), origin, actual, event).logicalHeadSha, logical);
  for (const changed of [
    { ...event.pull_request, draft: true },
    { ...event.pull_request, head: { ...event.pull_request.head, repo: { ...repository, id: 456 } } },
    { ...event.pull_request, head: { ...event.pull_request.head, sha } },
  ]) assert.throws(() => makePlan(contextFor(), origin, actual, { pull_request: changed }),
    /PR origins|exact originating/);
});

test("SDK, Framework and C++ compilation must be declared independently of Sonar eligibility", () => {
  const sdkPlan = makePlan(contextFor(["csharp"]), run, runtime, {}, sdk);
  assert.equal(sdkPlan.context.sonar.status, "not-applicable");
  assert.equal(sdkPlan.matrix.include[0].buildMode, "manual");
  assert.equal(sdkPlan.matrix.include[0].sdk, "9.0.x\n10.0.x");
  const framework = makePlan(contextFor(["csharp"]), run, runtime, {},
    { ...sdk, kind: "netfx", tests: false, solution: "Source.sln" });
  assert.equal(framework.matrix.include[0].runner, "windows-latest");
  assert.equal(framework.matrix.include[0].bundle, "win64");
  const cpp = { kind: "cmake", configureArgs: ["-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON"],
    buildArgs: ["--config", "Release"], testArgs: ["--output-on-failure", "--build-config", "Release"] };
  assert.equal(makePlan(contextFor(["cpp"]), run, runtime, {}, cpp).matrix.include[0].family, "cmake");
  assert.throws(() => makePlan(contextFor(["csharp"])), /build recipe/);
  assert.throws(() => makePlan(contextFor(["cpp"]), run, runtime, {}, sdk), /compiled language/);
  assert.throws(() => makePlan(contextFor(["csharp", "cpp"]), run, runtime, {}, sdk), /compiled language/);
});

function evidence(language = "python") {
  const planned = makePlan(contextFor(language === "javascript-typescript" ? ["javascript", "typescript"] : [language]));
  const coverage = language === "javascript-typescript" ? { javascript: 2, typescript: 1 } : { [language]: 3 };
  const report = { schema: SCHEMA, repository: repository.full_name, repositoryId: repository.id,
    visibility: "public", sourceSha: sha, policyDigest: planned.context.policyDigest, language,
    definition: { sha: definition, path: WORKFLOW_PATH, digest }, version: VERSION, ruleRevision: VERSION,
    run: { id: 10, attempt: 2, job: "native", workflowSha: sha, workflowPath: runtime.workflowPath, logicalHeadSha: sha },
    sourceCoverage: coverage, extraction: { schema: "repository-analysis-codeql-integration-v1",
      scope: "selected-codeql-language-only", fullProfileEvidence: false, visibility: "public",
      repository: repository.full_name, repositoryId: repository.id, sourceSha: sha,
      language, version: VERSION, ruleRevision: VERSION, run: { id: 10, attempt: 2 },
      extraction: { files: 3, sourceDigest: digest, sourceCoverage: structuredClone(coverage) },
      sarif: { sha256: digest, resultCount: 27 } } };
  const native = { schema: "repository-analysis-sarif-proof-v1", repository: repository.full_name,
    repositoryId: repository.id, visibility: "public", policyDigest: planned.context.policyDigest,
    toolId: `codeql/${language}`, sourceSha: sha, run: report.run,
    tool: { name: "CodeQL", version: VERSION }, category: `/language:${language}/`,
    processing: { status: "completed", id: "12345678-1234-1234-1234-123456789abc" },
    publication: { status: "completed", destination: "github-security", id: "999" },
    findingCount: 0, ruleCount: 52, verifiedAt: "2026-10-05T20:00:00.000Z" };
  return { planned, report, native };
}

test("completion uses actual native finding counts, not diagnostic SARIF counts or full-profile claims", () => {
  const { planned, report, native } = evidence();
  const tool = validateArtifact(report, native, planned, "python", digest);
  assert.equal(tool.findingCount, 0);
  assert.equal(report.extraction.sarif.resultCount, 27);
  assert.equal(tool.publication.id, "999");
});

test("native completion timestamps must be genuine canonical UTC dates before propagation", () => {
  const { planned, report, native } = evidence();
  assert.equal(validateArtifact(report, native, planned, "python", digest).completedAt, native.verifiedAt);
  for (const verifiedAt of [undefined, null, 123, "not-a-date", "2026-10-05",
    "2026-10-05T20:00:00Z", "2026-10-05T20:00:00.000+00:00",
    "2026-02-30T20:00:00.000Z", "2026-10-05T25:00:00.000Z"]) {
    assert.throws(() => validateArtifact(report, { ...native, verifiedAt }, planned, "python", digest),
      /canonical UTC timestamp/);
  }
});

test("every selected JS/TS capability needs genuinely archived source, not tracked estimates", () => {
  const { planned, report, native } = evidence("javascript-typescript");
  assert.deepEqual(sourceCoverage(planned.context, "javascript-typescript", report.extraction),
    { javascript: 2, typescript: 1 });
  validateArtifact(report, native, planned, "javascript-typescript", digest);
  for (const capability of ["javascript", "typescript"]) {
    const changed = structuredClone(report);
    changed.extraction.extraction.sourceCoverage[capability] = 0;
    assert.throws(() => validateArtifact(changed, native, planned, "javascript-typescript", digest), /absent/);
  }
  const estimate = structuredClone(report);
  estimate.sourceCoverage.javascript = 20;
  assert.throws(() => validateArtifact(estimate, native, planned, "javascript-typescript", digest), /genuinely archived/);
  const overflow = structuredClone(report);
  overflow.extraction.extraction.files = 1;
  assert.throws(() => validateArtifact(overflow, native, planned, "javascript-typescript", digest), /exceed/);
});

test("one genuinely archived container can independently contain both JS and TS source", () => {
  const { planned, report, native } = evidence("javascript-typescript");
  report.extraction.extraction.files = 1;
  report.sourceCoverage = { javascript: 1, typescript: 1 };
  report.extraction.extraction.sourceCoverage = structuredClone(report.sourceCoverage);
  validateArtifact(report, native, planned, "javascript-typescript", digest);
});

test("malformed archive evidence raises explicit coverage errors rather than accidental property exceptions", () => {
  const { planned } = evidence("javascript-typescript");
  for (const extracted of [undefined, {}, { extraction: null }, { extraction: { files: 0 } },
    { extraction: { files: 1.5 } }, { extraction: { files: "3" } }]) {
    assert.throws(() => sourceCoverage(planned.context, "javascript-typescript", extracted),
      /actual positive archived file count/);
  }
});

test("wrong source, definition, policy, fixture, attempt, producer or native state never completes", () => {
  const { planned, report, native } = evidence();
  for (const mutate of [
    (value) => { value.sourceSha = logical; },
    (value) => { value.policyDigest = "e".repeat(64); },
    (value) => { value.definition.digest = "e".repeat(64); },
    (value) => { value.definition.sha = sha; },
    (value) => { value.run.attempt = 1; },
    (value) => { value.run.job = "actual-public-source"; },
    (value) => { value.extraction.scope = "actual-build-fixture-only"; },
    (value) => { value.extraction.sourceSha = logical; },
    (value) => { value.extraction.fullProfileEvidence = true; },
    (value) => { value.sourceCoverage.python = 0; },
  ]) {
    const changed = structuredClone(report); mutate(changed);
    assert.throws(() => validateArtifact(changed, native, planned, "python", digest), /artifact/);
  }
  for (const mutate of [
    (value) => { value.sourceSha = logical; },
    (value) => { value.run.job = "wrong"; },
    (value) => { value.tool.version = "2.0.0"; },
    (value) => { value.category = "/language:actions"; },
    (value) => { value.processing.status = "pending"; },
    (value) => { value.processing.id = "unbound"; },
    (value) => { value.publication.status = "pending"; },
    (value) => { value.ruleCount = 0; },
    (value) => { value.findingCount = null; },
  ]) {
    const changed = structuredClone(native); mutate(changed);
    assert.throws(() => validateArtifact(report, changed, planned, "python", digest), /native processing/);
  }
});

test("every actual CLI mode reaches validation without circular module-evaluation deadlock", () => {
  for (const mode of ["plan", "authorize", "build", "extract", "bind", "assemble"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./engine.mjs", import.meta.url))], {
      timeout: 10_000, encoding: "utf8",
      env: { ...process.env, CODEQL_MODE: mode, CODEQL_PROFILE: JSON.stringify(profile),
        GITHUB_REPOSITORY: repository.full_name, GH_TOKEN: "" },
    });
    assert.equal(result.status, 1, `actual ${mode}: ${result.stderr}`);
    assert.match(result.stderr, /valid repository metadata read token/);
    assert.doesNotMatch(result.stderr, /unsettled top-level await/);
  }
});

test("assembly rejects missing, unexpected, oversized and wrong-attempt artifacts without success fallback", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeql-set-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { planned, report, native } = evidence();
  await assert.rejects(assembleTools(directory, planned, digest), /Missing/);
  const location = path.join(directory, "codeql-native-python-2");
  await mkdir(location);
  await writeFile(path.join(location, "report.json"), JSON.stringify(report));
  await writeFile(path.join(location, "native.json"), JSON.stringify(native));
  assert.equal((await assembleTools(directory, planned, digest)).length, 1);
  await writeFile(path.join(location, "native.json"), JSON.stringify({ ...native, verifiedAt: "altered" }));
  await assert.rejects(assembleTools(directory, planned, digest), /canonical UTC timestamp/);
  await writeFile(path.join(location, "native.json"), JSON.stringify(native));
  await assert.rejects(assembleTools(directory, { ...planned, attempt: 3 }, digest), /Missing/);
  await mkdir(path.join(directory, "unexpected"));
  await assert.rejects(assembleTools(directory, planned, digest), /unexpected/);
  await rmdir(path.join(directory, "unexpected"));
  await writeFile(path.join(location, "report.json"), " ".repeat(128 * 1024 + 1));
  await assert.rejects(assembleTools(directory, planned, digest), /bounded regular file/);
});

test("an empty private-native set remains explicitly empty and refuses injected native artifacts", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeql-private-set-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const planned = makePlan(contextFor(profile.languages, true));
  assert.deepEqual(await assembleTools(directory, planned, digest), []);
  await mkdir(path.join(directory, "codeql-native-python-2"));
  await assert.rejects(assembleTools(directory, planned, digest), /unexpected/);
});

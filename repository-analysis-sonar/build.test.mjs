import assert from "node:assert/strict";
import test from "node:test";
import { plan, validateBuild } from "./build.mjs";
import { recipeDigest, WORKFLOW_PATH } from "./sonar.mjs";

const dotnet = { version: 1, driver: "dotnet", projectKey: "project", sourceDirectory: "src", coverage: "cobertura" };
const build = { kind: "dotnet", sdk: ["9.0.x", "10.0.x"], globalJson: "global.json",
  solution: ".", skipFormat: true, tests: true };

function admission(eventName = "push") {
  const runtime = { repository: "frasermolyneux/example", repositoryId: 17,
    runId: 23, attempt: 2, sha: "a".repeat(40), expectedSha: "a".repeat(40),
    workflowSha: "a".repeat(40), workflowPath: ".github/workflows/codequality.yml",
    event: eventName, refName: "main" };
  const event = eventName === "pull_request" ? { pull_request: {
    number: 7, draft: false, head: { sha: "c".repeat(40), ref: "feature/example",
      repo: { full_name: runtime.repository } },
  } } : {};
  const run = { id: runtime.runId, run_attempt: runtime.attempt,
    repository: { id: runtime.repositoryId, full_name: runtime.repository },
    event: eventName, path: runtime.workflowPath,
    head_sha: event.pull_request?.head.sha ?? runtime.sha,
    run_started_at: "2026-10-05T12:00:00Z",
    referenced_workflows: [{
      path: `frasermolyneux/actions/${WORKFLOW_PATH}@repository-analysis-sonar/v1.0.0`,
      ref: "refs/tags/repository-analysis-sonar/v1.0.0", sha: "b".repeat(40),
    }],
  };
  return { runtime, event, run };
}

test("plan directly binds push/schedule/manual source, caller, attempt and immutable definition", () => {
  for (const eventName of ["push", "schedule", "workflow_dispatch"]) {
    const { run, runtime, event } = admission(eventName);
    const result = plan(run, runtime, event, dotnet, build);
    assert.equal(result.runner, "ubuntu-latest");
    assert.deepEqual(result.recipe, dotnet);
    assert.deepEqual(result.build, build);
    assert.equal(result.definitionSha, "b".repeat(40));
    assert.deepEqual(result.producer, {
      repository: runtime.repository, repositoryId: 17, projectKey: "project",
      sourceSha: runtime.sha, runId: 23, attempt: 2,
      workflowPath: runtime.workflowPath, workflowSha: runtime.workflowSha,
      definitionSha: "b".repeat(40), recipeDigest: recipeDigest(dotnet, build),
      branch: "main", pullRequest: null, startedAt: run.run_started_at,
      driver: "dotnet", coveragePath: null,
    });
  }
});

test("plan keeps actual PR merge checkout separate from its logical current head", () => {
  const { run, runtime, event } = admission("pull_request");
  const result = plan(run, runtime, event, dotnet, build);
  assert.equal(result.producer.sourceSha, runtime.sha);
  assert.notEqual(result.producer.sourceSha, run.head_sha);
  assert.equal(result.producer.branch, event.pull_request.head.ref);
  assert.equal(result.producer.pullRequest, 7);
  assert.equal(result.producer.workflowSha, runtime.workflowSha);
});

test("plan rejects mutation of each initial source/run/caller binding before checkout", () => {
  const mutations = [
    (value) => { value.runtime.expectedSha = "d".repeat(40); },
    (value) => { value.runtime.sha = value.runtime.expectedSha = "invalid"; },
    (value) => { value.runtime.event = "pull_request_target"; },
    (value) => { value.run.id++; },
    (value) => { value.run.run_attempt++; },
    (value) => { value.run.repository.id++; },
    (value) => { value.run.repository.full_name = "other/repository"; },
    (value) => { value.run.event = "schedule"; },
    (value) => { value.run.path = ".github/workflows/other.yml"; },
    (value) => { value.run.head_sha = "d".repeat(40); },
  ];
  for (const mutate of mutations) {
    const value = admission();
    mutate(value);
    assert.throws(() => plan(value.run, value.runtime, value.event, dotnet, build),
      /exact supported run\/source/);
  }
  const pr = admission("pull_request");
  pr.run.head_sha = pr.runtime.sha;
  assert.throws(() => plan(pr.run, pr.runtime, pr.event, dotnet, build),
    /exact supported run\/source/);
});

test("plan refuses foreign and draft PR sources during initial admission", () => {
  for (const mutate of [
    (event) => { event.pull_request.head.repo.full_name = "other/repository"; },
    (event) => { event.pull_request.draft = true; },
  ]) {
    const { run, runtime, event } = admission("pull_request");
    mutate(event);
    assert.throws(() => plan(run, runtime, event, dotnet, build), /foreign or draft/);
  }
});

test("plan refuses missing/ambiguous/invalid or mutable foreign executing definitions", () => {
  for (const mutate of [
    (run) => { run.referenced_workflows = []; },
    (run) => { run.referenced_workflows.push({ ...run.referenced_workflows[0] }); },
    (run) => { run.referenced_workflows[0].sha = "invalid"; },
    (run) => { run.referenced_workflows[0].path = "other/actions/" + WORKFLOW_PATH + "@main"; },
    (run) => { run.referenced_workflows[0].ref = "refs/heads/main"; },
    (run) => { run.referenced_workflows[0].ref = "repository-analysis-sonar/v1"; },
    (run) => { run.referenced_workflows[0].ref = "b".repeat(40); },
  ]) {
    const { run, runtime, event } = admission();
    mutate(run);
    assert.throws(() => plan(run, runtime, event, dotnet, build), /definition/);
  }
  const { run, runtime, event } = admission();
  delete run.referenced_workflows[0].ref;
  assert.equal(plan(run, runtime, event, dotnet, build).definitionSha, "b".repeat(40));
});

test("plan confines branch/merge contract definitions to the shared Actions repository", () => {
  for (const reference of ["refs/heads/estate-analysis", "refs/pull/46/merge"]) {
    const { run, runtime, event } = admission();
    run.referenced_workflows[0].ref = reference;
    assert.throws(() => plan(run, runtime, event, dotnet, build), /mutable foreign definition/);
    runtime.repository = run.repository.full_name = "frasermolyneux/actions";
    assert.equal(plan(run, runtime, event, dotnet, build).definitionSha, "b".repeat(40));
  }
});

test("canonical SDK/Framework/CLI/CMake families preserve explicit original build selections", () => {
  assert.deepEqual(validateBuild(build, dotnet), build);
  assert.deepEqual(validateBuild({ ...build, sdk: ["10.0.1xx"] }, dotnet).sdk, ["10.0.1xx"]);
  assert.equal(validateBuild({ ...build, kind: "netfx", tests: false, solution: "DemoManager.sln" },
    { ...dotnet, coverage: "not-applicable" }).kind, "netfx");
  assert.equal(validateBuild({ kind: "script", nodeVersion: "20.x", npmInstall: true },
    { ...dotnet, driver: "cli", coverage: "not-applicable" }).kind, "script");
  const cpp = { kind: "cmake", configureArgs: ["-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
    "-DPORTAL_COD4X_BUILD_PLUGIN_BINARY=OFF"], buildArgs: ["--config", "Release"],
  testArgs: ["--output-on-failure", "--build-config", "Release"] };
  assert.deepEqual(validateBuild(cpp, { ...dotnet, driver: "cpp", coverage: "not-applicable" }), cpp);
});

test("build/source/coverage family mismatches cannot execute success-shaped validation", () => {
  for (const patch of [{ kind: "netfx" }, { tests: false }, { solution: "../outside.sln" },
    { solution: "file;deploy" }, { sdk: ["main"] }, { sdk: ["10.0.x\ninjection"] },
    { globalJson: "../global.json" }, { globalJson: "notglobal.json" },
    { globalJson: "src/notglobal.json" }, { publish: true }, { skipFormat: "true" }]) {
    assert.throws(() => validateBuild({ ...build, ...patch }, dotnet));
  }
  assert.throws(() => validateBuild({ kind: "cmake", configureArgs: ["-DOTHER=ON"],
    buildArgs: ["--config", "Release"], testArgs: ["--output-on-failure"] },
  { ...dotnet, driver: "cpp", coverage: "not-applicable" }));
});

test("SDK discovery uses the exact root or nested global.json basename", () => {
  assert.equal(validateBuild(build, dotnet).globalJson, "global.json");
  assert.equal(validateBuild({ ...build, globalJson: "src/global.json" }, dotnet).globalJson, "src/global.json");
});

test("a solution path cannot turn restore/build into a successful help invocation", () => {
  for (const kind of ["dotnet", "netfx"]) {
    const absentTests = { ...build, kind, tests: false };
    for (const solution of ["-h", "--help", "-version", "-folder/Project.sln"]) {
      assert.throws(() => validateBuild({ ...absentTests, solution },
        { ...dotnet, coverage: "not-applicable" }), /SDK\/solution/);
    }
    assert.equal(validateBuild({ ...absentTests, solution: "src/-Named.sln" },
      { ...dotnet, coverage: "not-applicable" }).solution, "src/-Named.sln");
  }
});

test("the selected global.json must be a real build-search ancestor, not a sibling or descendant", () => {
  for (const sourceDirectory of ["src", "src/project"]) {
    for (const globalJson of ["global.json", "src/global.json", "src/./global.json"]) {
      assert.equal(validateBuild({ ...build, globalJson }, { ...dotnet, sourceDirectory }).globalJson,
        globalJson);
    }
  }
  for (const [sourceDirectory, globalJson] of [
    ["src", "other/global.json"], ["src", "src/child/global.json"],
    ["src/project", "src/project-other/global.json"], [".", "src/global.json"],
  ]) assert.throws(() => validateBuild({ ...build, globalJson },
    { ...dotnet, sourceDirectory }), /discoverable/);
});

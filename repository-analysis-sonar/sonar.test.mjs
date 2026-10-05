import assert from "node:assert/strict";
import test from "node:test";
import { selectAnalysis } from "../repository-analysis-context/policy.mjs";
import { HOST, properties, receipt, recipeDigest, rootProperties, validateInput,
  validateProject, validateRecipe, validateTask, verify } from "./sonar.mjs";
import { validateProducerRun, WORKFLOW_PATH } from "./sonar.mjs";
import { createHash } from "node:crypto";
import { historicalMeasures, validateCollection, verifyBranchImport } from "./sonar.mjs";

const recipe = { version: 1, driver: "dotnet", projectKey: "owner_project", sourceDirectory: "src",
  coverage: "cobertura" };
const input = { repository: "owner/project", repositoryId: 123, projectKey: recipe.projectKey,
  sourceSha: "a".repeat(40), runId: 456, attempt: 2, workflowPath: ".github/workflows/codequality.yml",
  workflowSha: "b".repeat(40), definitionSha: "c".repeat(40), recipeDigest: recipeDigest(recipe),
  branch: "main", pullRequest: null, startedAt: "2026-10-05T12:00:00Z", driver: "dotnet",
  coveragePath: process.platform === "win32" ? "C:\\temp\\coverage.xml" : "/tmp/coverage.xml" };
const context = selectAnalysis({ version: "repository-analysis-v1", languages: ["csharp"], sonar: true },
  { full_name: input.repository, id: 123, private: false, visibility: "public", archived: false,
    fork: false, owner: { type: "User" } }, input.repository);
const project = { key: recipe.projectKey, organization: "frasermolyneux", visibility: "public",
  autoscanEnabled: false, alm: { key: "github", url: `https://github.com/${input.repository}` } };
const metadataPath = process.platform === "win32" ? "C:\\temp\\report-task.txt" : "/tmp/report-task.txt";
const scannerContext = (source = input) => [
  "Server settings:", "  - sonar.projectKey=wrong-server",
  "Project scanner properties:", ...Object.entries(properties(source, metadataPath)).map(([key, value]) => `  - ${key}=${value}`),
  "Scanner properties of module: tests", "  - sonar.projectKey=wrong-module", "  - sonar.scm.revision=wrong-module",
].join("\n");
const task = { id: "task_12345", type: "REPORT", status: "SUCCESS", componentKey: recipe.projectKey,
  analysisId: "analysis_12345", submittedAt: "2026-10-05T12:01:00Z", executedAt: "2026-10-05T12:02:00Z",
  scannerContext: scannerContext() };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const runtime = { repository: input.repository, repositoryId: input.repositoryId, runId: input.runId,
  attempt: input.attempt, sourceSha: input.sourceSha, workflowPath: input.workflowPath,
  workflowSha: input.workflowSha, event: "push" };
const producer = { id: input.runId, run_attempt: input.attempt, repository: { id: input.repositoryId,
  full_name: input.repository }, event: "push", head_sha: input.sourceSha, path: input.workflowPath,
  run_started_at: input.startedAt, referenced_workflows: [{ sha: input.definitionSha,
    path: `frasermolyneux/actions/${WORKFLOW_PATH}@repository-analysis-sonar/v1.0.0`,
    ref: "refs/tags/repository-analysis-sonar/v1.0.0" }] };
const bytes = Buffer.from("<coverage/>");
const collection = { schema: 1, status: "collected", format: "cobertura", sourceSha: input.sourceSha,
  toolVersion: "18.11.2", sha256: createHash("sha256").update(bytes).digest("hex"),
  lines: { total: 10, covered: 8 } };
const tests = { schema: 1, status: "passed", executed: 5, passed: 5, failed: 0, skipped: 1 };
const analysis = { key: task.analysisId, revision: input.sourceSha, date: "2026-10-05T12:01:00+0000" };
const metrics = { paging: { total: 1 }, measures: [
  { metric: "lines_to_cover", history: [{ date: analysis.date, value: "8" }] },
  { metric: "uncovered_lines", history: [{ date: analysis.date, value: "2" }] },
] };

test("native report bytes and genuine passing TRX execution bind coverage collection", () => {
  assert.equal(validateCollection(collection, tests, input, bytes).status, "collected");
  for (const patch of [{ sourceSha: "d".repeat(40) }, { sha256: "f".repeat(64) },
    { lines: { total: 0, covered: 0 } }, { toolVersion: "18.0.0" }, { format: "xml" }]) {
    assert.throws(() => validateCollection({ ...collection, ...patch }, tests, input, bytes));
  }
  for (const patch of [{ status: "all-skipped" }, { executed: 0 }, { failed: 1 }, { passed: 4 }]) {
    assert.throws(() => validateCollection(collection, { ...tests, ...patch }, input, bytes));
  }
  assert.throws(() => validateCollection(collection, tests, input, Buffer.from("changed")));
});

test("exact-date historical measures reject missing, duplicate, wrong-date and malformed metrics", () => {
  assert.deepEqual(historicalMeasures(metrics, analysis.date, ["lines_to_cover", "uncovered_lines"]),
    { lines_to_cover: 8, uncovered_lines: 2 });
  for (const candidate of [
    { ...metrics, paging: { total: 2 } },
    { ...metrics, measures: [] },
    { ...metrics, measures: [...metrics.measures, metrics.measures[0]] },
    { ...metrics, measures: [{ metric: "lines_to_cover", history: [{ date: input.startedAt, value: "8" }] }] },
    { ...metrics, measures: [{ metric: "lines_to_cover", history: [{ date: analysis.date, value: "-1" }] }] },
  ]) assert.throws(() => historicalMeasures(candidate, analysis.date, ["lines_to_cover", "uncovered_lines"]));
});

test("branch import proof binds exact analysis key, revision and immutable historical metrics", async () => {
  const imported = await verifyBranchImport(input, { processing: { analysisId: task.analysisId } },
    validateCollection(collection, tests, input, bytes), "token", async (url) =>
      response(url.includes("search_history") ? metrics : { analyses: [analysis] }));
  assert.equal(imported.status, "imported");
  assert.equal(imported.analysisId, task.analysisId);
  assert.deepEqual(imported.providerLines, { total: 8, covered: 6 });
});

test("superseded, same-date ambiguous, foreign-source and PR history are not branch import evidence", async () => {
  for (const entries of [
    [{ ...analysis, key: "other" }], [{ ...analysis, revision: "d".repeat(40) }],
    [analysis, { ...analysis, key: "another" }],
  ]) {
    await assert.rejects(verifyBranchImport(input, { processing: { analysisId: task.analysisId } },
      collection, "token", async () => response({ analyses: entries })));
  }
  await assert.rejects(verifyBranchImport({ ...input, pullRequest: 42 },
    { processing: { analysisId: task.analysisId } }, collection, "token"), /pull-request/);
  let calls = 0;
  await assert.rejects(verifyBranchImport(input, { processing: { analysisId: task.analysisId } },
    collection, "token", async (url) => response(url.includes("search_history") ? metrics :
      { analyses: [{ ...analysis, key: calls++ ? "changed" : analysis.key }] })), /changed/);
});

test("authenticated run attempt and released definition independently bind producer claims", () => {
  validateProducerRun(producer, input, runtime, {});
  for (const patch of [{ runId: 987 }, { sourceSha: "d".repeat(40) }, { attempt: 1 },
    { workflowPath: ".github/workflows/foreign.yml" }, { workflowSha: "e".repeat(40) }]) {
    assert.throws(() => validateProducerRun(producer, { ...input, ...patch }, runtime, {}));
  }
  for (const patch of [{ head_sha: "d".repeat(40) }, { run_started_at: "2026-10-04T12:00:00Z" },
    { referenced_workflows: [] }, { referenced_workflows: [...producer.referenced_workflows, ...producer.referenced_workflows] },
    { referenced_workflows: [{ ...producer.referenced_workflows[0], ref: "refs/heads/main" }] }]) {
    assert.throws(() => validateProducerRun({ ...producer, ...patch }, input, runtime, {}));
  }
});

test("foreign PR source cannot receive Sonar credentials under this contract", () => {
  const pr = { ...input, pullRequest: 42 };
  const event = { pull_request: { number: 42, head: { sha: "d".repeat(40),
    repo: { full_name: "fork/project" } } } };
  assert.throws(() => validateProducerRun({ ...producer, event: "pull_request", head_sha: "d".repeat(40) },
    pr, { ...runtime, event: "pull_request" }, event));
  event.pull_request.head.repo.full_name = input.repository;
  validateProducerRun({ ...producer, event: "pull_request", head_sha: "d".repeat(40) },
    pr, { ...runtime, event: "pull_request" }, event);
});

test("strict Sonar recipes retain supported source, driver and coverage combinations", () => {
  assert.deepEqual(validateRecipe(recipe), recipe);
  for (const patch of [{ coverage: "opencover" }, { driver: "cli" }, { sourceDirectory: "../src" },
    { sourceDirectory: "src/../outside" }, { projectKey: "key\ninjection" }, { secret: "unsupported" }]) {
    assert.throws(() => validateRecipe({ ...recipe, ...patch }));
  }
});

test("only the exact root section supplies allowlisted producer properties", () => {
  const result = rootProperties(scannerContext() + "\nScanner properties of module: other\n  - sonar.token=secret");
  assert.equal(result["sonar.projectKey"], recipe.projectKey);
  assert.equal(result["sonar.scm.revision"], input.sourceSha);
  assert.equal(Object.hasOwn(result, "sonar.token"), false);
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.throws(() => rootProperties("Scanner properties of module: test\n  - sonar.projectKey=wrong"));
});

test("duplicate root sections or keys fail, including non-retained sensitive keys", () => {
  for (const context of [
    scannerContext() + "\nProject scanner properties:\n  - sonar.projectKey=other",
    "Project scanner properties:\n  - sonar.projectKey=a\n  - sonar.projectKey=b",
    "Project scanner properties:\n  - sonar.token=one\n  - sonar.token=two",
    "Project scanner properties:\n  - broken",
  ]) assert.throws(() => rootProperties(context));
});

test("project preflight refuses private, automatic, foreign or ambiguous publication", () => {
  validateProject(project, context, input);
  for (const patch of [{ visibility: "private" }, { autoscanEnabled: true }, { autoscanEnabled: undefined },
    { key: "foreign" }, { organization: "other" }, { alm: { key: "github", url: "https://github.com/other/repo" } }]) {
    assert.throws(() => validateProject({ ...project, ...patch }, context, input));
  }
  assert.throws(() => validateProject(project, { ...context, visibility: "private" }, input));
});

test("actual task binds source, producer, coverage path and branch independently", () => {
  assert.equal(validateTask(task, input, task.id).analysisId, task.analysisId);
  for (const field of ["sourceSha", "runId", "attempt", "workflowPath", "workflowSha",
    "definitionSha", "recipeDigest", "coveragePath", "branch"]) {
    const changed = { ...input, [field]: `${input[field]}different` };
    assert.throws(() => validateTask({ ...task, scannerContext: scannerContext(changed) }, input, task.id));
  }
  for (const patch of [{ id: "foreign-task" }, { status: "FAILED" }, { componentKey: "foreign" },
    { type: "ISSUE_SYNC" }, { analysisId: "" }, { submittedAt: "2026-10-04T12:00:00Z" },
    { executedAt: "2026-10-05T11:00:00Z" }]) assert.throws(() => validateTask({ ...task, ...patch }, input, task.id));
});

test("PR tasks cannot borrow branch or another PR identity", () => {
  const pr = { ...input, pullRequest: 42 };
  assert.equal(validateTask({ ...task, scannerContext: scannerContext(pr) }, pr, task.id).id, task.id);
  assert.throws(() => validateTask(task, pr, task.id));
  assert.throws(() => validateTask({ ...task, scannerContext: scannerContext({ ...pr, pullRequest: 43 }) }, pr, task.id));
});

test("receipt never supplies an arbitrary host or task endpoint", () => {
  const valid = `projectKey=${recipe.projectKey}\nserverUrl=${HOST}\nceTaskId=${task.id}\nceTaskUrl=${HOST}/api/ce/task?id=${task.id}\n`;
  assert.equal(receipt(valid, recipe.projectKey), task.id);
  for (const text of [valid.replace(HOST, "https://example.invalid"), valid + "ceTaskId=duplicate\n",
    valid.replace(task.id, "bad/id"), valid.replace(recipe.projectKey, "foreign")]) {
    assert.throws(() => receipt(text, recipe.projectKey));
  }
});

test("pending upload is not completed analysis; verifier awaits the actual task", async () => {
  let calls = 0;
  const endpoints = [];
  const proof = await verify(context, input, task.id, "test-token", {
    request: async (url, options) => {
      assert.equal(options.redirect, "error");
      endpoints.push(url);
      if (url.includes("navigation")) return response(project);
      return response({ task: calls++ ? task : { ...task, status: "PENDING", scannerContext: undefined } });
    },
    sleep: async () => {}, now: () => Date.parse("2026-10-05T12:03:00Z"),
  });
  assert.equal(calls, 2);
  assert.equal(proof.processing.status, "completed");
  assert.equal(proof.sourceSha, input.sourceSha);
  assert.equal(proof.run.attempt, input.attempt);
  assert.ok(endpoints.every((url) => url.startsWith(HOST + "/api/")));
  assert.ok(!JSON.stringify(proof).includes("scannerContext"));
});

test("private or inconsistent live context fails before any Sonar API request", async () => {
  let calls = 0;
  await assert.rejects(verify({ ...context, visibility: "private" }, input, task.id, "token", {
    request: async () => { calls++; return response(project); },
  }), /live public/);
  assert.equal(calls, 0);
});

test("failed, cancelled, malformed, oversized and denied tasks do not become clean", async () => {
  for (const provider of [
    response({ task: { ...task, status: "FAILED" } }), response({ task: { ...task, status: "CANCELED" } }),
    response({ task: { ...task, id: "wrong" } }), response({}, 403),
    new Response("{"), new Response("x".repeat(3 * 1024 * 1024 + 1)),
  ]) {
    await assert.rejects(verify(context, input, task.id, "token", {
      request: async (url) => url.includes("navigation") ? response(project) : provider,
    }));
  }
});

test("producer validation rejects malformed and unexpected fields without echoing values", () => {
  validateInput(input);
  for (const patch of [{ sourceSha: "secret" }, { repositoryId: 0 }, { attempt: 1.5 },
    { recipeDigest: "short" }, { branch: "main\ninjection" }, { pullRequest: -1 }, { arbitrary: "secret" }]) {
    assert.throws(() => validateInput({ ...input, ...patch }), (error) => !error.message.includes("secret"));
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { selectAnalysis } from "../repository-analysis-context/policy.mjs";
import { HOST, properties, receipt, recipeDigest, rootProperties, validateInput,
  validateProject, validateRecipe, validateTask, validateDriver, verify } from "./sonar.mjs";
import { validateProducerRun, WORKFLOW_PATH } from "./sonar.mjs";
import { createHash } from "node:crypto";
import { historicalMeasures, validateCollection, verifyBranchImport } from "./sonar.mjs";
import { authorizeSource, trustedSource } from "./sonar.mjs";
import { validateUntracked } from "./sonar.mjs";
import { validateSource } from "./sonar.mjs";
import { validateCoverageSelection } from "./sonar.mjs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

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
const owner = { id: 789, login: "owner", type: "User" };
const publicRepository = { id: input.repositoryId, full_name: input.repository,
  private: false, visibility: "public", owner, default_branch: "main" };
const copilot = { id: 198982749, login: "Copilot", type: "Bot" };
const dependabot = { id: 49699333, login: "dependabot[bot]", type: "Bot" };
const githubActions = { id: 41898282, login: "github-actions[bot]", type: "Bot" };
const pullInput = { ...input, pullRequest: 42 };
const pullEvent = { pull_request: { head: { sha: "d".repeat(40) } } };
const pull = { number: 42, state: "open", draft: false, user: owner,
  head: { sha: pullEvent.pull_request.head.sha, repo: { id: input.repositoryId, full_name: input.repository } },
  base: { repo: { id: input.repositoryId } } };

test("owner-approved trust boundary accepts only exact owner and approved author/actor pairs", () => {
  for (const [author, actor, origin] of [
    [owner, owner, "owner"], [copilot, copilot, "copilot"], [copilot, owner, "copilot"],
    [dependabot, dependabot, "dependabot"], [dependabot, githubActions, "dependabot"],
  ]) {
    const trust = trustedSource(publicRepository, { actor },
      { ...pull, user: author }, pullInput, pullEvent);
    assert.equal(trust.origin, origin);
    assert.equal(trust.isolation, "same-runner-risk-accepted");
    assert.equal(trust.logicalHeadSha, pullEvent.pull_request.head.sha);
  }
});

test("third-party identities, generic bots, spoofed service names and mismatched actors are denied", () => {
  for (const [author, actor] of [
    [{ ...owner, id: 987 }, owner], [{ ...copilot, id: 987 }, copilot],
    [{ ...copilot, type: "User" }, copilot], [githubActions, githubActions],
    [copilot, githubActions], [owner, copilot], [dependabot, { ...dependabot, id: 987 }],
  ]) assert.throws(() => trustedSource(publicRepository, { actor },
    { ...pull, user: author }, pullInput, pullEvent), /author|actor/);
});

test("authenticated owner reruns authorize approved origins but cannot override an untrusted PR author", () => {
  assert.equal(trustedSource(publicRepository, { actor: githubActions, triggering_actor: owner },
    { ...pull, user: copilot }, pullInput, pullEvent).origin, "copilot");
  assert.throws(() => trustedSource(publicRepository, { actor: owner, triggering_actor: githubActions },
    { ...pull, user: copilot }, pullInput, pullEvent), /actor/);
  assert.throws(() => trustedSource(publicRepository, { actor: githubActions, triggering_actor: owner },
    { ...pull, user: { ...owner, id: 987 } }, pullInput, pullEvent), /author/);
});

test("trust admission refuses forks, superseded heads, closed/draft PRs and account/visibility changes", () => {
  for (const candidate of [
    { ...pull, draft: true }, { ...pull, state: "closed" },
    { ...pull, head: { ...pull.head, sha: "e".repeat(40) } },
    { ...pull, head: { ...pull.head, repo: { id: 987, full_name: input.repository } } },
    { ...pull, base: { repo: { id: 987 } } },
  ]) assert.throws(() => trustedSource(publicRepository, { actor: owner },
    candidate, pullInput, pullEvent), /foreign|superseded/);
  for (const patch of [{ private: true }, { visibility: "private" }, { id: 987 },
    { owner: { ...owner, type: "Organization" } }]) {
    assert.throws(() => trustedSource({ ...publicRepository, ...patch },
      { actor: owner }, pull, pullInput, pullEvent), /personal-owner/);
  }
});

test("default sources and explicit owner dispatch are distinct from untrusted manual branches", () => {
  assert.equal(trustedSource(publicRepository, { head_branch: "main" }, null, input, {}).origin,
    "default-or-owner-dispatch");
  assert.equal(trustedSource(publicRepository,
    { head_branch: "feature", event: "workflow_dispatch", actor: owner }, null, input, {}).origin,
  "default-or-owner-dispatch");
  assert.throws(() => trustedSource(publicRepository,
    { head_branch: "feature", event: "workflow_dispatch", actor: copilot }, null, input, {}), /owner dispatch/);
});

test("fresh authenticated PR metadata authorizes the exact logical source independently of merge checkout", async () => {
  const requests = [];
  const trust = await authorizeSource(pullInput, { actor: copilot }, pullEvent, "token", async (url) => {
    requests.push(url);
    return response(url.endsWith("/pulls/42") ? { ...pull, user: copilot } : publicRepository);
  });
  assert.equal(requests.length, 2);
  assert.equal(trust.origin, "copilot");
  assert.notEqual(trust.logicalHeadSha, pullInput.sourceSha);
});

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

test("the recursive report glob cannot import an extra nested report or a foreign invocation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sonar-coverage-contract-"));
  try {
    const invocation = path.join(root, "invocation");
    await mkdir(invocation);
    await writeFile(path.join(invocation, "coverage.cobertura.xml"), bytes);
    const pattern = path.join(root, "**", "coverage.cobertura.xml");
    assert.equal(await validateCoverageSelection(root, invocation, pattern),
      await realpath(path.join(invocation, "coverage.cobertura.xml")));
    await assert.rejects(validateCoverageSelection(root, invocation,
      path.join(root, "**", "*.xml")), /declared/);
    await mkdir(path.join(invocation, "extra"));
    await writeFile(path.join(invocation, "extra", "coverage.cobertura.xml"), bytes);
    await assert.rejects(validateCoverageSelection(root, invocation, pattern), /exactly the one/);
    await rm(path.join(invocation, "extra", "coverage.cobertura.xml"));
    await mkdir(path.join(root, "foreign"));
    await assert.rejects(validateCoverageSelection(root, invocation, pattern), /one isolated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coverage import settings in server or module sections cannot supply selected-report evidence", () => {
  for (const section of ["Server settings:", "Scanner properties of module: other"]) {
    for (const key of ["sonar.cs.opencover.reportsPaths", "sonar.cs.cobertura.reportsPaths",
      "sonar.javascript.lcov.reportPaths"]) {
      assert.throws(() => rootProperties(scannerContext() +
        `\n${section}\n  - ${key}=unvalidated-report`), /Alternate Sonar coverage/);
    }
  }
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

test("zero native coverage remains collected even when historical provider measures are zero", async () => {
  const zero = { ...collection, lines: { total: 10, covered: 0 } };
  const result = await verifyBranchImport(input, { processing: { analysisId: task.analysisId } },
    zero, "token", async (url) => response(url.includes("search_history") ?
      { ...metrics, measures: [
        { metric: "lines_to_cover", history: [{ date: analysis.date, value: "8" }] },
        { metric: "uncovered_lines", history: [{ date: analysis.date, value: "8" }] },
      ] } : { analyses: [analysis] }));
  assert.equal(result.status, "collected");
  assert.ok(!Object.hasOwn(result, "analysisId"));
  assert.match(result.reason, /cannot distinguish/);
});

test("not-applicable coverage cannot accept undeclared root scanner report paths", () => {
  const noCoverage = { ...input, coveragePath: null };
  validateTask({ ...task, scannerContext: scannerContext(noCoverage) }, noCoverage, task.id);
  assert.throws(() => validateTask(task, noCoverage, task.id), /coverage report/);
});

test("alternate coverage imports are rejected without retaining their configured values", () => {
  for (const key of ["sonar.cs.opencover.reportsPaths", "sonar.javascript.lcov.reportPaths",
    "sonar.coverageReportPaths", "sonar.python.coverage.reportPaths", "sonar.coverage.jacoco.xmlReportPaths",
    "sonar.cs.dotcover.reportsPaths", "sonar.cfamily.llvm-cov.reportPath"]) {
    const alternate = scannerContext().replace("Project scanner properties:",
      `Project scanner properties:\n  - ${key}=unretained-value`);
    assert.throws(() => rootProperties(alternate), /Alternate Sonar coverage/);
  }
});

test("generated analyzable files cannot expand the authenticated commit outside excluded outputs", () => {
  validateUntracked(["src/Project/obj/Generated.cs", "src/Project/bin/Release/compiled.js",
    ".sonarqube/out/generated.json"], "dotnet");
  validateUntracked(["src/node_modules/package/index.js", "src/build/compiled.cpp",
    "src/fixtures/sample.py", ".scannerwork/scanner.json"], "cli");
  for (const driver of ["dotnet", "cli", "cpp"]) {
    for (const filename of ["src/untracked.cs", "src/untracked.js", "src/ignored-by-git/added.py",
      "src/component.vue", "src/component.svelte", "src/header.ipp", "src/header.inl", "src/unknown-extension"]) {
      assert.throws(() => validateUntracked([filename], driver), /Untracked analyzable/);
    }
  }
});

test("actual Git source admission rejects ignored untracked files, not only tracked diffs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sonar-source-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = process.platform === "win32" ? String.raw`C:\Program Files\Git\cmd\git.exe` : "/usr/bin/git";
  const git = (...args) => execFileSync(command, ["-C", root, ...args], { encoding: "utf8" }).trim();
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "tracked.js"), "export const value = 1;\n");
  await writeFile(path.join(root, ".gitignore"), "ignored/\nnode_modules/\n");
  git("init", "--quiet");
  git("add", ".");
  git("-c", "user.name=Contract", "-c", "user.email=contract@example.invalid", "commit", "--quiet", "-m", "fixture");
  const sha = git("rev-parse", "HEAD");
  const selection = { ...recipe, driver: "cli", coverage: "not-applicable" };
  assert.ok(await validateSource(root, selection, sha));
  await mkdir(path.join(root, "src", "node_modules"));
  await writeFile(path.join(root, "src", "node_modules", "dependency.js"), "dependency\n");
  assert.ok(await validateSource(root, selection, sha));
  await mkdir(path.join(root, "src", "ignored"));
  await writeFile(path.join(root, "src", "ignored", "untracked.vue"), "uncommitted source\n");
  await assert.rejects(validateSource(root, selection, sha), /Untracked analyzable/);
});

test("each scanner family requires its real declared catalog source capability", () => {
  for (const [driver, languages] of [
    ["dotnet", ["csharp"]], ["cpp", ["cpp"]], ["cli", ["javascript", "typescript", "python", "php"]],
  ]) {
    for (const language of languages) validateDriver({ profile: { languages: [language] } }, driver);
    for (const unsupported of ["actions", "terraform", ...(driver === "dotnet" ? ["javascript"] : ["csharp"])]) {
      assert.throws(() => validateDriver({ profile: { languages: [unsupported] } }, driver), /catalog/);
    }
  }
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

test("slow successful provider responses cannot extend the ten-minute wall-clock budget", async (t) => {
  const start = Date.parse("2026-10-05T12:03:00Z");
  let elapsed = 0;
  let polls = 0;
  const timeouts = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    timeouts.push(milliseconds);
    return timeout(milliseconds);
  });
  await assert.rejects(verify(context, input, task.id, "test-token", {
    now: () => start + elapsed,
    request: async (url) => {
      if (url.includes("navigation")) return response(project);
      polls++;
      elapsed += Math.min(29_000, 600_000 - elapsed);
      return response({ task: { ...task, status: "PENDING" } });
    },
    sleep: async (milliseconds) => { elapsed += milliseconds; },
  }), /within ten minutes/);
  assert.equal(elapsed, 600_000);
  assert.equal(polls, 18);
  assert.equal(timeouts.at(-1), 22_000);
  assert.ok(timeouts.every((milliseconds) => milliseconds <= 30_000));
});

test("a success returned after the absolute deadline is not completed evidence", async () => {
  const start = Date.parse("2026-10-05T12:03:00Z");
  let elapsed = 0;
  await assert.rejects(verify(context, input, task.id, "test-token", {
    now: () => start + elapsed,
    request: async (url) => {
      if (url.includes("navigation")) return response(project);
      elapsed = 600_000;
      return response({ task });
    },
  }), /within ten minutes/);
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

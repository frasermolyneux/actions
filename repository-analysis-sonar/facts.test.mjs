import assert from "node:assert/strict";
import test from "node:test";
import { selectAnalysis } from "../repository-analysis-context/policy.mjs";
import { branchSnapshot, countedFiles, filePage, findingTotal, pullSnapshot, verifyFacts } from "./facts.mjs";

const sourceSha = "a".repeat(40);
const input = { repository: "owner/example", repositoryId: 123, projectKey: "owner_example",
  sourceSha, runId: 456, attempt: 2, branch: "main", pullRequest: null,
  startedAt: "2026-10-06T12:00:00.000Z" };
const context = selectAnalysis({ version: "repository-analysis-v1",
  languages: ["csharp", "javascript", "typescript", "cpp", "python", "php"], sonar: true },
{ id: 123, full_name: input.repository, visibility: "public", private: false,
  fork: false, archived: false, owner: { type: "User" } }, input.repository);
const proof = { sourceSha, projectKey: input.projectKey, policyDigest: context.policyDigest,
  run: { id: input.runId, attempt: input.attempt },
  processing: { id: "task_12345", status: "completed", analysisId: "analysis_12345",
    executedAt: "2026-10-06T12:02:00.000Z" },
  publication: { id: "analysis_12345" } };
const analysis = { key: proof.processing.analysisId, revision: sourceSha, date: "2026-10-06T12:01:00+0000" };
const file = (filename, language) => ({ key: `${input.projectKey}:${filename}`, path: filename,
  language, qualifier: "FIL" });
const files = [file("app.cs", "cs"), file("app.js", "js"), file("app.ts", "ts"),
  file("app.c", "c"), file("app.cpp", "cpp"), file("app.py", "py"), file("app.php", "php")];
const tracked = new Set(files.map(({ path }) => path));
const page = (components = files, total = components.length, pageIndex = 1) => ({
  baseComponent: { key: input.projectKey, qualifier: "TRK", visibility: "public" },
  paging: { pageIndex, pageSize: 500, total }, components: structuredClone(components),
});
const issues = (total) => ({ paging: { pageIndex: 1, pageSize: 1, total }, total,
  issues: total ? [{ project: input.projectKey, component: `${input.projectKey}:app.cs` }] : [] });
const pullInput = { ...input, pullRequest: 42 };
const pulls = { pullRequests: [{ key: "42", commit: { sha: sourceSha },
  analysisDate: analysis.date, url: `https://github.com/${input.repository}/pull/42` }] };
const receipt = { task: { type: "REPORT", status: "SUCCESS", componentKey: input.projectKey,
  id: proof.processing.id, analysisId: proof.processing.analysisId,
  submittedAt: "2026-10-06T12:01:30.000Z",
  executedAt: proof.processing.executedAt, pullRequest: "42" } };
const component = { queue: [], current: structuredClone(receipt.task) };

function reader(calls, mutate = (route, result) => result) {
  return async (route, timeout) => {
    assert(timeout > 0 && timeout <= 30000);
    calls.push(route);
    const url = new URL(route, "https://sonarcloud.io");
    let result;
    if (url.pathname === "/api/project_analyses/search") result = { analyses: [analysis] };
    else if (url.pathname === "/api/project_pull_requests/list") result = pulls;
    else if (url.pathname === "/api/ce/task") {
      assert.equal(url.searchParams.get("id"), proof.processing.id);
      assert.equal(url.searchParams.has("additionalFields"), false);
      result = receipt;
    } else if (url.pathname === "/api/ce/component") {
      assert.equal(url.searchParams.get("component"), input.projectKey);
      result = component;
    }
    else if (url.pathname === "/api/components/tree") result = page();
    else if (url.pathname === "/api/issues/search") result = issues(13);
    else assert.fail(`Unexpected provider route: ${route}`);
    return mutate(route, structuredClone(result));
  };
}

test("all selected languages count genuine provider file metadata, not tracked-file estimates", () => {
  const value = countedFiles(files, tracked, context.profile.languages, input.projectKey);
  assert.deepEqual(value.sourceCoverage,
    { csharp: 1, javascript: 1, typescript: 1, cpp: 2, python: 1, php: 1 });
  assert.equal(value.analyzedFiles, 7);
  assert.match(value.sourceMetadataDigest, /^[a-f0-9]{64}$/);
  assert.equal(countedFiles([...files].reverse(), tracked, context.profile.languages,
    input.projectKey).sourceMetadataDigest, value.sourceMetadataDigest);
});

test("data/template languages cannot stand in for an absent selected program capability", () => {
  assert.throws(() => countedFiles([file("page.html", "web")], new Set(["page.html"]),
    ["javascript"], input.projectKey), /every selected capability/);
});

test("unknown provider languages are not promoted into declared capability counts", () => {
  const result = countedFiles([...files, file("page.html", "web")],
    tracked, context.profile.languages, input.projectKey);
  assert.equal(result.analyzedFiles, files.length);
});

test("missing, changed, truncated and overflowing source pages fail explicitly", () => {
  assert.equal(filePage(page(), input.projectKey, 1, null), files.length);
  assert.equal(filePage(page([], 0), input.projectKey, 1, null), 0);
  for (const change of [
    (value) => { value.paging.total = 20001; },
    (value) => { value.paging.total = 1.5; },
    (value) => { value.paging.pageIndex = 2; },
    (value) => { value.paging.pageSize = 100; },
    (value) => { value.components.pop(); },
    (value) => { value.baseComponent.visibility = "private"; },
    (value) => { value.baseComponent.key = "another_project"; },
  ]) {
    const value = page(); change(value);
    assert.throws(() => filePage(value, input.projectKey, 1, null), /paging/);
  }
  assert.throws(() => filePage(page(), input.projectKey, 1, 8), /paging/);
  assert.throws(() => filePage({}, input.projectKey, 1, null), /paging/);
});

test("foreign, duplicate, untracked, generated and traversal files cannot prove source coverage", () => {
  for (const value of [
    { ...files[0], key: "other:app.cs" },
    { ...files[0], qualifier: "UTS" },
    { ...files[0], path: "../app.cs" },
    { ...files[0], path: "C:\\app.cs" },
    { ...files[0], path: "/app.cs" },
    { ...files[0], path: "absent.cs" },
    { ...files[0], path: "fixtures/app.cs" },
    { ...files[0], language: null },
  ]) {
    assert.throws(() => countedFiles([value], new Set([...tracked, "fixtures/app.cs"]),
      ["csharp"], input.projectKey), /metadata|maintained/);
  }
  assert.throws(() => countedFiles([files[0], files[0]], tracked,
    ["csharp"], input.projectKey), /duplicated/);
});

test("raw unresolved findings preserve historical nonzero counts without imposing a backlog gate", () => {
  assert.equal(findingTotal(issues(13), input.projectKey), 13);
  assert.equal(findingTotal(issues(0), input.projectKey), 0);
  const projectIssue = issues(1);
  projectIssue.issues[0].component = input.projectKey;
  assert.equal(findingTotal(projectIssue, input.projectKey), 1);
});

test("missing, inconsistent and foreign issue counts never become a zero-finding fallback", () => {
  for (const value of [{}, { ...issues(0), total: 1 },
    { ...issues(1), issues: [] }, { ...issues(0), paging: { pageIndex: 1, pageSize: 1, total: -1 } },
    { ...issues(1), issues: [{ project: "other", component: "other:file.cs" }] }]) {
    assert.throws(() => findingTotal(value, input.projectKey), /finding count/);
  }
});

test("default snapshot must bind exact provider analysis identity and actual revision", () => {
  assert.equal(branchSnapshot({ analyses: [analysis] }, input, proof).analysisId, analysis.key);
  for (const patch of [{ key: "another" }, { revision: "b".repeat(40) }, { date: null }]) {
    assert.throws(() => branchSnapshot({ analyses: [{ ...analysis, ...patch }] }, input, proof),
      /latest exact-source/);
  }
});

test("default analysis timestamps must identify an unambiguous latest result", () => {
  const older = { ...analysis, key: "previous", date: "2026-10-06T11:59:00+0000" };
  assert.equal(branchSnapshot({ analyses: [analysis, older] }, input, proof).analysisId, analysis.key);
  for (const date of [analysis.date, "2026-10-06T14:01:00+0200",
    "2026-10-06T12:03:00+0000", "malformed"]) {
    assert.throws(() => branchSnapshot({ analyses: [analysis, { ...older, date }] }, input, proof),
      /unambiguous latest exact-source/);
  }
});

test("PR snapshot correlates its actual merge source with its current verified receipt", () => {
  assert.equal(pullSnapshot(pulls, receipt, component, pullInput, proof).taskId, proof.processing.id);
  for (const patch of [{ pullRequest: "43" }, { id: "another" }, { analysisId: "another" },
    { status: "FAILED" }, { componentKey: "other" }, { executedAt: "malformed" },
    { submittedAt: "2026-10-06T11:59:00.000Z" },
    { executedAt: "2026-10-06T12:03:00.000Z" }]) {
    assert.throws(() => pullSnapshot(pulls, { task: { ...receipt.task, ...patch } },
      component, pullInput, proof), /latest successful/);
    assert.throws(() => pullSnapshot(pulls, receipt,
      { ...component, current: { ...component.current, ...patch } }, pullInput, proof),
    /latest successful/);
  }
  assert.throws(() => pullSnapshot(pulls, receipt, { ...component, queue: [{ id: "pending" }] },
    pullInput, proof), /completed-task/);
  assert.throws(() => pullSnapshot(pulls, {}, component, pullInput, proof), /latest successful/);
  assert.throws(() => pullSnapshot(pulls, receipt, { queue: [] }, pullInput, proof), /latest successful/);
  assert.throws(() => pullSnapshot({ pullRequests: [...pulls.pullRequests, ...pulls.pullRequests] },
    receipt, component, pullInput, proof), /ambiguous/);
  assert.throws(() => pullSnapshot({ pullRequests: [{ ...pulls.pullRequests[0], commit: { sha: "b".repeat(40) } }] },
    receipt, component, pullInput, proof), /actual source/);
});

test("bounded default verification binds counts between identical provider snapshots", async () => {
  const calls = [];
  const facts = await verifyFacts(context, input, proof, tracked, reader(calls));
  assert.equal(facts.findingCount, 13);
  assert.equal(facts.sourceCoverage.cpp, 2);
  assert.equal(calls.filter((route) => route.startsWith("/api/project_analyses/search")).length, 2);
  const issueQuery = new URL(calls.find((route) => route.startsWith("/api/issues/search")), "https://sonarcloud.io");
  assert.equal(issueQuery.searchParams.get("resolved"), "false");
  assert.equal(issueQuery.searchParams.get("branch"), "main");
  assert.equal(issueQuery.searchParams.has("pullRequest"), false);
});

test("PR verification never reads default-branch findings or treats PR collection as default freshness", async () => {
  const calls = [];
  const facts = await verifyFacts(context, pullInput, proof, tracked, reader(calls));
  assert.equal(facts.snapshot.sourceSha, sourceSha);
  assert.equal(facts.findingCount, 13);
  assert.equal(facts.scope, "pull-request-incremental");
  assert.equal(facts.sourceCoverage, null);
  assert.equal(facts.sourceCoverageStatus, "incremental-pr-only");
  assert.equal(facts.reportedSourceCoverage.cpp, 2);
  assert.equal(calls.filter((route) => route.startsWith("/api/ce/task")).length, 2);
  assert.equal(calls.filter((route) => route.startsWith("/api/ce/component")).length, 2);
  assert.equal(calls.some((route) => route.startsWith("/api/ce/activity")), false);
  assert.equal(calls.some((route) => route.startsWith("/api/project_analyses/")), false);
  for (const route of calls.filter((entry) => /\/(?:components|issues)\//.test(entry))) {
    const query = new URL(route, "https://sonarcloud.io").searchParams;
    assert.equal(query.get("pullRequest"), "42");
    assert.equal(query.has("branch"), false);
  }
});

test("genuine empty PR metadata records its limitation instead of failing task validation or inventing full coverage", async () => {
  const facts = await verifyFacts(context, pullInput, proof, tracked,
    reader([], (route, value) => route.startsWith("/api/components/tree") ? page([]) : value));
  assert.equal(facts.reportedFiles, 0);
  assert.equal(facts.sourceCoverage, null);
  assert.equal(facts.sourceCoverageStatus, "incremental-pr-only");
  assert.match(facts.sourceCoverageReason, /does not establish whole-branch/);
  assert.equal(facts.findingCount, 13);
  assert.equal(facts.snapshot.taskId, proof.processing.id);
  assert.equal(facts.analyzedFiles, undefined);
  await assert.rejects(verifyFacts(context, input, proof, tracked,
    reader([], (route, value) => route.startsWith("/api/components/tree") ? page([]) : value)),
  /every selected capability/);
});

test("partial PR file populations cannot claim complete multi-language coverage", () => {
  const value = countedFiles([files[0]], tracked, context.profile.languages, input.projectKey, false);
  assert.equal(value.sourceCoverage, null);
  assert.equal(value.reportedFiles, 1);
  assert.equal(value.reportedSourceCoverage.csharp, 1);
  assert.equal(value.reportedSourceCoverage.javascript, 0);
  assert.throws(() => countedFiles([files[0]], tracked, context.profile.languages, input.projectKey),
    /every selected capability/);
  assert.throws(() => countedFiles([{ ...files[0], path: "absent.cs" }], tracked,
    context.profile.languages, input.projectKey, false), /maintained tracked source/);
});

test("complete paging actually consumes a second page before emitting source facts", async () => {
  const large = Array.from({ length: 501 }, (_, index) => file(`file${index}.cs`, "cs"));
  const calls = [];
  const single = selectAnalysis({ ...context.profile, languages: ["csharp"] },
    { id: 123, full_name: input.repository, visibility: "public", private: false,
      fork: false, archived: false, owner: { type: "User" } }, input.repository);
  const facts = await verifyFacts(single, input, { ...proof, policyDigest: single.policyDigest },
    new Set(large.map(({ path }) => path)),
    reader(calls, (route, value) => {
      if (!route.startsWith("/api/components/tree")) return value;
      const index = Number(new URL(route, "https://sonarcloud.io").searchParams.get("p"));
      return page(large.slice((index - 1) * 500, index * 500), 501, index);
    }));
  assert.equal(facts.sourceCoverage.csharp, 501);
  assert.equal(calls.filter((route) => route.startsWith("/api/components/tree")).length, 2);
});

test("superseding analysis and API errors are explicit failures, not clean data", async () => {
  let snapshots = 0;
  await assert.rejects(verifyFacts(context, input, proof, tracked,
    reader([], (route, value) => {
      if (route.startsWith("/api/project_analyses/search") && ++snapshots === 2) {
        value.analyses[0].key = "superseding";
      }
      return value;
    })), /latest exact-source/);
  await assert.rejects(verifyFacts(context, input, proof, tracked,
    async () => { throw new Error("Provider request failed (HTTP 403)"); }), /HTTP 403/);
});

test("superseding or queued project tasks cannot relabel PR facts as the receipt's analysis", async () => {
  for (const patch of [
    { ...component, current: { ...component.current, id: "superseding" } },
    { ...component, queue: [{ id: "queued" }] },
  ]) {
    let snapshots = 0;
    await assert.rejects(verifyFacts(context, pullInput, proof, tracked,
      reader([], (route, value) => route.startsWith("/api/ce/component") && ++snapshots === 2
        ? patch : value)), /latest successful|completed-task/);
  }
});

test("absolute source/finding deadline includes time spent in provider calls", async () => {
  let clock = 0;
  await assert.rejects(verifyFacts(context, input, proof, tracked,
    async () => { clock += 120001; return { analyses: [analysis] }; }, () => clock), /two-minute deadline/);
});

test("private, foreign, uncompleted and stale producer identities cannot request facts", async () => {
  for (const changed of [{ ...context, visibility: "private" }, { ...context, repositoryId: 99 },
    { ...context, sonar: { status: "unavailable" } }]) {
    await assert.rejects(verifyFacts(changed, input, proof, tracked,
      async () => assert.fail("Must refuse before provider read")), /live public/);
  }
  for (const patch of [{ sourceSha: "b".repeat(40) }, { run: { ...proof.run, attempt: 1 } },
    { processing: { ...proof.processing, status: "pending" } }]) {
    await assert.rejects(verifyFacts(context, input, { ...proof, ...patch }, tracked,
      async () => assert.fail("Must refuse before provider read")), /live public/);
  }
});

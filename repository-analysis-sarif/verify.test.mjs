import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main, PROOF_SCHEMA, verify } from "./verify.mjs";

const SHA = "a".repeat(40);
const UUID = "695b0e3c-c088-11f1-98eb-30da116a4774";
const START = "2026-10-05T06:44:56Z";
const CREATED = "2026-10-05T06:45:54Z";
const NOW = Date.parse("2026-10-05T06:46:00Z");
const REPO = "owner/example";
const WORKFLOW = ".github/workflows/analysis.yml";

function sign(material) {
  const { policyDigest: _discarded, ...value } = material;
  return { ...value, policyDigest: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}

function fixture() {
  const context = sign({
    contract: "repository-analysis-v1", repository: REPO, repositoryId: 123, visibility: "public",
    profile: { version: "repository-analysis-v1", languages: ["actions"], sonar: false },
    codeql: { status: "eligible", languages: ["actions"] },
    localTools: [{ tool: "zizmor", languages: ["actions"] }],
    publication: { sarif: "github-security" },
  });
  return {
    context,
    input: { toolId: "codeql/actions", version: "2.27.1", sourceSha: SHA, uploadId: UUID },
    runtime: { repository: REPO, repositoryId: 123, runId: 321, attempt: 2, event: "push",
      job: "native", ref: "refs/heads/main", sourceSha: SHA, logicalHeadSha: SHA,
      workflowRef: `${REPO}/${WORKFLOW}@refs/heads/main`, workflowSha: "b".repeat(40) },
    metadata: { id: 123, full_name: REPO, private: false, visibility: "public", archived: false, fork: false },
    run: { id: 321, run_attempt: 2, head_sha: SHA, event: "push", path: WORKFLOW,
      run_started_at: START, repository: { id: 123, full_name: REPO } },
    upload: { processing_status: "complete", errors: null, analyses_url: "https://evil.example/token" },
    analyses: [{ id: 987, sarif_id: UUID, commit_sha: SHA, ref: "refs/heads/main",
      tool: { name: "CodeQL", version: "2.27.1" }, category: "/language:actions",
      analysis_key: `${WORKFLOW}:native`, created_at: CREATED, error: "", results_count: 0, rules_count: 10 }],
    calls: [], sleeps: [],
  };
}

function dependencies(f) {
  return {
    now: () => NOW,
    sleep: async (milliseconds) => f.sleeps.push(milliseconds),
    request: async (url, options) => {
      f.calls.push({ url, options });
      if (f.transportError) throw new Error("secret transport payload");
      if (f.httpStatus) return new Response("secret provider payload", { status: f.httpStatus });
      let body;
      if (url === `https://api.github.com/repos/${REPO}`) body = f.metadata;
      else if (url.endsWith("/attempts/2")) body = f.run;
      else if (url.endsWith(`/sarifs/${UUID}`)) {
        body = f.uploads?.length ? f.uploads.shift() : f.upload;
      } else if (url.endsWith(`analyses?sarif_id=${UUID}&per_page=100`)) body = f.analyses;
      else throw new Error(`Unexpected test request: ${url}`);
      return new Response(f.rawBody ?? JSON.stringify(body));
    },
  };
}

const execute = (f) => verify(f.context, f.input, f.runtime, "test-token", dependencies(f));

test("zero findings require an actual completed upload and native analysis", async () => {
  const f = fixture();
  const proof = await execute(f);
  assert.equal(proof.schema, PROOF_SCHEMA);
  assert.deepEqual(proof.processing, { status: "completed", id: UUID });
  assert.deepEqual(proof.publication, { destination: "github-security", status: "completed", id: "987" });
  assert.equal(proof.findingCount, 0);
  assert.equal(proof.sourceSha, SHA);
  assert.equal(proof.run.attempt, 2);
  assert.equal(f.calls.length, 4);
  assert(f.calls.every(({ url, options }) => url.startsWith("https://api.github.com/repos/owner/example") &&
    options.redirect === "error" && options.headers.Authorization === "Bearer test-token"));
  assert(!JSON.stringify(proof).includes("test-token"));
  assert(!JSON.stringify(proof).includes("evil"));
});

test("pending upload is polled before looking up native analyses", async () => {
  const f = fixture();
  f.uploads = [{ processing_status: "pending", errors: null }, f.upload];
  assert.equal((await execute(f)).publication.id, "987");
  assert.deepEqual(f.sleeps, [5000]);
});

test("bounded pending upload never becomes successful zero findings", async () => {
  const f = fixture();
  f.upload = { processing_status: "pending", errors: null };
  await assert.rejects(execute(f), /still pending/);
  assert.equal(f.sleeps.length, 59);
  assert.equal(f.calls.length, 62);
  assert(!f.calls.some(({ url }) => url.includes("/analyses?")));
});

test("local tools use the selected complementary category and observed version", async () => {
  const f = fixture();
  f.input.toolId = "local/zizmor";
  f.input.version = "1.30.1";
  Object.assign(f.analyses[0], { tool: { name: "zizmor", version: "1.30.1" }, category: "/tool:zizmor/" });
  assert.equal((await execute(f)).category, "/tool:zizmor/");
});

test("PR merge source and logical head remain distinct and independently bound", async () => {
  const f = fixture();
  f.runtime.event = f.run.event = "pull_request";
  f.runtime.logicalHeadSha = f.run.head_sha = "c".repeat(40);
  f.runtime.ref = f.analyses[0].ref = "refs/pull/42/merge";
  f.runtime.workflowRef = `${REPO}/${WORKFLOW}@refs/pull/42/merge`;
  const proof = await execute(f);
  assert.equal(proof.sourceSha, SHA);
  assert.equal(proof.run.logicalHeadSha, "c".repeat(40));
});

for (const [label, change, pattern] of [
  ["private context", (f) => { f.context = sign({ ...f.context, visibility: "private" }); }, /live public/],
  ["exempt context", (f) => { f.context = sign({ ...f.context, profile: { exemption: {} } }); }, /live public/],
  ["no native publication", (f) => {
    f.context = sign({ ...f.context, publication: { sarif: "not-available" } });
  }, /live public/],
  ["tampered selection", (f) => { f.context.codeql.languages.push("python"); }, /digest mismatch/],
  ["unselected CodeQL language", (f) => { f.input.toolId = "codeql/python"; }, /not selected/],
  ["unselected local tool", (f) => { f.input.toolId = "local/checkov"; }, /not selected/],
  ["unknown tool", (f) => { f.input.toolId = "sonar"; }, /Unsupported native tool/],
  ["wrong repository", (f) => { f.runtime.repository = "other/repository"; }, /repository identity/],
  ["wrong immutable repository ID", (f) => { f.runtime.repositoryId = 456; }, /repository identity/],
  ["invalid run", (f) => { f.runtime.runId = NaN; }, /runtime identity/],
  ["invalid attempt", (f) => { f.runtime.attempt = 0; }, /runtime identity/],
  ["invalid job", (f) => { f.runtime.job = "job\nmalicious"; }, /runtime identity/],
  ["foreign definition", (f) => { f.runtime.workflowRef = `other/repo/${WORKFLOW}@refs/heads/main`; },
    /workflow reference/],
  ["different checked-out source", (f) => { f.input.sourceSha = "c".repeat(40); }, /exact workflow source/],
  ["floating version", (f) => { f.input.version = "latest"; }, /pinned observed tool version/],
  ["invalid upload identity", (f) => { f.input.uploadId = "bad/id"; }, /upload identity/],
  ["invalid ref", (f) => { f.runtime.ref = "refs/heads/main\nx"; }, /analysis reference/],
]) {
  test(`${label} fails before provider access`, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(execute(f), pattern);
    assert.equal(f.calls.length, 0);
  });
}

for (const [label, change, pattern] of [
  ["public-to-private visibility race", (f) => { f.metadata.private = true; f.metadata.visibility = "private"; },
    /eligibility changed/],
  ["inconsistent visibility", (f) => { f.metadata.private = true; }, /eligibility changed/],
  ["repository identity race", (f) => { f.metadata.id = 456; }, /eligibility changed/],
  ["archived source", (f) => { f.metadata.archived = true; }, /eligibility changed/],
  ["different run", (f) => { f.run.id = 322; }, /producer run/],
  ["older attempt", (f) => { f.run.run_attempt = 1; }, /producer run/],
  ["different producer repository", (f) => { f.run.repository.id = 456; }, /producer run/],
  ["different logical head", (f) => { f.run.head_sha = "c".repeat(40); }, /logical head/],
  ["different producer workflow", (f) => { f.run.path = ".github/workflows/other.yml"; }, /workflow mismatch/],
  ["different event", (f) => { f.run.event = "pull_request_target"; }, /producer run/],
  ["future run", (f) => { f.run.run_started_at = "2026-10-05T06:47:00Z"; }, /start is in the future/],
  ["failed processing", (f) => { f.upload.processing_status = "failed"; }, /processing failed/],
  ["unexpected processing", (f) => { f.upload.processing_status = "unknown"; }, /Unknown native/],
  ["processing errors", (f) => { f.upload.errors = ["secret provider message"]; }, /reported errors/],
  ["missing native analysis", (f) => { f.analyses = []; }, /Missing or ambiguous/],
  ["wrong upload analysis", (f) => { f.analyses[0].sarif_id = "other"; }, /unbound native/],
  ["ambiguous native analysis", (f) => { f.analyses.push({ ...f.analyses[0], id: 988 }); }, /ambiguous/],
  ["truncated native analyses", (f) => { f.analyses = Array(100).fill(f.analyses[0]); }, /oversized/],
  ["wrong category", (f) => { f.analyses[0].category = "/language:python"; }, /Missing or ambiguous/],
  ["different tool", (f) => { f.analyses[0].tool.name = "Other"; }, /Missing or ambiguous/],
  ["different tool version", (f) => { f.analyses[0].tool.version = "2.27.0"; }, /version/],
  ["different actual source", (f) => { f.analyses[0].commit_sha = "c".repeat(40); }, /source/],
  ["different native ref", (f) => { f.analyses[0].ref = "refs/heads/other"; }, /ref/],
  ["different producer job", (f) => { f.analyses[0].analysis_key = `${WORKFLOW}:other`; }, /producer category/],
  ["prior same-source upload", (f) => { f.analyses[0].created_at = "2026-10-05T06:44:55Z"; }, /predates/],
  ["future upload", (f) => { f.analyses[0].created_at = "2026-10-05T06:47:00Z"; }, /future creation/],
  ["impossible creation time", (f) => { f.analyses[0].created_at = "2026-02-30T06:45:54Z"; }, /timestamp/],
  ["invalid analysis ID", (f) => { f.analyses[0].id = 0; }, /Native analysis source/],
  ["analysis error", (f) => { f.analyses[0].error = "source analysis failed"; }, /has errors/],
  ["missing finding count", (f) => { delete f.analyses[0].results_count; }, /missing result counts/],
  ["negative finding count", (f) => { f.analyses[0].results_count = -1; }, /missing result counts/],
  ["invalid rule count", (f) => { f.analyses[0].rules_count = "10"; }, /missing result counts/],
  ["malformed JSON", (f) => { f.rawBody = "secret non-JSON"; }, /Malformed native/],
  ["HTTP denial", (f) => { f.httpStatus = 403; }, /HTTP 403/],
  ["transport failure", (f) => { f.transportError = true; }, /transport/],
  ["oversized response", (f) => { f.rawBody = " ".repeat(1024 * 1024 + 1); }, /bounded limit/],
]) {
  test(`${label} fails explicitly without completion`, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(execute(f), pattern);
  });
}

test("another tool in the same upload cannot substitute for the selected analysis", async () => {
  const f = fixture();
  f.analyses.push({ ...f.analyses[0], id: 988, tool: { name: "zizmor", version: "1.30.1" },
    category: "/tool:zizmor" });
  assert.equal((await execute(f)).publication.id, "987");
});

test("main persists only bounded completion metadata and emits no success on failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sarif-proof-test-"));
  try {
    const f = fixture();
    const output = path.join(directory, "output");
    const summary = path.join(directory, "summary");
    const env = {
      RUNNER_TEMP: directory, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
      ANALYSIS_CONTEXT: JSON.stringify(f.context), ANALYSIS_TOOL: f.input.toolId,
      ANALYSIS_TOOL_VERSION: f.input.version, ANALYSIS_SOURCE_SHA: SHA, ANALYSIS_SARIF_ID: UUID,
      GH_TOKEN: "test-token", GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: "123",
      GITHUB_RUN_ID: "321", GITHUB_RUN_ATTEMPT: "2", GITHUB_EVENT_NAME: "push",
      GITHUB_JOB: "native", GITHUB_REF: f.runtime.ref, GITHUB_SHA: SHA,
      ANALYSIS_LOGICAL_SHA: SHA, GITHUB_WORKFLOW_REF: f.runtime.workflowRef,
      GITHUB_WORKFLOW_SHA: f.runtime.workflowSha,
    };
    const proof = await main(env, dependencies(f));
    const text = await readFile(output, "utf8");
    assert.match(text, /^analysis-id=987\nproof-directory=/);
    const proofDirectory = text.split("proof-directory=")[1].trim();
    assert.deepEqual(JSON.parse(await readFile(path.join(proofDirectory, "proof.json"), "utf8")), proof);
    f.analyses[0].commit_sha = "c".repeat(40);
    await assert.rejects(main(env, dependencies(f)), /source/);
    assert.equal(await readFile(output, "utf8"), text);
    assert(!(await readFile(summary, "utf8")).includes("test-token"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

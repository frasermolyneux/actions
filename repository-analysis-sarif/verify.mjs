import { createHash } from "node:crypto";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const PROOF_SCHEMA = "repository-analysis-sarif-proof-v1";
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const VERSION = /^\d+(?:\.\d+){2,3}(?:[+-][A-Za-z0-9.-]+)?$/;
const RESPONSE_LIMIT = 1024 * 1024;
const MAX_POLLS = 60;
const POLL_MS = 5000;
const CODEQL = new Set(["actions", "csharp", "cpp", "javascript-typescript", "python"]);
const LOCAL = new Map([
  ["zizmor", "zizmor"], ["semgrep-ce", "Semgrep"], ["checkov", "checkov"],
  ["bandit", "Bandit"], ["shellcheck", "ShellCheck"], ["psscriptanalyzer", "PSScriptAnalyzer"],
]);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function timestamp(value, label) {
  requireValue(typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value),
  `Invalid ${label} timestamp`);
  const milliseconds = Date.parse(value);
  requireValue(Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString().slice(0, 19) === value.slice(0, 19),
  `Invalid ${label} timestamp`);
  return milliseconds;
}

function selectedTool(context, id) {
  requireValue(context?.contract === "repository-analysis-v1" && context.visibility === "public" &&
    context.publication?.sarif === "github-security" && !context.profile?.exemption,
  "Native SARIF verification requires a live public eligible repository");
  const { policyDigest, ...material } = context;
  requireValue(createHash("sha256").update(JSON.stringify(material)).digest("hex") === policyDigest,
    "Live analysis context digest mismatch");
  if (typeof id === "string" && id.startsWith("codeql/")) {
    const language = id.slice(7);
    requireValue(CODEQL.has(language) && context.codeql?.status === "eligible" &&
      Array.isArray(context.codeql.languages) && context.codeql.languages.includes(language),
    "CodeQL tool is not selected by live policy");
    return { name: "CodeQL", category: `/language:${language}` };
  }
  if (typeof id === "string" && id.startsWith("local/")) {
    const tool = id.slice(6);
    requireValue(LOCAL.has(tool) && Array.isArray(context.localTools) &&
      context.localTools.some((entry) => entry?.tool === tool),
      "Local tool is not selected by live policy");
    return { name: LOCAL.get(tool), category: `/tool:${tool}` };
  }
  throw new Error("Unsupported native tool identity");
}

function validateRuntime(context, input, runtime) {
  requireValue(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(runtime.repository ?? "") &&
    context.repository?.toLowerCase() === runtime.repository.toLowerCase() &&
    Number.isSafeInteger(runtime.repositoryId) && runtime.repositoryId > 0 &&
    context.repositoryId === runtime.repositoryId, "Unexpected immutable workflow repository identity");
  requireValue(Number.isSafeInteger(runtime.runId) && runtime.runId > 0 &&
    Number.isSafeInteger(runtime.attempt) && runtime.attempt > 0 &&
    /^[A-Za-z_][A-Za-z0-9_-]*$/.test(runtime.job ?? "") &&
    SHA.test(runtime.workflowSha ?? "") && SHA.test(runtime.logicalHeadSha ?? "") &&
    ["push", "pull_request", "schedule", "workflow_dispatch"].includes(runtime.event),
  "Invalid native producer runtime identity");
  requireValue(typeof runtime.workflowRef === "string" &&
    runtime.workflowRef.startsWith(`${runtime.repository}/.github/workflows/`) &&
    /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(
      runtime.workflowRef.slice(runtime.repository.length + 1).split("@", 1)[0]),
  "Invalid native producer workflow reference");
  requireValue(SHA.test(input.sourceSha ?? "") && input.sourceSha === runtime.sourceSha &&
    UUID.test(input.uploadId ?? "") && typeof input.version === "string" &&
    input.version.length <= 80 && VERSION.test(input.version),
  "An exact workflow source, upload identity and pinned observed tool version are required");
  requireValue(typeof runtime.ref === "string" && runtime.ref.length <= 512 &&
    /^refs\/(?:heads\/|tags\/|pull\/[1-9]\d*\/(?:merge|head)$)/.test(runtime.ref) &&
    !/[\x00-\x20\x7f\\~^:?*\[]/.test(runtime.ref) &&
    !runtime.ref.includes("..") && !runtime.ref.includes("//") &&
    !runtime.ref.endsWith("/") && !runtime.ref.endsWith(".lock"),
  "Invalid native analysis reference");
}

async function getJson(endpoint, token, request) {
  let response;
  try {
    response = await request(`https://api.github.com${endpoint}`, {
      headers: {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("Native provider metadata request failed (transport)");
  }
  requireValue(response.ok, `Native provider metadata request failed (HTTP ${response.status})`);
  const chunks = [];
  let bytes = 0;
  requireValue(response.body, "Native provider metadata response is empty");
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > RESPONSE_LIMIT) {
      throw new Error("Native provider metadata response exceeds the bounded limit");
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Malformed native provider metadata JSON");
  }
}

export async function verify(context, input, runtime, token, {
  request = fetch, sleep = delay, now = Date.now,
} = {}) {
  const selected = selectedTool(context, input.toolId);
  validateRuntime(context, input, runtime);
  requireValue(typeof token === "string" && /^[\x21-\x7e]+$/.test(token),
    "A valid native provider metadata-read token is required");
  const prefix = `/repos/${runtime.repository}`;
  const metadata = await getJson(prefix, token, request);
  requireValue(metadata?.id === runtime.repositoryId &&
    metadata.full_name?.toLowerCase() === runtime.repository.toLowerCase() &&
    metadata.private === false && metadata.visibility === "public" &&
    metadata.archived === false && metadata.fork === false,
  "Live native publication eligibility changed or metadata is inconsistent");
  const run = await getJson(`${prefix}/actions/runs/${runtime.runId}/attempts/${runtime.attempt}`,
    token, request);
  const workflowPath = runtime.workflowRef.slice(runtime.repository.length + 1).split("@", 1)[0];
  requireValue(run?.id === runtime.runId && run.run_attempt === runtime.attempt &&
    run.repository?.id === runtime.repositoryId &&
    run.repository.full_name?.toLowerCase() === runtime.repository.toLowerCase() &&
    run.head_sha === runtime.logicalHeadSha && run.event === runtime.event && run.path === workflowPath,
  "Native producer run, attempt, repository, logical head or workflow mismatch");
  const startedAt = timestamp(run.run_started_at, "native producer start");
  requireValue(startedAt <= now(), "Native producer start is in the future");
  let complete = false;
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    const upload = await getJson(`${prefix}/code-scanning/sarifs/${input.uploadId}`, token, request);
    requireValue(["pending", "complete", "failed"].includes(upload?.processing_status),
      "Unknown native SARIF processing state");
    requireValue(upload.processing_status !== "failed", "Native SARIF processing failed");
    requireValue(upload.errors === null || (Array.isArray(upload.errors) && upload.errors.length === 0),
      "Native SARIF processing reported errors");
    if (upload.processing_status === "complete") {
      complete = true;
      break;
    }
    if (poll + 1 < MAX_POLLS) await sleep(POLL_MS);
  }
  requireValue(complete, "Native SARIF processing is still pending after the bounded wait");
  // Construct the endpoint locally: provider-supplied links never receive credentials.
  const analyses = await getJson(`${prefix}/code-scanning/analyses?sarif_id=${input.uploadId}&per_page=100`,
    token, request);
  requireValue(Array.isArray(analyses) && analyses.length < 100 &&
    analyses.every((analysis) => analysis?.sarif_id === input.uploadId),
  "Missing, oversized or unbound native analysis response");
  const matching = analyses.filter((analysis) =>
    typeof analysis.tool?.name === "string" &&
    analysis.tool.name.toLowerCase() === selected.name.toLowerCase() &&
    [selected.category, `${selected.category}/`].includes(analysis.category));
  requireValue(matching.length === 1, "Missing or ambiguous selected native analysis");
  const analysis = matching[0];
  requireValue(Number.isSafeInteger(analysis.id) && analysis.id > 0 &&
    analysis.commit_sha === input.sourceSha && analysis.ref === runtime.ref &&
    analysis.tool.version === input.version &&
    analysis.analysis_key === `${workflowPath}:${runtime.job}`,
  "Native analysis source, ref, version or producer category mismatch");
  requireValue(analysis.error === "" && Number.isSafeInteger(analysis.results_count) &&
    analysis.results_count >= 0 && Number.isSafeInteger(analysis.rules_count) && analysis.rules_count >= 0,
  "Native analysis has errors or missing result counts");
  const createdAt = timestamp(analysis.created_at, "native analysis creation");
  requireValue(createdAt >= startedAt && createdAt <= now(),
    "Native analysis predates this attempt or has a future creation time");
  return {
    schema: PROOF_SCHEMA, repository: context.repository, repositoryId: context.repositoryId,
    visibility: "public", policyDigest: context.policyDigest, toolId: input.toolId,
    sourceSha: input.sourceSha, ref: runtime.ref,
    run: { id: runtime.runId, attempt: runtime.attempt, workflowPath,
      workflowSha: runtime.workflowSha, job: runtime.job, logicalHeadSha: runtime.logicalHeadSha },
    processing: { status: "completed", id: input.uploadId },
    publication: { destination: "github-security", status: "completed", id: String(analysis.id) },
    tool: { name: analysis.tool.name, version: analysis.tool.version },
    category: analysis.category, findingCount: analysis.results_count, ruleCount: analysis.rules_count,
    createdAt: analysis.created_at, verifiedAt: new Date(now()).toISOString(),
  };
}

export async function main(env = process.env, dependencies) {
  requireValue(env.RUNNER_TEMP && env.GITHUB_OUTPUT && env.GITHUB_STEP_SUMMARY,
    "Runner temporary, output and summary paths are required");
  requireValue((env.ANALYSIS_CONTEXT ?? "").length <= 128 * 1024,
    "Analysis context exceeds the bounded limit");
  const proof = await verify(JSON.parse(env.ANALYSIS_CONTEXT ?? ""), {
    toolId: env.ANALYSIS_TOOL, version: env.ANALYSIS_TOOL_VERSION,
    sourceSha: env.ANALYSIS_SOURCE_SHA, uploadId: env.ANALYSIS_SARIF_ID,
  }, {
    repository: env.GITHUB_REPOSITORY, repositoryId: Number(env.GITHUB_REPOSITORY_ID),
    runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT),
    event: env.GITHUB_EVENT_NAME, job: env.GITHUB_JOB, ref: env.GITHUB_REF,
    sourceSha: env.GITHUB_SHA, logicalHeadSha: env.ANALYSIS_LOGICAL_SHA,
    workflowRef: env.GITHUB_WORKFLOW_REF, workflowSha: env.GITHUB_WORKFLOW_SHA,
  }, env.GH_TOKEN, dependencies);
  const directory = await mkdtemp(path.join(env.RUNNER_TEMP, "repository-analysis-sarif-"));
  await writeFile(path.join(directory, "proof.json"), JSON.stringify(proof));
  await appendFile(env.GITHUB_OUTPUT,
    `analysis-id=${proof.publication.id}\nproof-directory=${directory}\n`);
  await appendFile(env.GITHUB_STEP_SUMMARY, [
    "### Native SARIF processing", "",
    `Tool: **${proof.tool.name} ${proof.tool.version}**. Native processing: **completed**.`,
    `Upload: \`${proof.processing.id}\`. Analysis: \`${proof.publication.id}\`.`,
    "Provider completion is not source-coverage, query-pin or complete-profile evidence.",
    "",
  ].join("\n"));
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::${error instanceof SyntaxError ? "Malformed native analysis context JSON" : error.message}`);
    process.exitCode = 1;
  }
}

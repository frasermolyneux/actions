import { createHash } from "node:crypto";
import { appendFile, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RESULT_SCHEMA = "repository-analysis-result-v1";
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const RESULT_LIMIT = 128 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const VERSION = /^\d+(?:\.\d+){2,3}(?:[+-][A-Za-z0-9.-]+)?$/;
const SOURCE = ["actions", "csharp", "cpp", "javascript", "typescript", "python", "php",
  "terraform", "bicep", "dockerfile", "ansible", "powershell", "shell"];
const LOCAL = ["zizmor", "semgrep-ce", "checkov", "bandit", "shellcheck", "psscriptanalyzer"];
const CODEQL = ["actions", "csharp", "cpp", "javascript-typescript", "python"];
const SONAR = ["csharp", "cpp", "javascript", "typescript", "python", "php"];
const EVENTS = ["push", "pull_request", "schedule", "workflow_dispatch"];
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 600;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, allowed, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `Missing ${label}`);
  requireValue(Object.keys(value).every((key) => allowed.includes(key)), `Unsupported ${label} field`);
}

function timestamp(value, label) {
  requireValue(typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value),
  `Invalid ${label} timestamp`);
  const milliseconds = Date.parse(value);
  requireValue(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 19) === value.slice(0, 19),
    `Invalid ${label} timestamp`);
  return milliseconds;
}

export function selectedTools(context) {
  object(context, ["contract", "repository", "repositoryId", "visibility", "ownerType", "profile",
    "codeql", "localTools", "publication", "sonar", "limitations", "policyDigest"], "live analysis context");
  requireValue(context.contract === "repository-analysis-v1" &&
    /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(context.repository ?? "") &&
    positive(context.repositoryId) && ["public", "private"].includes(context.visibility) &&
    DIGEST.test(context.policyDigest ?? ""), "Invalid live analysis identity");
  const { policyDigest, ...material } = context;
  requireValue(hash(material) === policyDigest, "Live analysis context digest mismatch");
  requireValue(context.profile?.version === context.contract &&
    Array.isArray(context.profile.languages) &&
    context.profile.languages.every((language) => SOURCE.includes(language)) &&
    new Set(context.profile.languages).size === context.profile.languages.length,
  "Invalid selected source capabilities");
  requireValue(Array.isArray(context.codeql?.languages) && Array.isArray(context.localTools) &&
    Array.isArray(context.limitations), "Incomplete live tool selection");
  requireValue(context.codeql.languages.every((language) => CODEQL.includes(language)) &&
    new Set(context.codeql.languages).size === context.codeql.languages.length,
  "Invalid selected CodeQL capabilities");
  requireValue(context.visibility !== "private" ||
    (context.codeql.languages.length === 0 && context.sonar.status !== "eligible" &&
      context.publication.sarif === "not-available"), "Private native/provider execution is prohibited");
  const tools = context.codeql.languages.map((language) => ({
    id: `codeql/${language}`, tool: "codeql", category: `/language:${language}`,
    capabilities: language === "javascript-typescript"
      ? context.profile.languages.filter((value) => ["javascript", "typescript"].includes(value)) : [language],
    destination: "github-security",
  }));
  for (const selected of context.localTools) {
    requireValue(LOCAL.includes(selected.tool) && Array.isArray(selected.languages) &&
      selected.languages.length > 0 && selected.languages.every((language) => context.profile.languages.includes(language)),
    "Invalid selected local tool");
    tools.push({ id: `local/${selected.tool}`, tool: selected.tool, category: `/tool:${selected.tool}`,
      capabilities: selected.languages, destination: context.publication.sarif === "github-security"
        ? "github-security" : "originating-repository-artifact" });
  }
  if (context.sonar.status === "eligible") {
    const capabilities = context.profile.languages.filter((value) => SONAR.includes(value));
    requireValue(capabilities.length > 0 && context.profile.sonar === true, "Invalid selected Sonar capabilities");
    tools.push({ id: "sonar", tool: "sonar", category: "quality", capabilities, destination: "sonar-public" });
  }
  requireValue(new Set(tools.map(({ id }) => id)).size === tools.length, "Duplicate selected tool");
  requireValue(!context.profile.exemption || tools.length === 0, "Exempt profile selected scanners");
  return tools.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function validateEngine(engine) {
  object(engine, ["release", "sourceSha", "digest"], "engine identity");
  requireValue(/^[a-z][a-z0-9-]*\/v\d+\.\d+\.\d+$/.test(engine.release ?? "") &&
    SHA.test(engine.sourceSha ?? "") && DIGEST.test(engine.digest ?? ""),
  "An immutable engine release, revision and digest are required");
}

function validateSource(source) {
  object(source, ["checkoutSha", "logicalHeadSha", "baseSha", "headRepositoryId", "pullRequest"], "source provenance");
  requireValue(SHA.test(source.checkoutSha ?? "") && SHA.test(source.logicalHeadSha ?? "") &&
    (source.baseSha === null || SHA.test(source.baseSha ?? "")) && positive(source.headRepositoryId) &&
    (source.pullRequest === null || positive(source.pullRequest)), "Invalid actual/logical/base source provenance");
  requireValue((source.pullRequest === null) === (source.baseSha === null), "PR source needs a frozen base revision");
  requireValue(source.pullRequest !== null || source.checkoutSha === source.logicalHeadSha,
    "Default-branch actual and logical source revisions disagree");
}

function validateRun(run, source) {
  object(run, ["id", "attempt", "event", "workflowPath", "workflowSha", "startedAt", "completedAt"], "run provenance");
  requireValue(positive(run.id) && positive(run.attempt) && EVENTS.includes(run.event) &&
    /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(run.workflowPath ?? "") &&
    SHA.test(run.workflowSha ?? ""), "Invalid immutable analysis run provenance");
  requireValue((run.event === "pull_request") === (source.pullRequest !== null), "Run event disagrees with PR provenance");
  requireValue(timestamp(run.startedAt, "run start") <= timestamp(run.completedAt, "run completion"),
    "Analysis completion predates its start");
}

function validatePins(pins, selected) {
  requireValue(Array.isArray(pins) && pins.length === selected.length, "Every selected tool needs one immutable pin");
  const ids = new Set();
  for (const pin of pins) {
    object(pin, ["id", "version", "ruleRevision", "engineDigest"], "tool pin");
    requireValue(selected.some(({ id }) => id === pin.id) && !ids.has(pin.id), "Unexpected or duplicate tool pin");
    ids.add(pin.id);
    requireValue(typeof pin.version === "string" && pin.version.length <= 80 && VERSION.test(pin.version) &&
      typeof pin.ruleRevision === "string" && pin.ruleRevision.length <= 80 &&
      (VERSION.test(pin.ruleRevision) || SHA.test(pin.ruleRevision) || DIGEST.test(pin.ruleRevision)) &&
      DIGEST.test(pin.engineDigest ?? ""), "Invalid tool/rule/engine pin");
  }
}

function validatePublication(publication, selected, completed) {
  object(publication, ["destination", "status", "id"], "tool publication");
  requireValue(publication.destination === selected.destination &&
    ["completed", "pending", "failed", "unavailable"].includes(publication.status),
  "Tool publication does not match live visibility/capability");
  requireValue(publication.id === null || (text(publication.id) && /^[A-Za-z0-9_.:-]+$/.test(publication.id)),
    "Invalid native publication identity");
  if (completed) {
    requireValue(publication.status === "completed", "Pending/failed publication cannot be completed analysis");
    requireValue(selected.destination === "originating-repository-artifact" || publication.id !== null,
      "Completed native publication needs its actual provider identity");
  }
}

function validateTool(result, selected, pin, source, run) {
  object(result, ["id", "status", "sourceSha", "version", "ruleRevision", "engineDigest", "sourceCoverage",
    "findingCount", "processing", "publication", "completedAt", "reason"], "tool result");
  requireValue(["completed", "failed", "pending", "unavailable"].includes(result.status) &&
    result.sourceSha === source.checkoutSha &&
    ["version", "ruleRevision", "engineDigest"].every((key) => result[key] === pin[key]),
  "Tool result revision or scanner/rule identity mismatch");
  object(result.sourceCoverage, selected.capabilities, "tool source coverage");
  requireValue(Object.values(result.sourceCoverage).every(count), "Invalid source coverage count");
  object(result.processing, ["status", "id"], "provider processing");
  requireValue(["completed", "pending", "failed", "not-applicable"].includes(result.processing.status) &&
    (result.processing.id === null || (text(result.processing.id) && /^[A-Za-z0-9_.:-]+$/.test(result.processing.id))),
  "Invalid provider processing state");
  const completed = result.status === "completed";
  validatePublication(result.publication, selected, completed);
  if (!completed) {
    requireValue(result.findingCount === null && text(result.reason) && result.completedAt === null,
      "Incomplete analysis needs an explicit reason, never a zero-finding fallback");
    return;
  }
  requireValue(count(result.findingCount) && selected.capabilities.every((language) => positive(result.sourceCoverage[language])),
    "Completed tools require actual nonempty coverage of every selected capability");
  const end = timestamp(result.completedAt, "tool completion");
  requireValue(end >= timestamp(run.startedAt, "run start") && end <= timestamp(run.completedAt, "run completion"),
    "Tool completion is outside this analysis invocation");
  if (selected.destination === "sonar-public") {
    requireValue(result.processing.status === "completed" && result.processing.id !== null,
      "Sonar upload is not complete until the bound compute task succeeds");
  } else {
    requireValue(["completed", "not-applicable"].includes(result.processing.status),
      "Pending/failed native processing cannot be completed analysis");
    if (selected.destination === "github-security") {
      requireValue(result.processing.status === "completed" && result.processing.id !== null,
        "Native SARIF processing needs its completed upload identity");
    }
  }
}

function validateCoverage(coverage, source, exempt) {
  requireValue(Array.isArray(coverage) && coverage.length <= 32 && (exempt || coverage.length > 0),
    "Explicit bounded coverage suite evidence is required");
  const suites = new Set();
  for (const entry of coverage) {
    object(entry, ["suite", "status", "format", "sourceSha", "reports", "lines", "tests", "analysisId", "reason"], "coverage evidence");
    requireValue(text(entry.suite) && !suites.has(entry.suite) && entry.sourceSha === source.checkoutSha &&
      ["imported", "unavailable", "not-applicable", "failed"].includes(entry.status), "Invalid coverage identity/state");
    suites.add(entry.suite);
    requireValue(Array.isArray(entry.reports) && entry.reports.length <= 256, "Invalid coverage reports");
    if (entry.status !== "imported") {
      requireValue(text(entry.reason) && entry.reports.length === 0 && entry.lines === null &&
        entry.tests === null && entry.analysisId === null, "Unavailable coverage must not masquerade as an imported zero");
      continue;
    }
    requireValue(["opencover", "lcov", "gcov"].includes(entry.format) && entry.reports.length > 0 &&
      text(entry.analysisId) && /^[A-Za-z0-9_.:-]+$/.test(entry.analysisId), "Imported coverage needs a bound provider analysis");
    const files = new Set();
    for (const report of entry.reports) {
      object(report, ["path", "sha256"], "coverage report");
      requireValue(typeof report.path === "string" && report.path.length <= 512 &&
        !/[\\\0\r\n]/.test(report.path) && !report.path.startsWith("/") &&
        report.path.split("/").every((part) => part && ![".", ".."].includes(part)) &&
        DIGEST.test(report.sha256 ?? "") && !files.has(report.path), "Invalid or duplicate coverage report provenance");
      files.add(report.path);
    }
    object(entry.lines, ["total", "covered"], "coverage lines");
    object(entry.tests, ["executed", "passed", "failed", "skipped"], "coverage tests");
    requireValue(positive(entry.lines.total) && count(entry.lines.covered) && entry.lines.covered <= entry.lines.total &&
      positive(entry.tests.executed) && [entry.tests.passed, entry.tests.failed, entry.tests.skipped].every(count) &&
      entry.tests.executed === entry.tests.passed + entry.tests.failed && entry.tests.failed === 0,
    "Imported coverage needs genuine passing executed tests and nonempty instrumented source");
  }
}

function unavailableCapabilities(context) {
  return [
    ...(context.visibility === "private" && context.profile.languages.includes("cpp") ? ["cpp"] : []),
    ...(context.sonar.status === "unavailable" ? ["sonar"] : []),
  ];
}

export function assemble(context, input) {
  const selected = selectedTools(context);
  object(input, ["engine", "source", "run", "pins", "results", "coverage", "finishedHeadSha"], "analysis bundle");
  validateEngine(input.engine);
  validateSource(input.source);
  validateRun(input.run, input.source);
  requireValue(input.source.pullRequest !== null || input.source.headRepositoryId === context.repositoryId,
    "Default-branch source belongs to a different repository");
  requireValue(SHA.test(input.finishedHeadSha ?? ""), "The independently observed finish revision is required");
  validatePins(input.pins, selected);
  requireValue(Array.isArray(input.results) && input.results.length <= selected.length, "Invalid selected tool results");
  const ids = new Set();
  for (const result of input.results) {
    const tool = selected.find(({ id }) => id === result.id);
    requireValue(tool && !ids.has(result.id), "Unexpected or duplicate result tool/category");
    ids.add(result.id);
    validateTool(result, tool, input.pins.find(({ id }) => id === result.id), input.source, input.run);
  }
  validateCoverage(input.coverage, input.source, Boolean(context.profile.exemption));
  for (const entry of input.coverage.filter(({ status }) => status === "imported")) {
    requireValue(input.results.some((tool) => tool.id === "sonar" && tool.status === "completed" &&
      tool.publication.id === entry.analysisId), "Coverage import is not bound to this completed Sonar analysis");
  }
  const missing = selected.filter(({ id }) => !ids.has(id)).map(({ id }) => id);
  const unavailable = unavailableCapabilities(context);
  const complete = missing.length === 0 && input.results.every(({ status }) => status === "completed") &&
    unavailable.length === 0 && input.coverage.every(({ status }) => status !== "failed");
  const superseded = input.finishedHeadSha !== input.source.logicalHeadSha;
  const status = context.profile.exemption ? "not-applicable" :
    !complete ? "incomplete" : superseded ? "superseded" : "completed";
  const result = {
    schema: RESULT_SCHEMA, context, engine: input.engine, source: input.source, run: input.run,
    pins: [...input.pins].sort((left, right) => left.id.localeCompare(right.id, "en")),
    results: [...input.results].sort((left, right) => left.id.localeCompare(right.id, "en")),
    coverage: input.coverage, finishedHeadSha: input.finishedHeadSha,
    completeness: { status, missing, unavailable, selectedTools: selected.map(({ id }) => id) },
  };
  requireValue(Buffer.byteLength(JSON.stringify(result)) <= RESULT_LIMIT, "Analysis result exceeds the bounded contract");
  return result;
}

export function validateResult(result) {
  object(result, ["schema", "context", "engine", "source", "run", "pins", "results", "coverage",
    "finishedHeadSha", "completeness"], "analysis result");
  requireValue(result.schema === RESULT_SCHEMA, "Unsupported completed-result schema");
  const { schema, context, completeness, ...input } = result;
  const validated = assemble(context, input);
  requireValue(JSON.stringify(completeness) === JSON.stringify(validated.completeness),
    "Result completion flags disagree with actual selected-tool evidence");
  return validated;
}

export function assessFreshness(context, request, previous, now = Date.now()) {
  const selected = selectedTools(context);
  object(request, ["engine", "pins", "headSha", "expectedSha", "force"], "freshness request");
  validateEngine(request.engine);
  validatePins(request.pins, selected);
  requireValue((SHA.test(request.headSha ?? "") ||
    (context.profile.exemption?.kind === "empty" && request.headSha === null)) &&
    (request.expectedSha === null || SHA.test(request.expectedSha ?? "")) &&
    typeof request.force === "boolean" && Number.isFinite(now), "Invalid current/expected source or force request");
  if (request.expectedSha !== null && request.expectedSha !== request.headSha) {
    return { action: "superseded", reason: "Expected revision is no longer the live default-branch head" };
  }
  if (context.profile.exemption) return { action: "not-applicable", reason: "Explicit catalog applicability exemption" };
  if (request.force) return { action: "scan", reason: "Explicit forced analysis of the verified current head" };
  if (previous === null) return { action: "scan", reason: "No completed result exists" };
  const result = validateResult(previous);
  requireValue(result.context.repositoryId === context.repositoryId &&
    result.context.repository.toLowerCase() === context.repository.toLowerCase(), "Foreign repository result is not freshness evidence");
  const completedAt = timestamp(result.run.completedAt, "previous completion");
  requireValue(completedAt <= now + CLOCK_SKEW_MS, "Previous completion is implausibly in the future");
  if (result.run.event === "pull_request") return { action: "scan", reason: "PR results cannot satisfy default-branch freshness" };
  if (result.completeness.status !== "completed") return { action: "scan", reason: "Selected tools or capabilities are incomplete/superseded" };
  if (result.source.checkoutSha !== request.headSha || result.source.logicalHeadSha !== request.headSha) {
    return { action: "scan", reason: "Source revision changed" };
  }
  if (result.context.policyDigest !== context.policyDigest || hash(result.engine) !== hash(request.engine) ||
      hash(result.pins) !== hash([...request.pins].sort((left, right) => left.id.localeCompare(right.id, "en")))) {
    return { action: "scan", reason: "Visibility, profile, engine, scanner or rule policy changed" };
  }
  if (now - completedAt >= WEEK_MS) return { action: "scan", reason: "Weekly unchanged-source analysis is due" };
  return { action: "current", reason: "Every selected tool completed for the current source and policy within the weekly interval" };
}

export function aggregateStatus(result) {
  const validated = validateResult(result);
  return {
    repository: validated.context.repository, visibility: validated.context.visibility,
    status: validated.completeness.status, selectedTools: validated.completeness.selectedTools,
    missingTools: validated.completeness.missing, unavailableCapabilities: validated.completeness.unavailable,
    completedAt: validated.run.completedAt,
  };
}

async function readInput(filename, temporaryRoot) {
  const [resolved, root] = await Promise.all([realpath(filename), realpath(temporaryRoot)]);
  const relative = path.relative(root, resolved);
  requireValue(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative),
    "Analysis input must be an isolated runner temporary file");
  const handle = await open(resolved, "r");
  try {
    const metadata = await handle.stat();
    requireValue(metadata.isFile() && metadata.size <= RESULT_LIMIT, "Analysis input exceeds the bounded regular-file contract");
    const buffer = Buffer.alloc(RESULT_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    requireValue(bytesRead <= RESULT_LIMIT, "Analysis input exceeds the bounded contract");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

export async function main(env = process.env) {
  requireValue(env.GITHUB_OUTPUT && env.GITHUB_STEP_SUMMARY && env.RUNNER_TEMP, "GitHub runner output paths are required");
  const context = JSON.parse(env.ANALYSIS_CONTEXT ?? "");
  requireValue(context.repository === env.GITHUB_REPOSITORY &&
    context.repositoryId === Number(env.GITHUB_REPOSITORY_ID), "Live context does not match the immutable workflow repository");
  const input = await readInput(env.ANALYSIS_INPUT, env.RUNNER_TEMP);
  let result;
  if (env.ANALYSIS_MODE === "assemble") {
    requireValue(input.run?.id === Number(env.GITHUB_RUN_ID) &&
      input.run?.attempt === Number(env.GITHUB_RUN_ATTEMPT) && input.run?.event === env.GITHUB_EVENT_NAME,
    "Analysis result belongs to a different run, attempt or event");
    const workflow = env.GITHUB_WORKFLOW_REF?.split("@", 1)[0];
    requireValue(workflow?.startsWith(`${env.GITHUB_REPOSITORY}/`) &&
      input.run?.workflowPath === workflow.slice(env.GITHUB_REPOSITORY.length + 1) &&
      input.run?.workflowSha === env.GITHUB_WORKFLOW_SHA, "Analysis workflow definition does not match this execution");
    result = assemble(context, input);
  } else if (env.ANALYSIS_MODE === "assess") {
    object(input, ["request", "previous"], "freshness input");
    result = assessFreshness(context, input.request, input.previous);
  } else {
    throw new Error("Unsupported analysis state operation");
  }
  const directory = await mkdtemp(path.join(env.RUNNER_TEMP, "repository-analysis-state-"));
  await writeFile(path.join(directory, "result.json"), JSON.stringify(result, null, 2) + "\n");
  const status = env.ANALYSIS_MODE === "assemble" ? result.completeness.status : result.action;
  await appendFile(env.GITHUB_OUTPUT, `status=${status}\nresult-directory=${directory}\n`);
  await appendFile(env.GITHUB_STEP_SUMMARY, [
    "### Repository analysis state", "",
    `Visibility: **${context.visibility}**. State: **${status}**.`,
    ...(env.ANALYSIS_MODE === "assemble" ? [
      `Missing tools: ${result.completeness.missing.join(", ") || "none"}.`,
      `Unavailable capabilities: ${result.completeness.unavailable.join(", ") || "none"}.`,
      "Result completeness is not a claim of zero findings or equivalent analyzer coverage.",
    ] : [result.reason]),
    "",
  ].join("\n"));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::${error instanceof SyntaxError ? "Malformed analysis state JSON" : error.message}`);
    process.exitCode = 1;
  }
}

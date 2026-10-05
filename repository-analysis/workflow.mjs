import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { engineDigest, selectTool } from "../repository-analysis-local/scan.mjs";

export const WORKFLOW_PATH = ".github/workflows/repository-analysis-local.yml";
export const ARTIFACT_SCHEMA = "repository-analysis-local-artifact-v1";
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const NAMES = { zizmor: "zizmor", "semgrep-ce": "Semgrep", checkov: "checkov",
  bandit: "Bandit", shellcheck: "ShellCheck", psscriptanalyzer: "PSScriptAnalyzer" };
const pinFile = new URL("../repository-analysis-local/tools.json", import.meta.url);
const pins = JSON.parse(await readFile(pinFile, "utf8"));
export const RELEASE_PATHS = [
  "repository-analysis/", ".github/workflows/repository-analysis-local.yml",
  "repository-analysis-context/", "repository-analysis-local/", "repository-analysis-sarif/",
];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function definitionFromRun(run, runtime) {
  requireValue(run?.id === runtime.runId && run.run_attempt === runtime.attempt &&
    run.repository?.id === runtime.repositoryId && run.repository.full_name === runtime.repository &&
    run.head_sha === runtime.logicalHeadSha && run.event === runtime.event &&
    run.path === runtime.workflowPath, "Shared workflow producer run identity mismatch");
  const matches = run.referenced_workflows?.filter((entry) =>
    entry.path?.startsWith(`frasermolyneux/actions/${WORKFLOW_PATH}@`));
  requireValue(matches?.length === 1 && SHA.test(matches[0].sha ?? ""),
    "Missing or ambiguous authenticated shared workflow definition");
  const reference = matches[0].ref ?? matches[0].path.split("@")[1];
  requireValue(/^refs\/tags\/repository-analysis\/v\d+\.\d+\.\d+$/.test(reference) ||
    /^repository-analysis\/v\d+\.\d+\.\d+$/.test(reference) ||
    (runtime.repository === "frasermolyneux/actions" &&
      /^refs\/(?:heads\/[A-Za-z0-9_./-]+|pull\/[1-9]\d*\/merge)$/.test(reference)),
  "Shared workflow must use an immutable release; branch/merge definitions are only for its own contracts");
  return matches[0].sha;
}

export async function definitionDigest() {
  const base = new URL("../", import.meta.url);
  const filenames = [
    WORKFLOW_PATH, "repository-analysis/workflow.mjs", "repository-analysis/version.json",
    "repository-analysis-context/action.yml", "repository-analysis-context/policy.mjs",
    "repository-analysis-local/action.yml", "repository-analysis-local/scan.mjs",
    "repository-analysis-local/reports.mjs", "repository-analysis-local/sarif.mjs",
    "repository-analysis-local/tools.json", "repository-analysis-local/powershell-scan.ps1",
    "repository-analysis-sarif/action.yml", "repository-analysis-sarif/verify.mjs",
  ];
  const manifest = await Promise.all(filenames.map(async (filename) => {
    const content = await readFile(new URL(filename, base));
    return { filename, bytes: content.length, sha256: hash(content) };
  }));
  return hash(JSON.stringify(manifest));
}

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function boundedFile(filename, limit) {
  const stat = await lstat(filename);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit,
    "Analysis artifact file is not a bounded regular file");
  const content = await readFile(filename);
  requireValue(content.length <= limit, "Analysis artifact file exceeds its bounded limit");
  return content;
}

export function validateReport(report, sarif, context, tool, runtime, expectedEngineDigest) {
  const selected = selectTool(context, tool);
  const pin = pins[tool];
  requireValue(report?.schema === "repository-analysis-local-v1" && report.status === "completed" &&
    report.repository === context.repository && report.repositoryId === context.repositoryId &&
    report.visibility === context.visibility && report.sourceSha === runtime.sourceSha &&
    report.policyDigest === context.policyDigest && report.tool === tool &&
    report.engineDigest === expectedEngineDigest &&
    report.toolVersion === (pin.engineVersion ?? pin.version) && report.packageVersion === pin.version &&
    report.ruleRevision === (pin.rulesRevision ?? pin.version) &&
    report.publication === "originating-repository-artifact-only",
  "Local report source, policy, engine, package or rule identity mismatch");
  requireValue(selected.languages.length === Object.keys(report.sourceCoverage ?? {}).length &&
    selected.languages.every((language) => Number.isSafeInteger(report.sourceCoverage[language]) &&
      report.sourceCoverage[language] > 0), "Selected local capability coverage is incomplete");
  requireValue(Number.isSafeInteger(report.findingCount) && report.findingCount >= 0 &&
    Number.isFinite(Date.parse(report.completedAt)), "Local completion metadata is malformed");
  const run = sarif?.runs?.[0];
  requireValue(sarif?.version === "2.1.0" && sarif.runs.length === 1 &&
    run.tool?.driver?.name === NAMES[tool] && run.tool.driver.version === report.toolVersion &&
    run.automationDetails?.id === `/tool:${tool}/` &&
    Array.isArray(run.results) && run.results.length === report.findingCount &&
    run.invocations?.length === 1 && run.invocations[0].executionSuccessful === true,
  "Actual SARIF finding count, tool, category or completion identity mismatch");
  return report;
}

export function validateEnvelope(envelope, report, context, tool, runtime, digest, fileHashes) {
  requireValue(envelope?.schema === ARTIFACT_SCHEMA && envelope.repository === runtime.repository &&
    envelope.repositoryId === runtime.repositoryId && envelope.visibility === context.visibility &&
    envelope.sourceSha === runtime.sourceSha && envelope.policyDigest === context.policyDigest &&
    envelope.tool === tool && envelope.definition?.sha === runtime.definitionSha &&
    envelope.definition.path === WORKFLOW_PATH && envelope.definition.digest === digest &&
    envelope.run?.id === runtime.runId && envelope.run.attempt === runtime.attempt &&
    envelope.run.workflowPath === runtime.workflowPath && envelope.run.workflowSha === runtime.workflowSha &&
    envelope.run.logicalHeadSha === runtime.logicalHeadSha && envelope.run.job === "local",
  "Artifact is not bound to this source, selected tool, reviewed definition and originating run attempt");
  for (const filename of ["report.json", "native.json", "analysis.sarif"]) {
    requireValue(HASH.test(envelope.files?.[filename] ?? "") && envelope.files[filename] === fileHashes[filename],
      "Analysis artifact content hash mismatch");
  }
  requireValue(envelope.completedAt === report.completedAt, "Artifact completion time mismatch");
}

async function evidence(location, context, tool, runtime) {
  const reportContent = await boundedFile(path.join(location, "report.json"), 128 * 1024);
  const nativeContent = await boundedFile(path.join(location, "native.json"), 256 * 1024 * 1024);
  const sarifContent = await boundedFile(path.join(location, "analysis.sarif"), 50 * 1024 * 1024);
  const report = JSON.parse(reportContent);
  validateReport(report, JSON.parse(sarifContent), context, tool, runtime, await engineDigest());
  return { report, files: { "report.json": hash(reportContent),
    "native.json": hash(nativeContent), "analysis.sarif": hash(sarifContent) } };
}

function runtimeFromEnvironment(env) {
  const runtime = {
    repository: env.GITHUB_REPOSITORY, repositoryId: Number(env.GITHUB_REPOSITORY_ID),
    runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT),
    sourceSha: env.GITHUB_SHA, logicalHeadSha: env.ANALYSIS_LOGICAL_SHA,
    workflowPath: env.GITHUB_WORKFLOW_REF?.split("@")[0].slice(env.GITHUB_REPOSITORY.length + 1),
    workflowSha: env.GITHUB_WORKFLOW_SHA, definitionSha: env.ANALYSIS_DEFINITION_SHA,
    event: env.GITHUB_EVENT_NAME,
  };
  requireValue(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(runtime.repository ?? "") &&
    [runtime.repositoryId, runtime.runId, runtime.attempt].every((value) => Number.isSafeInteger(value) && value > 0) &&
    [runtime.sourceSha, runtime.logicalHeadSha, runtime.workflowSha, runtime.definitionSha].every((value) => SHA.test(value ?? "")) &&
    /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(runtime.workflowPath ?? "") &&
    ["pull_request", "push", "schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME),
  "Shared workflow requires an exact supported source and originating runtime identity");
  return runtime;
}

export function validateProcessing(proof, report, context, tool, runtime) {
  requireValue(proof?.schema === "repository-analysis-sarif-proof-v1" &&
    proof.repository === runtime.repository && proof.repositoryId === runtime.repositoryId &&
    proof.visibility === "public" && proof.policyDigest === context.policyDigest &&
    proof.toolId === `local/${tool}` && proof.sourceSha === runtime.sourceSha &&
    proof.run?.id === runtime.runId && proof.run.attempt === runtime.attempt &&
    proof.run.workflowPath === runtime.workflowPath && proof.run.workflowSha === runtime.workflowSha &&
    proof.run.logicalHeadSha === runtime.logicalHeadSha && proof.run.job === "publish-public" &&
    proof.processing?.status === "completed" &&
    proof.publication?.destination === "github-security" && proof.publication.status === "completed" &&
    /^[1-9]\d*$/.test(proof.publication.id ?? "") &&
    typeof proof.tool?.name === "string" && proof.tool.name.toLowerCase() === NAMES[tool].toLowerCase() &&
    proof.tool.version === report.toolVersion &&
    [ `/tool:${tool}`, `/tool:${tool}/` ].includes(proof.category) &&
    Number.isSafeInteger(proof.findingCount) && proof.findingCount >= 0 &&
    Number.isSafeInteger(proof.ruleCount) && proof.ruleCount >= 0,
  "Native completion proof is not bound to this public tool/source/producer attempt");
}

export async function main(env = process.env) {
  const runtime = runtimeFromEnvironment(env);
  const context = JSON.parse(env.ANALYSIS_CONTEXT ?? "");
  const digest = await definitionDigest();
  if (env.ANALYSIS_MODE === "plan") {
    const run = JSON.parse(env.ANALYSIS_RUN ?? "");
    requireValue(definitionFromRun(run, runtime) === runtime.definitionSha,
      "The checked-out definition is not the authenticated called workflow");
    requireValue(context.repository === runtime.repository && context.repositoryId === runtime.repositoryId &&
      Array.isArray(context.localTools), "Live workflow context repository mismatch");
    for (const { tool } of context.localTools) selectTool(context, tool);
    const event = JSON.parse(await boundedFile(env.GITHUB_EVENT_PATH, 5 * 1024 * 1024));
    const publish = context.visibility === "public" && context.publication?.sarif === "github-security" &&
      (runtime.event !== "pull_request" || event.pull_request?.head.repo.full_name === runtime.repository);
    const matrix = { include: context.localTools.length ? context.localTools : [{ tool: "not-selected" }] };
    await appendFile(env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\nhas-tools=${context.localTools.length > 0}\npublish=${publish}\n`);
    return;
  }
  const location = env.ANALYSIS_DIRECTORY;
  requireValue(location && path.isAbsolute(location) && env.GITHUB_OUTPUT,
    "An isolated artifact directory and runner output path are required");
  if (env.ANALYSIS_MODE === "attest" || env.ANALYSIS_MODE === "validate") {
    const tool = env.ANALYSIS_TOOL;
    const { report, files } = await evidence(location, context, tool, runtime);
    if (env.ANALYSIS_MODE === "attest") {
      requireValue(env.GITHUB_JOB === "local", "Only the actual local scanner job creates its artifact envelope");
      const envelope = {
        schema: ARTIFACT_SCHEMA, repository: runtime.repository, repositoryId: runtime.repositoryId,
        visibility: context.visibility, sourceSha: runtime.sourceSha, policyDigest: context.policyDigest, tool,
        definition: { path: WORKFLOW_PATH, sha: runtime.definitionSha, digest },
        run: { id: runtime.runId, attempt: runtime.attempt, workflowPath: runtime.workflowPath,
          workflowSha: runtime.workflowSha, logicalHeadSha: runtime.logicalHeadSha, job: "local" },
        files, completedAt: report.completedAt,
      };
      await writeFile(path.join(location, "artifact.json"), JSON.stringify(envelope) + "\n");
    } else {
      const envelope = JSON.parse(await boundedFile(path.join(location, "artifact.json"), 128 * 1024));
      validateEnvelope(envelope, report, context, tool, runtime, digest, files);
    }
    await appendFile(env.GITHUB_OUTPUT, `tool-version=${report.toolVersion}\n`);
    return;
  }
  requireValue(env.ANALYSIS_MODE === "assemble", "Unknown shared workflow evidence mode");
  const selected = context.localTools;
  requireValue(Array.isArray(selected), "A fresh selected-local-tools context is required");
  const actual = await readdir(location);
  const expected = selected.map(({ tool }) => `local-${tool}-${runtime.attempt}`);
  const nativeExpected = env.ANALYSIS_NATIVE_PUBLICATION === "true"
    ? selected.map(({ tool }) => `native-${tool}-${runtime.attempt}`) : [];
  requireValue(actual.length === expected.length + nativeExpected.length &&
    [...expected, ...nativeExpected].every((filename) => actual.includes(filename)),
  "Missing, unexpected or duplicated selected-tool artifact");
  const tools = [];
  for (const { tool } of selected) {
    const local = path.join(location, `local-${tool}-${runtime.attempt}`);
    const { report, files } = await evidence(local, context, tool, runtime);
    const envelope = JSON.parse(await boundedFile(path.join(local, "artifact.json"), 128 * 1024));
    validateEnvelope(envelope, report, context, tool, runtime, digest, files);
    let processing = null;
    if (nativeExpected.length) {
      processing = JSON.parse(await boundedFile(path.join(location, `native-${tool}-${runtime.attempt}`, "proof.json"), 128 * 1024));
      validateProcessing(processing, report, context, tool, runtime);
    }
    tools.push({ ...report, artifact: envelope, nativeProcessing: processing });
  }
  const output = path.join(env.RUNNER_TEMP, "repository-analysis-local-set");
  await mkdir(output);
  const result = {
    schema: "repository-analysis-local-set-v1", status: "local-tools-completed",
    scope: "selected-local-analyzers-only", fullProfileEvidence: false,
    repository: runtime.repository, repositoryId: runtime.repositoryId, visibility: context.visibility,
    sourceSha: runtime.sourceSha, policyDigest: context.policyDigest,
    definition: { path: WORKFLOW_PATH, sha: runtime.definitionSha, digest }, tools,
    publication: nativeExpected.length ? "github-security" : "originating-repository-artifact-only",
  };
  await writeFile(path.join(output, "local-results.json"), JSON.stringify(result, null, 2) + "\n");
  await appendFile(env.GITHUB_OUTPUT, `result-directory=${output}\n`);
  await appendFile(env.GITHUB_STEP_SUMMARY, [
    "### Selected local analysis", "",
    `All ${tools.length} selected local tools completed for \`${runtime.sourceSha}\`.`,
    `Publication: ${result.publication}. This is not the complete CodeQL/Sonar/build/coverage profile.`,
    "",
    "| Tool | Version | Findings |",
    "| --- | --- | --- |",
    ...tools.map((report) => `| ${report.tool} | ${report.toolVersion} | ${report.findingCount} |`),
    "",
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::${error instanceof SyntaxError ? "Malformed shared workflow evidence" : error.message}`);
    process.exitCode = 1;
  }
}

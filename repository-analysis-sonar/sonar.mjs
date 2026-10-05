import { createHash } from "node:crypto";
import { appendFile, lstat, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { resolveAnalysis } from "../repository-analysis-context/policy.mjs";

export const HOST = "https://sonarcloud.io";
export const DOTNET_VERSION = "11.3.0";
export const CLI_VERSION = "8.1.0.6389";
export const SCHEMA = "repository-analysis-sonar-proof-v1";
export const WORKFLOW_PATH = ".github/workflows/repository-analysis-sonar.yml";
export const DEFINITION_FILES = [
  WORKFLOW_PATH, "repository-analysis-sonar/action.yml", "repository-analysis-sonar/sonar.mjs",
  "repository-analysis-sonar/build.mjs", "repository-analysis-sonar/build.ps1",
  "repository-analysis-sonar/scanner.ps1", "repository-analysis-sonar/validate-build.mjs",
  "repository-analysis-sonar/version.json", "repository-analysis-context/action.yml",
  "repository-analysis-context/policy.mjs", "dotnet-test/action.yml", "dotnet-test/run-tests.ps1",
  "dotnet-test/report-coverage.ps1", "dotnet-test/coverage-tools.json",
  "dotnet-test-report/action.yml", "dotnet-test-report/report-test-results.ps1",
];
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{8,80}$/;
const ROOT = "Project scanner properties:";
const BINDING = {
  projectKey: "sonar.projectKey",
  sourceSha: "sonar.scm.revision",
  repositoryId: "sonar.analysis.devex.repositoryId",
  runId: "sonar.analysis.devex.runId",
  attempt: "sonar.analysis.devex.attempt",
  workflowPath: "sonar.analysis.devex.workflowPath",
  workflowSha: "sonar.analysis.devex.workflowSha",
  definitionSha: "sonar.analysis.devex.definitionSha",
  recipeDigest: "sonar.analysis.devex.recipeDigest",
};
const ALLOWED_PROPERTIES = new Set([...Object.values(BINDING),
  "sonar.branch.name", "sonar.pullrequest.key", "sonar.pullrequest.branch",
  "sonar.pullrequest.base", "sonar.cs.cobertura.reportsPaths"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const APPROVED_PR_AUTOMATION = [
  { id: 198982749, login: "Copilot", type: "Bot", origin: "copilot" },
  { id: 49699333, login: "dependabot[bot]", type: "Bot", origin: "dependabot" },
];
const GITHUB_ACTIONS_ACTOR = { id: 41898282, login: "github-actions[bot]", type: "Bot" };
const sameIdentity = (actual, expected) => actual?.id === expected.id &&
  actual.login === expected.login && actual.type === expected.type;

export function trustedSource(repository, run, pullRequest, input, event) {
  const owner = repository?.owner;
  requireValue(repository?.id === input.repositoryId && repository.full_name === input.repository &&
    repository.visibility === "public" && repository.private === false &&
    owner?.type === "User" && Number.isSafeInteger(owner.id) &&
    owner.login === input.repository.split("/")[0],
  "Sonar trusted-first-party policy requires this live public personal-owner repository");
  const actor = run?.actor;
  if (input.pullRequest === null) {
    requireValue(run.head_branch === repository.default_branch ||
      (run.event === "workflow_dispatch" && sameIdentity(actor, owner)),
    "Token-bearing analysis requires the default branch or explicit owner dispatch");
    return { policy: "trusted-first-party-v1", origin: "default-or-owner-dispatch",
      isolation: "same-runner-risk-accepted", logicalHeadSha: input.sourceSha };
  }
  const logicalHeadSha = event.pull_request?.head.sha;
  requireValue(pullRequest?.number === input.pullRequest && pullRequest.state === "open" &&
    pullRequest.draft === false && pullRequest.head?.repo?.id === input.repositoryId &&
    pullRequest.head.repo.full_name === input.repository &&
    pullRequest.head.sha === logicalHeadSha && SHA.test(logicalHeadSha ?? "") &&
    pullRequest.base?.repo?.id === input.repositoryId,
  "Sonar cannot authorize a foreign, draft, closed or superseded PR source");
  const author = pullRequest.user;
  const automation = APPROVED_PR_AUTOMATION.find((identity) => sameIdentity(author, identity));
  const ownerAuthored = sameIdentity(author, owner);
  requireValue(ownerAuthored || automation, "PR author is not the verified owner or approved automation");
  requireValue(sameIdentity(actor, owner) || (automation && sameIdentity(actor, automation)) ||
    (automation?.origin === "dependabot" && sameIdentity(actor, GITHUB_ACTIONS_ACTOR)),
  "PR analysis actor is not authorized for this trusted author/source pair");
  return { policy: "trusted-first-party-v1", origin: ownerAuthored ? "owner" : automation.origin,
    isolation: "same-runner-risk-accepted", logicalHeadSha,
    authorId: author.id, actorId: actor.id, pullRequest: input.pullRequest };
}

export async function authorizeSource(input, run, event, token, request = fetch) {
  const base = `https://api.github.com/repos/${input.repository}`;
  const repository = await readJson(base, token, request);
  const pullRequest = input.pullRequest === null ? null :
    await readJson(`${base}/pulls/${input.pullRequest}`, token, request);
  return trustedSource(repository, run, pullRequest, input, event);
}

export async function definitionDigest() {
  const manifest = await Promise.all(DEFINITION_FILES.map(async (filename) => {
    const content = await readFile(new URL("../" + filename, import.meta.url));
    return { filename, bytes: content.length, sha256: hash(content) };
  }));
  return hash(JSON.stringify(manifest));
}

function object(value, fields, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => fields.includes(key)), `Invalid ${label}`);
}

export function validateRecipe(value) {
  object(value, ["version", "driver", "projectKey", "sourceDirectory", "coverage"], "Sonar recipe");
  requireValue(value.version === 1 && ["dotnet", "cli", "cpp"].includes(value.driver) &&
    /^[A-Za-z0-9_.:-]{1,200}$/.test(value.projectKey ?? ""), "Invalid Sonar scanner/project selection");
  requireValue(typeof value.sourceDirectory === "string" &&
    (value.sourceDirectory === "." || /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value.sourceDirectory)) &&
    value.sourceDirectory.split("/").every((part) => !["..", ""].includes(part)),
  "Sonar source directory must be a repository-relative path");
  requireValue(["cobertura", "not-applicable"].includes(value.coverage) &&
    (value.coverage !== "cobertura" || value.driver === "dotnet"),
  "Only verified C# Cobertura or explicitly inapplicable coverage is supported");
  return { version: value.version, driver: value.driver, projectKey: value.projectKey,
    sourceDirectory: value.sourceDirectory, coverage: value.coverage };
}

export function recipeDigest(recipe, build) {
  const material = validateRecipe(recipe);
  return hash(JSON.stringify(build === undefined ? material : { recipe: material, build }));
}

export function rootProperties(scannerContext) {
  requireValue(typeof scannerContext === "string" &&
    Buffer.byteLength(scannerContext) <= 2 * 1024 * 1024, "Missing or oversized Sonar scanner context");
  let active = false;
  let sections = 0;
  const result = {};
  const seen = new Set();
  for (const line of scannerContext.split(/\r?\n/)) {
    if (line === ROOT) {
      sections++;
      requireValue(sections === 1, "Duplicate root Sonar scanner section");
      active = true;
      continue;
    }
    if (line && !/^\s/.test(line)) active = false;
    if (!active || !line.startsWith("  - ")) continue;
    const offset = line.indexOf("=", 4);
    requireValue(offset > 4, "Malformed root Sonar scanner property");
    const key = line.slice(4, offset);
    requireValue(!seen.has(key), "Duplicate root Sonar scanner property");
    seen.add(key);
    const coverageImport = /(?:coverage|opencover|cobertura|lcov|gcov|jacoco)/i.test(key) &&
      /report(?:s?Paths?|s)/i.test(key);
    requireValue(!coverageImport || key === "sonar.cs.cobertura.reportsPaths",
      "Alternate Sonar coverage import properties cannot prove the selected native report");
    if (ALLOWED_PROPERTIES.has(key)) result[key] = line.slice(offset + 1);
  }
  requireValue(sections === 1, "Missing root Sonar scanner section");
  return result;
}

export function validateInput(input) {
  object(input, ["repository", "repositoryId", "projectKey", "sourceSha", "runId", "attempt",
    "workflowPath", "workflowSha", "definitionSha", "recipeDigest", "branch", "pullRequest",
    "startedAt", "driver", "coveragePath"], "Sonar producer identity");
  requireValue(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(input.repository ?? "") &&
    [input.repositoryId, input.runId, input.attempt].every((value) => Number.isSafeInteger(value) && value > 0) &&
    [input.sourceSha, input.workflowSha, input.definitionSha].every((value) => SHA.test(value ?? "")) &&
    HASH.test(input.recipeDigest ?? "") &&
    /^[A-Za-z0-9_.:-]{1,200}$/.test(input.projectKey ?? "") &&
    /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(input.workflowPath ?? "") &&
    typeof input.branch === "string" && input.branch.length > 0 && input.branch.length <= 200 &&
    !/[\x00-\x20\\~^:?*[]/.test(input.branch) &&
    (input.pullRequest === null || (Number.isSafeInteger(input.pullRequest) && input.pullRequest > 0)) &&
    ["dotnet", "cli", "cpp"].includes(input.driver) &&
    Number.isFinite(Date.parse(input.startedAt)) &&
    (input.coveragePath === null || (typeof input.coveragePath === "string" &&
      path.isAbsolute(input.coveragePath) && !/[\0\r\n,]/.test(input.coveragePath))),
  "An exact Sonar source, run, attempt and reviewed producer are required");
  return input;
}

export function validateDriver(context, driver) {
  const supported = { dotnet: ["csharp"], cpp: ["cpp"], cli: ["javascript", "typescript", "python", "php"] };
  requireValue(Object.hasOwn(supported, driver) && Array.isArray(context?.profile?.languages) &&
    context.profile.languages.some((language) => supported[driver].includes(language)),
  "Sonar driver must match this catalog source capability profile");
}

function eligible(context, input) {
  const { policyDigest, ...material } = context ?? {};
  requireValue(context?.visibility === "public" && context.sonar?.status === "eligible" &&
    context.repository === input.repository && context.repositoryId === input.repositoryId &&
    hash(JSON.stringify(material)) === policyDigest,
  "Sonar execution requires a live public eligible repository");
  validateDriver(context, input.driver);
}

export function validateProject(project, context, input) {
  eligible(context, input);
  requireValue(project?.key === input.projectKey && project.organization === "frasermolyneux" &&
    project.visibility === "public" && project.autoscanEnabled === false &&
    project.alm?.key === "github" &&
    project.alm.url === `https://github.com/${input.repository}`,
  "Sonar project must be public, bound to this repository and configured for CI analysis");
}

export function validateProducerRun(run, input, runtime, event) {
  requireValue(input.repository === runtime.repository && input.repositoryId === runtime.repositoryId &&
    input.runId === runtime.runId && input.attempt === runtime.attempt && input.sourceSha === runtime.sourceSha &&
    input.workflowPath === runtime.workflowPath && input.workflowSha === runtime.workflowSha &&
    ["push", "pull_request", "schedule", "workflow_dispatch"].includes(runtime.event),
  "Sonar producer does not match the actual workflow runtime");
  const logical = runtime.event === "pull_request" ? event.pull_request?.head.sha : runtime.sourceSha;
  requireValue(SHA.test(logical ?? "") && run?.id === input.runId && run.run_attempt === input.attempt &&
    run.repository?.id === input.repositoryId && run.repository.full_name === input.repository &&
    run.event === runtime.event && run.head_sha === logical && run.path === input.workflowPath &&
    run.run_started_at === input.startedAt &&
    (runtime.event === "pull_request" ? event.pull_request?.number === input.pullRequest &&
      event.pull_request.head.repo.full_name === input.repository : input.pullRequest === null),
  "Sonar producer is not this authenticated originating-repository run attempt");
  const definitions = run.referenced_workflows?.filter((entry) =>
    entry.path?.startsWith(`frasermolyneux/actions/${WORKFLOW_PATH}@`));
  requireValue(definitions?.length === 1 && definitions[0].sha === input.definitionSha,
    "Missing or ambiguous authenticated Sonar reusable definition");
  const reference = definitions[0].ref ?? definitions[0].path.split("@")[1];
  requireValue(/^(?:refs\/tags\/)?repository-analysis-sonar\/v\d+\.\d+\.\d+$/.test(reference) ||
    (input.repository === "frasermolyneux/actions" &&
      /^refs\/(?:heads\/[A-Za-z0-9_./-]+|pull\/[1-9]\d*\/merge)$/.test(reference)),
  "Sonar reusable analysis requires an immutable release, not an unreviewed foreign branch");
}

export function validateTask(task, input, taskId) {
  requireValue(task?.id === taskId && task.type === "REPORT" && task.status === "SUCCESS" &&
    task.componentKey === input.projectKey && ID.test(task.analysisId ?? "") &&
    Date.parse(task.submittedAt) >= Date.parse(input.startedAt) &&
    Date.parse(task.executedAt) >= Date.parse(task.submittedAt),
  "Sonar compute task is not a successful current invocation");
  const properties = rootProperties(task.scannerContext);
  for (const [field, key] of Object.entries(BINDING)) {
    requireValue(properties[key] === String(input[field]), "Sonar source or producer property mismatch");
  }
  if (input.pullRequest !== null) {
    requireValue(properties["sonar.pullrequest.key"] === String(input.pullRequest) &&
      !properties["sonar.branch.name"], "Sonar pull-request analysis identity mismatch");
  } else {
    requireValue(properties["sonar.branch.name"] === input.branch &&
      !properties["sonar.pullrequest.key"], "Sonar branch analysis identity mismatch");
  }
  requireValue(input.coveragePath === null
    ? properties["sonar.cs.cobertura.reportsPaths"] === undefined
    : properties["sonar.cs.cobertura.reportsPaths"] === input.coveragePath,
  "Sonar task did not select this invocation's coverage report");
  return { id: task.id, analysisId: task.analysisId, executedAt: task.executedAt };
}

async function getJson(endpoint, token, request) {
  requireValue(endpoint.startsWith("/api/") && typeof token === "string" &&
    /^[\x21-\x7e]+$/.test(token), "A valid Sonar token and fixed provider endpoint are required");
  return readJson(`${HOST}${endpoint}`, token, request);
}

async function readJson(url, token, request) {
  let response;
  try {
    response = await request(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json",
        ...(url.startsWith("https://api.github.com/") ? { "X-GitHub-Api-Version": "2022-11-28" } : {}) },
      redirect: "error", signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("Sonar provider request failed (transport)");
  }
  requireValue(response.ok, `Sonar provider request failed (HTTP ${response.status})`);
  let bytes = 0;
  const chunks = [];
  requireValue(response.body, "Empty Sonar provider response");
  for await (const chunk of response.body) {
    bytes += chunk.length;
    requireValue(bytes <= 3 * 1024 * 1024, "Sonar provider response exceeds the bounded limit");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Malformed Sonar provider JSON");
  }
}

export function receipt(content, projectKey) {
  requireValue(typeof content === "string" && Buffer.byteLength(content) <= 16 * 1024,
    "Missing or oversized Sonar upload receipt");
  const values = {};
  for (const line of content.split(/\r?\n/).filter(Boolean)) {
    const offset = line.indexOf("=");
    requireValue(offset > 0 && !Object.hasOwn(values, line.slice(0, offset)), "Malformed Sonar upload receipt");
    values[line.slice(0, offset)] = line.slice(offset + 1);
  }
  requireValue(values.projectKey === projectKey && values.serverUrl === HOST && ID.test(values.ceTaskId ?? "") &&
    values.ceTaskUrl === `${HOST}/api/ce/task?id=${values.ceTaskId}`,
  "Sonar receipt does not identify this fixed project and provider");
  return values.ceTaskId;
}

export async function verify(context, input, taskId, token, {
  request = fetch, sleep = delay, now = Date.now,
} = {}) {
  validateInput(input);
  eligible(context, input);
  requireValue(ID.test(taskId ?? ""), "A valid Sonar compute-task receipt is required");
  validateProject(await getJson(`/api/navigation/component?component=${encodeURIComponent(input.projectKey)}`,
    token, request), context, input);
  const poll = async (attempt) => {
    const { task } = await getJson(`/api/ce/task?id=${taskId}&additionalFields=scannerContext,warnings`, token, request);
    requireValue(task?.id === taskId && task.componentKey === input.projectKey &&
      ["PENDING", "IN_PROGRESS", "SUCCESS"].includes(task.status),
    "Sonar compute task failed, disappeared or changed identity");
    if (task.status === "SUCCESS") {
      return validateTask(task, input, taskId);
    }
    requireValue(attempt < 119, "Sonar compute task did not complete within ten minutes");
    await sleep(5000);
    return poll(attempt + 1);
  };
  const result = await poll(0);
  requireValue(Date.parse(result.executedAt) <= now() + 5 * 60 * 1000,
    "Sonar compute completion is in the future");
  return {
    schema: SCHEMA, repository: input.repository, repositoryId: input.repositoryId, visibility: "public",
    sourceSha: input.sourceSha, policyDigest: context.policyDigest, projectKey: input.projectKey,
    driver: input.driver, toolVersion: input.driver === "dotnet" ? DOTNET_VERSION : CLI_VERSION,
    recipeDigest: input.recipeDigest,
    definition: { sha: input.definitionSha, path: WORKFLOW_PATH, digest: await definitionDigest() },
    run: { id: input.runId, attempt: input.attempt, workflowPath: input.workflowPath,
      workflowSha: input.workflowSha, definitionSha: input.definitionSha },
    processing: { status: "completed", ...result },
    publication: { destination: "sonar-public", status: "completed", id: result.analysisId },
    completedAt: new Date(now()).toISOString(),
  };
}

export function properties(input, metadataPath) {
  validateInput(input);
  requireValue(path.isAbsolute(metadataPath) && !/[\0\r\n]/.test(metadataPath), "An isolated scanner metadata path is required");
  const values = Object.fromEntries(Object.entries(BINDING).map(([field, key]) => [key, String(input[field])]));
  values["sonar.organization"] = "frasermolyneux";
  values["sonar.host.url"] = HOST;
  values["sonar.scanner.metadataFilePath"] = metadataPath;
  if (input.pullRequest !== null) values["sonar.pullrequest.key"] = String(input.pullRequest);
  else values["sonar.branch.name"] = input.branch;
  if (input.coveragePath) values["sonar.cs.cobertura.reportsPaths"] = input.coveragePath;
  return values;
}

export function validateCollection(coverage, tests, input, bytes) {
  requireValue(coverage?.schema === 1 && coverage.status === "collected" && coverage.format === "cobertura" &&
    coverage.sourceSha === input.sourceSha && coverage.toolVersion === "18.11.2" &&
    coverage.sha256 === hash(bytes) && Number.isSafeInteger(coverage.lines?.total) && coverage.lines.total > 0 &&
    Number.isSafeInteger(coverage.lines.covered) && coverage.lines.covered >= 0 &&
    coverage.lines.covered <= coverage.lines.total,
  "Coverage must be this exact source's validated pinned native Cobertura report");
  requireValue(tests?.schema === 1 && tests.status === "passed" &&
    Number.isSafeInteger(tests.executed) && tests.executed > 0 &&
    Number.isSafeInteger(tests.passed) && tests.passed === tests.executed && tests.failed === 0 &&
    Number.isSafeInteger(tests.skipped) && tests.skipped >= 0,
  "Coverage requires actual successful executed tests, not missing or all-skipped tests");
  return { status: "collected", format: "cobertura", sourceSha: input.sourceSha, sha256: coverage.sha256,
    lines: coverage.lines, tests: { executed: tests.executed, passed: tests.passed, failed: 0, skipped: tests.skipped } };
}

export function historicalMeasures(payload, date, metrics) {
  requireValue(Number.isFinite(Date.parse(date)) && payload?.paging?.total === 1 &&
    Array.isArray(payload.measures), "Sonar historical measures are missing or ambiguous");
  const result = {};
  for (const name of metrics) {
    const values = payload.measures.filter((measure) => measure.metric === name);
    requireValue(values.length === 1 && values[0].history?.length === 1 &&
      Date.parse(values[0].history[0].date) === Date.parse(date),
    "Sonar historical metric is not bound to the exact analysis date");
    const value = values[0].history[0].value;
    requireValue(typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)),
      "Sonar historical metric is not a valid integer");
    result[name] = Number(value);
  }
  return result;
}

export async function verifyBranchImport(input, proof, collection, token, request = fetch) {
  requireValue(input.pullRequest === null, "Default-branch history cannot prove a pull-request coverage import");
  const parameters = new URLSearchParams({ project: input.projectKey, branch: input.branch, ps: "2" });
  const analyses = await getJson(`/api/project_analyses/search?${parameters}`, token, request);
  const analysis = analyses.analyses?.[0];
  requireValue(analysis?.key === proof.processing.analysisId && analysis.revision === input.sourceSha &&
    Number.isFinite(Date.parse(analysis.date)) &&
    analyses.analyses.filter((entry) => Date.parse(entry.date) === Date.parse(analysis.date)).length === 1,
  "Coverage needs the current exact-source analysis, not latest measures or a superseded task");
  const history = new URLSearchParams({ component: input.projectKey, branch: input.branch,
    metrics: "lines_to_cover,uncovered_lines", from: analysis.date, to: analysis.date, ps: "100" });
  const values = historicalMeasures(await getJson(`/api/measures/search_history?${history}`, token, request),
    analysis.date, ["lines_to_cover", "uncovered_lines"]);
  requireValue(values.lines_to_cover > 0 && values.uncovered_lines <= values.lines_to_cover &&
    (collection.lines.covered === 0 || values.uncovered_lines < values.lines_to_cover),
  "Completed Sonar analysis has no measurable matching coverage import");
  const after = await getJson(`/api/project_analyses/search?${parameters}`, token, request);
  requireValue(after.analyses?.[0]?.key === analysis.key && after.analyses[0].revision === input.sourceSha &&
    after.analyses[0].date === analysis.date, "Sonar analysis changed while verifying historical coverage");
  if (collection.lines.covered === 0) {
    return { ...collection, status: "collected",
      reason: "Zero covered lines cannot distinguish report import from missing server coverage" };
  }
  return { ...collection, status: "imported", analysisId: analysis.key, analysisDate: analysis.date,
    providerLines: { total: values.lines_to_cover, covered: values.lines_to_cover - values.uncovered_lines } };
}

async function boundedFile(filename, limit) {
  const info = await lstat(filename);
  requireValue(info.isFile() && !info.isSymbolicLink() && info.size <= limit,
    "Sonar evidence must be a bounded regular file");
  const content = await readFile(filename);
  requireValue(content.length <= limit, "Sonar evidence grew beyond its bounded limit");
  return content;
}

function git(root, args) {
  const command = process.platform === "win32" ? String.raw`C:\Program Files\Git\cmd\git.exe` : "/usr/bin/git";
  const result = spawnSync(command, ["-C", root, ...args], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  requireValue(result.status === 0, "Cannot validate the unchanged Sonar source checkout");
  return result.stdout.trim();
}

export function validateUntracked(files, driver) {
  const outputs = new Set(driver === "dotnet"
    ? ["bin", "obj", ".sonarqube"]
    : ["node_modules", "vendor", "fixtures", "build", ".scannerwork"]);
  const sourceFile = /\.(?:cs|vb|c|cc|cpp|cxx|h|hh|hpp|hxx|[cm]?js|jsx|[cm]?ts|tsx|py|php|html|css|scss|sass|json|xml|ya?ml|tf|bicep|sh|ps1|props|targets)$/i;
  requireValue(files.every((filename) => !sourceFile.test(filename) ||
    filename.split("/").some((part) => outputs.has(part))),
  "Untracked analyzable files outside known excluded build outputs cannot be published");
}

export async function validateSource(root, recipe, sha) {
  const physical = await realpath(root);
  requireValue(physical === await realpath(git(root, ["rev-parse", "--show-toplevel"])) &&
    git(root, ["rev-parse", "HEAD"]) === sha, "Sonar requires the exact complete Git worktree");
  git(root, ["diff", "--exit-code", "HEAD", "--"]);
  const untracked = ["--exclude-standard", "--ignored"].flatMap((selection) =>
    git(root, ["ls-files", "--others", ...(selection === "--ignored"
      ? ["--ignored", "--exclude-standard"] : [selection]), "-z"]).split("\0").filter(Boolean));
  validateUntracked(untracked, recipe.driver);
  const directory = await realpath(path.join(root, recipe.sourceDirectory));
  requireValue(directory === physical || directory.startsWith(physical + path.sep),
    "Sonar base directory escapes the authenticated source");
  return directory;
}

export async function main(env = process.env) {
  if (env.SONAR_MODE === "capability") {
    const context = await resolveAnalysis(JSON.parse(env.SONAR_PROFILE ?? ""),
      env.GITHUB_REPOSITORY, env.GH_TOKEN);
    requireValue(context.repositoryId === Number(env.GITHUB_REPOSITORY_ID) &&
      context.visibility === "public" && context.sonar.status === "eligible",
    "Sonar scanner installation requires this live public eligible repository");
    validateDriver(context, validateRecipe(JSON.parse(env.SONAR_RECIPE ?? "")).driver);
    return;
  }
  const recipe = validateRecipe(JSON.parse(env.SONAR_RECIPE ?? ""));
  const { validateBuild } = await import("./build.mjs");
  const build = validateBuild(JSON.parse(env.SONAR_BUILD ?? ""), recipe);
  const input = validateInput(JSON.parse(env.SONAR_PRODUCER ?? ""));
  requireValue(input.projectKey === recipe.projectKey && input.driver === recipe.driver &&
    input.recipeDigest === recipeDigest(recipe, build) &&
    (input.coveragePath !== null) === (recipe.coverage === "cobertura"), "Sonar producer recipe mismatch");
  const context = await resolveAnalysis(JSON.parse(env.SONAR_PROFILE ?? ""),
    env.GITHUB_REPOSITORY, env.GH_TOKEN);
  requireValue(context.repositoryId === Number(env.GITHUB_REPOSITORY_ID), "Unexpected live Sonar repository identity");
  eligible(context, input);
  const runtime = { repository: env.GITHUB_REPOSITORY, repositoryId: Number(env.GITHUB_REPOSITORY_ID),
    runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT), sourceSha: env.GITHUB_SHA,
    workflowPath: env.GITHUB_WORKFLOW_REF?.slice(env.GITHUB_REPOSITORY.length + 1).split("@")[0],
    workflowSha: env.GITHUB_WORKFLOW_SHA, event: env.GITHUB_EVENT_NAME };
  const event = JSON.parse(await boundedFile(env.GITHUB_EVENT_PATH, 5 * 1024 * 1024));
  const run = await readJson(`https://api.github.com/repos/${input.repository}/actions/runs/${input.runId}/attempts/${input.attempt}`,
    env.GH_TOKEN, fetch);
  validateProducerRun(run, input, runtime, event);
  const trust = await authorizeSource(input, run, event, env.GH_TOKEN);
  const directory = await validateSource(env.SONAR_SOURCE_DIRECTORY, recipe, input.sourceSha);
  if (env.SONAR_MODE === "authorize") {
    const stored = JSON.parse(await boundedFile(path.join(env.SONAR_EVIDENCE_DIRECTORY, "producer.json"), 16 * 1024));
    requireValue(JSON.stringify(stored) === JSON.stringify(input) &&
      directory === await realpath(env.SONAR_SCANNER_SOURCE),
    "Native scanner must use the previously prepared producer and physical source directory");
    validateProject(await getJson(`/api/navigation/component?component=${encodeURIComponent(input.projectKey)}`,
      env.SONAR_TOKEN, fetch), context, input);
    if (env.SONAR_AUTH_PHASE === "begin") {
      requireValue(JSON.stringify(JSON.parse(env.SONAR_PROPERTIES)) ===
        JSON.stringify(properties(input, path.join(env.SONAR_EVIDENCE_DIRECTORY, "report-task.txt"))),
      "Native scanner properties must exactly match the prepared fixed-provider/source binding");
    }
    return;
  }
  if (env.SONAR_MODE === "prepare") {
    validateProject(await getJson(`/api/navigation/component?component=${encodeURIComponent(input.projectKey)}`,
      env.SONAR_TOKEN, fetch), context, input);
    const output = await mkdtemp(path.join(env.RUNNER_TEMP, "sonar-evidence-"));
    const metadataPath = path.join(output, "report-task.txt");
    const args = properties(input, metadataPath);
    await writeFile(path.join(output, "producer.json"), JSON.stringify(input) + "\n");
    await appendFile(env.GITHUB_OUTPUT, `evidence-directory=${output}\nsource-directory=${directory}\nproperties=${JSON.stringify(args)}\n`);
    return;
  }
  requireValue(env.SONAR_MODE === "verify", "Unknown Sonar evidence mode");
  const stored = JSON.parse(await boundedFile(path.join(env.SONAR_EVIDENCE_DIRECTORY, "producer.json"), 16 * 1024));
  requireValue(JSON.stringify(stored) === JSON.stringify(input), "Sonar producer changed during execution");
  const taskId = receipt((await boundedFile(path.join(env.SONAR_EVIDENCE_DIRECTORY, "report-task.txt"), 16 * 1024)).toString(),
    input.projectKey);
  const proof = await verify(context, input, taskId, env.SONAR_TOKEN);
  proof.trust = trust;
  if (recipe.coverage === "cobertura") {
    const root = path.join(env.RUNNER_TEMP, "dotnet-test");
    const directories = await readdir(root);
    requireValue(directories.length === 1 &&
      await realpath(path.dirname(env.SONAR_COVERAGE_DIRECTORY)) === await realpath(root),
    "Coverage selection must contain only this job's one isolated test invocation");
    const coveragePath = path.join(env.SONAR_COVERAGE_DIRECTORY, "coverage.cobertura.xml");
    const bytes = await boundedFile(coveragePath, 32 * 1024 * 1024);
    const collection = validateCollection(JSON.parse(env.SONAR_COVERAGE_REPORT), JSON.parse(env.SONAR_TEST_REPORT),
      input, bytes);
    proof.coverage = input.pullRequest === null
      ? await verifyBranchImport(input, proof, collection, env.SONAR_TOKEN)
      : { ...collection, status: "collected", reason: "PR task completed; default-branch history is not PR import proof" };
    requireValue(hash(await boundedFile(coveragePath, 32 * 1024 * 1024)) === collection.sha256,
      "Coverage report changed during provider verification");
  } else {
    proof.coverage = { status: "not-applicable", reason: "Original build family has no declared supported coverage" };
  }
  proof.scope = "sonar-task-and-selected-coverage-only";
  proof.fullProfileEvidence = false;
  await writeFile(path.join(env.SONAR_EVIDENCE_DIRECTORY, "proof.json"), JSON.stringify(proof) + "\n");
  await appendFile(env.GITHUB_OUTPUT, `proof-directory=${env.SONAR_EVIDENCE_DIRECTORY}\nanalysis-id=${proof.publication.id}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::${error instanceof SyntaxError ? "Malformed Sonar analysis JSON" : error.message}`);
    process.exitCode = 1;
  }
}

import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAnalysis } from "../repository-analysis-context/policy.mjs";
import { selectedTools } from "../repository-analysis-state/state.mjs";
import { authorizeSource, validateRecipe, validateSource } from "../repository-analysis-sonar/sonar.mjs";
import { validateBuild } from "../repository-analysis-sonar/build.mjs";

export const VERSION = "2.27.1";
export const WORKFLOW_PATH = ".github/workflows/repository-analysis-codeql.yml";
export const SCHEMA = "repository-analysis-codeql-artifact-v1";
export const DEFINITION_FILES = [
  WORKFLOW_PATH, "repository-analysis-codeql/action.yml", "repository-analysis-codeql/engine.mjs",
  "repository-analysis-codeql/version.json", "repository-analysis-codeql/integration.mjs",
  "repository-analysis-codeql/extractor.mjs", "repository-analysis-codeql/archive.py",
  "repository-analysis-context/policy.mjs", "repository-analysis-context/source.mjs",
  "repository-analysis-state/state.mjs", "repository-analysis-sonar/sonar.mjs",
  "repository-analysis-sonar/build.mjs", "repository-analysis-sonar/build.ps1",
  "dotnet-test/coverage-tools.json", "repository-analysis-sarif/action.yml",
  "repository-analysis-sarif/verify.mjs", "repository-analysis-context/action.yml",
];
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const compiled = new Set(["csharp", "cpp"]);
const root = fileURLToPath(new URL("../", import.meta.url));

export async function definitionDigest() {
  const manifest = await Promise.all(DEFINITION_FILES.map(async (filename) => {
    const bytes = await readFile(path.join(root, filename));
    return { filename, bytes: bytes.length, sha256: hash(bytes) };
  }));
  return hash(JSON.stringify(manifest));
}

export function plan(context, run, runtime, event, buildInput, sourceDirectory) {
  const tools = selectedTools(context).filter(({ tool }) => tool === "codeql");
  requireValue(context.repository === runtime.repository && context.repositoryId === runtime.repositoryId &&
    [runtime.sourceSha, runtime.workflowSha].every((sha) => SHA.test(sha ?? "")) &&
    runtime.expectedSha === runtime.sourceSha &&
    [runtime.runId, runtime.attempt].every((value) => Number.isSafeInteger(value) && value > 0) &&
    ["push", "pull_request", "schedule", "workflow_dispatch"].includes(runtime.event) &&
    /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(runtime.workflowPath ?? "") &&
    run?.id === runtime.runId && run.run_attempt === runtime.attempt &&
    run.repository?.id === runtime.repositoryId && run.repository.full_name === runtime.repository &&
    run.event === runtime.event && run.path === runtime.workflowPath &&
    run.head_sha === (event.pull_request?.head.sha ?? runtime.sourceSha),
  "CodeQL requires the exact originating repository, run, attempt and actual/logical source");
  requireValue(runtime.event !== "pull_request" ||
    (event.pull_request?.head.repo.id === runtime.repositoryId &&
      event.pull_request.head.repo.full_name === runtime.repository && event.pull_request.draft === false),
  "CodeQL publication rejects foreign, draft or missing PR origins");
  const definitions = run.referenced_workflows?.filter((entry) =>
    entry.path?.startsWith(`frasermolyneux/actions/${WORKFLOW_PATH}@`));
  requireValue(definitions?.length === 1 && SHA.test(definitions[0].sha ?? ""),
    "Missing or ambiguous called CodeQL definition");
  const reference = definitions[0].ref ?? definitions[0].path.split("@")[1];
  requireValue(/^(?:refs\/tags\/)?repository-analysis-codeql\/v\d+\.\d+\.\d+$/.test(reference) ||
    (runtime.repository === "frasermolyneux/actions" &&
      /^refs\/(?:heads\/[A-Za-z0-9_./-]+|pull\/[1-9]\d*\/merge)$/.test(reference)),
  "CodeQL requires an immutable foreign release before checkout or licensed execution");
  const needsBuild = tools.some(({ id }) => compiled.has(id.slice(7)));
  const sourceRecipe = validateRecipe({ version: 1,
    driver: needsBuild ? (buildInput?.kind === "cmake" ? "cpp" : "dotnet") : "cli",
    projectKey: "codeql-analysis-only", sourceDirectory,
    coverage: buildInput?.tests === true ? "cobertura" : "not-applicable" });
  const build = needsBuild ? validateBuild(buildInput, sourceRecipe) : null;
  if (needsBuild) {
    requireValue(tools.every(({ id }) => !compiled.has(id.slice(7)) ||
      (id === "codeql/csharp" && ["dotnet", "netfx"].includes(build.kind)) ||
      (id === "codeql/cpp" && build.kind === "cmake")),
    "Every selected compiled language needs its declared original build family");
  }
  return {
    context, definitionSha: definitions[0].sha, sourceRecipe, build,
    sourceSha: runtime.sourceSha, logicalHeadSha: event.pull_request?.head.sha ?? runtime.sourceSha,
    runId: runtime.runId, attempt: runtime.attempt, workflowPath: runtime.workflowPath,
    workflowSha: runtime.workflowSha, event: runtime.event,
    matrix: { include: tools.length ? tools.map(({ id }) => {
      const language = id.slice(7);
      const windows = language === "csharp" && build.kind === "netfx";
      return { language, runner: windows ? "windows-latest" : "ubuntu-latest",
        bundle: windows ? "win64" : "linux64", buildMode: compiled.has(language) ? "manual" : "none",
        sdk: language === "csharp" ? build.sdk.join("\n") : "", family: compiled.has(language) ? build.kind : "none" };
    }) : [{ language: "not-selected", runner: "ubuntu-latest" }] },
    hasLanguages: tools.length > 0,
  };
}

async function boundedFile(filename, limit = 128 * 1024) {
  const info = await lstat(filename);
  requireValue(info.isFile() && !info.isSymbolicLink() && info.size <= limit,
    "CodeQL evidence must be a bounded regular file");
  const bytes = await readFile(filename);
  requireValue(bytes.length <= limit, "CodeQL evidence grew beyond its bound");
  return bytes;
}

async function readRun(runtime, token) {
  const response = await fetch(
    `https://api.github.com/repos/${runtime.repository}/actions/runs/${runtime.runId}/attempts/${runtime.attempt}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error", signal: AbortSignal.timeout(30_000),
    });
  requireValue(response.ok, `CodeQL originating run read failed (HTTP ${response.status})`);
  const chunks = [];
  let size = 0;
  requireValue(response.body, "CodeQL run metadata is empty");
  for await (const chunk of response.body) {
    size += chunk.length;
    requireValue(size <= 1024 * 1024, "CodeQL run metadata exceeds its bound");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function runtimeFromEnvironment(env) {
  return { repository: env.GITHUB_REPOSITORY, repositoryId: Number(env.GITHUB_REPOSITORY_ID),
    sourceSha: env.GITHUB_SHA, expectedSha: env.CODEQL_EXPECTED_SHA,
    workflowSha: env.GITHUB_WORKFLOW_SHA, runId: Number(env.GITHUB_RUN_ID),
    attempt: Number(env.GITHUB_RUN_ATTEMPT), event: env.GITHUB_EVENT_NAME,
    workflowPath: env.GITHUB_WORKFLOW_REF?.slice(env.GITHUB_REPOSITORY.length + 1).split("@")[0] };
}

function command(executable, args, env) {
  const result = spawnSync(executable, args, { env, encoding: "utf8",
    timeout: 120_000, maxBuffer: 1024 * 1024 });
  requireValue(!result.error && result.status === 0,
    `CodeQL source verification failed (${result.error?.code ?? result.status}): ${result.stderr?.slice(0, 4096) ?? ""}`);
  return result.stdout;
}

export function sourceCoverage(context, language, extracted) {
  const selected = selectedTools(context).find(({ id }) => id === `codeql/${language}`);
  requireValue(selected, "Source coverage requires a selected native language");
  const files = extracted?.extraction?.files;
  requireValue(Number.isSafeInteger(files) && files > 0,
    "Native source coverage requires an actual positive archived file count");
  const counts = {};
  for (const capability of selected.capabilities) {
    counts[capability] = extracted.extraction?.sourceCoverage?.[capability];
    requireValue(Number.isSafeInteger(counts[capability]) && counts[capability] > 0,
      "Native source archive cannot prove an absent selected capability");
  }
  requireValue(language === "javascript-typescript"
    ? Object.values(counts).every((count) => count <= files)
    : counts[language] === files, "Native capability counts exceed actual archived source");
  return counts;
}

export function validateArtifact(report, native, planned, language, digest) {
  const selected = selectedTools(planned.context).find(({ id }) => id === `codeql/${language}`);
  requireValue(selected && report?.schema === SCHEMA && report.language === language &&
    report.visibility === "public" &&
    report.repository === planned.context.repository && report.repositoryId === planned.context.repositoryId &&
    report.sourceSha === planned.sourceSha && report.policyDigest === planned.context.policyDigest &&
    report.definition?.sha === planned.definitionSha && report.definition.path === WORKFLOW_PATH &&
    report.definition.digest === digest && report.version === VERSION && report.ruleRevision === VERSION &&
    report.run?.id === planned.runId && report.run.attempt === planned.attempt &&
    report.run.logicalHeadSha === planned.logicalHeadSha && report.run.workflowSha === planned.workflowSha &&
    report.run.workflowPath === planned.workflowPath && report.run.job === "native" &&
    report.extraction?.schema === "repository-analysis-codeql-integration-v1" &&
    report.extraction.scope === "selected-codeql-language-only" &&
    report.extraction.fullProfileEvidence === false && report.extraction.visibility === "public" &&
    report.extraction.sourceSha === planned.sourceSha && report.extraction.version === VERSION &&
    report.extraction.language === language && report.extraction.repository === report.repository &&
    report.extraction.repositoryId === report.repositoryId &&
    report.extraction.run?.id === planned.runId && report.extraction.run.attempt === planned.attempt &&
    report.extraction.ruleRevision === VERSION &&
    Number.isSafeInteger(report.extraction.extraction?.files) && report.extraction.extraction.files > 0 &&
    HASH.test(report.extraction.extraction.sourceDigest ?? "") &&
    HASH.test(report.extraction.sarif?.sha256 ?? "") &&
    selected.capabilities.length === Object.keys(report.sourceCoverage ?? {}).length &&
    selected.capabilities.every((capability) =>
      Number.isSafeInteger(report.sourceCoverage[capability]) && report.sourceCoverage[capability] > 0),
  "CodeQL extraction artifact is not this selected source, definition, version and run attempt");
  requireValue(JSON.stringify(report.sourceCoverage) ===
    JSON.stringify(sourceCoverage(planned.context, language, report.extraction)),
  "CodeQL capability coverage must come from the genuinely archived source, not tracked candidate counts");
  requireValue(native?.schema === "repository-analysis-sarif-proof-v1" &&
    native.repository === report.repository && native.repositoryId === report.repositoryId &&
    native.visibility === "public" && native.policyDigest === report.policyDigest &&
    native.toolId === selected.id && native.sourceSha === report.sourceSha &&
    native.run?.id === planned.runId && native.run.attempt === planned.attempt &&
    native.run.job === "native" && native.run.workflowPath === planned.workflowPath &&
    native.run.workflowSha === planned.workflowSha && native.run.logicalHeadSha === planned.logicalHeadSha &&
    native.tool?.name === "CodeQL" && native.tool.version === VERSION &&
    [selected.category, `${selected.category}/`].includes(native.category) &&
    native.processing?.status === "completed" && native.publication?.status === "completed" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(native.processing.id ?? "") &&
    native.publication.destination === "github-security" &&
    /^[1-9]\d*$/.test(native.publication.id ?? "") &&
    Number.isSafeInteger(native.findingCount) && native.findingCount >= 0 &&
    Number.isSafeInteger(native.ruleCount) && native.ruleCount > 0,
  "CodeQL native processing is not this actual language/source/producer");
  return { id: selected.id, status: "completed", sourceSha: report.sourceSha,
    version: VERSION, ruleRevision: VERSION, engineDigest: digest, sourceCoverage: report.sourceCoverage,
    findingCount: native.findingCount, processing: native.processing, publication: native.publication,
    completedAt: native.verifiedAt };
}

export async function assembleTools(directory, planned, digest) {
  requireValue(path.isAbsolute(directory ?? ""), "An isolated CodeQL artifact set is required");
  const languages = planned.context.codeql.languages;
  const names = languages.map((language) => `codeql-native-${language}-${planned.attempt}`);
  const actual = await readdir(directory);
  requireValue(actual.length === names.length && names.every((name) => actual.includes(name)),
    "Missing, duplicated or unexpected selected CodeQL artifact");
  const tools = [];
  for (const language of languages) {
    const location = path.join(directory, `codeql-native-${language}-${planned.attempt}`);
    tools.push(validateArtifact(JSON.parse(await boundedFile(path.join(location, "report.json"))),
      JSON.parse(await boundedFile(path.join(location, "native.json"))), planned, language, digest));
  }
  return tools;
}

export async function main(env = process.env) {
  const runtime = runtimeFromEnvironment(env);
  const context = await resolveAnalysis(JSON.parse(env.CODEQL_PROFILE ?? ""),
    runtime.repository, env.GH_TOKEN);
  const run = await readRun(runtime, env.GH_TOKEN);
  const event = JSON.parse(await boundedFile(env.GITHUB_EVENT_PATH, 5 * 1024 * 1024));
  const planned = plan(context, run, runtime, event, JSON.parse(env.CODEQL_BUILD ?? "null"),
    env.CODEQL_SOURCE_DIRECTORY);
  if (env.CODEQL_MODE === "plan") {
    if (planned.hasLanguages) {
      await authorizeSource({ repository: runtime.repository, repositoryId: runtime.repositoryId,
        sourceSha: runtime.sourceSha, pullRequest: event.pull_request?.number ?? null }, run, event, env.GH_TOKEN);
    }
    await appendFile(env.GITHUB_OUTPUT, `plan=${JSON.stringify(planned)}\n` +
      `matrix=${JSON.stringify(planned.matrix)}\nhas-languages=${planned.hasLanguages}\n`);
    return;
  }
  requireValue(JSON.stringify(planned) === JSON.stringify(JSON.parse(env.CODEQL_PLAN ?? "")),
    "CodeQL live source, visibility, selection, definition or build changed after planning");
  if (env.CODEQL_MODE === "assemble") {
    const digest = await definitionDigest();
    const tools = await assembleTools(env.CODEQL_EVIDENCE_DIRECTORY, planned, digest);
    const output = path.join(env.RUNNER_TEMP, "repository-analysis-codeql-set");
    await mkdir(output);
    await writeFile(path.join(output, "codeql-results.json"), JSON.stringify({
      schema: "repository-analysis-codeql-set-v1", scope: "selected-codeql-languages-only",
      fullProfileEvidence: false, repository: context.repository, repositoryId: context.repositoryId,
      visibility: context.visibility, policyDigest: context.policyDigest, sourceSha: runtime.sourceSha,
      definition: { sha: planned.definitionSha, path: WORKFLOW_PATH, digest },
      run: { id: runtime.runId, attempt: runtime.attempt, workflowPath: runtime.workflowPath,
        workflowSha: runtime.workflowSha, logicalHeadSha: planned.logicalHeadSha }, tools,
      applicability: context.codeql.status,
    }, null, 2) + "\n");
    await appendFile(env.GITHUB_OUTPUT, `result-directory=${output}\n`);
    return;
  }
  const language = env.CODEQL_LANGUAGE;
  requireValue(context.visibility === "public" && context.codeql.languages.includes(language) &&
    env.GITHUB_JOB === "native", "Only a live eligible native producer may execute or publish CodeQL");
  await authorizeSource({ repository: runtime.repository, repositoryId: runtime.repositoryId,
    sourceSha: runtime.sourceSha, pullRequest: event.pull_request?.number ?? null }, run, event, env.GH_TOKEN);
  const source = await validateSource(env.GITHUB_WORKSPACE,
    { ...planned.sourceRecipe, driver: language === "cpp" ? "cpp" : language === "csharp" ? "dotnet" : "cli" },
    runtime.sourceSha);
  if (env.CODEQL_MODE === "authorize" || env.CODEQL_MODE === "build") {
    requireValue(env.CODEQL_MODE !== "build" || compiled.has(language),
      "Only the selected compiled language may execute the declared build");
    await appendFile(env.GITHUB_OUTPUT, `source-directory=${source}\n`);
    return;
  }
  const output = path.join(env.RUNNER_TEMP, `codeql-extraction-${language}`);
  if (env.CODEQL_MODE === "extract") {
    requireValue(env.CODEQL_VERSION === VERSION, "Native CodeQL executable version changed");
    command(process.execPath, [path.join(root, "repository-analysis-codeql", "integration.mjs")],
      { ...env, ANALYSIS_PROFILE: env.CODEQL_PROFILE, CODEQL_FIXTURE: "false" });
    const extraction = JSON.parse(await boundedFile(path.join(output, "proof.json")));
    const report = { schema: SCHEMA, repository: context.repository, repositoryId: context.repositoryId,
      visibility: "public", policyDigest: context.policyDigest, sourceSha: runtime.sourceSha, language,
      version: VERSION, ruleRevision: VERSION,
      definition: { sha: planned.definitionSha, path: WORKFLOW_PATH, digest: await definitionDigest() },
      run: { id: runtime.runId, attempt: runtime.attempt, job: "native", workflowPath: runtime.workflowPath,
        workflowSha: runtime.workflowSha, logicalHeadSha: planned.logicalHeadSha },
      sourceCoverage: sourceCoverage(context, language, extraction), extraction };
    await writeFile(path.join(output, "report.json"), JSON.stringify(report) + "\n");
    await appendFile(env.GITHUB_OUTPUT, `report-directory=${output}\n`);
    return;
  }
  requireValue(env.CODEQL_MODE === "bind", "Unknown CodeQL evidence mode");
  const native = JSON.parse(await boundedFile(path.join(env.CODEQL_NATIVE_DIRECTORY, "proof.json")));
  const report = JSON.parse(await boundedFile(path.join(output, "report.json")));
  validateArtifact(report, native, planned, language, await definitionDigest());
  await writeFile(path.join(output, "native.json"), JSON.stringify(native) + "\n");
  await appendFile(env.GITHUB_OUTPUT, `report-directory=${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error instanceof SyntaxError ? "Malformed CodeQL analysis JSON" : error.message}`);
    process.exitCode = 1;
  });
}

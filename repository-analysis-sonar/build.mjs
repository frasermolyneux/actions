import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { recipeDigest, validateRecipe, WORKFLOW_PATH } from "./sonar.mjs";

const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const relative = (value) => typeof value === "string" &&
  (value === "." || /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)) &&
  value.split("/").every((part) => !["", ".."].includes(part));

export function validateBuild(value, recipeInput) {
  const recipe = validateRecipe(recipeInput);
  requireValue(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => ["kind", "sdk", "globalJson", "solution", "skipFormat",
      "tests", "nodeVersion", "npmInstall", "configureArgs", "buildArgs", "testArgs"].includes(key)),
  "Invalid analysis-only build recipe");
  requireValue(["dotnet", "netfx", "cmake", "script"].includes(value.kind) &&
    ((recipe.driver === "dotnet" && ["dotnet", "netfx"].includes(value.kind)) ||
      (recipe.driver === "cpp" && value.kind === "cmake") ||
      (recipe.driver === "cli" && value.kind === "script")), "Scanner/build family mismatch");
  if (["dotnet", "netfx"].includes(value.kind)) {
    requireValue(Array.isArray(value.sdk) && value.sdk.length > 0 && value.sdk.length <= 4 &&
      value.sdk.every((sdk) => /^\d+\.\d+\.(?:x|\d+|[1-9]xx)$/.test(sdk)) &&
      (value.globalJson === null || (relative(value.globalJson) && value.globalJson.split("/").at(-1) === "global.json")) &&
      relative(value.solution) && typeof value.skipFormat === "boolean" && typeof value.tests === "boolean" &&
      (recipe.coverage === "cobertura") === value.tests &&
      (value.kind !== "netfx" || (!value.tests && value.skipFormat)),
    "Build-aware .NET needs declared SDK/solution/format/test and coverage selections");
    requireValue(["kind", "sdk", "globalJson", "solution", "skipFormat", "tests"].length === Object.keys(value).length,
      "Unexpected .NET build inputs");
  } else if (value.kind === "cmake") {
    const allowedConfigure = new Set(["-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
      "-DPORTAL_COD4X_BUILD_PLUGIN_BINARY=OFF"]);
    requireValue(Object.keys(value).length === 4 &&
      ["configureArgs", "buildArgs", "testArgs"].every((key) => Array.isArray(value[key]) &&
        value[key].length > 0 && value[key].length <= 32 &&
        value[key].every((arg) => typeof arg === "string" && arg.length > 0 &&
          arg.length <= 512 && !/[\0\r\n]/.test(arg))) &&
      value.configureArgs.includes("-DCMAKE_EXPORT_COMPILE_COMMANDS=ON") &&
      value.configureArgs.every((arg) => allowedConfigure.has(arg)) &&
      JSON.stringify(value.buildArgs) === JSON.stringify(["--config", "Release"]) &&
      JSON.stringify(value.testArgs) === JSON.stringify(["--output-on-failure", "--build-config", "Release"]),
    "CMake analysis requires bounded original argv and actual compile commands");
  } else {
    requireValue(Object.keys(value).length === 3 && ["20.x", "22"].includes(value.nodeVersion) &&
      typeof value.npmInstall === "boolean", "Script analysis needs declared Node/dependency selection");
  }
  return value;
}

export function plan(run, runtime, event, recipeInput, buildInput) {
  const recipe = validateRecipe(recipeInput);
  const build = validateBuild(buildInput, recipe);
  requireValue(["push", "pull_request", "schedule", "workflow_dispatch"].includes(runtime.event) &&
    runtime.expectedSha === runtime.sha && /^[a-f0-9]{40}$/.test(runtime.sha ?? "") &&
    run?.id === runtime.runId && run.run_attempt === runtime.attempt &&
    run.repository?.id === runtime.repositoryId && run.repository.full_name === runtime.repository &&
    run.event === runtime.event && run.path === runtime.workflowPath &&
    run.head_sha === (event.pull_request?.head.sha ?? runtime.sha),
  "Sonar plan must originate from this exact supported run/source");
  requireValue(runtime.event !== "pull_request" ||
    (event.pull_request?.head.repo.full_name === runtime.repository && !event.pull_request.draft),
  "Sonar credentials cannot be used for foreign or draft pull requests");
  const definitions = run.referenced_workflows?.filter((entry) =>
    entry.path?.startsWith(`frasermolyneux/actions/${WORKFLOW_PATH}@`));
  requireValue(definitions?.length === 1 && /^[a-f0-9]{40}$/.test(definitions[0].sha ?? ""),
    "Missing or ambiguous called Sonar definition");
  const reference = definitions[0].ref ?? definitions[0].path.split("@")[1];
  requireValue(/^(?:refs\/tags\/)?repository-analysis-sonar\/v\d+\.\d+\.\d+$/.test(reference) ||
    (runtime.repository === "frasermolyneux/actions" &&
      /^refs\/(?:heads\/[A-Za-z0-9_./-]+|pull\/[1-9]\d*\/merge)$/.test(reference)),
  "Sonar plan rejects a mutable foreign definition");
  const branch = runtime.event === "pull_request" ? event.pull_request.head.ref : runtime.refName;
  return {
    recipe, build, runner: build.kind === "netfx" ? "windows-latest" : "ubuntu-latest",
    definitionSha: definitions[0].sha,
    producer: { repository: runtime.repository, repositoryId: runtime.repositoryId,
      projectKey: recipe.projectKey, sourceSha: runtime.sha, runId: runtime.runId, attempt: runtime.attempt,
      workflowPath: runtime.workflowPath, workflowSha: runtime.workflowSha, definitionSha: definitions[0].sha,
      recipeDigest: recipeDigest(recipe, build), branch, pullRequest: event.pull_request?.number ?? null,
      startedAt: run.run_started_at, driver: recipe.driver, coveragePath: null },
  };
}

export async function main(env = process.env) {
  const repository = env.GITHUB_REPOSITORY;
  const runtime = { repository, repositoryId: Number(env.GITHUB_REPOSITORY_ID),
    runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT), sha: env.GITHUB_SHA,
    workflowPath: env.GITHUB_WORKFLOW_REF?.slice(repository.length + 1).split("@")[0],
    workflowSha: env.GITHUB_WORKFLOW_SHA, event: env.GITHUB_EVENT_NAME,
    expectedSha: env.SONAR_EXPECTED_SHA, refName: env.GITHUB_REF_NAME };
  const result = plan(JSON.parse(env.SONAR_RUN), runtime,
    JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")),
    JSON.parse(env.SONAR_RECIPE), JSON.parse(env.SONAR_BUILD));
  await appendFile(env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) =>
    `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join("\n") + "\n" +
    `sdk<<SDK_VERSIONS\n${result.build.sdk?.join("\n") ?? ""}\nSDK_VERSIONS\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch (error) {
    console.error(`::error::${error instanceof SyntaxError ? "Malformed Sonar build JSON" : error.message}`);
    process.exitCode = 1;
  }
}

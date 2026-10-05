import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAnalysis } from "../repository-analysis-context/policy.mjs";

const env = process.env;
const hash = (content) => createHash("sha256").update(content).digest("hex");
const language = env.CODEQL_LANGUAGE;
const aliases = { "javascript-typescript": "javascript", actions: "actions", python: "python",
  csharp: "csharp", cpp: "cpp" };
assert.ok(Object.hasOwn(aliases, language), "An explicit supported CodeQL language is required");
assert.equal(env.CODEQL_VERSION, "2.27.1");
const context = await resolveAnalysis(JSON.parse(env.ANALYSIS_PROFILE), env.GITHUB_REPOSITORY, env.GH_TOKEN);
assert.equal(context.repositoryId, Number(env.GITHUB_REPOSITORY_ID));
assert.equal(context.visibility, "public");
assert.ok(context.codeql.languages.includes(language), "CodeQL language must be public and selected");
const root = await realpath(env.GITHUB_WORKSPACE);
const git = process.platform === "win32" ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git";
const run = (command, args, input) => {
  assert.ok(path.isAbsolute(command), "Evidence commands must not resolve through repository-controlled PATH");
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", input, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `CodeQL evidence command failed: ${path.basename(command)}`);
  return result.stdout;
};
assert.equal(run(git, ["rev-parse", "HEAD"]).trim(), env.GITHUB_SHA);
run(git, ["diff", "--exit-code", "HEAD", "--"]);
const databases = JSON.parse(env.CODEQL_DATABASES);
assert.equal(Object.keys(databases).length, 1);
const database = databases[aliases[language]];
assert.ok(path.isAbsolute(database));
const resolved = JSON.parse(run(env.CODEQL_COMMAND, ["resolve", "database", database, "--format=json"]));
const archive = path.join(database, "src.zip");
const info = await lstat(archive);
assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 512 * 1024 * 1024);
const tracked = run(git, ["ls-files", "-z"]).split("\0").filter(Boolean);
const expressions = {
  actions: /^\.github\/workflows\/[^/]+\.ya?ml$/,
  "javascript-typescript": /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/,
  python: /\.py$/,
  csharp: /\.cs$/,
  cpp: /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/,
};
const fixture = env.CODEQL_FIXTURE === "true";
assert.ok(!fixture || env.GITHUB_REPOSITORY === "frasermolyneux/actions");
const candidates = tracked.filter((file) => expressions[language].test(file) &&
  (fixture ? file.startsWith(env.CODEQL_FIXTURE_DIRECTORY + "/") :
    !/(?:^|\/)(?:fixtures|node_modules|vendor|bin|obj)\//i.test(file)));
assert.ok(candidates.length > 0, "Selected source cannot be inferred from successful commands");
const extracted = JSON.parse(run(env.CODEQL_PYTHON, [
  path.join(path.dirname(fileURLToPath(import.meta.url)), "archive.py"),
], JSON.stringify({ archive, root, files: candidates })));
const output = env.CODEQL_SARIF_DIRECTORY;
const filename = path.join(output, aliases[language] + ".sarif");
const bytes = await readFile(filename);
assert.ok(bytes.length > 0 && bytes.length <= 50 * 1024 * 1024);
const sarif = JSON.parse(bytes);
assert.equal(sarif.version, "2.1.0");
assert.equal(sarif.runs.length, 1);
const analysis = sarif.runs[0];
assert.equal(analysis.tool.driver.name, "CodeQL");
assert.equal(analysis.tool.driver.semanticVersion ?? analysis.tool.driver.version, "2.27.1");
assert.ok(Array.isArray(analysis.results));
assert.ok(analysis.invocations?.length > 0 && analysis.invocations.every(item => item.executionSuccessful === true));
const directory = path.join(env.RUNNER_TEMP, `codeql-extraction-${language}`);
await mkdir(directory);
await writeFile(path.join(directory, "proof.json"), JSON.stringify({
  schema: "repository-analysis-codeql-integration-v1",
  scope: fixture ? "actual-build-fixture-only" : "selected-codeql-language-only", fullProfileEvidence: false,
  repository: env.GITHUB_REPOSITORY, repositoryId: context.repositoryId, visibility: "public",
  sourceSha: env.GITHUB_SHA, language, version: "2.27.1", ruleRevision: "2.27.1",
  run: { id: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT) },
  extraction: extracted, resolvedDatabaseFields: Object.keys(resolved).sort(),
  sarif: { sha256: hash(bytes), findingCount: analysis.results.length },
  publication: fixture ? "not-requested-fixture-source" : "await-independent-native-processing-proof",
}) + "\n");
console.log(`CodeQL genuinely archived ${extracted.files} selected source files; integration evidence only.`);

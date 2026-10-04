import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile, copyFile, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateReport } from "./reports.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const tools = JSON.parse(await readFile(path.join(directory, "tools.json"), "utf8"));
const EXTENSIONS = new Map([
  ["csharp", /\.cs$/i], ["cpp", /\.(?:c|cc|cpp|cxx|h|hpp)$/i],
  ["javascript", /\.[cm]?jsx?$/i], ["typescript", /\.tsx?$/i],
  ["python", /\.py$/i], ["php", /\.php$/i], ["terraform", /\.tf(?:vars(?:\.json)?)?$/i],
  ["bicep", /\.bicep$/i], ["powershell", /\.ps(?:1|m1|d1)$/i],
  ["shell", /\.sh$/i], ["dockerfile", /(^|\/)Dockerfile(?:\.[^/]+)?$/i],
  ["actions", /^\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)action\.ya?ml$|^templates\/workflows\/.*\.ya?ml$/],
  ["ansible", /^(?:ansible|playbooks|roles)\/.*\.ya?ml$|(^|\/)playbook\.ya?ml$/],
]);

export function scannerEnvironment(environment, home) {
  const allowed = ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"];
  return {
    ...Object.fromEntries(allowed.filter((key) => environment[key]).map((key) => [key, environment[key]])),
    HOME: home, USERPROFILE: home, NO_COLOR: "1",
    SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0",
    ZIZMOR_OFFLINE: "1", CHECKOV_SKIP_DOWNLOAD: "true", PYTHONNOUSERSITE: "1",
  };
}

export function command(tool, version, files, rules, source, moduleRoot, bin = "") {
  switch (tool) {
    case "zizmor":
      return [path.join(bin, "zizmor"), ["--offline", "--strict-collection", "--format=sarif", ...files]];
    case "semgrep-ce":
      return [path.join(bin, "semgrep"), ["scan", "--metrics=off", "--disable-version-check", "--no-git-ignore",
        "--strict", "--scan-unknown-extensions", "--max-target-bytes=0", "--json",
        ...rules.flatMap((rule) => ["--config", rule]), ...files]];
    case "checkov":
      return [path.join(bin, "checkov"), ["--directory", ".", "--framework", ...source.languages,
        "--skip-download", "--download-external-modules", "false", "--output", "json"]];
    case "bandit":
      return [path.join(bin, "bandit"), ["--format", "json", "--quiet", ...files]];
    case "shellcheck":
      return [path.join(bin, "shellcheck"), ["--norc", "--format=json1", ...files]];
    case "psscriptanalyzer":
      return ["/usr/bin/pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(directory, "powershell-scan.ps1"),
        "-Source", ".", "-Version", version, "-ModuleRoot", moduleRoot]];
    default: throw new Error("Unsupported local analyzer");
  }
}

function run(executable, args, cwd, environment) {
  const result = spawnSync(executable, args, { cwd, env: environment, encoding: "utf8",
    timeout: 1_200_000, maxBuffer: 50 * 1024 * 1024, windowsHide: true });
  if (result.error || result.signal || result.status === null) {
    throw new Error("Analyzer command could not complete", { cause: result.error });
  }
  return result;
}

export function selectTool(context, tool) {
  if (context?.contract !== "repository-analysis-v1" || !["public", "private"].includes(context.visibility) ||
      !tools[tool] || !Array.isArray(context.localTools) || context.profile?.exemption) {
    throw new Error("A valid applicable live context and supported local analyzer are required");
  }
  const selected = context.localTools.find((entry) => entry.tool === tool);
  if (!selected?.languages?.length || selected.languages.some((language) => !EXTENSIONS.has(language))) {
    throw new Error("The local analyzer is not selected by the live capability policy");
  }
  const { policyDigest, ...body } = context;
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  if (digest !== policyDigest) throw new Error("Analysis context digest is inconsistent");
  return selected;
}

function classify(filename, firstLine, languages) {
  return languages.filter((language) => {
    if (EXTENSIONS.get(language).test(filename)) return true;
    if (path.posix.extname(filename)) return false;
    const interpreters = {
      shell: /^#!.*\b(?:ba|da|k)?sh(?:\s|$)/, python: /^#!.*\bpython[\d.]*(?:\s|$)/,
      php: /^#!.*\bphp(?:\s|$)/, javascript: /^#!.*\bnode(?:\s|$)/,
      powershell: /^#!.*\bpwsh(?:\s|$)/,
    };
    return Boolean(interpreters[language]?.test(firstLine));
  });
}

function eligibleFile(filename, languages) {
  if (/(^|\/)(?:node_modules|vendor|bin|obj|packages|fixtures)\//i.test(filename) ||
      /\/wwwroot\/lib\//i.test(filename)) return false;
  if (languages.some((language) => EXTENSIONS.get(language).test(filename))) return true;
  return !path.posix.extname(filename) &&
    (filename.startsWith("scripts/") || filename.endsWith("/container-healthcheck"));
}

async function copySource(root, destination, filename, languages) {
  if (!eligibleFile(filename, languages)) return [];
  const location = path.join(root, filename);
  const info = await lstat(location);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Tracked source must be regular files, not links");
  if (info.size > 20 * 1024 * 1024) throw new Error("Tracked source exceeds the analyzer input bound");
  const firstLine = (await readFile(location, "utf8")).split("\n", 1)[0];
  const capabilities = classify(filename, firstLine, languages);
  if (!capabilities.length) return [];
  const target = path.join(destination, filename);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(location, target);
  return capabilities;
}

async function snapshot(root, destination, selected, environment) {
  const tracked = run("/usr/bin/git", ["ls-files", "-z"], root, environment);
  const clean = run("/usr/bin/git", ["diff", "--exit-code", "HEAD", "--"], root, environment);
  if (tracked.status || clean.status) throw new Error("Analysis requires an unchanged tracked checkout");
  const files = [];
  const counts = Object.fromEntries(selected.languages.map((language) => [language, 0]));
  const candidates = tracked.stdout.split("\0").filter(Boolean);
  const copied = [];
  let cursor = 0;
  async function worker() {
    const index = cursor++;
    if (index >= candidates.length) return;
    const filename = candidates[index];
    const capabilities = await copySource(root, destination, filename, selected.languages);
    copied[index] = { filename, capabilities };
    await worker();
  }
  await Promise.all(Array.from({ length: 16 }, () => worker()));
  for (const { filename, capabilities } of copied) {
    for (const language of capabilities) counts[language]++;
    if (capabilities.length) files.push(filename);
  }
  if (!files.length || Object.values(counts).some((value) => !value)) {
    throw new Error("Every selected analyzer capability needs nonempty maintained source");
  }
  return { files, counts };
}

function validateExit(tool, status) {
  if (status === 0) return;
  if (status === 1 && ["checkov", "bandit", "shellcheck"].includes(tool)) return;
  throw new Error(`Local analyzer failed (exit ${status}); no completed report`);
}

async function rulesFor(selected, rulesRoot, environment) {
  if (!rulesRoot) throw new Error("Pinned local Semgrep rules are required");
  const head = run("/usr/bin/git", ["rev-parse", "HEAD"], rulesRoot, environment);
  const clean = run("/usr/bin/git", ["diff", "--exit-code", "HEAD", "--"], rulesRoot, environment);
  if (head.status || clean.status || head.stdout.trim() !== tools["semgrep-ce"].rulesRevision) {
    throw new Error("Semgrep rules do not match the pinned immutable revision");
  }
  const languageDirectories = new Set(selected.languages.map((language) => language === "cpp" ? "c" : language));
  const tracked = run("/usr/bin/git", ["ls-files", "-z"], rulesRoot, environment);
  if (tracked.status) throw new Error("Cannot inventory pinned Semgrep rules");
  const configs = tracked.stdout.split("\0").filter((file) =>
    languageDirectories.has(file.split("/")[0]) && file.includes("/security/") && /\.ya?ml$/.test(file));
  if (!configs.length) throw new Error("The pinned Semgrep bundle has no applicable security rules");
  return configs.map((file) => path.join(rulesRoot, file));
}

function verifyVersion(tool, pin, cwd, environment, bin) {
  if (tool === "psscriptanalyzer") return;
  if (!bin || !path.isAbsolute(bin)) throw new Error("A trusted installed analyzer path is required");
  const version = run(path.join(bin, pin.command), ["--version"], cwd, environment);
  const expected = pin.engineVersion ?? pin.version;
  if (version.status || !version.stdout.split(/\s+/).includes(expected)) {
    throw new Error("The installed analyzer does not match its pinned engine version");
  }
}

function requiredCommand(executable, args, cwd, environment) {
  const result = run(executable, args, cwd, environment);
  if (result.status) throw new Error(`Pinned analyzer installation failed (exit ${result.status})`);
  return result;
}

async function installPython(pin, scratch, environment, pythonLocation) {
  const venv = path.join(scratch, "venv");
  if (!pythonLocation || !path.isAbsolute(pythonLocation)) throw new Error("The trusted setup-python location is required");
  requiredCommand(path.join(pythonLocation, "bin", "python"), ["-m", "venv", venv], scratch, environment);
  const bin = path.join(venv, process.platform === "win32" ? "Scripts" : "bin");
  const python = path.join(bin, process.platform === "win32" ? "python.exe" : "python");
  requiredCommand(python, ["-m", "pip", "install", "--disable-pip-version-check",
    `${pin.package}==${pin.version}`], scratch, environment);
  return bin;
}

function installRules(pin, scratch, environment) {
  const rules = path.join(scratch, "rules");
  requiredCommand("/usr/bin/git", ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null",
    "init", "--quiet", rules], scratch, environment);
  requiredCommand("/usr/bin/git", ["-C", rules, "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null",
    "fetch", "--quiet", "--depth=1", pin.rulesRepository, pin.rulesRevision], scratch, environment);
  requiredCommand("/usr/bin/git", ["-C", rules, "-c", "core.hooksPath=/dev/null",
    "checkout", "--quiet", "--detach", "FETCH_HEAD"], scratch, environment);
  return rules;
}

export async function install(environment = process.env) {
  const context = JSON.parse(environment.ANALYSIS_CONTEXT ?? "");
  const tool = environment.ANALYSIS_TOOL;
  selectTool(context, tool);
  const pin = tools[tool];
  const scratch = await mkdtemp(path.join(environment.RUNNER_TEMP, "repository-analyzer-"));
  const home = path.join(scratch, "home");
  await mkdir(home);
  const safe = scannerEnvironment(environment, home);
  const modules = path.join(scratch, "modules");
  let bin = "";
  if (tool === "psscriptanalyzer") {
    requiredCommand("/usr/bin/pwsh", ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; Save-Module -Name PSScriptAnalyzer -RequiredVersion $env:PIN_VERSION -Path $env:PIN_MODULES -Repository PSGallery -Force"],
    scratch, { ...safe, PIN_VERSION: pin.version, PIN_MODULES: modules });
  } else {
    bin = await installPython(pin, scratch, safe, environment.pythonLocation);
  }
  const rules = tool === "semgrep-ce" ? installRules(pin, scratch, safe) : "";
  await appendFile(environment.GITHUB_OUTPUT, [
    `scanner-path=${bin}`, `rules-directory=${rules}`, `module-root=${modules}`, "",
  ].join("\n"));
  return { bin, rules, modules };
}

export async function scan(environment = process.env) {
  const context = JSON.parse(environment.ANALYSIS_CONTEXT ?? "");
  const tool = environment.ANALYSIS_TOOL;
  const selected = selectTool(context, tool);
  const pin = tools[tool];
  const root = environment.GITHUB_WORKSPACE;
  if (!root || !environment.RUNNER_TEMP || !/^[a-f\d]{40}$/.test(environment.ANALYSIS_EXPECTED_SHA ?? "")) {
    throw new Error("Source checkout, runner temporary directory and expected SHA are required");
  }
  if (context.repository !== environment.GITHUB_REPOSITORY ||
      context.repositoryId !== Number(environment.GITHUB_REPOSITORY_ID)) {
    throw new Error("Analysis context does not match the immutable workflow repository identity");
  }
  const scratch = await mkdtemp(path.join(environment.RUNNER_TEMP, "repository-analysis-"));
  const safeEnvironment = scannerEnvironment(environment, path.join(scratch, "home"));
  await mkdir(safeEnvironment.HOME);
  const head = run("/usr/bin/git", ["rev-parse", "HEAD"], root, safeEnvironment);
  if (head.status || head.stdout.trim() !== environment.ANALYSIS_EXPECTED_SHA) {
    throw new Error("The actual source checkout does not match the frozen expected revision");
  }
  const source = path.join(scratch, "source");
  await mkdir(source);
  const inventory = await snapshot(root, source, selected, safeEnvironment);
  verifyVersion(tool, pin, source, safeEnvironment, environment.ANALYSIS_SCANNER_BIN);
  const rules = tool === "semgrep-ce" ? await rulesFor(selected, environment.ANALYSIS_RULES, safeEnvironment) : [];
  const [executable, args] = command(tool, pin.version, inventory.files,
    rules, selected, environment.ANALYSIS_PS_MODULE_ROOT, environment.ANALYSIS_SCANNER_BIN);
  const execution = run(executable, args, source, safeEnvironment);
  const diagnostics = path.join(scratch, "diagnostics");
  await mkdir(diagnostics);
  await writeFile(path.join(diagnostics, "stdout.txt"), execution.stdout);
  await writeFile(path.join(diagnostics, "stderr.txt"), execution.stderr);
  await appendFile(environment.GITHUB_OUTPUT, `diagnostic-directory=${diagnostics}\n`);
  validateExit(tool, execution.status);
  let native;
  try {
    native = JSON.parse(execution.stdout);
  } catch (error) {
    throw new Error("Analyzer did not produce a valid JSON report", { cause: error });
  }
  const findings = validateReport(tool, native, pin.version, inventory.files, selected.languages);
  const finalHead = run("/usr/bin/git", ["rev-parse", "HEAD"], root, safeEnvironment);
  const finalClean = run("/usr/bin/git", ["diff", "--exit-code", "HEAD", "--"], root, safeEnvironment);
  if (finalHead.status || finalClean.status || finalHead.stdout.trim() !== head.stdout.trim()) {
    throw new Error("Source changed during analysis; the result cannot be published as complete");
  }
  const output = path.join(scratch, "result");
  await mkdir(output);
  const engine = await Promise.all(["scan.mjs", "reports.mjs", "tools.json", "powershell-scan.ps1"]
    .map((filename) => readFile(path.join(directory, filename))));
  const report = {
    schema: "repository-analysis-local-v1", status: "completed",
    repository: context.repository, repositoryId: context.repositoryId, visibility: context.visibility,
    sourceSha: head.stdout.trim(), policyDigest: context.policyDigest,
    tool, toolVersion: pin.engineVersion ?? pin.version, packageVersion: pin.version,
    engineDigest: createHash("sha256").update(Buffer.concat(engine)).digest("hex"),
    ruleRevision: pin.rulesRevision ?? pin.version,
    sourceCoverage: inventory.counts, findingCount: findings.length,
    publication: "originating-repository-artifact-only",
    completedAt: new Date().toISOString(),
  };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(output, "native.json"), JSON.stringify(native) + "\n");
  await appendFile(environment.GITHUB_OUTPUT, `report-directory=${output}\nfinding-count=${findings.length}\n`);
  await appendFile(environment.GITHUB_STEP_SUMMARY, [
    `### Local analysis: ${tool}`, "",
    `Completed against \`${report.sourceSha}\` with ${findings.length} findings.`,
    `Tool version: \`${pin.version}\`. Source capabilities: ${selected.languages.join(", ")}.`,
    "Results stay in the originating repository. This report does not imply CodeQL-equivalent coverage.",
    "",
  ].join("\n"));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "install") await install();
    else await scan();
  } catch (error) {
    console.error(`::error::${error instanceof SyntaxError ? "Malformed analyzer input" : error.message}`);
    process.exitCode = 1;
  }
}

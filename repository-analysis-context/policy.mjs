import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const CONTRACT_VERSION = "repository-analysis-v1";
const LANGUAGES = new Set([
  "actions", "csharp", "cpp", "javascript", "typescript", "python", "php",
  "terraform", "bicep", "dockerfile", "ansible", "powershell", "shell",
]);
const CODEQL = new Map([
  ["actions", "actions"], ["csharp", "csharp"], ["cpp", "cpp"],
  ["javascript", "javascript-typescript"], ["typescript", "javascript-typescript"],
  ["python", "python"],
]);
const SEMGREP = new Set(["csharp", "cpp", "javascript", "typescript", "python", "php"]);
const IAC = new Set(["terraform", "bicep", "dockerfile", "ansible"]);
const EXEMPTIONS = new Set(["documentation-only", "empty", "archived", "upstream-fork"]);
const compareLanguages = (left, right) => left.localeCompare(right, "en");

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function keys(value, allowed, label) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains an unsupported field`);
  }
}

export function validateProfile(profile) {
  object(profile, "Analysis profile");
  keys(profile, ["version", "languages", "sonar", "exemption"], "Analysis profile");
  if (profile.version !== CONTRACT_VERSION) throw new Error("Unsupported analysis profile version");
  if (!Array.isArray(profile.languages) || profile.languages.some((item) => !LANGUAGES.has(item)) ||
      new Set(profile.languages).size !== profile.languages.length) {
    throw new Error("Analysis languages must be unique supported capabilities");
  }
  if (typeof profile.sonar !== "boolean") throw new Error("Analysis sonar must be a boolean");
  if (profile.exemption !== undefined) {
    object(profile.exemption, "Analysis exemption");
    keys(profile.exemption, ["kind", "reason", "reevaluate"], "Analysis exemption");
    if (!EXEMPTIONS.has(profile.exemption.kind) ||
        [profile.exemption.reason, profile.exemption.reevaluate].some((value) =>
          typeof value !== "string" || !value.trim() || value.length > 600)) {
      throw new Error("Analysis exemption needs a supported kind, reason and re-evaluation condition");
    }
    if (profile.languages.length || profile.sonar) throw new Error("An exempt profile cannot select scanners");
  } else if (!profile.languages.length) {
    throw new Error("A profile without source capabilities needs an explicit exemption");
  }
  if (profile.sonar && !profile.languages.some((language) => SEMGREP.has(language))) {
    throw new Error("Sonar requires substantive supported source; it is not an IaC/workflow-only scanner");
  }
  return {
    version: profile.version,
    languages: [...profile.languages].sort(compareLanguages),
    sonar: profile.sonar,
    ...(profile.exemption ? { exemption: {
      kind: profile.exemption.kind,
      reason: profile.exemption.reason.trim(),
      reevaluate: profile.exemption.reevaluate.trim(),
    } } : {}),
  };
}

function validateRepository(repository, expectedRepository) {
  object(repository, "Repository metadata");
  if (typeof expectedRepository !== "string" ||
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(expectedRepository) ||
      repository.full_name?.toLowerCase() !== expectedRepository.toLowerCase() ||
      !Number.isSafeInteger(repository.id) || repository.id <= 0 ||
      typeof repository.private !== "boolean" ||
      !["public", "private"].includes(repository.visibility) ||
      repository.private !== (repository.visibility === "private") ||
      typeof repository.archived !== "boolean" || typeof repository.fork !== "boolean" ||
      !["User", "Organization"].includes(repository.owner?.type)) {
    throw new Error("Missing, inconsistent or unexpected live repository metadata");
  }
}

function validateApplicability(profile, repository) {
  const kind = profile.exemption?.kind;
  if (repository.archived) {
    if (kind !== "archived") throw new Error("Repository applicability changed; review the catalog profile");
    return;
  }
  if (kind === "archived" || repository.fork !== (kind === "upstream-fork")) {
    throw new Error("Repository applicability changed; review the catalog profile");
  }
}

function selectCodeql(profile, publicRepository) {
  if (profile.exemption) {
    return { languages: [], status: "not-applicable", reason: "Catalog applicability exemption" };
  }
  const supportedCodeqlSource = profile.languages.some((language) => CODEQL.has(language));
  if (!supportedCodeqlSource) {
    return { languages: [], status: "not-applicable", reason: "No supported CodeQL source capabilities" };
  }
  if (!publicRepository) {
    return { languages: [], status: "unavailable",
      reason: "Private code scanning is not licensed under the current estate contract; do not execute CodeQL" };
  }
  return {
    languages: [...new Set(profile.languages.flatMap((language) => CODEQL.get(language) ?? []))].sort(compareLanguages),
    status: "eligible", reason: "Public repository with supported source capabilities",
  };
}

function selectLocalTools(profile, publicRepository) {
  const semgrepLanguages = profile.languages.filter((language) =>
    SEMGREP.has(language) && language !== "cpp" && (!publicRepository || !CODEQL.has(language)));
  const localTools = [];
  if (profile.languages.includes("actions")) localTools.push({ tool: "zizmor", languages: ["actions"] });
  if (semgrepLanguages.length) localTools.push({ tool: "semgrep-ce", languages: semgrepLanguages });
  const iac = profile.languages.filter((language) => IAC.has(language));
  if (iac.length) localTools.push({ tool: "checkov", languages: iac });
  if (profile.languages.includes("python")) localTools.push({ tool: "bandit", languages: ["python"] });
  if (profile.languages.includes("powershell")) localTools.push({ tool: "psscriptanalyzer", languages: ["powershell"] });
  if (profile.languages.includes("shell")) localTools.push({ tool: "shellcheck", languages: ["shell"] });
  return localTools;
}

function selectSonar(profile, publicRepository) {
  if (!profile.sonar) return { status: "not-applicable", reason: "Not selected by the catalog source profile" };
  if (!publicRepository) {
    return { status: "unavailable", reason: "Private Sonar execution is not approved by the current estate contract" };
  }
  return { status: "eligible", reason: "Verify the public project and CI configuration before execution" };
}

export function selectAnalysis(profileInput, repository, expectedRepository) {
  const profile = validateProfile(profileInput);
  validateRepository(repository, expectedRepository);
  validateApplicability(profile, repository);
  const publicRepository = repository.visibility === "public";
  const codeql = selectCodeql(profile, publicRepository);
  const localTools = selectLocalTools(profile, publicRepository);
  const sonar = selectSonar(profile, publicRepository);
  const limitations = [];
  if (!publicRepository && localTools.some(({ tool }) => tool === "semgrep-ce")) {
    limitations.push("Semgrep CE is local-only and does not provide CodeQL-equivalent analysis");
  }
  if (!publicRepository && profile.languages.includes("cpp")) {
    limitations.push("Local C++ analysis is unavailable under the current estate contract; never report it as clean");
  }
  if (sonar.status === "unavailable") limitations.push("Sonar quality findings are unavailable; never report them as clean");
  const context = {
    contract: CONTRACT_VERSION, repository: repository.full_name, repositoryId: repository.id,
    visibility: repository.visibility, ownerType: repository.owner.type, profile,
    codeql,
    localTools,
    publication: {
      sarif: !profile.exemption && publicRepository ? "github-security" : "not-available",
      artifacts: repository.visibility,
      summary: "originating-repository-only",
      estateSummary: "aggregate-status-only",
    },
    sonar,
    limitations,
  };
  context.policyDigest = createHash("sha256").update(JSON.stringify(context)).digest("hex");
  return context;
}

export async function resolveAnalysis(profile, expectedRepository, token, request = fetch) {
  if (typeof token !== "string" || !/^[\x21-\x7e]+$/.test(token)) {
    throw new Error("A valid repository metadata read token is required");
  }
  if (typeof expectedRepository !== "string" ||
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(expectedRepository)) {
    throw new Error("A valid target repository is required");
  }
  const normalizedProfile = validateProfile(profile);
  let response;
  try {
    response = await request(`https://api.github.com/repos/${expectedRepository}`, {
      headers: {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error("Live repository metadata request failed (transport)", { cause: error });
  }
  if (!response.ok) throw new Error(`Live repository metadata request failed (HTTP ${response.status})`);
  return selectAnalysis(normalizedProfile, await response.json(), expectedRepository);
}

export async function main(env = process.env) {
  if (!env.GITHUB_OUTPUT || !env.GITHUB_STEP_SUMMARY) throw new Error("GitHub output and summary paths are required");
  if (!/^[1-9]\d*$/.test(env.ANALYSIS_REPOSITORY_ID ?? "") ||
      !Number.isSafeInteger(Number(env.ANALYSIS_REPOSITORY_ID))) {
    throw new Error("The immutable workflow repository identity is required");
  }
  const profile = JSON.parse(env.ANALYSIS_PROFILE ?? "");
  const context = await resolveAnalysis(profile, env.ANALYSIS_REPOSITORY, env.GH_TOKEN);
  if (context.repositoryId !== Number(env.ANALYSIS_REPOSITORY_ID)) {
    throw new Error("Live metadata does not match the immutable workflow repository identity");
  }
  await appendFile(env.GITHUB_OUTPUT, [
    `context=${JSON.stringify(context)}`,
    `codeql-languages=${context.codeql.languages.join(",")}`,
    `local-tools=${JSON.stringify(context.localTools)}`,
    `sarif-publication=${context.publication.sarif}`,
    `sonar-status=${context.sonar.status}`,
    `policy-digest=${context.policyDigest}`,
    `exempt=${Boolean(context.profile.exemption)}`,
    "",
  ].join("\n"));
  const toolNames = context.localTools.map(({ tool }) => "`" + tool + "`").join(", ");
  const emptyTools = context.profile.exemption ? "none (applicability exemption)" : "none selected";
  await appendFile(env.GITHUB_STEP_SUMMARY, [
    "### Analysis capability selection", "",
    `Repository visibility: **${context.visibility}**. Contract: \`${context.contract}\`.`,
    `CodeQL: **${context.codeql.status}**. ${context.codeql.reason}.`,
    `Local tools: ${toolNames || emptyTools}.`,
    `Sonar: **${context.sonar.status}**. ${context.sonar.reason}.`,
    `SARIF destination: **${context.publication.sarif}**; artifacts remain **${context.publication.artifacts}**.`,
    "Capability selection is not scanner execution or evidence of zero findings.",
    ...context.limitations.map((limitation) => `- ${limitation}`),
    "",
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::${error instanceof SyntaxError ? "Malformed analysis JSON" : error.message}`);
    process.exitCode = 1;
  }
}

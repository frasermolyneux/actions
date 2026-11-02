import { appendFile, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ACTIONABLE_RULES = [
  "csharpsquid:S2699",
  "csharpsquid:S3237",
  "csharpsquid:S3427",
  "javascript:S2004",
  "javascript:S2699",
  "javascript:S3358",
  "javascript:S3776",
  "javascript:S5843",
  "javascript:S6353",
  "javascript:S6535",
  "javascript:S6582",
  "javascript:S7758",
  "javascript:S7767",
  "javascript:S7770",
  "javascript:S7772",
  "javascript:S7773",
  "javascript:S7776",
  "javascript:S7780",
  "javascript:S7781",
  "javascript:S7785",
  "javascript:S7786",
  "javascript:S9382",
  "python:S1192",
  "python:S3776",
  "python:S5778",
  "shell:S7677",
  "Web:InputWithoutLabelCheck",
  "Web:S5254",
  "Web:S5256",
  "Web:S6840",
  "Web:S6843",
  "Web:S6845",
  "Web:S6850",
  "Web:S6853",
];

export const COMMON_EXCLUSIONS = [
  "**/node_modules/**",
  "**/vendor/**",
  "**/wwwroot/lib/**",
  "**/*.min.js",
  "**/*.min.css",
];

const MAX_POLICY_BYTES = 256 * 1024;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const RULE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*:[A-Za-z0-9_.-]+$/;
const GLOB_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*[,\\\s])[A-Za-z0-9._/*?-]+$/;
const compareKeys = (left, right) => left.localeCompare(right, "en");

function exactKeys(value, keys, message) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort(compareKeys).join("\0") !== [...keys].sort(compareKeys).join("\0")
  ) {
    throw new Error(message);
  }
}

function validReason(value) {
  if (typeof value !== "string" || value !== value.trim()) {
    return false;
  }
  const length = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)].length;
  return (
    length >= 10 &&
    length <= 240 &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff\ufffe\uffff]/u.test(value)
  );
}

export function emptyPolicy() {
  return {
    version: "sonar-policy-v1",
    provenance: "repository-standards-v1",
    profiles: [],
    ignoredRules: [],
    exclusions: [],
  };
}

export function validatePolicy(policy) {
  exactKeys(
    policy,
    ["version", "provenance", "profiles", "ignoredRules", "exclusions"],
    "Invalid managed Sonar policy",
  );
  if (
    policy.version !== "sonar-policy-v1" ||
    policy.provenance !== "repository-standards-v1" ||
    !Array.isArray(policy.profiles) ||
    policy.profiles.length > 2 ||
    !policy.profiles.every((name) => ["actionable-only", "common-vendor-assets"].includes(name)) ||
    new Set(policy.profiles).size !== policy.profiles.length ||
    !Array.isArray(policy.ignoredRules) ||
    policy.ignoredRules.length > 128 ||
    !Array.isArray(policy.exclusions) ||
    policy.exclusions.length > 64
  ) {
    throw new Error("Invalid managed Sonar policy");
  }

  const rules = new Set();
  for (const rule of policy.ignoredRules) {
    exactKeys(rule, ["key", "reason"], "Invalid managed Sonar ignored rule");
    if (!RULE_PATTERN.test(rule.key) || rules.has(rule.key) || !validReason(rule.reason)) {
      throw new Error("Invalid managed Sonar ignored rule");
    }
    rules.add(rule.key);
  }
  const expectedRules = policy.profiles.includes("actionable-only") ? ACTIONABLE_RULES : [];
  if (JSON.stringify([...rules]) !== JSON.stringify(expectedRules)) {
    throw new Error("Managed Sonar ignored rules do not match the approved profile");
  }

  const patterns = new Set();
  for (const exclusion of policy.exclusions) {
    exactKeys(exclusion, ["pattern", "reason"], "Invalid managed Sonar exclusion");
    if (
      exclusion.pattern.length > 240 ||
      !GLOB_PATTERN.test(exclusion.pattern) ||
      patterns.has(exclusion.pattern) ||
      !validReason(exclusion.reason)
    ) {
      throw new Error("Invalid managed Sonar exclusion");
    }
    patterns.add(exclusion.pattern);
  }

  const exclusions = [...patterns];
  const commonCount = policy.profiles.includes("common-vendor-assets") ? COMMON_EXCLUSIONS.length : 0;
  const expectedCommon = policy.profiles.includes("common-vendor-assets") ? COMMON_EXCLUSIONS : [];
  if (JSON.stringify(exclusions.slice(0, commonCount)) !== JSON.stringify(expectedCommon)) {
    throw new Error("Managed Sonar exclusions do not match the approved common profile");
  }
  for (const pattern of exclusions.slice(commonCount)) {
    const parts = pattern.split("/");
    if (
      pattern.startsWith("**/") ||
      parts.length < 3 ||
      (parts.at(-1) === "**" && !["less", "scss", "vendor", "lib"].includes(parts.at(-2)))
    ) {
      throw new Error("Managed Sonar targeted exclusion is too broad");
    }
  }

  return policy;
}

export function buildArguments(policy) {
  const properties = [];
  if (policy.exclusions.length > 0) {
    properties.push(["sonar.exclusions", policy.exclusions.map(({ pattern }) => pattern).join(",")]);
  }
  if (policy.ignoredRules.length > 0) {
    const criteria = policy.ignoredRules.map((_, index) => `managed${index + 1}`);
    properties.push(["sonar.issue.ignore.multicriteria", criteria.join(",")]);
    for (const [index, rule] of policy.ignoredRules.entries()) {
      const criterion = criteria[index];
      properties.push([`sonar.issue.ignore.multicriteria.${criterion}.ruleKey`, rule.key]);
      properties.push([`sonar.issue.ignore.multicriteria.${criterion}.resourceKey`, "**/*"]);
    }
  }
  return properties.map(([key, value]) => `-D${key}=${value}`);
}

async function readPolicy(workspace, policyPath) {
  if (!SAFE_RELATIVE_PATH.test(policyPath) || policyPath.includes("..")) {
    throw new Error("policy-path must be a safe repository-relative path.");
  }

  const workspacePath = await realpath(workspace);
  const requestedPath = path.resolve(workspacePath, policyPath);
  let policyRealPath;
  try {
    policyRealPath = await realpath(requestedPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return emptyPolicy();
    }
    throw error;
  }

  const relativePath = path.relative(workspacePath, policyRealPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("The managed Sonar policy must resolve inside the repository workspace.");
  }

  const policyStat = await stat(policyRealPath);
  if (!policyStat.isFile() || policyStat.size > MAX_POLICY_BYTES) {
    throw new Error(`The managed Sonar policy must be a file no larger than ${MAX_POLICY_BYTES} bytes.`);
  }

  return validatePolicy(JSON.parse(await readFile(policyRealPath, "utf8")));
}

export async function run({
  workspace = process.env.GITHUB_WORKSPACE,
  policyPath = process.env.INPUT_POLICY_PATH || ".sonarcloud.json",
  outputPath = process.env.GITHUB_OUTPUT,
} = {}) {
  if (!workspace) {
    throw new Error("GITHUB_WORKSPACE is required.");
  }
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required.");
  }

  const argumentsList = buildArguments(await readPolicy(workspace, policyPath));
  await appendFile(outputPath, `cli-arguments=${argumentsList.join(" ")}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}

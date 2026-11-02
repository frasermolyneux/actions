import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ACTIONABLE_RULES,
  COMMON_EXCLUSIONS,
  buildArguments,
  run,
  validatePolicy,
} from "./policy.mjs";

const reason = "This is an approved managed policy rationale.";

function validPolicy() {
  return {
    version: "sonar-policy-v1",
    provenance: "repository-standards-v1",
    profiles: ["actionable-only", "common-vendor-assets"],
    ignoredRules: ACTIONABLE_RULES.map((key) => ({ key, reason })),
    exclusions: COMMON_EXCLUSIONS.map((pattern) => ({ pattern, reason })),
  };
}

test("buildArguments emits exclusions and one multicriteria pair per rule", () => {
  const argumentsList = buildArguments(validatePolicy(validPolicy()));
  assert.equal(argumentsList[0], `-Dsonar.exclusions=${COMMON_EXCLUSIONS.join(",")}`);
  assert.equal(
    argumentsList[1],
    `-Dsonar.issue.ignore.multicriteria=${ACTIONABLE_RULES.map((_, index) => `managed${index + 1}`).join(",")}`,
  );
  assert.equal(argumentsList[2], `-Dsonar.issue.ignore.multicriteria.managed1.ruleKey=${ACTIONABLE_RULES[0]}`);
  assert.equal(argumentsList[3], "-Dsonar.issue.ignore.multicriteria.managed1.resourceKey=**/*");
  assert.equal(argumentsList.length, 2 + ACTIONABLE_RULES.length * 2);
});

test("validatePolicy rejects an incomplete approved profile", () => {
  const policy = validPolicy();
  policy.ignoredRules.pop();
  assert.throws(() => validatePolicy(policy), /do not match the approved profile/);
});

test("validatePolicy rejects unsafe coverage exclusions", () => {
  const policy = validPolicy();
  policy.exclusions.push({ pattern: "../secrets/**", reason });
  assert.throws(() => validatePolicy(policy), /Invalid managed Sonar exclusion/);
});

test("validatePolicy rejects unmanaged schema changes", () => {
  const policy = { ...validPolicy(), extra: true };
  assert.throws(() => validatePolicy(policy), /Invalid managed Sonar policy/);
});

test("run emits an empty output when no managed policy exists", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "sonar-policy-"));
  const outputPath = path.join(workspace, "output.txt");
  await run({ workspace, outputPath });
  assert.equal(await readFile(outputPath, "utf8"), "cli-arguments=\n");
});

test("run validates and emits policy arguments", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "sonar-policy-"));
  const outputPath = path.join(workspace, "output.txt");
  await writeFile(path.join(workspace, ".sonarcloud.json"), JSON.stringify(validPolicy()), "utf8");
  await run({ workspace, outputPath });
  const output = await readFile(outputPath, "utf8");
  assert.match(output, /^cli-arguments=-Dsonar\.exclusions=/);
  assert.match(output, /-Dsonar\.issue\.ignore\.multicriteria\.managed34\.ruleKey=Web:S6853/);
});

test("run rejects policy paths that escape through symlinks", async (context) => {
  if (process.platform === "win32") {
    context.skip("Creating symlinks requires elevated Windows privileges.");
    return;
  }

  const workspace = await mkdtemp(path.join(os.tmpdir(), "sonar-policy-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "sonar-policy-external-"));
  const outputPath = path.join(workspace, "output.txt");
  await mkdir(path.join(workspace, "config"));
  await writeFile(path.join(external, "policy.json"), JSON.stringify(validPolicy()), "utf8");
  await symlink(path.join(external, "policy.json"), path.join(workspace, "config", "policy.json"));
  await assert.rejects(
    run({ workspace, policyPath: "config/policy.json", outputPath }),
    /must resolve inside the repository workspace/,
  );
});

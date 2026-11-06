import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validatePolicy } from "../sonar-policy-arguments/policy.mjs";

test("managed Sonar policy remains valid", async () => {
  const policy = JSON.parse(await readFile(".sonarcloud.json", "utf8"));
  assert.equal(validatePolicy(policy), policy);
});

test("Checkov policy is fail-closed and contains only approved skips", async () => {
  const source = await readFile(".checkov.yml", "utf8");
  assert.match(source, /^# Provenance: repository-standards-v1 \/ checkov-v1$/m);
  assert.match(source, /^soft-fail: false$/m);
  assert.match(source, /^compact: true$/m);

  const skips = [...source.matchAll(/^\s+-\s+(CKV_[A-Z0-9_]+)\s*(?:#.*)?$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(skips, [
    "CKV_AZURE_41",
    "CKV_AZURE_114",
    "CKV_GHA_7",
    "CKV_GIT_1",
  ]);
});

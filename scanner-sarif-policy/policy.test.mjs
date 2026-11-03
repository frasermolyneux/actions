import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyPolicy, run } from "./policy.mjs";

function fixture() {
  return {
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "zizmor" } },
      results: [
        { ruleId: "zizmor/self-repository", level: "warning", message: { text: "Use $/ syntax" } },
        { ruleId: "zizmor/template-injection", level: "error", message: { text: "Injection" } },
      ],
    }, {
      tool: { driver: { name: "Bandit" } },
      results: [{ ruleId: "B603", level: "warning", message: { text: "Subprocess" } }],
    }],
  };
}

test("only approved static-policy findings become informational", () => {
  const document = applyPolicy(fixture());
  const [informational, security] = document.runs[0].results;
  assert.equal(informational.level, "note");
  assert.equal(informational.properties.scannerPolicyClass, "informational-static-policy");
  assert.equal(informational.properties.scannerOriginalLevel, "warning");
  assert.equal(security.level, "error");
  assert.equal(security.properties.scannerPolicyClass, "security");
  assert.equal(document.runs[1].results[0].properties, undefined);
  assert.equal(document.runs.flatMap((run) => run.results).length, 3);
});

test("policy rejects malformed findings instead of dropping them", () => {
  const document = fixture();
  delete document.runs[0].results[0].ruleId;
  assert.throws(() => applyPolicy(document), /rule identity/);
});

test("run rewrites the selected SARIF file in place", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scanner-sarif-policy-"));
  const sarifFile = path.join(directory, "alerts.sarif");
  await writeFile(sarifFile, JSON.stringify(fixture()), "utf8");
  await run(sarifFile);
  const document = JSON.parse(await readFile(sarifFile, "utf8"));
  assert.equal(document.runs[0].results[0].level, "note");
  assert.equal(document.runs[0].results[1].level, "error");
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFINITION_FILES, definitionDigest, WORKFLOW_PATH } from "./engine.mjs";

const text = await readFile(new URL("../" + WORKFLOW_PATH, import.meta.url), "utf8");
const composite = await readFile(new URL("./action.yml", import.meta.url), "utf8");
const version = JSON.parse(await readFile(new URL("./version.json", import.meta.url), "utf8"));
const release = await readFile(new URL("../.github/workflows/actions-versioning.yml", import.meta.url), "utf8");

test("planning has no source checkout, licensed initialization or write permissions", () => {
  const planning = text.slice(text.indexOf("\n  plan:"), text.indexOf("\n  native:"));
  assert.match(planning, /mode: plan/);
  assert.doesNotMatch(planning, /checkout@|codeql-action\/init@|: write|secrets\./);
  assert.match(text, /if: needs\.plan\.outputs\.has-languages == 'true'/);
  assert.match(text, /fail-fast: false/);
});

test("native execution retains setup-before-init, manual-only compiler and reauthorized byte-bound publication", () => {
  const anchors = ["uses: actions/setup-dotnet@", "mode: authorize", "uses: github/codeql-action/init@",
    "mode: build", "uses: github/codeql-action/analyze@", "mode: extract",
    "uses: github/codeql-action/upload-sarif@", "uses: $/repository-analysis-sarif", "mode: bind"];
  const indices = anchors.map((anchor) => text.indexOf(anchor));
  assert.ok(indices.every((index) => index >= 0));
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  assert.match(text, /upload: never/);
  assert.match(text, /upload-database: false/);
  assert.match(text, /wait-for-processing: true/);
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /if: matrix\.buildMode == 'manual'/);
  assert.match(composite, /repository-analysis-sonar\/build\.ps1/);
  assert.doesNotMatch(composite, /uses: \$\/repository-analysis-sonar/);
  assert.doesNotMatch(text + composite, /secrets\.|id-token:|contents: write|@main|@v\d/);
});

test("all runtime dependencies are covered by the digest, release filter and dependency ordering", async () => {
  assert.match(await definitionDigest(), /^[a-f0-9]{64}$/);
  for (const filename of DEFINITION_FILES) {
    assert.ok(version.pathFilters.some((filter) => filename === filter.slice(2) ||
      filename.startsWith(filter.slice(2) + "/")), `Version misses ${filename}`);
  }
  const packages = /ACTIONS=\(([\s\S]*?)\)/.exec(release)[1].trim().split(/\s+/);
  const index = packages.indexOf("repository-analysis-codeql");
  assert.ok(index >= 0);
  for (const dependency of ["repository-analysis-context", "repository-analysis-state",
    "repository-analysis-sarif", "repository-analysis-sonar"]) {
    assert.ok(packages.indexOf(dependency) >= 0 && packages.indexOf(dependency) < index, dependency);
  }
  const detection = new RegExp(/PATTERN='(\^\(repository-analysis-codeql[^']+)'/.exec(release)[1]);
  for (const filename of DEFINITION_FILES) assert.ok(detection.test(filename), `Release misses ${filename}`);
});

test("only actual current-attempt report/native evidence is retained; databases and SARIF are not artifacts", () => {
  assert.match(text, /name: codeql-native-\$\{\{ matrix\.language \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(text, /pattern: codeql-native-\*-\$\{\{ github\.run_attempt \}\}/);
  const artifactSteps = [...text.matchAll(/uses: actions\/upload-artifact@[\s\S]*?(?=\n      -|\n  [a-z]|$)/g)];
  assert.equal(artifactSteps.length, 2);
  for (const [step] of artifactSteps) {
    assert.doesNotMatch(step, /src\.zip|db-locations|sarif-output/);
    assert.match(step, /if-no-files-found: error/);
  }
  assert.match(text, /retention-days: 14/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFINITION_FILES, definitionDigest, WORKFLOW_PATH } from "./sonar.mjs";

const text = await readFile(new URL("../" + WORKFLOW_PATH, import.meta.url), "utf8");
const release = await readFile(new URL("../.github/workflows/actions-versioning.yml", import.meta.url), "utf8");
const version = JSON.parse(await readFile(new URL("./version.json", import.meta.url)));

function positions(source, anchors) {
  const indices = anchors.map((anchor) => source.indexOf(anchor));
  assert.ok(indices.every((index) => index >= 0), "Every required workflow anchor must exist");
  return indices;
}

test("SDK provisioning precedes installation and begin; tokens are not shared with tests/builds", () => {
  const [sdk, scanner, begin, buildStart, buildEnd] = positions(text, [
    "Install declared SDKs", "Install the exact .NET scanner", "Begin source-bound",
    "- name: Build and validate only", "- name: End successful",
  ]);
  assert.ok(sdk < scanner && scanner < begin && begin < buildStart && buildStart < buildEnd);
  const build = text.slice(buildStart, buildEnd);
  assert.ok(!build.includes("secrets."));
  assert.ok(!text.includes("inherit"));
  assert.ok(!text.includes("id-token:"));
  assert.ok(!text.includes("security-events:"));
  assert.ok(!text.includes("contents: write"));
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /mode: verify[\s\S]*coverage-report: \$\{\{ steps.tests.outputs.coverage-report \}\}/);
});

test("immutable definition closure matches all release filters and dependency ordering", async () => {
  assert.match(await definitionDigest(), /^[a-f0-9]{64}$/);
  for (const filename of DEFINITION_FILES) {
    assert.ok(version.pathFilters.some((filter) => filename === filter.slice(2) ||
      filename.startsWith(filter.slice(2) + "/")), `Missing version closure: ${filename}`);
  }
  const packages = /ACTIONS=\(([\s\S]*?)\)/.exec(release)[1].trim().split(/\s+/);
  const packageIndex = packages.indexOf("repository-analysis-sonar");
  assert.ok(packageIndex >= 0, "Sonar package must remain in the release set");
  for (const dependency of ["repository-analysis-context", "dotnet-test", "dotnet-test-report"]) {
    const dependencyIndex = packages.indexOf(dependency);
    assert.ok(dependencyIndex >= 0 && dependencyIndex < packageIndex, `${dependency} must release before Sonar`);
  }
  const detection = new RegExp(/PATTERN='(\^\(repository-analysis-sonar[^']+)'/.exec(release)[1]);
  for (const filename of DEFINITION_FILES) {
    assert.ok(detection.test(filename), `Missing release detection: ${filename}`);
  }
});

test("production workflow uses exact vendor pins and commit-bound internal execution", () => {
  const references = [...text.matchAll(/^\s+uses: (.+)$/gm)].map((entry) => entry[1]);
  assert.ok(references.length > 0);
  assert.ok(references.every((ref) => ref.startsWith("$/") || /@[a-f0-9]{40}$/.test(ref)));
  assert.match(text, /scannerVersion: "8\.1\.0\.6389"/);
  assert.ok(!text.includes("skipSignatureVerification:"));
});

test("the actual scanner preserves the existing protected quality check name", () => {
  assert.match(text, /\r?\n  analyze:\r?\n    name: Code Quality\r?\n    needs: plan\r?\n/);
  assert.match(text, /value: \$\{\{ jobs\.analyze\.outputs\.artifact-id \}\}/);
});

test("CLI publication repeats source/producer/live-project authorization after repository builds", () => {
  const build = text.indexOf("- name: Build and validate only");
  const authorize = text.indexOf("- name: Reauthorize unchanged CLI/C++ source");
  const publication = text.indexOf("- name: Scan substantive CLI/C++ source");
  assert.ok(build > 0 && authorize > build && publication > authorize);
  const step = text.slice(authorize, publication);
  assert.match(step, /mode: authorize/);
  assert.match(step, /producer: \$\{\{ steps.producer.outputs.producer \}\}/);
  assert.match(step, /evidence-directory: \$\{\{ steps.prepare.outputs.evidence-directory \}\}/);
});

test("deleted provisioning or build anchors cannot satisfy workflow safety assertions", () => {
  const anchors = ["Install declared SDKs", "Install the exact .NET scanner", "Begin source-bound",
    "- name: Build and validate only", "- name: End successful"];
  for (const anchor of anchors) {
    assert.throws(() => positions(text.replace(anchor, "removed"), anchors), /must exist/);
  }
});

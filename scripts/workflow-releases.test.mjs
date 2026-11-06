import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const release = await read(".github/workflows/actions-versioning.yml");
const order = /ACTIONS=\(([\s\S]*?)\)/.exec(release)[1].trim().split(/\s+/);

test("reusable workflow packages cover their actual first-party dependencies in release order", async () => {
  for (const [name, workflow, dependencies] of [
    ["codequality", ".github/workflows/codequality.yml",
      ["dotnet-ci", "dotnet-web-ci", "dotnet-func-ci", "dotnet-sdk-setup", "dotnet-test",
        "dotnet-test-report", "nbgv-metadata", "test-results-summary"]],
    ["devops-secure-scanning", ".github/workflows/devops-secure-scanning.yml", ["scanner-sarif-policy"]],
  ]) {
    const version = JSON.parse(await read(`${name}/version.json`));
    const marker = `"$ACTION" == "${name}"`;
    const section = release.slice(release.indexOf(marker));
    const pattern = new RegExp(/PATTERN='([^']+)'/.exec(section)[1]);
    assert.ok(order.includes(name));
    for (const dependency of dependencies) {
      assert.ok(order.indexOf(dependency) >= 0 && order.indexOf(dependency) < order.indexOf(name));
    }
    for (const file of [`${name}/version.json`, workflow, ...dependencies.map((d) => `${d}/action.yml`)]) {
      assert.ok(version.pathFilters.some((filter) => file === filter.slice(2) || file.startsWith(filter.slice(2) + "/")), file);
      assert.match(file, pattern);
    }
    assert.doesNotMatch(".github/workflows/unrelated.yml", pattern);
    const text = await read(workflow);
    const internal = [...text.matchAll(/uses:\s+\$\/([^\s]+)/g)].map((match) => match[1]);
    for (const dependency of internal) assert.ok(dependencies.includes(dependency), dependency);
  }
});

test("updated composite dependencies retain reviewed complete SHA pins", async () => {
  for (const file of ["apim-api-import", "dotnet-ci", "dotnet-func-ci", "dotnet-web-ci", "dotnet-playwright-tests"]) {
    const text = await read(`${file}/action.yml`);
    const refs = [...text.matchAll(/uses:\s+frasermolyneux\/actions\/[^\s]+/g)];
    assert.ok(refs.length > 0);
    assert.ok(refs.every(([ref]) => /@[a-f0-9]{40}$/.test(ref)), file);
  }
});

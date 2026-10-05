import assert from "node:assert/strict";
import test from "node:test";
import { validateBuild } from "./build.mjs";

const dotnet = { version: 1, driver: "dotnet", projectKey: "project", sourceDirectory: "src", coverage: "cobertura" };
const build = { kind: "dotnet", sdk: ["9.0.x", "10.0.x"], globalJson: "global.json",
  solution: ".", skipFormat: true, tests: true };

test("canonical SDK/Framework/CLI/CMake families preserve explicit original build selections", () => {
  assert.deepEqual(validateBuild(build, dotnet), build);
  assert.deepEqual(validateBuild({ ...build, sdk: ["10.0.1xx"] }, dotnet).sdk, ["10.0.1xx"]);
  assert.equal(validateBuild({ ...build, kind: "netfx", tests: false, solution: "DemoManager.sln" },
    { ...dotnet, coverage: "not-applicable" }).kind, "netfx");
  assert.equal(validateBuild({ kind: "script", nodeVersion: "20.x", npmInstall: true },
    { ...dotnet, driver: "cli", coverage: "not-applicable" }).kind, "script");
  const cpp = { kind: "cmake", configureArgs: ["-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
    "-DPORTAL_COD4X_BUILD_PLUGIN_BINARY=OFF"], buildArgs: ["--config", "Release"],
  testArgs: ["--output-on-failure", "--build-config", "Release"] };
  assert.deepEqual(validateBuild(cpp, { ...dotnet, driver: "cpp", coverage: "not-applicable" }), cpp);
});

test("build/source/coverage family mismatches cannot execute success-shaped validation", () => {
  for (const patch of [{ kind: "netfx" }, { tests: false }, { solution: "../outside.sln" },
    { solution: "file;deploy" }, { sdk: ["main"] }, { sdk: ["10.0.x\ninjection"] },
    { globalJson: "../global.json" }, { publish: true }, { skipFormat: "true" }]) {
    assert.throws(() => validateBuild({ ...build, ...patch }, dotnet));
  }
  assert.throws(() => validateBuild({ kind: "cmake", configureArgs: ["-DOTHER=ON"],
    buildArgs: ["--config", "Release"], testArgs: ["--output-on-failure"] },
  { ...dotnet, driver: "cpp", coverage: "not-applicable" }));
});

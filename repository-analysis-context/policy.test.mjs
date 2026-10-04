import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONTRACT_VERSION, main, resolveAnalysis, selectAnalysis, validateProfile } from "./policy.mjs";

const profile = (languages, sonar = false) => ({ version: CONTRACT_VERSION, languages, sonar });
const metadata = (visibility = "public") => ({
  id: 123, full_name: "example/sample", private: visibility === "private", visibility,
  owner: { type: "User" }, archived: false, fork: false,
});
const select = (languages, visibility = "public", sonar = false) =>
  selectAnalysis(profile(languages, sonar), metadata(visibility), "example/sample");

test("public supported source uses CodeQL and GitHub SARIF, with de-duplicated JS/TS", () => {
  const context = select(["csharp", "javascript", "typescript", "actions", "python"], "public", true);
  assert.deepEqual(context.codeql.languages, ["actions", "csharp", "javascript-typescript", "python"]);
  assert.equal(context.codeql.status, "eligible");
  assert.equal(context.publication.sarif, "github-security");
  assert.deepEqual(context.localTools.map(({ tool }) => tool), ["zizmor", "bandit"]);
  assert.equal(context.sonar.status, "eligible");
});

test("private supported languages select permitted local tools, never licensed CodeQL or invented C++ coverage", () => {
  const context = select(["csharp", "cpp", "javascript", "typescript", "python", "php", "actions",
    "terraform", "bicep", "dockerfile", "ansible", "powershell", "shell"], "private");
  assert.deepEqual(context.codeql.languages, []);
  assert.equal(context.codeql.status, "unavailable");
  assert.deepEqual(context.localTools, [
    { tool: "zizmor", languages: ["actions"] },
    { tool: "semgrep-ce", languages: ["csharp", "javascript", "php", "python", "typescript"] },
    { tool: "checkov", languages: ["ansible", "bicep", "dockerfile", "terraform"] },
    { tool: "bandit", languages: ["python"] },
    { tool: "psscriptanalyzer", languages: ["powershell"] },
    { tool: "shellcheck", languages: ["shell"] },
  ]);
  assert.equal(context.publication.sarif, "not-available");
  assert.equal(context.publication.artifacts, "private");
  assert.equal(context.publication.summary, "originating-repository-only");
  assert.equal(context.publication.estateSummary, "aggregate-status-only");
  assert.match(context.limitations[0], /not provide CodeQL-equivalent/);
  assert.match(context.limitations.join(" "), /Local C\+\+ analysis is unavailable/);
});

test("private C++ is explicitly unavailable while public C++ remains eligible for CodeQL", () => {
  const privateContext = select(["cpp"], "private");
  assert.equal(privateContext.codeql.status, "unavailable");
  assert.deepEqual(privateContext.codeql.languages, []);
  assert.deepEqual(privateContext.localTools, []);
  assert.match(privateContext.limitations.join(" "), /Local C\+\+ analysis is unavailable.*never report it as clean/);
  assert.equal(privateContext.publication.sarif, "not-available");
  const publicContext = select(["cpp"]);
  assert.equal(publicContext.codeql.status, "eligible");
  assert.deepEqual(publicContext.codeql.languages, ["cpp"]);
  assert.deepEqual(publicContext.localTools, []);
});
test("private visibility overrides a public-oriented Sonar source profile", () => {
  const context = select(["csharp"], "private", true);
  assert.equal(context.sonar.status, "unavailable");
  assert.match(context.limitations.join(" "), /never report them as clean/);
  assert.deepEqual(context.codeql.languages, []);
  assert.equal(context.localTools[0].tool, "semgrep-ce");
});

test("public PHP and shell/PowerShell use maintained alternatives, not invented CodeQL support", () => {
  const context = select(["php", "shell", "powershell"]);
  assert.deepEqual(context.codeql.languages, []);
  assert.equal(context.codeql.status, "not-applicable");
  assert.deepEqual(context.localTools.map(({ tool }) => tool), ["semgrep-ce", "psscriptanalyzer", "shellcheck"]);
});

test("Terraform/Bicep-only profiles do not select Sonar or CodeQL", () => {
  const context = select(["terraform", "bicep"]);
  assert.equal(context.sonar.status, "not-applicable");
  assert.deepEqual(context.codeql.languages, []);
  assert.deepEqual(context.localTools, [{ tool: "checkov", languages: ["bicep", "terraform"] }]);
  assert.throws(() => select(["terraform"], "public", true), /substantive supported source/);
  assert.equal(select(["terraform", "bicep"], "private").codeql.status, "not-applicable");
});

test("visibility changes invalidate freshness identities even with unchanged source/profile", () => {
  const publicContext = select(["actions", "javascript"]);
  const privateContext = select(["actions", "javascript"], "private");
  assert.notEqual(publicContext.policyDigest, privateContext.policyDigest);
  assert.match(publicContext.policyDigest, /^[0-9a-f]{64}$/);
  assert.equal(publicContext.policyDigest, select(["javascript", "actions"]).policyDigest);
});

test("profile and repository identity changes invalidate freshness identities", () => {
  assert.notEqual(select(["actions"]).policyDigest, select(["actions", "python"]).policyDigest);
  const other = selectAnalysis(profile(["actions"]), { ...metadata(), id: 456 }, "example/sample");
  assert.notEqual(select(["actions"]).policyDigest, other.policyDigest);
});

test("caller-supplied visibility and entitlement fields are rejected", () => {
  for (const extra of [{ private: false }, { visibility: "public" }, { codeqlLicensed: true }, { uploadSarif: true }]) {
    assert.throws(() => validateProfile({ ...profile(["actions"]), ...extra }), /unsupported field/);
  }
});

test("unknown, inconsistent and wrong-target repository metadata fail closed", () => {
  for (const extra of [{ private: undefined }, { visibility: undefined }, { private: true },
    { visibility: "internal" }, { id: 0 }, { full_name: "other/sample" },
    { archived: undefined }, { fork: undefined }, { owner: { type: "unknown" } }]) {
    assert.throws(() => selectAnalysis(profile(["actions"]), { ...metadata(), ...extra }, "example/sample"), /metadata/);
  }
});

test("unsupported languages, empty/duplicate profiles and untyped Sonar flags are errors", () => {
  for (const value of [profile(["go"]), profile([]), profile(["actions", "actions"]),
    { ...profile(["actions"]), sonar: "false" }, { ...profile(["actions"]), version: "v2" }, null]) {
    assert.throws(() => validateProfile(value));
  }
});

test("explicit applicability exemptions produce no scanners, not a completed clean scan", () => {
  const exempt = { ...profile([]), exemption: {
    kind: "documentation-only", reason: "No executable source or workflows",
    reevaluate: "Executable source or a workflow is added",
  } };
  const context = selectAnalysis(exempt, metadata("private"), "example/sample");
  assert.deepEqual(context.localTools, []);
  assert.deepEqual(context.codeql.languages, []);
  assert.equal(context.codeql.status, "not-applicable");
  assert.equal(context.publication.sarif, "not-available");
  assert.equal(context.profile.exemption.kind, "documentation-only");
  const reordered = { ...exempt, exemption: {
    reevaluate: ` ${exempt.exemption.reevaluate} `, reason: exempt.exemption.reason, kind: exempt.exemption.kind,
  } };
  assert.equal(context.policyDigest, selectAnalysis(reordered, metadata("private"), "example/sample").policyDigest);
  assert.throws(() => validateProfile({ ...exempt, languages: ["actions"] }), /cannot select/);
  assert.throws(() => validateProfile({ ...exempt, exemption: { ...exempt.exemption, reevaluate: "" } }), /re-evaluation/);
});

test("archival and fork changes require catalog re-evaluation, not automatic skipping", () => {
  for (const change of [{ archived: true }, { fork: true }]) {
    assert.throws(() => selectAnalysis(profile(["actions"]), { ...metadata(), ...change }, "example/sample"), /applicability changed/);
  }
  for (const kind of ["archived", "upstream-fork"]) {
    const exempt = { ...profile([]), exemption: { kind, reason: "Deliberate exemption", reevaluate: "Repository status changes" } };
    assert.throws(() => selectAnalysis(exempt, metadata(), "example/sample"), /applicability changed/);
    const context = selectAnalysis(exempt, { ...metadata(), [kind === "archived" ? "archived" : "fork"]: true }, "example/sample");
    assert.deepEqual(context.localTools, []);
  }
});

test("live lookup uses only GitHub metadata, never scanner feature probes or source upload", async () => {
  const calls = [];
  const context = await resolveAnalysis(profile(["csharp"]), "example/sample", "test-token", async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => metadata("private") };
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/example/sample");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(context.codeql.languages, []);
});

test("archived forks use the archive exemption and require re-evaluation when unarchived", () => {
  const exempt = { ...profile([]), exemption: {
    kind: "archived", reason: "Archived repository", reevaluate: "Repository is unarchived",
  } };
  const repository = { ...metadata(), archived: true, fork: true };
  const context = selectAnalysis(exempt, repository, "example/sample");
  assert.deepEqual(context.localTools, []);
  assert.equal(context.codeql.status, "not-applicable");
  assert.throws(() => selectAnalysis(exempt, { ...repository, archived: false }, "example/sample"),
    /applicability changed/);
  for (const kind of ["upstream-fork", "documentation-only"]) {
    assert.throws(() => selectAnalysis({ ...exempt, exemption: { ...exempt.exemption, kind } },
      repository, "example/sample"), /applicability changed/);
  }
});

test("403, 404 and server errors cannot be mistaken for private-feature inapplicability", async () => {
  for (const status of [403, 404, 500]) {
    await assert.rejects(resolveAnalysis(profile(["actions"]), "example/sample", "test-token", async () => ({
      ok: false, status,
    })), new RegExp(`HTTP ${status}`));
  }
});

test("missing authentication and invalid targets fail before any request", async () => {
  const request = () => { throw new Error("Unexpected request"); };
  for (const token of ["", "contains\ncredential", " credential ", "non-ascii-\u200b"]) {
    await assert.rejects(resolveAnalysis(profile(["actions"]), "example/sample", token, request), /token is required/);
  }
  for (const target of ["example/sample?ref=main", "example/sample/extra", undefined]) {
    await assert.rejects(resolveAnalysis(profile(["actions"]), target, "test-token", request), /valid target/);
  }
});

test("transport diagnostics never echo credentials from the request exception", async () => {
  await assert.rejects(resolveAnalysis(profile(["actions"]), "example/sample", "test-token", async () => {
    throw new Error("Header contains test-token");
  }), (error) => {
    assert.equal(error.message, "Live repository metadata request failed (transport)");
    assert.doesNotMatch(error.message, /test-token/);
    return true;
  });
});

test("composite outputs and private summary have no credentials or source excerpts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "analysis-context-"));
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => metadata("private") });
  try {
    const output = path.join(directory, "outputs");
    const summary = path.join(directory, "summary");
    await main({ GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
      ANALYSIS_REPOSITORY: "example/sample", ANALYSIS_REPOSITORY_ID: "123",
      GH_TOKEN: "must-not-be-published", ANALYSIS_PROFILE: JSON.stringify(profile(["actions", "php"])) });
    const published = await readFile(output, "utf8");
    assert.match(published, /codeql-languages=\n/);
    assert.match(published, /sarif-publication=not-available/);
    assert.match(published, /sonar-status=not-applicable/);
    assert.doesNotMatch(published, /must-not-be-published/);
    const body = await readFile(summary, "utf8");
    assert.match(body, /not scanner execution or evidence of zero findings/);
    assert.match(body, /artifacts remain \*\*private\*\*/);
    assert.doesNotMatch(body, /must-not-be-published/);
  } finally {
    globalThis.fetch = previous;
    await rm(directory, { recursive: true });
  }
});

test("the composite binds live metadata to immutable workflow repository identity", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => metadata("private") });
  const env = { GITHUB_OUTPUT: "not-written", GITHUB_STEP_SUMMARY: "not-written",
    ANALYSIS_REPOSITORY: "example/sample", ANALYSIS_REPOSITORY_ID: "456", GH_TOKEN: "test-token",
    ANALYSIS_PROFILE: JSON.stringify(profile(["actions"])) };
  try {
    await assert.rejects(main(env), /does not match the immutable/);
    for (const id of [undefined, "0", "NaN", "9007199254740992"]) {
      await assert.rejects(main({ ...env, ANALYSIS_REPOSITORY_ID: id }), /immutable workflow repository identity is required/);
    }
  } finally {
    globalThis.fetch = previous;
  }
});

test("a public CodeQL-only profile is not described as an applicability exemption", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "analysis-summary-"));
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => metadata() });
  try {
    const summary = path.join(directory, "summary");
    await main({ GITHUB_OUTPUT: path.join(directory, "outputs"), GITHUB_STEP_SUMMARY: summary,
      ANALYSIS_REPOSITORY: "example/sample", ANALYSIS_REPOSITORY_ID: "123",
      GH_TOKEN: "test-token", ANALYSIS_PROFILE: JSON.stringify(profile(["csharp"])) });
    const body = await readFile(summary, "utf8");
    assert.match(body, /Local tools: none selected/);
    assert.doesNotMatch(body, /applicability exemption/);
  } finally {
    globalThis.fetch = previous;
    await rm(directory, { recursive: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { selectAnalysis } from "../repository-analysis-context/policy.mjs";
import { analyzerRegistry, captureCurrency, CURRENCY_DEADLINE_MS, sameCurrency } from "./currency.mjs";

const context = selectAnalysis({
  version: "repository-analysis-v1", languages: ["csharp"], sonar: true,
}, { id: 123, full_name: "fixture/source", visibility: "public", private: false,
  owner: { type: "User" }, archived: false, fork: false }, "fixture/source");
const clone = (value) => structuredClone(value);
const binding = { projectKey: "custom:reviewed-project", organization: "frasermolyneux" };
const registry = { plugins: [{ key: "csharp", version: "1.2", filename: "cs-1.2.jar", hash: "a".repeat(32) }] };
const engine = { filename: "engine-1.2.jar", sha256: "b".repeat(64) };
const profile = { key: "profile-123", language: "cs", organization: binding.organization,
  activeRuleCount: 1, rulesUpdatedAt: "2026-10-07T00:00:00Z" };
const rule = { key: "cs:Rule1", lang: "cs", repo: "cs", status: "READY", severity: "INFO", params: [] };
const active = { qProfile: profile.key, severity: "INFO", params: [{ key: "threshold", value: "3" }] };

function provider(mutate = () => {}, calls = []) {
  return async (endpoint, type, remaining) => {
    calls.push({ endpoint, type, remaining });
    let value;
    if (endpoint === "/api/plugins/installed") value = clone(registry);
    else if (endpoint === "/analysis/engine") value = clone(engine);
    else if (endpoint.startsWith("/api/qualityprofiles/search?")) {
      const query = new URL(`https://fixture.invalid${endpoint}`).searchParams;
      assert.equal(query.get("project"), binding.projectKey);
      assert.equal(query.get("organization"), binding.organization);
      value = { profiles: [clone(profile)] };
    } else {
      assert.ok(endpoint.startsWith("/api/rules/search?"));
      const query = new URL(`https://fixture.invalid${endpoint}`).searchParams;
      assert.equal(query.get("activation"), "true");
      assert.equal(query.get("qprofile"), profile.key);
      assert.equal(query.get("f"), "actives,params,repo,severity,lang,status");
      value = { total: 1, p: Number(query.get("p")), ps: 500,
        rules: [clone(rule)], actives: { [rule.key]: [clone(active)] } };
    }
    mutate(value, endpoint);
    return value;
  };
}

test("currency binds the actual complete active rules, parameters, analyzer hashes and bootstrap engine", async () => {
  const result = await captureCurrency(context, provider(), binding);
  assert.equal(result.status, "completed");
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(result.profiles[0].reportedRuleCount, 1);
  assert.equal(result.projectKey, binding.projectKey);
  assert.equal(result.organization, binding.organization);
  assert.equal(sameCurrency(result, await captureCurrency(context, provider(), binding)), true);
  for (const mutate of [
    (value, endpoint) => { if (endpoint.includes("plugins")) value.plugins[0].hash = "c".repeat(32); },
    (value, endpoint) => { if (endpoint.includes("plugins")) value.plugins[0].version = "1.3"; },
    (value, endpoint) => { if (endpoint === "/analysis/engine") value.sha256 = "d".repeat(64); },
    (value, endpoint) => { if (endpoint.includes("rules/search")) value.actives[rule.key][0].params[0].value = "4"; },
    (value, endpoint) => { if (endpoint.includes("rules/search")) value.rules[0].status = "DEPRECATED"; },
  ]) {
    assert.equal(sameCurrency(result, await captureCurrency(context, provider(mutate), binding)), false);
  }
  assert.notEqual(analyzerRegistry(registry, engine).digest,
    analyzerRegistry(registry, { ...engine, filename: "engine-1.3.jar" }).digest);
});

test("advertised rules absent from the provider response explicitly forbid reuse without fabricating a hash", async () => {
  const completed = await captureCurrency(context, provider(), binding);
  for (const reportedRuleCount of [0, 1]) {
    const result = await captureCurrency(context, provider((value, endpoint) => {
      if (endpoint.includes("qualityprofiles")) value.profiles[0].activeRuleCount = 2;
      if (endpoint.includes("rules/search") && reportedRuleCount === 0) {
        Object.assign(value, { total: 0, rules: [], actives: {} });
      }
    }), binding);
    assert.equal(result.status, "incomplete");
    assert.equal(result.digest, null);
    assert.equal(result.profiles[0].advertisedRuleCount, 2);
    assert.equal(result.profiles[0].reportedRuleCount, reportedRuleCount);
    assert.equal(result.reason, "advertised-and-returned-active-rule-counts-disagree");
    assert.equal(sameCurrency(result, result), false);
    assert.equal(sameCurrency(completed, result), false);
    assert.equal(sameCurrency(result, completed), false);
  }
});

test("retained snapshot tampering cannot reuse a copied later digest", async () => {
  const actual = await captureCurrency(context, provider(), binding);
  for (const mutate of [
    (value) => { value.analyzers.digest = "c".repeat(64); },
    (value) => { value.analyzers.pluginCount++; },
    (value) => { value.profiles[0].digest = "d".repeat(64); },
    (value) => { value.profiles[0].rulesUpdatedAt = "2026-10-06T00:00:00Z"; },
    (value) => { value.projectKey = "other-project"; },
    (value) => { value.organization = "other-organization"; },
  ]) {
    const tampered = clone(actual);
    mutate(tampered);
    assert.throws(() => sameCurrency(tampered, actual), /digest disagrees/);
    assert.throws(() => sameCurrency(actual, tampered), /digest disagrees/);
  }
  const tampered = clone(actual);
  tampered.profiles[0].advertisedRuleCount++;
  assert.throws(() => sameCurrency(tampered, actual), /completeness/);
});

test("multi-page capture rejects profile edits even when the active rule count is unchanged", async () => {
  for (const change of [null, { key: "replacement-profile" },
    { rulesUpdatedAt: "2026-10-07T00:00:01Z" }, { activeRuleCount: 502 }]) {
    let profileReads = 0;
    const pages = [];
    const read = provider((value, endpoint) => {
      if (endpoint.includes("qualityprofiles")) {
        value.profiles[0].activeRuleCount = 501;
        if (++profileReads === 2 && change) Object.assign(value.profiles[0], change);
      }
      if (endpoint.includes("rules/search")) {
        pages.push(value.p);
        value.total = 501;
        const start = (value.p - 1) * 500;
        value.rules = Array.from({ length: value.p === 1 ? 500 : 1 },
          (_, index) => ({ ...clone(rule), key: `cs:Rule${start + index + 1}` }));
        value.actives = Object.fromEntries(value.rules.map(({ key }) => [key, [clone(active)]]));
      }
    });
    if (change) {
      await assert.rejects(captureCurrency(context, read, binding), /profile changed during capture/);
    } else {
      const snapshot = await captureCurrency(context, read, binding);
      assert.equal(snapshot.status, "completed");
      assert.equal(sameCurrency(snapshot, snapshot), true);
    }
    assert.deepEqual(pages, [1, 2]);
    assert.equal(profileReads, 2);
  }
});

for (const [label, mutation, message] of [
  ["duplicate analyzer", (value, endpoint) => { if (endpoint.includes("plugins")) value.plugins.push(clone(value.plugins[0])); }, /unique/],
  ["missing analyzer hash", (value, endpoint) => { if (endpoint.includes("plugins")) delete value.plugins[0].hash; }, /byte-identified/],
  ["no project profile", (value, endpoint) => { if (endpoint.includes("qualityprofiles")) value.profiles = []; }, /exactly one/],
  ["foreign profile", (value, endpoint) => { if (endpoint.includes("qualityprofiles")) value.profiles[0].organization = "foreign"; }, /identity/],
  ["empty advertised profile", (value, endpoint) => { if (endpoint.includes("qualityprofiles")) value.profiles[0].activeRuleCount = 0; }, /identity/],
  ["short page", (value, endpoint) => { if (endpoint.includes("rules/search")) value.total = 2; }, /paging/],
  ["wrong page", (value, endpoint) => { if (endpoint.includes("rules/search")) value.p = 2; }, /paging/],
  ["missing activation", (value, endpoint) => { if (endpoint.includes("rules/search")) value.actives = {}; }, /configured parameters/],
  ["foreign activation", (value, endpoint) => { if (endpoint.includes("rules/search")) value.actives[rule.key][0].qProfile = "foreign"; }, /foreign/],
  ["additional activation", (value, endpoint) => { if (endpoint.includes("rules/search")) value.actives.extra = [clone(active)]; }, /unexpected rules/],
  ["missing parameter value", (value, endpoint) => { if (endpoint.includes("rules/search")) delete value.actives[rule.key][0].params[0].value; }, /actual string values/],
  ["non-string parameter value", (value, endpoint) => { if (endpoint.includes("rules/search")) value.actives[rule.key][0].params[0].value = 3; }, /actual string values/],
  ["duplicate parameter key", (value, endpoint) => { if (endpoint.includes("rules/search")) value.actives[rule.key][0].params.push(clone(active.params[0])); }, /unique keys/],
]) {
  test(`currency rejects ${label}`, async () => {
    await assert.rejects(captureCurrency(context, provider(mutation), binding), message);
  });
}

test("public currency refuses a private context before any provider call", async () => {
  const privateContext = selectAnalysis(context.profile, { id: 123, full_name: "fixture/source",
    visibility: "private", private: true, owner: { type: "User" }, archived: false, fork: false }, "fixture/source");
  let called = false;
  await assert.rejects(captureCurrency(privateContext, async () => { called = true; }, binding), /eligible live public/);
  assert.equal(called, false);
});

test("the absolute deadline covers all metadata requests without a reset", async () => {
  let clock = 0;
  const calls = [];
  const read = provider(() => { clock += 30_001; }, calls);
  await assert.rejects(captureCurrency(context, read, { ...binding, now: () => clock }), /deadline/);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].remaining, CURRENCY_DEADLINE_MS);
  assert.ok(calls.every((call, index) => index === 0 || call.remaining < calls[index - 1].remaining));
});

test("provider failures are not converted into currency or quiet success", async () => {
  await assert.rejects(captureCurrency(context, async () => { throw new Error("HTTP 403"); }, binding), /HTTP 403/);
});

test("currency refuses missing or malformed provider bindings before reading", async () => {
  for (const options of [undefined, {}, { ...binding, projectKey: "bad/key" }, { ...binding, organization: "" }]) {
    let called = false;
    await assert.rejects(captureCurrency(context, async () => { called = true; }, options), /validated provider/);
    assert.equal(called, false);
  }
});

test("engine identity cannot substitute the server version, legacy index or malformed metadata", () => {
  for (const value of ["10.8", "", `engine.jar|${"b".repeat(32)}`, null,
    { ...engine, filename: "../engine.jar" }, { ...engine, sha256: "b".repeat(32) }]) {
    assert.throws(() => analyzerRegistry(registry, value), /engine identity/);
  }
  assert.throws(() => sameCurrency({ status: "completed" }, {}), /typed currency/);
});

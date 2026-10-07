import assert from "node:assert/strict";
import test from "node:test";
import { selectAnalysis } from "../repository-analysis-context/policy.mjs";
import { analyzerRegistry, captureCurrency, CURRENCY_DEADLINE_MS, sameCurrency } from "./currency.mjs";

const context = selectAnalysis({
  version: "repository-analysis-v1", languages: ["csharp"], sonar: true,
}, { id: 123, full_name: "fixture/source", visibility: "public", private: false,
  owner: { type: "User" }, archived: false, fork: false }, "fixture/source");
const clone = (value) => structuredClone(value);
const registry = { plugins: [{ key: "csharp", version: "1.2", filename: "cs-1.2.jar", hash: "a".repeat(32) }] };
const engine = `engine-1.2.jar|${"b".repeat(32)}\n`;
const profile = { key: "profile-123", language: "cs", organization: "fixture",
  activeRuleCount: 1, rulesUpdatedAt: "2026-10-07T00:00:00Z" };
const rule = { key: "cs:Rule1", lang: "cs", repo: "cs", status: "READY", severity: "INFO", params: [] };
const active = { qProfile: profile.key, severity: "INFO", params: [{ key: "threshold", value: "3" }] };

function provider(mutate = () => {}, calls = []) {
  return async (endpoint, type, remaining) => {
    calls.push({ endpoint, type, remaining });
    let value;
    if (endpoint === "/api/plugins/installed") value = clone(registry);
    else if (endpoint === "/batch/index") value = engine;
    else if (endpoint.startsWith("/api/qualityprofiles/search?")) {
      const query = new URL(`https://fixture.invalid${endpoint}`).searchParams;
      assert.equal(query.get("project"), "fixture_source");
      assert.equal(query.get("organization"), "fixture");
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
  const result = await captureCurrency(context, provider());
  assert.equal(result.status, "completed");
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(result.profiles[0].reportedRuleCount, 1);
  assert.equal(sameCurrency(result, await captureCurrency(context, provider())), true);
  for (const mutate of [
    (value, endpoint) => { if (endpoint.includes("plugins")) value.plugins[0].hash = "c".repeat(32); },
    (value, endpoint) => { if (endpoint.includes("plugins")) value.plugins[0].version = "1.3"; },
    (value, endpoint) => { if (endpoint.includes("rules/search")) value.actives[rule.key][0].params[0].value = "4"; },
    (value, endpoint) => { if (endpoint.includes("rules/search")) value.rules[0].status = "DEPRECATED"; },
  ]) {
    assert.equal(sameCurrency(result, await captureCurrency(context, provider(mutate))), false);
  }
  assert.notEqual(analyzerRegistry(registry, engine).digest,
    analyzerRegistry(registry, engine.replace("engine-1.2", "engine-1.3")).digest);
});

test("advertised rules absent from the provider response explicitly forbid reuse without fabricating a hash", async () => {
  const result = await captureCurrency(context, provider((value, endpoint) => {
    if (endpoint.includes("qualityprofiles")) value.profiles[0].activeRuleCount = 2;
  }));
  assert.equal(result.status, "incomplete");
  assert.equal(result.digest, null);
  assert.equal(result.reason, "advertised-and-returned-active-rule-counts-disagree");
  assert.equal(sameCurrency(result, result), false);
});

for (const [label, mutation, message] of [
  ["duplicate analyzer", (value, endpoint) => { if (endpoint.includes("plugins")) value.plugins.push(clone(value.plugins[0])); }, /unique/],
  ["missing analyzer hash", (value, endpoint) => { if (endpoint.includes("plugins")) delete value.plugins[0].hash; }, /byte-identified/],
  ["no project profile", (value, endpoint) => { if (endpoint.includes("qualityprofiles")) value.profiles = []; }, /exactly one/],
  ["foreign profile", (value, endpoint) => { if (endpoint.includes("qualityprofiles")) value.profiles[0].organization = "foreign"; }, /identity/],
  ["short page", (value, endpoint) => { if (endpoint.includes("rules/search")) value.total = 2; }, /paging/],
  ["wrong page", (value, endpoint) => { if (endpoint.includes("rules/search")) value.p = 2; }, /paging/],
  ["missing activation", (value, endpoint) => { if (endpoint.includes("rules/search")) value.actives = {}; }, /configured parameters/],
  ["foreign activation", (value, endpoint) => { if (endpoint.includes("rules/search")) value.actives[rule.key][0].qProfile = "foreign"; }, /foreign/],
  ["additional activation", (value, endpoint) => { if (endpoint.includes("rules/search")) value.actives.extra = [clone(active)]; }, /unexpected rules/],
]) {
  test(`currency rejects ${label}`, async () => {
    await assert.rejects(captureCurrency(context, provider(mutation)), message);
  });
}

test("public currency refuses a private context before any provider call", async () => {
  const privateContext = selectAnalysis(context.profile, { id: 123, full_name: "fixture/source",
    visibility: "private", private: true, owner: { type: "User" }, archived: false, fork: false }, "fixture/source");
  let called = false;
  await assert.rejects(captureCurrency(privateContext, async () => { called = true; }), /eligible live public/);
  assert.equal(called, false);
});

test("the absolute deadline covers all metadata requests without a reset", async () => {
  let clock = 0;
  const calls = [];
  const read = provider(() => { clock += 30_001; }, calls);
  await assert.rejects(captureCurrency(context, read, { now: () => clock }), /deadline/);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].remaining, CURRENCY_DEADLINE_MS);
  assert.ok(calls.every((call, index) => index === 0 || call.remaining < calls[index - 1].remaining));
});

test("provider failures are not converted into currency or quiet success", async () => {
  await assert.rejects(captureCurrency(context, async () => { throw new Error("HTTP 403"); }), /HTTP 403/);
});

test("bootstrap index cannot substitute the server version or ambiguous engine metadata", () => {
  for (const value of ["10.8", "", `${engine}${engine}`, engine.replace("|", ":")]) {
    assert.throws(() => analyzerRegistry(registry, value), /bootstrap/);
  }
  assert.throws(() => sameCurrency({ status: "completed" }, {}), /typed currency/);
});

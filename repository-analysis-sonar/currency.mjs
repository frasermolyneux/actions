import { createHash } from "node:crypto";
import { selectedTools } from "../repository-analysis-state/state.mjs";

export const CURRENCY_SCHEMA = "repository-analysis-sonar-currency-v1";
export const CURRENCY_DEADLINE_MS = 120_000;
const LANGUAGES = { csharp: "cs", cpp: "cpp", javascript: "js", typescript: "ts", python: "py", php: "php" };
const PAGE_SIZE = 500;
const MAX_RULES = 10_000;
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024;
const order = (left, right) => left.localeCompare(right, "en");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(order).map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  const bytes = JSON.stringify(canonical(value));
  requireValue(Buffer.byteLength(bytes) <= 16 * 1024 * 1024, "Sonar currency material exceeds its bound");
  return createHash("sha256").update(bytes).digest("hex");
}

export function analyzerRegistry(payload, engineIndex) {
  requireValue(Array.isArray(payload?.plugins) && payload.plugins.length > 0 && payload.plugins.length <= 256,
    "Sonar analyzer registry is missing or exceeds its bound");
  const keys = new Set();
  const plugins = payload.plugins.map((plugin) => {
    requireValue(text(plugin?.key) && /^[a-z0-9_-]+$/.test(plugin.key) && !keys.has(plugin.key) &&
      text(plugin.version) && /^[A-Za-z0-9_.-]+\.jar$/.test(plugin.filename ?? "") &&
      /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(plugin.hash ?? ""),
    "Sonar analyzer registry needs unique versioned, byte-identified plugins");
    keys.add(plugin.key);
    return { key: plugin.key, version: plugin.version, filename: plugin.filename, hash: plugin.hash };
  }).sort((left, right) => order(left.key, right.key));
  requireValue(typeof engineIndex === "string" && engineIndex.length <= 16 * 1024,
    "Sonar scanner engine bootstrap index exceeds its bound");
  const rows = engineIndex.trim().split(/\r?\n/);
  requireValue(rows.length === 1 &&
    /^[A-Za-z0-9_.-]+\.jar\|(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(rows[0]),
  "Sonar scanner engine bootstrap is missing, malformed or ambiguous");
  const [filename, hash] = rows[0].split("|");
  return { digest: digest({ plugins, engine: { filename, hash } }), pluginCount: plugins.length };
}

export async function captureCurrency(context, read, { now = Date.now } = {}) {
  const tool = selectedTools(context).find(({ id }) => id === "sonar");
  requireValue(tool && context.visibility === "public" && context.sonar.status === "eligible",
    "Sonar currency may only read an eligible live public project");
  requireValue(typeof read === "function" && typeof now === "function",
    "Sonar currency needs bounded provider readers");
  const deadline = now() + CURRENCY_DEADLINE_MS;
  const request = async (endpoint, type = "json") => {
    const remaining = deadline - now();
    requireValue(remaining > 0, "Sonar currency deadline exceeded");
    const result = await read(endpoint, type, remaining);
    requireValue(now() <= deadline, "Sonar currency deadline exceeded");
    return result;
  };
  const analyzers = analyzerRegistry(await request("/api/plugins/installed"), await request("/batch/index", "text"));
  const organization = context.repository.split("/")[0];
  const projectKey = context.repository.replace("/", "_");
  const profiles = [];
  for (const capability of tool.capabilities) {
    const language = LANGUAGES[capability];
    const query = new URLSearchParams({ organization, project: projectKey, language });
    const response = await request(`/api/qualityprofiles/search?${query}`);
    requireValue(Array.isArray(response?.profiles) && response.profiles.length === 1,
      "Sonar currency requires exactly one selected project profile per capability");
    const profile = response.profiles[0];
    requireValue(text(profile?.key) && profile.language === language && profile.organization === organization &&
      count(profile.activeRuleCount) && profile.activeRuleCount > 0 && profile.activeRuleCount <= MAX_RULES &&
      text(profile.rulesUpdatedAt) && Number.isFinite(Date.parse(profile.rulesUpdatedAt)),
    "Sonar currency profile identity or rule metadata is malformed");
    const rules = [];
    const keys = new Set();
    let total = null;
    for (let page = 1; total === null || rules.length < total; page++) {
      requireValue(page <= Math.ceil(MAX_RULES / PAGE_SIZE), "Sonar active-rule pagination exceeds its bound");
      const parameters = new URLSearchParams({ qprofile: profile.key, activation: "true",
        include_external: "true", p: String(page), ps: String(PAGE_SIZE),
        f: "actives,params,repo,severity,lang,status" });
      const payload = await request(`/api/rules/search?${parameters}`);
      requireValue(count(payload?.total) && payload.total > 0 && payload.total <= MAX_RULES &&
        payload.p === page && payload.ps === PAGE_SIZE &&
        (total === null || payload.total === total) && Array.isArray(payload.rules) &&
        payload.rules.length === Math.min(PAGE_SIZE, payload.total - (page - 1) * PAGE_SIZE) &&
        payload.actives && typeof payload.actives === "object" && !Array.isArray(payload.actives),
      "Sonar active-rule paging is incomplete or changed during capture");
      total = payload.total;
      for (const rule of payload.rules) {
        const active = payload.actives[rule?.key];
        requireValue(text(rule?.key) && !keys.has(rule.key) && rule.lang === language &&
          text(rule.repo) && text(rule.status) && text(rule.severity) && Array.isArray(rule.params) &&
          Array.isArray(active) && active.length === 1 && active[0]?.qProfile === profile.key &&
          text(active[0].severity) && Array.isArray(active[0].params),
        "Sonar active rules are missing, duplicated, foreign or lack actual configured parameters");
        keys.add(rule.key);
        rules.push({ rule, active: active[0] });
      }
      requireValue(Object.keys(payload.actives).length === payload.rules.length &&
        Object.keys(payload.actives).every((key) => payload.rules.some((rule) => rule.key === key)),
      "Sonar active-rule configuration contains unexpected rules");
    }
    rules.sort((left, right) => order(left.rule.key, right.rule.key));
    profiles.push({ capability, key: profile.key, language, rulesUpdatedAt: profile.rulesUpdatedAt,
      advertisedRuleCount: profile.activeRuleCount, reportedRuleCount: total, digest: digest(rules) });
  }
  const complete = profiles.every(({ advertisedRuleCount, reportedRuleCount }) =>
    advertisedRuleCount === reportedRuleCount);
  const material = { projectKey, analyzers, profiles };
  return {
    schema: CURRENCY_SCHEMA, repository: context.repository, repositoryId: context.repositoryId,
    policyDigest: context.policyDigest, projectKey, status: complete ? "completed" : "incomplete",
    digest: complete ? digest(material) : null, analyzers, profiles,
    ...(complete ? {} : { reason: "advertised-and-returned-active-rule-counts-disagree" }),
  };
}

export function sameCurrency(before, after) {
  for (const snapshot of [before, after]) {
    requireValue(snapshot?.schema === CURRENCY_SCHEMA &&
      ["completed", "incomplete"].includes(snapshot.status) &&
      (snapshot.status === "completed" ? /^[a-f0-9]{64}$/.test(snapshot.digest ?? "") : snapshot.digest === null),
    "Sonar reuse requires actual typed currency evidence");
    requireValue(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(snapshot.repository ?? "") &&
      Number.isSafeInteger(snapshot.repositoryId) && snapshot.repositoryId > 0 &&
      /^[a-f0-9]{64}$/.test(snapshot.policyDigest ?? "") &&
      snapshot.projectKey === snapshot.repository.replace("/", "_") &&
      /^[a-f0-9]{64}$/.test(snapshot.analyzers?.digest ?? "") &&
      Number.isSafeInteger(snapshot.analyzers.pluginCount) &&
      snapshot.analyzers.pluginCount > 0 && snapshot.analyzers.pluginCount <= 256 &&
      Array.isArray(snapshot.profiles) && snapshot.profiles.length > 0 && snapshot.profiles.length <= 6,
    "Sonar currency snapshot identity or analyzer material is malformed");
    const capabilities = new Set();
    for (const profile of snapshot.profiles) {
      requireValue(profile && LANGUAGES[profile.capability] === profile.language &&
        !capabilities.has(profile.capability) && text(profile.key) &&
        text(profile.rulesUpdatedAt) && Number.isFinite(Date.parse(profile.rulesUpdatedAt)) &&
        [profile.advertisedRuleCount, profile.reportedRuleCount].every((value) =>
          Number.isSafeInteger(value) && value > 0 && value <= MAX_RULES) &&
        /^[a-f0-9]{64}$/.test(profile.digest ?? ""),
      "Sonar currency snapshot profile material is malformed");
      capabilities.add(profile.capability);
    }
    const complete = snapshot.profiles.every(({ advertisedRuleCount, reportedRuleCount }) =>
      advertisedRuleCount === reportedRuleCount);
    requireValue(complete === (snapshot.status === "completed") &&
      (complete ? snapshot.reason === undefined : snapshot.reason === "advertised-and-returned-active-rule-counts-disagree"),
    "Sonar currency completeness disagrees with retained profile counts");
    if (complete) {
      requireValue(snapshot.digest === digest({ projectKey: snapshot.projectKey,
        analyzers: snapshot.analyzers, profiles: snapshot.profiles }),
      "Sonar currency snapshot digest disagrees with its retained material");
    }
  }
  return before.status === "completed" && after.status === "completed" &&
    ["repository", "repositoryId", "policyDigest", "projectKey", "digest"].every((key) => before[key] === after[key]);
}

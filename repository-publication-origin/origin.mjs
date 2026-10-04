import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CONTRACT = "repository-publication-origin-v1";
export const ARTIFACT = "repository-publication-origin";
const SHA = /^[a-f0-9]{40}$/;
const WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const LOGIN = /^[A-Za-z0-9_-]+(?:\[bot\])?$/;
const MAX_PROOF = 64 * 1024;
const MAX_LINEAGE = 8;
const REPOSITORY_PATH = String.raw`/repos/[A-Za-z0-9-]+/[A-Za-z0-9_.-]+`;
const METADATA_ROUTES = [
  new RegExp(`^${REPOSITORY_PATH}$`),
  new RegExp(`^${REPOSITORY_PATH}/actions/runs/[1-9][0-9]*(?:/artifacts)?$`),
  new RegExp(`^${REPOSITORY_PATH}/collaborators/[A-Za-z0-9_-]+/permission$`),
  new RegExp(`^${REPOSITORY_PATH}/commits/[a-f0-9]{40}/pulls$`),
  new RegExp(`^${REPOSITORY_PATH}/pulls/[1-9][0-9]*$`),
  new RegExp(`^${REPOSITORY_PATH}/contents/\\.github/workflows/[A-Za-z0-9_.-]+\\.ya?ml$`),
  /^\/users\/(?:dependabot|github-actions)%5Bbot%5D$/,
  /^\/apps\/[A-Za-z0-9_-]+$/,
];

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function id(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function sha(value, label) {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error(`${label} must be a full commit SHA`);
  return value;
}

function actor(value) {
  object(value, "Run actor");
  id(value.id, "Actor identity");
  if (!LOGIN.test(value.login ?? "") || !["User", "Bot"].includes(value.type)) {
    throw new Error("Run actor has invalid metadata");
  }
  return { id: value.id, login: value.login, type: value.type };
}

export function validatePolicy(input) {
  object(input, "Origin policy");
  if (Object.keys(input).some(key => !["appId", "allowAppAuthoredMerges", "trustedProducers"].includes(key))) {
    throw new Error("Origin policy contains an unsupported field");
  }
  id(input.appId, "Trusted App identity");
  if (typeof input.allowAppAuthoredMerges !== "boolean" || !Array.isArray(input.trustedProducers)) {
    throw new Error("Origin policy requires explicit automation and producer declarations");
  }
  if (input.trustedProducers.length > 8) throw new Error("Too many trusted producer definitions");
  const producers = input.trustedProducers.map(producer => {
    object(producer, "Trusted producer");
    if (Object.keys(producer).some(key => !["path", "blobSha"].includes(key)) ||
        !WORKFLOW.test(producer.path ?? "")) throw new Error("Invalid trusted producer workflow path");
    sha(producer.blobSha, "Trusted producer blob");
    return { path: producer.path, blobSha: producer.blobSha };
  });
  if (new Set(producers.map(producer => producer.path)).size !== producers.length) {
    throw new Error("Duplicate trusted producer workflow");
  }
  return { appId: input.appId, allowAppAuthoredMerges: input.allowAppAuthoredMerges,
    trustedProducers: producers.sort((left, right) => left.path.localeCompare(right.path, "en")) };
}

export function validateRepository(repository, expectedName, expectedId) {
  object(repository, "Repository metadata");
  id(expectedId, "Expected repository identity");
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(expectedName ?? "") ||
      repository.full_name?.toLowerCase() !== expectedName.toLowerCase() ||
      repository.id !== expectedId || repository.archived !== false || repository.fork !== false ||
      typeof repository.default_branch !== "string" || !repository.default_branch ||
      typeof repository.private !== "boolean" ||
      !["public", "private"].includes(repository.visibility) ||
      repository.private !== (repository.visibility === "private")) {
    throw new Error("Repository metadata does not match the active immutable target");
  }
  return { id: repository.id, full_name: repository.full_name, private: repository.private,
    visibility: repository.visibility, archived: repository.archived, fork: repository.fork,
    default_branch: repository.default_branch };
}

export function validateRun(run, repository, expectedId) {
  object(run, "Workflow run");
  if (run.id !== id(expectedId, "Expected run identity") || run.repository?.id !== repository.id) {
    throw new Error("Workflow run belongs to a different repository or run");
  }
  id(run.run_attempt, "Run attempt");
  sha(run.head_sha, "Run source");
  actor(run.actor);
  if (typeof run.event !== "string" || !WORKFLOW.test(run.path ?? "") ||
      typeof run.head_branch !== "string" || !run.head_branch) {
    throw new Error("Workflow run has invalid event or workflow metadata");
  }
  return { id: run.id, run_attempt: run.run_attempt, repository: { id: repository.id },
    head_repository: { id: run.head_repository?.id }, head_sha: run.head_sha, head_branch: run.head_branch,
    event: run.event, path: run.path, actor: actor(run.actor), status: run.status, conclusion: run.conclusion };
}

function denied(origin, reason) {
  return { allowed: false, origin, reason };
}

function allowed(origin, reason) {
  return { allowed: true, origin, reason };
}

export function decideOrigin({ repository, run, pullRequests, identities, permission, policy, tagPush = false }) {
  validateRun(run, repository, run.id);
  policy = validatePolicy(policy);
  if (run.head_repository?.id !== repository.id) {
    return denied("untrusted-source", "The source repository is not the immutable target repository");
  }
  if (!["push", "workflow_dispatch", "schedule"].includes(run.event)) {
    return denied("unsupported-event", "PR, dynamic and unproven chained events cannot authorize publication");
  }
  if (!Array.isArray(pullRequests)) throw new Error("Associated pull requests must be an array");
  const matching = pullRequests.filter(pr => pr.merged === true && pr.merge_commit_sha === run.head_sha &&
    pr.base?.repo?.id === repository.id);
  const user = actor(run.actor);
  if (user.type === "User") {
    if (!["admin", "maintain", "write"].includes(permission)) {
      return denied("untrusted-human", "Publication requires a verified repository-write human actor");
    }
    if (run.event !== "push") return allowed(`human-${run.event}`, "Existing write-authorized manual or scheduled behavior");
    if (tagPush) return allowed("human-tag", "Verified repository-write human tag push");
    const humanMerge = matching.length === 1 && matching[0].merged_by?.id === user.id;
    return allowed(humanMerge ? "human-merge" : "human-push", "Verified original repository-write human push actor");
  }
  if (run.event !== "push") return denied("unknown-automation", "Bot-triggered manual or scheduled publication is not authorized");
  if (matching.length > 1) return denied("ambiguous-merge", "Multiple merged pull requests claim this source commit");
  const pr = matching[0];
  if (!pr || pr.merged_by?.id !== user.id || pr.merged_by?.type !== "Bot") {
    return denied("unproven-bot-merge", "The bot push is not bound to one exact merged pull request");
  }
  const sameRepository = pr.head?.repo?.id === repository.id;
  const knownApp = identities.app?.id === policy.appId && identities.app.actorId === user.id;
  const knownActions = identities.actions?.id === user.id;
  const dependabot = pr.user?.id === identities.dependabot?.id && pr.user?.type === "Bot";
  if (dependabot && sameRepository && (knownApp || knownActions)) {
    return denied("automatic-dependency-merge", "Automatic dependency merges receive analysis, not newly reachable publication");
  }
  if (knownApp && sameRepository && pr.user?.id === user.id && pr.user?.type === "Bot" &&
      policy.allowAppAuthoredMerges) {
    return allowed("existing-app-authored-merge", "Explicitly declared pre-existing App-authored repository automation");
  }
  return denied("unknown-automation", "The automation origin has no verified publication authorization");
}

export function policyDigest(repository, policy) {
  policy = validatePolicy(policy);
  return createHash("sha256").update(JSON.stringify({ contract: CONTRACT, repositoryId: repository.id,
    humanPushAdmission: "original-write-actor", appId: policy.appId,
    allowAppAuthoredMerges: policy.allowAppAuthoredMerges })).digest("hex");
}

function runIdentity(run) {
  return { id: run.id, attempt: run.run_attempt, sha: run.head_sha, branch: run.head_branch, event: run.event, path: run.path,
    actor: actor(run.actor) };
}

function sameRun(expected, actual) {
  const observed = runIdentity(actual);
  return ["id", "attempt", "sha", "branch", "event", "path"].every(key => expected?.[key] === observed[key]) &&
    ["id", "login", "type"].every(key => expected?.actor?.[key] === observed.actor[key]);
}

export function validateProof(proof, { repository, producer, policy, engineDigest }) {
  object(proof, "Origin proof");
  if (proof.contract !== CONTRACT || proof.repository !== repository.full_name ||
      proof.repositoryId !== repository.id || proof.visibility !== repository.visibility ||
      proof.engineDigest !== engineDigest || proof.policyDigest !== policyDigest(repository, policy) ||
      proof.decision?.allowed !== true || !Array.isArray(proof.lineage) ||
      !proof.lineage.length || proof.lineage.length >= MAX_LINEAGE) {
    throw new Error("Origin proof has invalid policy, engine, target or lineage");
  }
  if (!sameRun(proof.lineage.at(-1), producer)) throw new Error("Origin proof does not belong to the verified producer run");
  const seen = new Set();
  for (const entry of proof.lineage) {
    object(entry, "Proof run");
    id(entry.id, "Proof run identity");
    id(entry.attempt, "Proof attempt");
    sha(entry.sha, "Proof source");
    actor(entry.actor);
    if (seen.has(entry.id) || !WORKFLOW.test(entry.path ?? "")) throw new Error("Invalid or cyclic origin lineage");
    seen.add(entry.id);
  }
  if (!["push", "workflow_dispatch", "schedule"].includes(proof.lineage[0].event) ||
      proof.lineage.slice(1).some(entry => entry.event !== "workflow_run") ||
      proof.sourceSha !== proof.lineage[0].sha) throw new Error("Proof does not terminate in a supported source event");
  return proof;
}

function metadataUrl(endpoint) {
  if (typeof endpoint !== "string") throw new TypeError("Invalid GitHub metadata endpoint");
  if (/[\u0000-\u0020\u007f\\#]/.test(endpoint)) throw new Error("Invalid GitHub metadata endpoint");
  const [pathname, query, extra] = endpoint.split("?");
  if (extra !== undefined || !METADATA_ROUTES.some(route => route.test(pathname)) ||
      pathname.split("/").some(segment => segment === "." || segment === "..")) {
    throw new Error("Invalid GitHub metadata endpoint");
  }
  const url = new URL("https://api.github.com");
  const segments = pathname.split("/").map(segment => decodeURIComponent(segment));
  if (segments.some(segment => segment.split("/").some(part => part === "." || part === "..") ||
      /[\u0000-\u0020\u007f\\#?]/.test(segment))) throw new Error("Invalid GitHub metadata path component");
  url.pathname = segments.map(segment => encodeURIComponent(segment)).join("/");
  if (new RegExp(`^${REPOSITORY_PATH}/contents/`).test(pathname)) {
    if (!/^ref=[a-f0-9]{40}$/.test(query ?? "")) throw new Error("Invalid workflow metadata revision");
  } else if (query !== undefined) {
    if (!/\/(?:artifacts|pulls)$/.test(pathname) || !/^per_page=100&page=(?:[1-9]|1[0-9]|20)$/.test(query)) {
      throw new Error("Invalid GitHub metadata pagination");
    }
  }
  for (const [key, value] of new URLSearchParams(query)) url.searchParams.set(key, value);
  return url;
}

export class GitHub {
  constructor(token, request = fetch) {
    if (typeof token !== "string" || !/^[\x21-\x7e]+$/.test(token)) throw new Error("A metadata-read token is required");
    this.token = token;
    this.request = request;
  }
  async get(endpoint, allowMissing = false) {
    const url = metadataUrl(endpoint);
    if (!["https://api.github.com"].includes(url.origin)) throw new Error("Invalid GitHub metadata origin");
    const response = await this.request(url.href, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok) throw new Error(`Publication metadata request failed (HTTP ${response.status})`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error("Publication metadata exceeds the read bound");
    return JSON.parse(text);
  }
  async pages(endpoint, field) {
    const rows = [];
    for (let page = 1; page <= 20; page++) {
      const value = await this.get(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const items = field ? value[field] : value;
      if (!Array.isArray(items)) throw new Error("Invalid paginated publication metadata");
      rows.push(...items);
      if (items.length < 100) return rows;
    }
    throw new Error("Publication metadata exceeds the pagination bound");
  }
}

export async function readRootDecision(api, repository, run, policy, pushRef) {
  validateRun(run, repository, run.id);
  if (run.head_repository?.id !== repository.id ||
      !["push", "workflow_dispatch", "schedule"].includes(run.event)) {
    return decideOrigin({ repository, run, pullRequests: [], identities: {}, policy });
  }
  let permission;
  const identities = {};
  if (run.actor.type === "User") {
    const result = await api.get(`/repos/${repository.full_name}/collaborators/${encodeURIComponent(run.actor.login)}/permission`, true);
    if (result && (result.user?.id !== run.actor.id || result.user?.type !== "User" ||
        result.user?.login?.toLowerCase() !== run.actor.login.toLowerCase())) {
      throw new Error("Repository permission metadata belongs to a different actor identity");
    }
    permission = result?.permission;
  } else {
    identities.dependabot = await api.get("/users/dependabot%5Bbot%5D");
    identities.actions = await api.get("/users/github-actions%5Bbot%5D");
    if (run.actor.login.endsWith("[bot]")) {
      const slug = run.actor.login.slice(0, -5);
      const app = await api.get(`/apps/${encodeURIComponent(slug)}`, true);
      if (app?.id === policy.appId && app.slug?.toLowerCase() === slug.toLowerCase()) {
        identities.app = { id: app.id, actorId: run.actor.id };
      }
    }
  }
  const pullRequests = [];
  if (run.event === "push") {
    const associated = await api.pages(`/repos/${repository.full_name}/commits/${run.head_sha}/pulls`);
    for (const candidate of associated) {
      if (candidate.merge_commit_sha !== run.head_sha || !candidate.merged_at ||
          candidate.base?.repo?.id !== repository.id) continue;
      id(candidate.number, "Associated pull request");
      pullRequests.push(await api.get(`/repos/${repository.full_name}/pulls/${candidate.number}`));
    }
  }
  const tagPush = run.actor.type === "User" && run.event === "push" &&
    pushRef === `refs/tags/${run.head_branch}`;
  return decideOrigin({ repository, run, pullRequests, identities, permission, policy, tagPush });
}

async function completedRun(api, repository, runId) {
  const run = validateRun(await api.get(`/repos/${repository.full_name}/actions/runs/${runId}`), repository, runId);
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("An upstream publication origin must be a completed successful run");
  }
  return run;
}

export async function trustedProducer(api, repository, run, policy) {
  const declaration = policy.trustedProducers.find(producer => producer.path === run.path);
  if (!declaration) return false;
  const file = await api.get(`/repos/${repository.full_name}/contents/${run.path}?ref=${run.head_sha}`);
  if (file.type !== "file" || file.sha !== declaration.blobSha) return false;
  return true;
}

export async function prepare({ api, repositoryName, repositoryId, runId, runAttempt, eventName, expectedSha, workflowSha, expectedRef,
  event, policy, engineDigest }) {
  policy = validatePolicy(policy);
  sha(workflowSha, "Executed workflow definition");
  const repository = validateRepository(await api.get(`/repos/${repositoryName}`), repositoryName, repositoryId);
  const current = validateRun(await api.get(`/repos/${repository.full_name}/actions/runs/${runId}`), repository, runId);
  const prEvent = ["pull_request", "pull_request_target"].includes(current.event);
  if (current.run_attempt !== runAttempt || current.event !== eventName ||
      (!prEvent && current.head_sha !== expectedSha)) {
    throw new Error("Current workflow metadata does not match the frozen execution context");
  }
  if (current.event === "workflow_run" && current.head_sha !== workflowSha) {
    throw new Error("Chained workflow metadata does not identify the executed workflow definition");
  }
  if (current.event === "push" &&
      (![ `refs/heads/${current.head_branch}`, `refs/tags/${current.head_branch}` ].includes(expectedRef) ||
       event?.ref !== expectedRef)) {
    throw new Error("Push event reference does not match the frozen execution context");
  }
  if (current.status === "completed" && current.conclusion !== "success") {
    throw new Error("The current workflow was cancelled or completed unsuccessfully");
  }
  let source = current;
  if (current.event === "workflow_run") {
    object(event?.workflow_run, "Upstream run event");
    source = await completedRun(api, repository, id(event.workflow_run.id, "Upstream run identity"));
    if (event.workflow_run.head_sha !== source.head_sha ||
        event.workflow_run.run_attempt !== source.run_attempt ||
        event.workflow_run.head_repository?.id !== source.head_repository?.id) {
      throw new Error("The workflow_run event does not match the live producer metadata");
    }
  }
  const pushRef = source.id === current.id && current.event === "push" ? expectedRef : undefined;
  const plan = { contract: CONTRACT, repository, current, source, policy, engineDigest, pushRef,
    execution: { sourceSha: expectedSha, workflowSha }, proofRequired: false };
  if (source.id !== current.id && source.event === "workflow_run") {
    if (source.head_repository?.id !== repository.id || !await trustedProducer(api, repository, source, policy)) {
      plan.decision = denied("untrusted-producer", "Chained publication requires an exact reviewed producer definition");
      return plan;
    }
    const artifacts = await api.pages(`/repos/${repository.full_name}/actions/runs/${source.id}/artifacts`, "artifacts");
    const matching = artifacts.filter(artifact => artifact.name === ARTIFACT && artifact.expired === false);
    if (!matching.length) {
      plan.decision = denied("missing-producer-proof", "The reviewed producer retained no usable origin proof; publication remains held");
      return plan;
    }
    if (matching.length !== 1) throw new Error("The verified producer must retain exactly one unexpired origin proof");
    const artifact = matching[0];
    id(artifact.id, "Origin artifact identity");
    if (artifact.workflow_run?.id !== source.id || artifact.workflow_run.head_repository_id !== repository.id ||
        artifact.workflow_run.head_sha !== source.head_sha || !Number.isSafeInteger(artifact.size_in_bytes) ||
        artifact.size_in_bytes <= 0 || artifact.size_in_bytes > MAX_PROOF) {
      throw new Error("Origin artifact is not bound to the verified producer or exceeds the read bound");
    }
    return { ...plan, proofRequired: true, artifactId: artifact.id };
  }
  plan.decision = await readRootDecision(api, repository, source, policy, pushRef);
  return plan;
}

export async function finalize(plan, api, proof) {
  const repository = validateRepository(await api.get(`/repos/${plan.repository.full_name}`),
    plan.repository.full_name, plan.repository.id);
  if (repository.visibility !== plan.repository.visibility) throw new Error("Repository visibility changed during origin resolution");
  const current = validateRun(await api.get(`/repos/${repository.full_name}/actions/runs/${plan.current.id}`),
    repository, plan.current.id);
  if (!sameRun(runIdentity(plan.current), current)) throw new Error("Current run changed during origin resolution");
  if (current.status === "completed" && current.conclusion !== "success") {
    throw new Error("The current workflow was cancelled or completed unsuccessfully");
  }
  let source = current;
  if (plan.source.id !== current.id) {
    source = await completedRun(api, repository, plan.source.id);
    if (!sameRun(runIdentity(plan.source), source)) throw new Error("Producer changed during origin resolution");
  }
  let decision;
  let lineage;
  if (plan.proofRequired) {
    validateProof(proof, { repository, producer: source, policy: plan.policy, engineDigest: plan.engineDigest });
    for (let index = 0; index < proof.lineage.length; index++) {
      const recorded = proof.lineage[index];
      const actual = await completedRun(api, repository, recorded.id);
      if (!sameRun(recorded, actual) || actual.head_repository?.id !== repository.id) {
        throw new Error("Recorded origin lineage does not match live run metadata");
      }
      if (index > 0 && !await trustedProducer(api, repository, actual, plan.policy)) {
        throw new Error("Recorded chain contains an unapproved producer definition");
      }
      if (index === 0) {
        source = actual;
        decision = await readRootDecision(api, repository, source, plan.policy);
      }
    }
    lineage = proof.lineage;
  } else {
    decision = source.event === "workflow_run" ? plan.decision
      : await readRootDecision(api, repository, source, plan.policy, plan.pushRef);
    lineage = [runIdentity(source)];
  }
  if (lineage.at(-1).id !== current.id) lineage = [...lineage, runIdentity(current)];
  if (lineage.length > MAX_LINEAGE) throw new Error("Publication origin exceeds the chain bound");
  return { contract: CONTRACT, repository: repository.full_name, repositoryId: repository.id,
    visibility: repository.visibility, policyDigest: policyDigest(repository, plan.policy),
    engineDigest: plan.engineDigest, execution: plan.execution,
    sourceSha: source.event === "workflow_run" ? null : source.head_sha,
    decision, lineage };
}

async function boundedJson(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROOF) throw new Error("Origin JSON must be a bounded regular file");
  return JSON.parse(await readFile(filename, "utf8"));
}

export async function main(mode, env = process.env) {
  if (!["prepare", "finalize"].includes(mode)) throw new Error("Unknown publication-origin phase");
  if (!env.GITHUB_OUTPUT || !env.GITHUB_STEP_SUMMARY || !env.RUNNER_TEMP) throw new Error("GitHub output paths are required");
  const api = new GitHub(env.GH_TOKEN);
  if (mode === "prepare") {
    if (!["true", "false"].includes(env.ORIGIN_ALLOW_APP_AUTHORED)) throw new Error("App-authored automation must be explicit");
    const eventStat = await lstat(env.GITHUB_EVENT_PATH);
    if (!eventStat.isFile() || eventStat.isSymbolicLink() || eventStat.size > 8 * 1024 * 1024) {
      throw new Error("Invalid GitHub event payload");
    }
    const engineDigest = createHash("sha256")
      .update(await readFile(fileURLToPath(import.meta.url)))
      .update(await readFile(fileURLToPath(new URL("./action.yml", import.meta.url)))).digest("hex");
    const plan = await prepare({ api, repositoryName: env.GITHUB_REPOSITORY,
      repositoryId: id(Number(env.GITHUB_REPOSITORY_ID), "Workflow repository identity"),
      runId: id(Number(env.GITHUB_RUN_ID), "Workflow run identity"),
      runAttempt: id(Number(env.GITHUB_RUN_ATTEMPT), "Workflow attempt"),
      eventName: env.GITHUB_EVENT_NAME, expectedSha: sha(env.GITHUB_SHA, "Workflow source"),
      workflowSha: sha(env.GITHUB_WORKFLOW_SHA, "Executed workflow definition"),
      expectedRef: env.GITHUB_REF,
      event: JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")),
      policy: { appId: id(Number(env.ORIGIN_APP_ID), "Trusted App identity"),
        allowAppAuthoredMerges: env.ORIGIN_ALLOW_APP_AUTHORED === "true",
        trustedProducers: JSON.parse(env.ORIGIN_TRUSTED_PRODUCERS) }, engineDigest });
    const directory = await mkdtemp(path.join(env.RUNNER_TEMP, "publication-origin-"));
    const planPath = path.join(directory, "plan.json");
    await writeFile(planPath, `${JSON.stringify(plan)}\n`);
    await appendFile(env.GITHUB_OUTPUT, [
      `plan-path=${planPath}`, `proof-directory=${path.join(directory, "upstream")}`,
      `proof-required=${plan.proofRequired}`, `producer-run-id=${plan.source.id}`,
      `artifact-id=${plan.artifactId ?? ""}`, "",
    ].join("\n"));
    return;
  }
  const plan = await boundedJson(env.ORIGIN_PLAN_PATH);
  const proof = plan.proofRequired ? await boundedJson(path.join(env.ORIGIN_PROOF_DIRECTORY, "origin.json")) : undefined;
  const result = await finalize(plan, api, proof);
  const directory = path.join(path.dirname(env.ORIGIN_PLAN_PATH), "report");
  await mkdir(directory);
  await writeFile(path.join(directory, "origin.json"), `${JSON.stringify(result, null, 2)}\n`);
  await appendFile(env.GITHUB_OUTPUT, [
    `publication-allowed=${result.decision.allowed}`, `origin=${result.decision.origin}`,
    `source-sha=${result.sourceSha ?? ""}`, `report-directory=${directory}`, "",
  ].join("\n"));
  await appendFile(env.GITHUB_STEP_SUMMARY, [
    "### Publication origin", "",
    `Publication: **${result.decision.allowed ? "authorized origin" : "held for human attention"}**.`,
    `Origin: \`${result.decision.origin}\`. ${result.decision.reason}.`,
    "Existing branch, change, environment, check and release gates still apply.",
    "This helper reads metadata only; it does not authorize merges or execute repository source.", "",
  ].join("\n"));
  if (!result.decision.allowed) console.warn(`::warning::Publication held: ${result.decision.reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv[2]);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}

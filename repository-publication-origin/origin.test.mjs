import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ARTIFACT, CONTRACT, GitHub, decideOrigin, finalize, policyDigest, prepare,
  trustedProducer, validatePolicy, validateProof, validateRepository,
} from "./origin.mjs";

const SOURCE = "a".repeat(40);
const LATER = "b".repeat(40);
const BLOB = "c".repeat(40);
const ENGINE = "d".repeat(64);
const repository = { id: 100, full_name: "owner/target", default_branch: "main",
  private: true, visibility: "private", archived: false, fork: false };
const human = { id: 1, login: "owner", type: "User" };
const app = { id: 2, login: "trusted-app[bot]", type: "Bot" };
const actions = { id: 3, login: "github-actions[bot]", type: "Bot" };
const dependabot = { id: 4, login: "dependabot[bot]", type: "Bot" };
const identities = { app: { id: 50, actorId: app.id }, actions, dependabot };
const policy = { appId: 50, allowAppAuthoredMerges: false, trustedProducers: [] };

test("independent versioning tracks the actual repository-root action subtree", async () => {
  const version = JSON.parse(await readFile(new URL("./version.json", import.meta.url), "utf8"));
  assert.equal(version.inherit, false);
  assert.deepEqual(version.pathFilters, [":/repository-publication-origin"]);
});

test("metadata runtime setup never depends on the caller's npm cache or root lockfile", async () => {
  const wrapper = await readFile(new URL("./action.yml", import.meta.url), "utf8");
  assert.match(wrapper, /uses: actions\/setup-node@[a-f0-9]{40}\s+with:\s+node-version: '22'\s+package-manager-cache: false/);
});

function run(overrides = {}) {
  return { id: 10, run_attempt: 1, repository: { id: repository.id },
    head_repository: { id: repository.id }, head_sha: SOURCE, head_branch: "main", actor: human,
    event: "push", path: ".github/workflows/quality.yml", status: "completed", conclusion: "success", ...overrides };
}
function pr(overrides = {}) {
  return { number: 7, merged: true, merged_at: "2026-10-04T12:00:00Z", merge_commit_sha: SOURCE,
    base: { repo: { id: repository.id } }, head: { repo: { id: repository.id } },
    user: dependabot, merged_by: human, ...overrides };
}
function decision(overrides = {}) {
  return decideOrigin({ repository, run: run(), pullRequests: [], identities,
    permission: "write", policy, ...overrides });
}
function identity(value) {
  return { id: value.id, attempt: value.run_attempt, sha: value.head_sha, branch: value.head_branch,
    event: value.event, path: value.path, actor: value.actor };
}
function proof(root, producer, customPolicy) {
  return { contract: CONTRACT, repository: repository.full_name, repositoryId: repository.id,
    visibility: repository.visibility, engineDigest: ENGINE, policyDigest: policyDigest(repository, customPolicy),
    sourceSha: root.head_sha, decision: decision(), lineage: [identity(root), identity(producer)] };
}
function apiFixture({ runs = [], artifacts = [], pullRequests = [], permission = "write", files = {} } = {}) {
  const observed = [];
  const byId = new Map(runs.map(value => [value.id, value]));
  const api = {
    observed,
    async get(endpoint) {
      observed.push(endpoint);
      if (endpoint === "/repos/owner/target") return structuredClone(repository);
      const match = endpoint.match(/^\/repos\/owner\/target\/actions\/runs\/(\d+)$/);
      if (match) {
        if (!byId.has(Number(match[1]))) throw new Error("Unexpected run lookup");
        return structuredClone(byId.get(Number(match[1])));
      }
      if (endpoint.includes("/collaborators/")) return { permission, user: human };
      if (endpoint === "/users/dependabot%5Bbot%5D") return dependabot;
      if (endpoint === "/users/github-actions%5Bbot%5D") return actions;
      if (endpoint === "/apps/trusted-app") return { id: policy.appId, slug: "trusted-app" };
      if (endpoint.startsWith("/repos/owner/target/pulls/")) {
        return structuredClone(pullRequests.find(value => value.number === Number(endpoint.split("/").at(-1))));
      }
      if (endpoint in files) return structuredClone(files[endpoint]);
      throw new Error(`Unexpected fixture endpoint: ${endpoint}`);
    },
    async pages(endpoint) {
      observed.push(endpoint);
      if (endpoint.endsWith("/artifacts")) return structuredClone(artifacts);
      if (endpoint.endsWith("/pulls")) return structuredClone(pullRequests);
      throw new Error(`Unexpected fixture pagination: ${endpoint}`);
    },
  };
  return api;
}
function request(root, api, overrides = {}) {
  const expectedRef = overrides.event?.ref ?? `refs/heads/${root.head_branch}`;
  return prepare({ api, repositoryName: repository.full_name, repositoryId: repository.id,
    runId: root.id, runAttempt: root.run_attempt, eventName: root.event, expectedSha: root.head_sha,
    workflowSha: root.head_sha,
    expectedRef, event: { ref: expectedRef }, policy, engineDigest: ENGINE, ...overrides });
}

test("verified write-authorized human pushes and merges retain publication", () => {
  assert.equal(decision().origin, "human-push");
  assert.equal(decision({ pullRequests: [pr()] }).origin, "human-merge");
  assert.equal(decision({ pullRequests: [pr({ head: { repo: { id: 999 } } })] }).allowed, true);
});

test("manual and scheduled human behavior is retained without imposing new branch policies", () => {
  for (const event of ["schedule", "workflow_dispatch"]) {
    assert.equal(decision({ run: run({ event, head_branch: "release" }) }).allowed, true);
  }
  assert.equal(decision({ run: run({ head_branch: "v1.0.0" }) }).allowed, true);
});

test("read-only, triage and unknown human roles hold publication", () => {
  for (const permission of ["read", "triage", null, undefined]) {
    assert.equal(decision({ permission }).origin, "untrusted-human");
  }
});

test("a human rerun never converts an original bot merge into human publication", () => {
  const value = run({ actor: app, triggering_actor: human });
  assert.equal(decision({ run: value, pullRequests: [pr({ merged_by: app })] }).origin, "automatic-dependency-merge");
});

test("verified shared App and GitHub Actions dependency merges cannot newly publish", () => {
  for (const bot of [app, actions]) {
    const result = decision({ run: run({ actor: bot }), pullRequests: [pr({ merged_by: bot })] });
    assert.equal(result.allowed, false);
    assert.equal(result.origin, "automatic-dependency-merge");
  }
});

test("an existing automation exception never permits dependency publication", () => {
  assert.equal(decision({ run: run({ actor: app }), pullRequests: [pr({ merged_by: app })],
    policy: { ...policy, allowAppAuthoredMerges: true } }).origin, "automatic-dependency-merge");
});

test("pre-existing same-repository App-authored automation requires explicit declaration", () => {
  const input = { run: run({ actor: app }), pullRequests: [pr({ user: app, merged_by: app })] };
  assert.equal(decision(input).allowed, false);
  assert.equal(decision({ ...input, policy: { ...policy, allowAppAuthoredMerges: true } }).allowed, true);
});

test("App exceptions reject fork heads, unknown authors and wrong merge actors", () => {
  for (const change of [{ head: { repo: { id: 999 } } }, { user: human }, { merged_by: actions }]) {
    assert.equal(decision({ run: run({ actor: app }), pullRequests: [pr({ user: app, merged_by: app, ...change })],
      policy: { ...policy, allowAppAuthoredMerges: true } }).allowed, false);
  }
});

test("actor names, branch names and commit messages are not bot authorization", () => {
  const impostor = { ...app, id: 999 };
  assert.equal(decision({ run: run({ actor: impostor, head_branch: "main", display_title: "Dependabot" }),
    pullRequests: [pr({ merged_by: impostor })] }).allowed, false);
  assert.equal(decision({ run: run({ actor: app }), identities: { ...identities, app: { id: 999, actorId: app.id } },
    pullRequests: [pr({ merged_by: app })] }).allowed, false);
});

test("bot pushes without one exact merged PR are held", () => {
  for (const pullRequests of [[], [pr({ merge_commit_sha: LATER })], [pr({ base: { repo: { id: 999 } } })]]) {
    assert.equal(decision({ run: run({ actor: app }), pullRequests }).allowed, false);
  }
});

test("human write admission is independent of prior mergers while bot ambiguity still holds", () => {
  assert.equal(decision({ run: run({ actor: app }),
    pullRequests: [pr({ merged_by: app }), pr({ number: 8, merged_by: app })] }).origin, "ambiguous-merge");
  assert.equal(decision({ pullRequests: [pr({ merged_by: app })] }).origin, "human-push");
  assert.equal(decision({ pullRequests: [pr(), pr({ number: 8 })] }).origin, "human-push");
});

test("PRs, dynamic events, unknown bots and foreign source repositories are held", () => {
  for (const event of ["pull_request", "pull_request_target", "dynamic", "workflow_run"]) {
    assert.equal(decision({ run: run({ event }) }).allowed, false);
  }
  assert.equal(decision({ run: run({ head_repository: { id: 999 } }) }).origin, "untrusted-source");
  assert.equal(decision({ run: run({ event: "workflow_dispatch", actor: app }) }).allowed, false);
});

test("policy cannot be weakened with visibility, arbitrary actor or upload flags", () => {
  assert.throws(() => validatePolicy({ ...policy, trustedActor: "some-bot" }), /unsupported/);
  assert.throws(() => validatePolicy({ ...policy, appId: 0 }), /identity/);
  assert.throws(() => validatePolicy({ ...policy, allowAppAuthoredMerges: "true" }), /explicit/);
  assert.throws(() => validatePolicy({ ...policy, trustedProducers: [{ path: "../../file", blobSha: BLOB }] }), /path/);
  assert.throws(() => validatePolicy({ ...policy, trustedProducers: [{ path: ".github/workflows/relay.yml", blobSha: "main" }] }), /blob/);
  assert.throws(() => validatePolicy({ ...policy, trustedProducers: Array(2).fill({ path: ".github/workflows/relay.yml", blobSha: BLOB }) }), /Duplicate/);
});

test("target metadata is bound to immutable identity, ownership and visibility", () => {
  for (const change of [{ id: 999 }, { full_name: "other/target" }, { archived: true },
    { fork: true }, { visibility: "public" }]) {
    assert.throws(() => validateRepository({ ...repository, ...change }, "owner/target", 100), /immutable/);
  }
});

test("metadata requests are GET-only, fixed-origin and never reinterpret a 403 as absence", async () => {
  const requests = [];
  const api = new GitHub("read-token", async (url, options) => {
    requests.push({ url, options });
    return { ok: false, status: 403 };
  });
  await assert.rejects(api.get("/repos/owner/target", true), /HTTP 403/);
  assert.equal(requests[0].url, "https://api.github.com/repos/owner/target");
  assert.equal(requests[0].options.method, undefined);
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.headers.Authorization, "Bearer read-token");
  await assert.rejects(api.get("//external.invalid/path"), /endpoint/);
  assert.throws(() => new GitHub("invalid\nsecret"), /read token/);
});

test("transport, malformed metadata and pagination errors fail rather than authorizing", async () => {
  await assert.rejects(new GitHub("read-token", async () => { throw new Error("transport"); }).get("/repos/o/r"), /transport/);
  await assert.rejects(new GitHub("read-token", async () =>
    ({ ok: true, status: 200, text: async () => "not-json" })).get("/repos/o/r"), SyntaxError);
  const api = new GitHub("read-token", async () =>
    ({ ok: true, status: 200, text: async () => JSON.stringify(Array(100).fill({})) }));
  await assert.rejects(api.pages(`/repos/o/r/commits/${SOURCE}/pulls`), /pagination bound/);
});

test("metadata routes reject traversal, injected queries and unrelated API access before requesting", async () => {
  let requests = 0;
  const api = new GitHub("read-token", async () => { requests++; throw new Error("Unexpected request"); });
  for (const endpoint of [
    "/repos/owner/../actions/runs/10", "/repos/owner/%2e%2e/actions/runs/10",
    "/repos/owner/target\\actions\\runs\\10", "/repos/owner/target/actions/runs/10#fragment",
    "/repos/owner/target/actions/runs/10?other=1", "/repos/owner/target/issues",
    "/repos/owner/target\n", "/repos/owner/target/contents/.github/workflows/relay.yml?ref=" + SOURCE + "\n",
    "/repos/owner/target/actions/runs/10/artifacts?per_page=100&page=21",
    "/repos/owner/target/actions/runs/10/artifacts?per_page=100&page=1&redirect=evil",
    "/repos/owner/target/contents/.github/workflows/relay.yml?ref=main",
    "/repos/owner/target/contents/.github/workflows/relay.yml?ref=" + SOURCE + "&ref=" + LATER,
    "/repos/owner/target/git/ref/tags/%2e%2e%2Foutside",
    "//external.invalid/path", "https://api.github.com/repos/owner/target",
  ]) await assert.rejects(api.get(endpoint), /Invalid/);
  assert.equal(requests, 0);
});

test("allowed metadata routes preserve encoded bot identities, exact revisions and bounded pagination", async () => {
  const requests = [];
  const api = new GitHub("read-token", async (url, options) => {
    requests.push({ url, options });
    return { ok: true, text: async () => "{}" };
  });
  for (const endpoint of [
    "/users/dependabot%5Bbot%5D", "/users/github-actions%5Bbot%5D", "/apps/trusted-app",
    `/repos/owner/target/contents/.github/workflows/relay.yml?ref=${SOURCE}`,
    "/repos/owner/target/actions/runs/20/artifacts?per_page=100&page=20",
    "/repos/owner/contents/actions/runs/10",
    `/repos/contents/target/contents/.github/workflows/relay.yml?ref=${SOURCE}`,
  ]) {
    await api.get(endpoint);
    assert.equal(requests.at(-1).url, `https://api.github.com${endpoint}`);
  }
});

test("direct prepare/finalize uses live permission and merge metadata without source execution", async () => {
  const root = run();
  const api = apiFixture({ runs: [root], pullRequests: [pr()] });
  const plan = await request(root, api);
  const result = await finalize(plan, api);
  assert.equal(result.decision.origin, "human-merge");
  assert.equal(result.sourceSha, SOURCE);
  assert.deepEqual(result.lineage.map(value => value.id), [root.id]);
  assert.ok(api.observed.every(endpoint => !endpoint.includes("/git/blobs")));
});

test("a write-authorized release manager can tag a commit merged by another maintainer", async () => {
  const root = run({ head_branch: "v1.0.0" });
  const otherMaintainer = { ...human, id: 9, login: "maintainer" };
  const api = apiFixture({ runs: [root], pullRequests: [pr({ merged_by: otherMaintainer })] });
  const plan = await request(root, api, { event: { ref: "refs/tags/v1.0.0" } });
  const result = await finalize(plan, api);
  assert.equal(result.decision.allowed, true);
  assert.equal(result.decision.origin, "human-tag");
  assert.equal(result.sourceSha, SOURCE);
  assert.equal((await finalize(plan, apiFixture({ runs: [root], permission: "read" }))).decision.allowed, false);
});

test("tag classification requires the push payload, runtime reference and live branch to agree", async () => {
  const root = run();
  const api = apiFixture({ runs: [root] });
  await assert.rejects(request(root, api, { expectedRef: "refs/tags/v1.0.0",
    event: { ref: "refs/tags/v1.0.0" } }), /Push event reference/);
  await assert.rejects(request(root, api, { expectedRef: "refs/tags/main",
    event: { ref: "refs/heads/main" } }), /Push event reference/);
});

function tagFixture() {
  const source = run({ head_branch: "v1.0.0" });
  const current = run({ id: 20, event: "workflow_run", head_sha: LATER });
  const pullRequests = [pr({ merged_by: { ...human, id: 9, login: "maintainer" } })];
  return { source, current, pullRequests };
}

test("downstream human admission depends on the original writer, not historical merger or mutable refs", async () => {
  const { source, current, pullRequests } = tagFixture();
  const api = apiFixture({ runs: [source, current], pullRequests });
  const plan = await request(current, api, { event: { workflow_run: source } });
  const result = await finalize(plan, api);
  assert.equal(result.decision.allowed, true);
  assert.equal(result.decision.origin, "human-push");
  assert.equal(result.sourceSha, SOURCE);
  assert.ok(api.observed.every(endpoint => !endpoint.includes("/git/")));
});

test("direct and downstream tags remain consistent when multiple PRs share the same human merger", async () => {
  const { source, current } = tagFixture();
  const pullRequests = [pr(), pr({ number: 8 })];
  const api = apiFixture({ runs: [source, current], pullRequests });
  const direct = await request(source, api, { event: { ref: "refs/tags/v1.0.0" } });
  const downstream = await request(current, api, { event: { workflow_run: source } });
  for (const plan of [direct, downstream]) {
    const result = await finalize(plan, api);
    assert.equal(result.decision.allowed, true);
    assert.equal(result.sourceSha, SOURCE);
  }
});

test("later tag state cannot upgrade a bot origin or downgrade an originally authorized human branch push", async () => {
  const { current } = tagFixture();
  const humanSource = run({ head_branch: "release" });
  const botSource = run({ head_branch: "release", actor: app, triggering_actor: human });
  for (const source of [humanSource, botSource]) {
    const pullRequests = [pr({ merged_by: app })];
    const api = apiFixture({ runs: [source, current], pullRequests,
      files: { "/repos/owner/target/git/ref/tags/release": { object: { type: "commit", sha: SOURCE } } } });
    const direct = await request(source, api);
    const downstream = await request(current, api, { event: { workflow_run: source } });
    for (const plan of [direct, downstream]) {
      const result = await finalize(plan, api);
      assert.equal(result.decision.allowed, source.actor.type === "User");
      assert.equal(result.decision.origin, source.actor.type === "User" ? "human-push" : "automatic-dependency-merge");
    }
    assert.ok(api.observed.every(endpoint => !endpoint.includes("/git/")));
  }
});

test("a direct App merge resolves the official App and bot identities before denial", async () => {
  const root = run({ actor: app });
  const api = apiFixture({ runs: [root], pullRequests: [pr({ merged_by: app })] });
  const plan = await request(root, api);
  assert.equal((await finalize(plan, api)).decision.origin, "automatic-dependency-merge");
  assert.ok(api.observed.includes("/apps/trusted-app"));
  assert.ok(api.observed.includes("/users/dependabot%5Bbot%5D"));
});

test("workflow_run follows actual producer source rather than the later default tip", async () => {
  const source = run();
  const current = run({ id: 20, event: "workflow_run", head_sha: LATER, path: ".github/workflows/publish.yml" });
  const api = apiFixture({ runs: [source, current] });
  const plan = await request(current, api, { event: { workflow_run: source } });
  const result = await finalize(plan, api);
  assert.equal(result.decision.allowed, true);
  assert.equal(result.sourceSha, SOURCE);
  assert.deepEqual(result.execution, { sourceSha: LATER, workflowSha: LATER });
  assert.deepEqual(result.lineage.map(value => value.id), [10, 20]);
});

test("workflow_run metadata must bind to the actual executed workflow definition", async () => {
  const source = run();
  const current = run({ id: 20, event: "workflow_run", head_sha: LATER });
  await assert.rejects(request(current, apiFixture({ runs: [source, current] }),
    { workflowSha: SOURCE, event: { workflow_run: source } }), /executed workflow definition/);
  await assert.rejects(request(source, apiFixture({ runs: [source] }),
    { workflowSha: undefined }), /Executed workflow definition/);
});

test("stale attempts, wrong event/source and foreign current runs fail before output", async () => {
  const source = run();
  for (const change of [{ runAttempt: 2 }, { expectedSha: LATER }, { eventName: "schedule" }, { repositoryId: 999 }]) {
    await assert.rejects(request(source, apiFixture({ runs: [source] }), change));
  }
});

test("workflow_run requires an exact completed successful upstream event", async () => {
  const current = run({ id: 20, event: "workflow_run", head_sha: LATER });
  for (const source of [run({ conclusion: "failure" }), run({ status: "in_progress" })]) {
    await assert.rejects(request(current, apiFixture({ runs: [current, source] }),
      { event: { workflow_run: source } }), /completed successful/);
  }
  const source = run();
  await assert.rejects(request(current, apiFixture({ runs: [source, current] }),
    { event: { workflow_run: { ...source, head_sha: LATER } } }), /event does not match/);
});

test("chained producers need exact reviewed workflow blob identity", async () => {
  const producer = run({ id: 20, event: "workflow_run", path: ".github/workflows/relay.yml", head_sha: LATER });
  assert.equal(await trustedProducer(apiFixture(), repository, producer, policy), false);
  const declared = { ...policy, trustedProducers: [{ path: producer.path, blobSha: BLOB }] };
  const endpoint = `/repos/owner/target/contents/${producer.path}?ref=${LATER}`;
  assert.equal(await trustedProducer(apiFixture({ files: { [endpoint]: { type: "file", sha: BLOB } } }), repository, producer, declared), true);
  assert.equal(await trustedProducer(apiFixture({ files: { [endpoint]: { type: "file", sha: SOURCE } } }), repository, producer, declared), false);
});

function chainFixture() {
  const root = run();
  const producer = run({ id: 20, event: "workflow_run", path: ".github/workflows/relay.yml", head_sha: LATER });
  const current = run({ id: 30, event: "workflow_run", path: ".github/workflows/promote.yml", head_sha: LATER });
  const declared = { ...policy, trustedProducers: [{ path: producer.path, blobSha: BLOB }] };
  const artifact = { id: 70, name: ARTIFACT, expired: false, size_in_bytes: 1500,
    workflow_run: { id: producer.id, head_repository_id: repository.id, head_sha: producer.head_sha } };
  const files = { [`/repos/owner/target/contents/${producer.path}?ref=${LATER}`]: { type: "file", sha: BLOB } };
  return { root, producer, current, declared, artifact, files };
}

test("two-hop publication revalidates protected producer, artifact and original source", async () => {
  const { root, producer, current, declared, artifact, files } = chainFixture();
  const api = apiFixture({ runs: [root, producer, current], artifacts: [artifact], files });
  const plan = await request(current, api, { policy: declared, event: { workflow_run: producer } });
  assert.equal(plan.proofRequired, true);
  assert.equal(plan.artifactId, artifact.id);
  const result = await finalize(plan, api, proof(root, producer, declared));
  assert.equal(result.decision.allowed, true);
  assert.equal(result.sourceSha, SOURCE);
  assert.deepEqual(result.lineage.map(value => value.id), [10, 20, 30]);
});

test("chained event names alone never authorize publication or relabel the source", async () => {
  const { producer, current } = chainFixture();
  const api = apiFixture({ runs: [producer, current] });
  const plan = await request(current, api, { event: { workflow_run: producer } });
  const result = await finalize(plan, api);
  assert.equal(result.decision.origin, "untrusted-producer");
  assert.equal(result.decision.allowed, false);
  assert.equal(result.sourceSha, null);
});

test("duplicate, foreign and oversized producer artifacts fail", async () => {
  const { root, producer, current, declared, artifact, files } = chainFixture();
  for (const artifacts of [[artifact, { ...artifact, id: 71 }],
    [{ ...artifact, size_in_bytes: 65537 }],
    [{ ...artifact, workflow_run: { ...artifact.workflow_run, id: 999 } }],
    [{ ...artifact, workflow_run: { ...artifact.workflow_run, head_repository_id: 999 } }]]) {
    await assert.rejects(request(current, apiFixture({ runs: [root, producer, current], artifacts, files }),
      { policy: declared, event: { workflow_run: producer } }));
  }
});

test("missing or expired origin proof explicitly holds a no-op chained producer", async () => {
  const { root, producer, current, declared, artifact, files } = chainFixture();
  for (const artifacts of [[], [{ ...artifact, expired: true }]]) {
    const api = apiFixture({ runs: [root, producer, current], artifacts, files });
    const plan = await request(current, api, { policy: declared, event: { workflow_run: producer } });
    const result = await finalize(plan, api);
    assert.equal(result.decision.origin, "missing-producer-proof");
    assert.equal(result.decision.allowed, false);
    assert.equal(result.sourceSha, null);
  }
});

test("PR merge-ref differences never turn a PR validation run into publication", async () => {
  const current = run({ event: "pull_request" });
  const api = apiFixture({ runs: [current] });
  const plan = await request(current, api, { expectedSha: LATER });
  const result = await finalize(plan, api);
  assert.equal(result.decision.origin, "unsupported-event");
  assert.equal(result.decision.allowed, false);
});

test("proofs reject foreign targets, changed visibility, policy, engine and source", () => {
  const { root, producer, declared } = chainFixture();
  const original = proof(root, producer, declared);
  for (const change of [{ repositoryId: 999 }, { repository: "other/repo" }, { visibility: "public" },
    { contract: "old" }, { policyDigest: "other" }, { engineDigest: "other" },
    { sourceSha: LATER }, { decision: { allowed: false } }]) {
    assert.throws(() => validateProof({ ...original, ...change },
      { repository, producer, policy: declared, engineDigest: ENGINE }));
  }
});

test("proofs reject forged run identities, cycles, PR roots and unbounded ancestry", () => {
  const { root, producer, declared } = chainFixture();
  const original = proof(root, producer, declared);
  for (const lineage of [[identity(root)], [identity(producer), identity(producer)],
    [identity(run({ event: "pull_request" })), identity(producer)], Array(8).fill(identity(producer))]) {
    assert.throws(() => validateProof({ ...original, lineage },
      { repository, producer, policy: declared, engineDigest: ENGINE }));
  }
});

test("cached positive decisions are never trusted after current permission is revoked", async () => {
  const root = run();
  const plan = await request(root, apiFixture({ runs: [root] }));
  assert.equal(plan.decision.allowed, true);
  const result = await finalize(plan, apiFixture({ runs: [root], permission: "read" }));
  assert.equal(result.decision.allowed, false);
});

test("a reused login cannot substitute another human permission identity", async () => {
  const root = run();
  const api = apiFixture({ runs: [root] });
  const get = api.get.bind(api);
  api.get = async endpoint => endpoint.includes("/collaborators/")
    ? { permission: "admin", user: { ...human, id: 999 } } : get(endpoint);
  await assert.rejects(request(root, api), /different actor identity/);
});

test("cancellation and reruns invalidate in-flight authorization", async () => {
  const root = run();
  const plan = await request(root, apiFixture({ runs: [root] }));
  for (const changed of [run({ run_attempt: 2 }), run({ conclusion: "cancelled" }), run({ head_branch: "different" })]) {
    await assert.rejects(finalize(plan, apiFixture({ runs: [changed] })));
  }
});

test("a proof cannot replace a current dependency origin with a cached clean flag", async () => {
  const { root, producer, current, declared, artifact, files } = chainFixture();
  const automated = { ...root, actor: app };
  const api = apiFixture({ runs: [automated, producer, current], artifacts: [artifact], files,
    pullRequests: [pr({ merged_by: app })] });
  const plan = await request(current, api, { policy: declared, event: { workflow_run: producer } });
  const recorded = proof(automated, producer, declared);
  const result = await finalize(plan, api, recorded);
  assert.equal(result.decision.origin, "automatic-dependency-merge");
  assert.equal(result.decision.allowed, false);
});

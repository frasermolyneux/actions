import assert from "node:assert/strict";
import test from "node:test";
import { trustedOrigin } from "./origin.mjs";
import { selectAnalysis } from "./policy.mjs";

const owner = { id: 789, login: "owner", type: "User" };
const copilot = { id: 198982749, login: "Copilot", type: "Bot" };
const dependabot = { id: 49699333, login: "dependabot[bot]", type: "Bot" };
const actions = { id: 41898282, login: "github-actions[bot]", type: "Bot" };
const input = { repository: "owner/project", repositoryId: 123,
  sourceSha: "a".repeat(40), pullRequest: 42 };
const event = { pull_request: { head: { sha: "b".repeat(40) } } };
const repository = (privateRepository) => ({ id: 123, full_name: input.repository,
  private: privateRepository, visibility: privateRepository ? "private" : "public",
  fork: false, archived: false, default_branch: "main", owner });
const pull = { number: 42, state: "open", draft: false, user: owner,
  head: { sha: event.pull_request.head.sha, repo: { id: 123, full_name: input.repository } },
  base: { repo: { id: 123, full_name: input.repository } } };

test("actual private and public metadata admit the same verified first-party author/actor pairs", () => {
  for (const privateRepository of [false, true]) {
    for (const [author, actor, origin] of [
      [owner, owner, "owner"], [copilot, copilot, "copilot"], [copilot, owner, "copilot"],
      [dependabot, dependabot, "dependabot"], [dependabot, actions, "dependabot"],
    ]) {
      const trust = trustedOrigin(repository(privateRepository), { actor },
        { ...pull, user: author }, input, event);
      assert.equal(trust.origin, origin);
      assert.equal(trust.logicalHeadSha, event.pull_request.head.sha);
      assert.notEqual(trust.logicalHeadSha, input.sourceSha);
    }
  }
});

test("private first-party admission never grants private provider execution or public SARIF", () => {
  const metadata = repository(true);
  assert.equal(trustedOrigin(metadata, { actor: owner }, pull, input, event).origin, "owner");
  const context = selectAnalysis({ version: "repository-analysis-v1",
    languages: ["actions", "javascript", "python"], sonar: true }, metadata, input.repository);
  assert.equal(context.visibility, "private");
  assert.deepEqual(context.codeql.languages, []);
  assert.equal(context.sonar.status, "unavailable");
  assert.equal(context.publication.sarif, "not-available");
  assert.equal(context.publication.artifacts, "private");
});

test("missing, inconsistent, transferred, forked or archived metadata cannot authorize source", () => {
  for (const patch of [
    { visibility: "public" }, { private: false }, { id: 999 }, { fork: true },
    { archived: true }, { default_branch: undefined },
    { owner: { ...owner, type: "Organization" } }, { full_name: "other/project" },
  ]) {
    assert.throws(() => trustedOrigin({ ...repository(true), ...patch },
      { actor: owner }, pull, input, event), /personal-owner/);
  }
  assert.throws(() => trustedOrigin(null, {}, pull, input, event), /personal-owner/);
});

test("third-party authors, spoofed bots and mismatched actors remain blocked in private repositories", () => {
  for (const [author, actor] of [
    [{ ...owner, id: 999 }, owner], [{ ...copilot, id: 999 }, copilot],
    [{ ...copilot, type: "User" }, copilot], [actions, actions], [copilot, actions],
    [owner, copilot], [dependabot, { ...dependabot, id: 999 }],
  ]) assert.throws(() => trustedOrigin(repository(true), { actor },
    { ...pull, user: author }, input, event), /author|actor/);
});

test("forks, missing base origins, closed/draft PRs and changed logical heads fail closed", () => {
  for (const candidate of [
    { ...pull, state: "closed" }, { ...pull, draft: true }, { ...pull, number: 43 },
    { ...pull, head: { ...pull.head, sha: "c".repeat(40) } },
    { ...pull, head: { ...pull.head, repo: { id: 999, full_name: input.repository } } },
    { ...pull, base: { repo: { id: 123 } } },
    { ...pull, base: { repo: { id: 123, full_name: "other/project" } } },
  ]) assert.throws(() => trustedOrigin(repository(true), { actor: owner },
    candidate, input, event), /foreign|superseded/);
});

test("authenticated owner reruns cannot override an untrusted author or mismatched triggering actor", () => {
  assert.equal(trustedOrigin(repository(true), { actor: actions, triggering_actor: owner },
    { ...pull, user: copilot }, input, event).origin, "copilot");
  assert.throws(() => trustedOrigin(repository(true), { actor: owner, triggering_actor: actions },
    { ...pull, user: copilot }, input, event), /actor/);
  assert.throws(() => trustedOrigin(repository(true), { actor: actions, triggering_actor: owner },
    { ...pull, user: { ...owner, id: 999 } }, input, event), /author/);
});

test("default source and owner dispatch do not authorize arbitrary private manual branches", () => {
  const source = { ...input, pullRequest: null };
  assert.equal(trustedOrigin(repository(true), { head_branch: "main" }, null, source, {}).origin,
    "default-or-owner-dispatch");
  assert.equal(trustedOrigin(repository(true), { head_branch: "feature",
    event: "workflow_dispatch", actor: owner }, null, source, {}).origin, "default-or-owner-dispatch");
  assert.throws(() => trustedOrigin(repository(true), { head_branch: "feature",
    event: "workflow_dispatch", actor: copilot }, null, source, {}), /owner dispatch/);
});

test("malformed immutable source identities are refused explicitly", () => {
  for (const patch of [{ sourceSha: "main" }, { repositoryId: 0 }, { pullRequest: undefined },
    { pullRequest: 1.5 }, { repository: "../project" }]) {
    assert.throws(() => trustedOrigin(repository(true), {}, pull, { ...input, ...patch }, event),
      /identity is invalid/);
  }
});

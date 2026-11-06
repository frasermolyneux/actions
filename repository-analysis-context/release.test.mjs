import assert from "node:assert/strict";
import test from "node:test";
import { admittedReference, publishedShaForRun } from "./release.mjs";

const sha = "a".repeat(40);
const workflow = ".github/workflows/repository-analysis-sonar.yml";
const name = "repository-analysis-sonar";
const run = (ref = sha) => ({ referenced_workflows: [{
  path: `frasermolyneux/actions/${workflow}@${ref}`, ref, sha,
}] });
const response = (refs, status = 200) => new Response(JSON.stringify(refs), { status });
const tag = (ref, object = { type: "commit", sha }) => ({ ref, object });

test("only the correct exact published package commit authorizes an exact SHA reference", async () => {
  const good = tag(`refs/tags/${name}/v1.2.3`);
  const request = async (url, options) => {
    assert.equal(url, `https://api.github.com/repos/frasermolyneux/actions/git/matching-refs/tags/${name}/v`);
    assert.equal(options.redirect, "error");
    return response([good]);
  };
  const approved = await publishedShaForRun(run(), workflow, name, "token", request);
  assert.equal(approved, sha);
  assert.equal(admittedReference(sha, sha, "example/repo", name, approved), true);
  for (const bad of [
    tag("refs/tags/repository-analysis/v1.2.3"),
    tag(`refs/tags/${name}/v1.2`),
    tag(`refs/tags/${name}/v1.2.3`, { type: "commit", sha: "b".repeat(40) }),
    tag(`refs/tags/${name}/v1.2.3`, { type: "tag", sha }),
  ]) {
    assert.equal(await publishedShaForRun(run(), workflow, name, "token", async () => response([bad])), undefined);
  }
  assert.equal(admittedReference(sha, sha, "example/repo", name), false);
  assert.equal(admittedReference("b".repeat(40), sha, "example/repo", name, sha), false);
  assert.equal(admittedReference("refs/heads/main", sha, "example/repo", name, sha), false);
  assert.equal(admittedReference("refs/heads/main", sha, "frasermolyneux/actions", name), true);
  assert.equal(admittedReference(`refs/tags/${name}/v1.2.3`, sha, "example/repo", name), true);
});

test("lookup fails closed for ambiguous metadata and API errors", async () => {
  const ambiguous = run();
  ambiguous.referenced_workflows.push({ ...ambiguous.referenced_workflows[0] });
  assert.equal(await publishedShaForRun(ambiguous, workflow, name, "token"), undefined);
  await assert.rejects(publishedShaForRun(run(), workflow, name, "token",
    async () => response({}, 403)), /lookup failed/);
  await assert.rejects(publishedShaForRun(run(), workflow, name, "token",
    async () => response({})), /Malformed/);
});

const SHA = /^[a-f0-9]{40}$/;
const PACKAGES = new Set(["repository-analysis", "repository-analysis-codeql", "repository-analysis-sonar"]);

export function admittedReference(reference, sha, repository, name, approvedSha) {
  if (!PACKAGES.has(name) || !SHA.test(sha ?? "")) return false;
  const tag = new RegExp(`^(?:refs/tags/)?${name}/v\\d+\\.\\d+\\.\\d+$`);
  return tag.test(reference ?? "") ||
    (SHA.test(reference ?? "") && reference === sha && approvedSha === sha) ||
    (repository === "frasermolyneux/actions" &&
      /^refs\/(?:heads\/[A-Za-z0-9_./-]+|pull\/[1-9]\d*\/merge)$/.test(reference ?? ""));
}

export async function publishedShaForRun(run, workflowPath, name, token, request = fetch) {
  if (!PACKAGES.has(name)) throw new Error("Unknown workflow release package");
  const matches = run?.referenced_workflows?.filter((entry) =>
    entry.path?.startsWith(`frasermolyneux/actions/${workflowPath}@`));
  if (matches?.length !== 1) return undefined;
  const entry = matches[0];
  const reference = entry.ref ?? entry.path.split("@")[1];
  if (!SHA.test(reference ?? "") || reference !== entry.sha) return undefined;
  const response = await request(
    `https://api.github.com/repos/frasermolyneux/actions/git/matching-refs/tags/${name}/v`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error(`Workflow release lookup failed (HTTP ${response.status})`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("Workflow release lookup exceeds its bound");
    chunks.push(Buffer.from(chunk));
  }
  const refs = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(refs)) throw new Error("Malformed workflow release lookup");
  const exact = new RegExp(`^refs/tags/${name}/v\\d+\\.\\d+\\.\\d+$`);
  return refs.some((ref) => exact.test(ref.ref ?? "") &&
    ref.object?.type === "commit" && ref.object.sha === reference) ? reference : undefined;
}

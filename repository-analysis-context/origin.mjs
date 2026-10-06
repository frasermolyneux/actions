const SHA = /^[a-f0-9]{40}$/;
const APPROVED_PR_AUTOMATION = [
  { id: 198982749, login: "Copilot", type: "Bot", origin: "copilot" },
  { id: 49699333, login: "dependabot[bot]", type: "Bot", origin: "dependabot" },
];
const GITHUB_ACTIONS_ACTOR = { id: 41898282, login: "github-actions[bot]", type: "Bot" };
const sameIdentity = (actual, expected) => actual?.id === expected.id &&
  actual.login === expected.login && actual.type === expected.type;
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

export function trustedOrigin(repository, run, pullRequest, input, event) {
  requireValue(typeof input?.repository === "string" &&
    /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) &&
    Number.isSafeInteger(input.repositoryId) && input.repositoryId > 0 &&
    SHA.test(input.sourceSha ?? "") &&
    (input.pullRequest === null || (Number.isSafeInteger(input.pullRequest) && input.pullRequest > 0)),
  "First-party source identity is invalid");
  const owner = repository?.owner;
  requireValue(repository?.id === input.repositoryId && repository.full_name === input.repository &&
    ["public", "private"].includes(repository.visibility) &&
    repository.private === (repository.visibility === "private") &&
    repository.fork === false && repository.archived === false &&
    typeof repository.default_branch === "string" && repository.default_branch.trim().length > 0 &&
    owner?.type === "User" && Number.isSafeInteger(owner.id) && owner.id > 0 &&
    owner.login === input.repository.split("/")[0],
  "First-party policy requires this live active personal-owner repository");
  const actor = run?.triggering_actor ?? run?.actor;
  if (input.pullRequest === null) {
    requireValue(run?.head_branch === repository.default_branch ||
      (run?.event === "workflow_dispatch" && sameIdentity(actor, owner)),
    "First-party analysis requires the default branch or explicit owner dispatch");
    return { policy: "trusted-first-party-v1", origin: "default-or-owner-dispatch",
      isolation: "same-runner-risk-accepted", logicalHeadSha: input.sourceSha };
  }
  const logicalHeadSha = event?.pull_request?.head?.sha;
  requireValue(pullRequest?.number === input.pullRequest && pullRequest.state === "open" &&
    pullRequest.draft === false && pullRequest.head?.repo?.id === input.repositoryId &&
    pullRequest.head.repo.full_name === input.repository &&
    pullRequest.head.sha === logicalHeadSha && SHA.test(logicalHeadSha ?? "") &&
    pullRequest.base?.repo?.id === input.repositoryId &&
    pullRequest.base.repo.full_name === input.repository,
  "First-party policy cannot authorize a foreign, draft, closed or superseded PR source");
  const author = pullRequest.user;
  const automation = APPROVED_PR_AUTOMATION.find((identity) => sameIdentity(author, identity));
  const ownerAuthored = sameIdentity(author, owner);
  requireValue(ownerAuthored || automation, "PR author is not the verified owner or approved automation");
  requireValue(sameIdentity(actor, owner) || (automation && sameIdentity(actor, automation)) ||
    (automation?.origin === "dependabot" && sameIdentity(actor, GITHUB_ACTIONS_ACTOR)),
  "PR analysis actor is not authorized for this trusted author/source pair");
  return { policy: "trusted-first-party-v1", origin: ownerAuthored ? "owner" : automation.origin,
    isolation: "same-runner-risk-accepted", logicalHeadSha,
    authorId: author.id, actorId: actor.id, pullRequest: input.pullRequest };
}

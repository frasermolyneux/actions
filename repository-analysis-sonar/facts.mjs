import { createHash } from "node:crypto";

const LANGUAGES = { cs: "csharp", c: "cpp", cpp: "cpp", js: "javascript",
  ts: "typescript", py: "python", php: "php" };
const PAGE_SIZE = 500;
const FILE_LIMIT = 20000;
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

export function filePage(payload, projectKey, page, total) {
  requireValue(payload?.baseComponent?.key === projectKey &&
    payload.baseComponent.qualifier === "TRK" && payload.baseComponent.visibility === "public" &&
    payload.paging?.pageIndex === page && payload.paging.pageSize === PAGE_SIZE &&
    Number.isSafeInteger(payload.paging.total) && payload.paging.total >= 0 &&
    payload.paging.total <= FILE_LIMIT &&
    (total === null || payload.paging.total === total) && Array.isArray(payload.components) &&
    payload.components.length === Math.min(PAGE_SIZE, Math.max(0, payload.paging.total - (page - 1) * PAGE_SIZE)),
  "Sonar analyzed-file paging is missing, changed, incomplete or outside its bound");
  return payload.paging.total;
}

export function countedFiles(files, tracked, capabilities, projectKey) {
  requireValue(Array.isArray(files) && files.length <= FILE_LIMIT && tracked instanceof Set &&
    Array.isArray(capabilities) && capabilities.length > 0 &&
    capabilities.every((value) => Object.values(LANGUAGES).includes(value)),
  "A selected Sonar capability set and actual tracked source are required");
  const seen = new Set();
  const keys = new Set();
  const counts = Object.fromEntries(capabilities.map((value) => [value, 0]));
  const identities = [];
  for (const file of files) {
    requireValue(file?.qualifier === "FIL" && typeof file.key === "string" &&
      file.key.startsWith(projectKey + ":") && typeof file.path === "string" &&
      file.path.length <= 512 && !/[\\:\0\r\n]/.test(file.path) &&
      file.path.split("/").every((part) => part && ![".", ".."].includes(part)) &&
      !seen.has(file.path) && !keys.has(file.key) &&
      typeof file.language === "string" && file.language.length <= 40,
    "Sonar analyzed-file metadata is malformed, duplicated or outside this project");
    seen.add(file.path);
    keys.add(file.key);
    const capability = LANGUAGES[file.language];
    if (!capabilities.includes(capability)) continue;
    requireValue(tracked.has(file.path) &&
      !/(?:^|\/)(?:fixtures|node_modules|vendor|bin|obj|build)\//i.test(file.path),
    "Sonar selected-language coverage must name maintained tracked source, not generated or fixture files");
    counts[capability]++;
    identities.push({ key: file.key, path: file.path, language: file.language });
  }
  requireValue(Object.values(counts).every((value) => value > 0),
    "Sonar did not analyze maintained source for every selected capability");
  identities.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return { sourceCoverage: counts, analyzedFiles: identities.length,
    sourceMetadataDigest: createHash("sha256").update(JSON.stringify(identities)).digest("hex") };
}

export function findingTotal(payload, projectKey) {
  requireValue(payload?.paging?.pageIndex === 1 && payload.paging.pageSize === 1 &&
    Number.isSafeInteger(payload.paging.total) && payload.paging.total >= 0 &&
    (payload.total === undefined || payload.total === payload.paging.total) &&
    Array.isArray(payload.issues) && payload.issues.length === Math.min(1, payload.paging.total) &&
    payload.issues.every((issue) => issue?.project === projectKey && typeof issue.component === "string" &&
      (issue.component === projectKey || issue.component?.startsWith(projectKey + ":"))),
  "Sonar unresolved-finding count is absent, inconsistent or from another project");
  return payload.paging.total;
}

export function branchSnapshot(payload, input, proof) {
  const analysis = payload?.analyses?.[0];
  requireValue(analysis?.key === proof.processing.analysisId && analysis.revision === input.sourceSha &&
    date(analysis.date), "Sonar facts require the latest exact-source completed branch analysis");
  return { analysisId: analysis.key, sourceSha: analysis.revision, analysisDate: analysis.date };
}

export function pullSnapshot(payload, activity, input, proof) {
  requireValue(Array.isArray(payload?.pullRequests) && payload.pullRequests.length <= 1000 &&
    Array.isArray(activity?.tasks) && activity.tasks.length <= 1000,
  "Sonar PR snapshot or completed-task identity is missing");
  const matches = payload.pullRequests.filter((entry) => entry.key === String(input.pullRequest));
  const tasks = activity.tasks.filter((entry) => entry.componentKey === input.projectKey &&
    entry.type === "REPORT" && entry.status === "SUCCESS" &&
    String(entry.pullRequest ?? "") === String(input.pullRequest));
  requireValue(matches.length === 1 && tasks.length > 0 &&
    tasks.every((entry) => date(entry.executedAt)), "Sonar PR task selection is absent or ambiguous");
  tasks.sort((left, right) => Date.parse(right.executedAt) - Date.parse(left.executedAt));
  const latest = tasks[0];
  const pull = matches[0];
  requireValue(latest.id === proof.processing.id && latest.analysisId === proof.processing.analysisId &&
    tasks.filter((entry) => Date.parse(entry.executedAt) === Date.parse(latest.executedAt)).length === 1 &&
    pull.commit?.sha === input.sourceSha && date(pull.analysisDate) &&
    Date.parse(pull.analysisDate) >= Date.parse(input.startedAt) &&
    Date.parse(pull.analysisDate) <= Date.parse(proof.processing.executedAt) &&
    pull.url === `https://github.com/${input.repository}/pull/${input.pullRequest}`,
  "Sonar facts are not the latest successful task and exact actual source of this PR");
  return { analysisId: latest.analysisId, taskId: latest.id,
    sourceSha: pull.commit.sha, analysisDate: pull.analysisDate };
}

export async function verifyFacts(context, input, proof, tracked, read, now = Date.now) {
  const { policyDigest, ...material } = context ?? {};
  requireValue(context?.visibility === "public" && context.sonar?.status === "eligible" &&
    createHash("sha256").update(JSON.stringify(material)).digest("hex") === policyDigest &&
    context.repository === input.repository && context.repositoryId === input.repositoryId &&
    proof?.sourceSha === input.sourceSha && proof.projectKey === input.projectKey &&
    proof.policyDigest === context.policyDigest && proof.run?.id === input.runId &&
    proof.run.attempt === input.attempt && proof.processing?.status === "completed" &&
    proof.publication?.id === proof.processing.analysisId && date(proof.processing.executedAt),
  "Sonar source/finding facts require this live public, current-source completed producer");
  const deadline = now() + 120000;
  const request = async (route) => {
    const remaining = deadline - now();
    requireValue(remaining > 0, "Sonar source/finding verification exceeded its two-minute deadline");
    const result = await read(route, Math.min(30000, remaining));
    requireValue(now() < deadline, "Sonar source/finding verification exceeded its two-minute deadline");
    return result;
  };
  const scope = input.pullRequest === null ? { branch: input.branch } : { pullRequest: String(input.pullRequest) };
  const snapshot = async () => {
    if (input.pullRequest === null) {
      const parameters = new URLSearchParams({ project: input.projectKey, branch: input.branch, ps: "2" });
      return branchSnapshot(await request(`/api/project_analyses/search?${parameters}`), input, proof);
    }
    const pulls = new URLSearchParams({ project: input.projectKey });
    const activity = new URLSearchParams({ component: input.projectKey, status: "SUCCESS", type: "REPORT", ps: "1000" });
    return pullSnapshot(await request(`/api/project_pull_requests/list?${pulls}`),
      await request(`/api/ce/activity?${activity}`), input, proof);
  };
  const before = await snapshot();
  const files = [];
  let total = null;
  for (let page = 1; total === null || files.length < total; page++) {
    const parameters = new URLSearchParams({ component: input.projectKey, ...scope,
      qualifiers: "FIL", strategy: "leaves", s: "path", p: String(page), ps: String(PAGE_SIZE) });
    const payload = await request(`/api/components/tree?${parameters}`);
    total = filePage(payload, input.projectKey, page, total);
    files.push(...payload.components);
  }
  const capabilities = context.profile.languages.filter((value) => Object.values(LANGUAGES).includes(value));
  const coverage = countedFiles(files, tracked, capabilities, input.projectKey);
  const parameters = new URLSearchParams({ componentKeys: input.projectKey, ...scope,
    resolved: "false", p: "1", ps: "1" });
  const findingCount = findingTotal(await request(`/api/issues/search?${parameters}`), input.projectKey);
  const after = await snapshot();
  requireValue(JSON.stringify(before) === JSON.stringify(after),
    "Sonar analysis changed while verifying source/finding facts");
  return { schema: "repository-analysis-sonar-facts-v1", ...coverage, findingCount,
    snapshot: before, verifiedAt: new Date(now()).toISOString() };
}

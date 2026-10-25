const sensitivePath = name => /(?:^|\/)(?:\.terraform-version|\.terraform\.lock\.hcl|\.tool-versions|\.?mise\.toml|\.terraformrc|terraform\.rc)$/.test(name) ||
  /\.(?:tf|tf\.json|tfvars|tfvars\.json|tfbackend|hcl)$/.test(name);
const workflowPath = name => /^\.github\/workflows\/.*\.ya?ml$/.test(name) || /(?:^|\/)action\.ya?ml$/.test(name);
function multilineVersionChanged(patch) {
  let terraformIndent;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) { terraformIndent = undefined; continue; }
    const content = line.slice(1);
    const changed = /^[+-]/.test(line);
    const key = content.match(/^(\s*)['"]?terraform[_-]version['"]?\s*:/i);
    if (key) {
      if (changed) return true;
      terraformIndent = key[1].length;
      continue;
    }
    if (!content.trim()) continue;
    const indent = content.match(/^\s*/)[0].length;
    if (terraformIndent !== undefined && indent <= terraformIndent) terraformIndent = undefined;
    if (changed && terraformIndent !== undefined) return true;
    if (changed && /^\s+['"]?\d+\.\d+\.\d+['"]?\s*$/.test(content)) {
      throw new Error('Ambiguous multiline workflow version diff');
    }
  }
  return false;
}
function requiresReview(file) {
  const names = [file.filename, file.previous_filename].filter(Boolean);
  if (names.some(sensitivePath)) return true;
  if (names.some(workflowPath)) {
    if (typeof file.patch !== 'string') throw new Error('Workflow diff unavailable');
    const changed = file.patch.split('\n').filter(line => /^[+-](?![+-])/.test(line));
    if (!Number.isInteger(file.additions) || !Number.isInteger(file.deletions) ||
        changed.filter(line => line.startsWith('+')).length !== file.additions ||
        changed.filter(line => line.startsWith('-')).length !== file.deletions) {
      throw new Error('Workflow diff incomplete');
    }
    if (multilineVersionChanged(file.patch)) return true;
    return file.patch.split('\n').some(line => /^[+-](?![+-])/.test(line) &&
      (/(?:[^@\s'"]*\/terraform-[^@\s'"]*|hashicorp\/setup-terraform)@/i.test(line) ||
       /\bterraform[_-]version\b/i.test(line)));
  }
  return false;
}
async function terraformGuard(github, context) {
  const params = { owner: context.repo.owner, repo: context.repo.repo, pull_number: context.issue.number };
  try {
    const start = (await github.rest.pulls.get(params)).data;
    if (!Number.isInteger(start.changed_files) || start.changed_files < 1 || start.changed_files > 3000 ||
        !start.head?.sha || !start.base?.sha) throw new Error('Incomplete pull request file identity');
    const files = [];
    let complete = false;
    for (let page = 1; page <= 30; page++) {
      const response = await github.rest.pulls.listFiles({ ...params, per_page: 100, page });
      if (!Array.isArray(response.data) || response.data.length > 100) throw new Error('Invalid file page');
      files.push(...response.data);
      if (files.length > start.changed_files) throw new Error('File count changed');
      if (response.data.length < 100 || files.length === start.changed_files) {
        complete = true;
        break;
      }
    }
    if (!complete || files.length !== start.changed_files ||
        new Set(files.map(file => file.filename)).size !== files.length ||
        files.some(file => typeof file.filename !== 'string' || !file.filename)) throw new Error('Incomplete file pagination');
    const blocked = files.some(requiresReview);
    const end = (await github.rest.pulls.get(params)).data;
    if (end.head?.sha !== start.head.sha || end.base?.sha !== start.base.sha || end.changed_files !== start.changed_files) {
      throw new Error('Pull request changed during inspection');
    }
    return blocked
      ? { blocked: true, code: 'terraform_manual_review', reason: 'Terraform configuration, lock, pin or toolchain/action changes require manual review, regardless of labels or update type.' }
      : { blocked: false };
  } catch {
    return { blocked: true, code: 'changed_files_unavailable', reason: 'Complete immutable changed-file evidence is unavailable; auto-merge is blocked for manual review.' };
  }
}
async function enforceTerraformGuard(github, context) {
  const guard = await terraformGuard(github, context);
  if (!guard.blocked) return guard;
  const params = { owner: context.repo.owner, repo: context.repo.repo, pull_number: context.issue.number };
  const pr = (await github.rest.pulls.get(params)).data;
  if (!Object.hasOwn(pr, 'auto_merge')) throw new Error('Unable to verify existing auto-merge state');
  if (pr.auto_merge !== null) {
    if (!pr.node_id) throw new Error('Missing pull request identity for auto-merge revocation');
    await github.graphql(`mutation($id: ID!) {
      disablePullRequestAutoMerge(input: {pullRequestId: $id}) { pullRequest { id } }
    }`, { id: pr.node_id });
    const verified = (await github.rest.pulls.get(params)).data;
    if (verified.auto_merge !== null) throw new Error('Unable to verify auto-merge revocation');
    guard.reason += ' Existing auto-merge was revoked.';
  }
  return guard;
}
module.exports = { terraformGuard, enforceTerraformGuard, requiresReview };

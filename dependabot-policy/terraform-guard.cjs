const sensitivePath = name => /(?:^|\/)(?:\.terraform-version|\.terraform\.lock\.hcl|\.tool-versions|\.?mise\.toml|\.terraformrc|terraform\.rc)$/.test(name) ||
  /\.(?:tf|tf\.json|hcl)$/.test(name);
const workflowPath = name => /^\.github\/workflows\/.*\.ya?ml$/.test(name) || /(?:^|\/)action\.ya?ml$/.test(name);
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
    return file.patch.split('\n').some(line => /^[+-](?![+-])/.test(line) &&
      (/\buses:\s*['"]?(?:[^@\s'"]*\/terraform-[^@\s'"]*|hashicorp\/setup-terraform)@/i.test(line) ||
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
module.exports = { terraformGuard, requiresReview };

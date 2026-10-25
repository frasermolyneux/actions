const test = require('node:test');
const assert = require('node:assert/strict');
const { terraformGuard, enforceTerraformGuard, requiresReview } = require('./terraform-guard.cjs');
const context = { repo: { owner: 'owner', repo: 'repo' }, issue: { number: 1 } };
const diff = (filename, patch) => ({
  filename, patch,
  additions: patch.split('\n').filter(line => line.startsWith('+')).length,
  deletions: patch.split('\n').filter(line => line.startsWith('-')).length
});
function client(files, override = {}) {
  const calls = [];
  const pr = { changed_files: files.length, head: { sha: 'head' }, base: { sha: 'base' } };
  return { calls, rest: { pulls: {
    get: async () => ({ data: { ...pr, ...override } }),
    listFiles: async ({ page, per_page }) => {
      calls.push(page);
      return { data: files.slice((page - 1) * per_page, page * per_page) };
    }
  } } };
}
test('Terraform files, locks, CLI pins, toolchains and renamed paths always require manual review', () => {
  for (const filename of ['terraform/main.tf', 'edge/main.tf.json', 'edge/.terraform.lock.hcl',
    'root/.terraform-version', '.tool-versions', '.mise.toml', 'mise.toml', 'terraform.rc',
    'terraform/tfvars/prd.tfvars', 'prd.auto.tfvars', 'prd.auto.tfvars.json']) {
    assert.equal(requiresReview({ filename }), true, filename);
    assert.equal(requiresReview({ filename: 'innocent.txt', previous_filename: filename }), true, filename);
  }
});
test('Terraform action ref changes are denied while unrelated workflow ref changes retain existing policy', () => {
  for (const action of ['frasermolyneux/actions/terraform-plan@terraform-plan/v2',
    'hashicorp/setup-terraform@abcdef', 'frasermolyneux/actions/terraform-setup@terraform-setup/v1']) {
    for (const filename of ['.github/workflows/ci.yml', 'terraform-setup/action.yml', 'action.yml']) {
      assert.equal(requiresReview(diff(filename, `+  - uses: ${action}`)), true);
      assert.equal(requiresReview(diff(filename, `@@ -1,2 +1,2 @@\n   uses: >-\n-    ${action}old\n+    ${action}`)), true);
    }
  }
  assert.equal(requiresReview(diff('.github/workflows/ci.yml', '+ - uses: actions/checkout@abcdef')), false);
  assert.throws(() => requiresReview({ filename: '.github/workflows/ci.yml' }), /diff unavailable/);
  assert.equal(requiresReview({ filename: 'package-lock.json' }), false);
});
test('blocked Terraform decisions revoke existing auto-merge and fail closed if revocation is unverifiable', async () => {
  const github = client([{ filename: 'terraform/main.tf' }]);
  let autoMerge = { enabled_by: { login: 'dependabot[bot]' } };
  const get = github.rest.pulls.get;
  github.rest.pulls.get = async () => ({ data: { ...(await get()).data, auto_merge: autoMerge, node_id: 'PR_node' } });
  let revocations = 0;
  github.graphql = async (query, variables) => {
    assert.match(query, /disablePullRequestAutoMerge/);
    assert.equal(variables.id, 'PR_node');
    revocations++;
    autoMerge = null;
  };
  assert.equal((await enforceTerraformGuard(github, context)).blocked, true);
  assert.equal(revocations, 1);
  await enforceTerraformGuard(github, context);
  assert.equal(revocations, 1);
  autoMerge = {};
  github.graphql = async () => { throw new Error('Permission denied'); };
  await assert.rejects(() => enforceTerraformGuard(github, context), /Permission denied/);
  github.graphql = async () => {};
  await assert.rejects(() => enforceTerraformGuard(github, context), /verify auto-merge revocation/);
  const unknown = client([{ filename: 'terraform/main.tf' }]);
  await assert.rejects(() => enforceTerraformGuard(unknown, context), /verify existing auto-merge/);
  const allowed = client([{ filename: 'package-lock.json' }]);
  assert.equal((await enforceTerraformGuard(allowed, context)).blocked, false);
});
test('all file pages are inspected, including Terraform after the first 100 files', async () => {
  const files = Array.from({ length: 201 }, (_, index) => ({ filename: `src/file${index}.js` }));
  files[200] = { filename: 'terraform/.terraform.lock.hcl' };
  const github = client(files);
  assert.equal((await terraformGuard(github, context)).code, 'terraform_manual_review');
  assert.deepEqual(github.calls, [1, 2, 3]);
});
test('truncation, missing diffs, API failures, duplicate pages and oversized PRs fail closed', async () => {
  for (const github of [
    client([{ filename: 'src/a.js' }], { changed_files: 101 }),
    client([{ filename: '.github/workflows/ci.yml' }]),
    client([{ ...diff('.github/workflows/ci.yml', '+ - uses: actions/checkout@abcdef'), additions: 2 }]),
    client([{ filename: 'src/a.js' }], { changed_files: 3001 }),
    client([{ filename: 'src/a.js' }, { filename: 'src/a.js' }])
  ]) {
    assert.equal((await terraformGuard(github, context)).code, 'changed_files_unavailable');
  }
  const github = client([{ filename: 'package-lock.json' }]);
  github.rest.pulls.listFiles = async () => { throw new Error('API unavailable'); };
  assert.equal((await terraformGuard(github, context)).blocked, true);
});
test('unrelated changes pass and changed head/base identity cannot authorize merge', async () => {
  const github = client([{ filename: 'package-lock.json' }]);
  assert.equal((await terraformGuard(github, context)).blocked, false);
  let calls = 0;
  github.rest.pulls.get = async () => ({ data: {
    changed_files: 1, head: { sha: ++calls === 1 ? 'old' : 'new' }, base: { sha: 'base' }
  } });
  assert.equal((await terraformGuard(github, context)).code, 'changed_files_unavailable');
});

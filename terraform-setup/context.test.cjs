const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { prepare, selections, observe, planIdentity, verifyPlan, sha256 } = require('./context.cjs');
const { receipt } = require('../terraform-receipt/receipt.cjs');
const lock = `provider "registry.terraform.io/hashicorp/random" {
  version = "3.7.2"
  hashes = ["zh:${'a'.repeat(64)}"]
}`;
function fixture(t, pin = '1.16.7') {
  const base = path.join(__dirname, 'generated-fixtures');
  fs.mkdirSync(base, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(base, 'repo-'));
  t.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    if (!fs.readdirSync(base).length) fs.rmdirSync(base);
  });
  const root = path.join(workspace, 'root with spaces');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, '.terraform-version'), `${pin}\n`);
  fs.writeFileSync(path.join(root, '.terraform.lock.hcl'), lock);
  const git = args => cp.execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture']);
  return { workspace, root, context: prepare(workspace, 'root with spaces'), git };
}
test('root pins must be exact, committed and agree with an optional assertion', t => {
  const { workspace, root, context } = fixture(t);
  assert.equal(context.rootDirectory, 'root with spaces');
  assert.equal(context.terraformVersion, '1.16.7');
  assert.match(context.sourceCommit, /^[a-f0-9]{40}$/);
  assert.throws(() => prepare(workspace, 'root with spaces', '1.17.0'), /exact stable version/);
  fs.writeFileSync(path.join(root, '.terraform-version'), 'latest');
  assert.throws(() => prepare(workspace, 'root with spaces'), /exact stable version/);
  fs.writeFileSync(path.join(root, '.terraform-version'), '1.17.0');
  assert.throws(() => prepare(workspace, 'root with spaces'), /Command failed/);
  fs.unlinkSync(path.join(root, '.terraform-version'));
  assert.throws(() => prepare(workspace, 'root with spaces'));
});
test('provider locks require canonical selected providers and real checksum syntax', () => {
  assert.deepEqual(selections(lock), { 'registry.terraform.io/hashicorp/random': '3.7.2' });
  for (const invalid of ['', '# no providers', lock.replace('3.7.2', '~>3.7'),
    lock.replace('registry.terraform.io/hashicorp/random', 'random'), lock.replace('zh:', 'invalid:')]) {
    assert.throws(() => selections(invalid));
  }
});
test('path escape and untracked/missing locks are rejected', t => {
  const { workspace, root, git } = fixture(t);
  assert.throws(() => prepare(workspace, '..'), /Path escapes/);
  fs.unlinkSync(path.join(root, '.terraform.lock.hcl'));
  assert.throws(() => prepare(workspace, 'root with spaces'));
  fs.writeFileSync(path.join(root, '.terraform.lock.hcl'), lock);
  git(['rm', '--cached', 'root with spaces/.terraform.lock.hcl']);
  assert.throws(() => prepare(workspace, 'root with spaces'));
});
test('clean native version JSON verifies pin, lock and initialized selections', t => {
  const { root, context } = fixture(t);
  const original = cp.execFileSync;
  let observedExecutable;
  let version = { terraform_version: '1.16.7', platform: 'linux_amd64', provider_selections: context.providerSelections };
  const binary = path.join(root, process.platform === 'win32' ? 'terraform-bin.exe' : 'terraform-bin');
  fs.writeFileSync(binary, '');
  cp.execFileSync = (command, args) => {
    if (command === 'which' || command === 'where.exe') return path.join(root, 'terraform');
    observedExecutable = command;
    assert.deepEqual(args, ['version', '-json']);
    return JSON.stringify(version);
  };
  t.after(() => { cp.execFileSync = original; });
  assert.equal(observe(context, true).platform, 'linux_amd64');
  assert.equal(observedExecutable, binary);
  version.provider_selections = {};
  assert.throws(() => observe(context, true), /Selected providers/);
  assert.doesNotThrow(() => observe(context, false));
  assert.deepEqual(observe(context, false).observedProviderSelections, {});
  version.terraform_version = '1.17.0';
  assert.throws(() => observe(context), /Installed Terraform/);
  version.terraform_version = '1.16.7';
  fs.writeFileSync(path.join(root, '.terraform.lock.hcl'), `${lock}\n`);
  assert.throws(() => observe(context), /lock changed/);
});
test('saved plans bind checkout, root, pin, lock, environment and binary hash before copying', t => {
  const { root, context } = fixture(t);
  const name = 'plan.tfplan';
  fs.writeFileSync(path.join(root, name), 'binary plan fixture');
  const identity = planIdentity(context, name, 'prd');
  const directory = path.join(root, 'saved');
  fs.mkdirSync(directory);
  fs.copyFileSync(path.join(root, name), path.join(directory, name));
  fs.writeFileSync(path.join(directory, '.terraform.lock.hcl'), lock);
  const metadata = path.join(directory, `${name}.metadata.json`);
  fs.writeFileSync(metadata, JSON.stringify(identity));
  verifyPlan(context, name, directory, 'prd');
  for (const key of ['sourceCommit', 'rootDirectory', 'terraformVersion', 'lockSha256', 'environment', 'planSha256']) {
    fs.writeFileSync(metadata, JSON.stringify({ ...identity, [key]: 'mismatch' }));
    assert.throws(() => verifyPlan(context, name, directory, 'prd'), /identity mismatch/);
  }
  fs.writeFileSync(metadata, JSON.stringify(identity));
  fs.writeFileSync(path.join(directory, name), 'tampered plan');
  assert.throws(() => verifyPlan(context, name, directory, 'prd'), /planSha256/);
  assert.throws(() => planIdentity(context, '../secret', 'prd'), /simple filename/);
});
test('receipts are allowlisted metadata, actual checkout identity and unique invocation ids', () => {
  const context = { sourceCommit: 'a'.repeat(40), rootDirectory: 'terraform', terraformVersion: '1.16.7',
    lockSha256: sha256(lock), providerSelections: selections(lock), platform: 'linux_amd64', root: '/secret/workspace' };
  const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
    GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/deploy.yml@refs/heads/main',
    GITHUB_WORKFLOW_SHA: 'b'.repeat(40), GITHUB_JOB: 'deploy', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
    TF_OPERATION: 'apply', TF_OUTCOME: 'success', TF_VAR_FILE: 'tfvars/prd.tfvars',
    ARM_CLIENT_SECRET: 'must-not-leak', TF_VAR_password: 'must-not-leak', GITHUB_SHA: 'c'.repeat(40) };
  const first = receipt(context, env);
  assert.equal(first.sourceCommit, context.sourceCommit);
  assert.equal(first.environment, 'prd');
  assert.equal(first.runAttempt, 2);
  assert.notEqual(first.executionId, receipt(context, env).executionId);
  assert.ok(!JSON.stringify(first).includes('must-not-leak'));
  assert.ok(!JSON.stringify(first).includes('/secret/workspace'));
  assert.equal(receipt(context, { ...env, TF_OUTCOME: 'failure' }).outcome, 'failure');
  assert.equal(receipt(context, { ...env, TF_PRODUCER_REVISION: 'd'.repeat(40) }).producerRevision, 'd'.repeat(40));
  assert.equal(receipt(context, { ...env, TF_PRODUCER_REVISION: 'terraform-plan/v2' }).producerRevision, undefined);
  assert.throws(() => receipt(context, { ...env, TF_OUTCOME: 'skipped' }));
});
test('native Terraform bootstrap, readonly init and local saved-plan execution preserve the genuine lock', {
  skip: process.env.TERRAFORM_NATIVE_TEST !== '1'
}, t => {
  const { workspace, root, git } = fixture(t, '1.17.0');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|APPDATA|LOCALAPPDATA|PATHEXT)$/i.test(key)));
  const terraform = args => cp.execFileSync('terraform', args, { cwd: root, encoding: 'utf8', env, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'main.tf'), `
terraform {
  required_version = ">= 1.15.6"
  required_providers {
    random = { source = "hashicorp/random", version = "= 3.7.2" }
  }
}
resource "random_id" "fixture" { byte_length = 4 }
output "fixture" { value = random_id.fixture.hex }
`);
  fs.unlinkSync(path.join(root, '.terraform.lock.hcl'));
  terraform(['init', '-backend=false', '-input=false', '-upgrade']);
  git(['add', 'root with spaces/.terraform.lock.hcl', 'root with spaces/main.tf']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Genuine provider lock']);
  const context = prepare(workspace, 'root with spaces');
  const before = fs.readFileSync(path.join(root, '.terraform.lock.hcl'));
  terraform(['init', '-backend=false', '-input=false', '-lockfile=readonly']);
  terraform(['validate']);
  terraform(['plan', '-input=false', '-out=plan.tfplan']);
  const identity = planIdentity(observe(context, true), 'plan.tfplan', 'test');
  const directory = path.join(root, 'saved-plan');
  fs.mkdirSync(directory);
  fs.copyFileSync(path.join(root, 'plan.tfplan'), path.join(directory, 'plan.tfplan'));
  fs.copyFileSync(path.join(root, '.terraform.lock.hcl'), path.join(directory, '.terraform.lock.hcl'));
  fs.writeFileSync(path.join(directory, 'plan.tfplan.metadata.json'), JSON.stringify(identity));
  verifyPlan(context, 'plan.tfplan', directory, 'test');
  terraform(['apply', '-input=false', '-auto-approve', 'plan.tfplan']);
  assert.equal(terraform(['state', 'list']).trim(), 'random_id.fixture');
  assert.ok(Object.hasOwn(JSON.parse(terraform(['output', '-json'])), 'fixture'));
  terraform(['destroy', '-input=false', '-auto-approve']);
  assert.deepEqual(fs.readFileSync(path.join(root, '.terraform.lock.hcl')), before);
  fs.writeFileSync(path.join(root, '.terraform.lock.hcl'), before.toString().replace('3.7.2', '0.0.0'));
  assert.throws(() => terraform(['init', '-backend=false', '-input=false', '-lockfile=readonly']));
});

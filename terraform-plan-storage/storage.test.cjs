const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { details, pack, unpack } = require('./storage.cjs');
const { planIdentity, verifyPlan, sha256 } = require('../terraform-setup/context.cjs');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-plan-storage-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'terraform root');
  const directory = path.join(base, 'context');
  fs.mkdirSync(path.join(root, '.terraform'), { recursive: true });
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(root, '.terraform', 'terraform.tfstate'),
    JSON.stringify({ backend: { type: 'azurerm', config: { storage_account_name: 'backend123' } } }));
  const lock = 'provider lock bytes';
  fs.writeFileSync(path.join(root, '.terraform.lock.hcl'), lock);
  fs.writeFileSync(path.join(root, 'plan.tfplan'), Buffer.alloc(2 * 1024 * 1024 + 17, 42));
  const context = { root, rootDirectory: 'terraform', sourceCommit: 'a'.repeat(40),
    terraformVersion: '1.2.3', lockSha256: sha256(lock) };
  fs.writeFileSync(path.join(root, 'plan.tfplan.metadata.json'),
    JSON.stringify(planIdentity(context, 'plan.tfplan', 'prod')));
  const env = { GITHUB_REPOSITORY: 'Owner/Repo', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
  return { base, root, directory, context, env };
}

test('effective initialized Azure backend and run-scoped identifier determine storage location', t => {
  const { root, directory, context, env } = fixture(t);
  const current = details(context, directory, 'plan.tfplan', 'matrix-prod', env);
  assert.equal(current.account, 'backend123');
  assert.match(current.blob, /^[a-f0-9]{64}\/123\/1\/[a-f0-9]{64}\.tfplanbundle$/);
  assert.equal(current.blob, details(context, directory, 'plan.tfplan', 'matrix-prod',
    { ...env, GITHUB_REPOSITORY: 'owner/repo' }).blob);
  for (const change of [{ GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_RUN_ID: '124' },
    { GITHUB_RUN_ATTEMPT: '2' }]) {
    assert.notEqual(current.blob, details(context, directory, 'plan.tfplan', 'matrix-prod', { ...env, ...change }).blob);
  }
  assert.notEqual(current.blob, details(context, directory, 'plan.tfplan', 'matrix-dev', env).blob);
  fs.mkdirSync(path.join(root, 'custom'));
  fs.writeFileSync(path.join(root, 'custom', 'terraform.tfstate'),
    JSON.stringify({ backend: { type: 'azurerm', config: { storage_account_name: 'other123' } } }));
  assert.equal(details(context, directory, 'plan.tfplan', 'id', { ...env, TF_DATA_DIR: 'custom' }).account, 'other123');
  for (const invalid of ['', '../plan', '.terraform.lock.hcl']) {
    assert.throws(() => details(context, directory, invalid, 'id', env));
  }
  assert.throws(() => details(context, directory, 'plan.tfplan', '', env), /identifier/);
  assert.throws(() => details(context, directory, 'plan.tfplan', 'id', { ...env, GITHUB_RUN_ID: '' }), /run and attempt/);
  fs.writeFileSync(path.join(root, '.terraform', 'terraform.tfstate'),
    JSON.stringify({ backend: { type: 'local', config: { storage_account_name: 'backend123' } } }));
  assert.throws(() => details(context, directory, 'plan.tfplan', 'id', env), /azurerm/);
  fs.writeFileSync(path.join(root, '.terraform', 'terraform.tfstate'),
    JSON.stringify({ backend: { type: 'azurerm', config: { storage_account_name: 'not-valid!' } } }));
  assert.throws(() => details(context, directory, 'plan.tfplan', 'id', env), /storage account/);
});

test('bundle round trip retains plan and lock and existing verification rejects altered identities', t => {
  const { root, directory, context, env } = fixture(t);
  const bundle = details(context, directory, 'plan.tfplan', 'id', env).bundle;
  pack(root, 'plan.tfplan', bundle);
  assert.throws(() => pack(root, 'plan.tfplan', bundle), /EEXIST/);
  const saved = path.join(directory, 'saved-plan');
  unpack(bundle, saved, 'plan.tfplan');
  assert.deepEqual(fs.readFileSync(path.join(saved, 'plan.tfplan')), fs.readFileSync(path.join(root, 'plan.tfplan')));
  assert.doesNotThrow(() => verifyPlan(context, 'plan.tfplan', saved, 'prod'));
  assert.throws(() => verifyPlan(context, 'plan.tfplan', saved, 'dev'), /environment/);
  assert.throws(() => verifyPlan({ ...context, sourceCommit: 'b'.repeat(40) }, 'plan.tfplan', saved, 'prod'), /sourceCommit/);
  fs.writeFileSync(path.join(saved, 'plan.tfplan'), 'tampered');
  assert.throws(() => verifyPlan(context, 'plan.tfplan', saved, 'prod'), /planSha256/);
  assert.throws(() => unpack(bundle, saved, 'plan.tfplan'), /EEXIST/);
});

test('bundle rejects corruption, truncation, trailing data and oversized metadata', t => {
  const { root, directory, env, context } = fixture(t);
  const bundle = details(context, directory, 'plan.tfplan', 'id', env).bundle;
  pack(root, 'plan.tfplan', bundle);
  const original = fs.readFileSync(bundle);
  const badMagic = Buffer.from(original);
  badMagic[0] = 0;
  const excessive = Buffer.from(original);
  excessive.writeBigUInt64BE(11n * 1024n * 1024n, 16);
  for (const [index, bytes] of [badMagic, original.subarray(0, original.length - 1),
    Buffer.concat([original, Buffer.from('extra')]), excessive].entries()) {
    fs.writeFileSync(bundle, bytes);
    assert.throws(() => unpack(bundle, path.join(directory, `bad-${index}`), 'plan.tfplan'), /Invalid saved plan bundle/);
  }
});

test('actual transfer step uploads, downloads and fails closed on blob errors', t => {
  const { root, directory, context, env, base } = fixture(t);
  fs.writeFileSync(path.join(directory, 'context.json'), JSON.stringify(context));
  const manifest = fs.readFileSync(path.join(__dirname, 'action.yml'), 'utf8').replace(/\r\n/g, '\n');
  const script = manifest.split('      run: |\n')[1].split('\n').map(line => line.replace(/^        /, '')).join('\n');
  const fakeAz = `
function az {
  $arguments = @($args)
  if ($env:MOCK_FAIL -eq '1') { $global:LASTEXITCODE = 1; return }
  $fileIndex = [array]::IndexOf($arguments, '--file')
  if ($fileIndex -lt 0 -or $arguments -notcontains 'login') { throw 'Incorrect blob arguments' }
  $file = $arguments[$fileIndex + 1]
  if ($arguments -contains 'upload') {
    if (Test-Path -LiteralPath $env:MOCK_BLOB) { $global:LASTEXITCODE = 1; return }
    Copy-Item -LiteralPath $file -Destination $env:MOCK_BLOB
  } elseif ($arguments -contains 'download') {
    if (-not (Test-Path -LiteralPath $env:MOCK_BLOB)) { $global:LASTEXITCODE = 1; return }
    Copy-Item -LiteralPath $env:MOCK_BLOB -Destination $file
  } else { throw 'Unexpected blob operation' }
  $global:LASTEXITCODE = 0
}
`;
  const run = (operation, overrides = {}) => cp.spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', fakeAz + script], {
    encoding: 'utf8',
    env: { ...process.env, ...env, TF_CONTEXT: directory, TF_PLAN: 'plan.tfplan',
      TF_PLAN_ID: 'matrix-prod', TF_STORAGE_OPERATION: operation,
      TF_STORAGE_SCRIPT: path.join(__dirname, 'storage.cjs'), MOCK_BLOB: path.join(base, 'blob'), ...overrides }
  });
  let result = run('upload');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(base, 'blob')));
  assert.ok(!fs.existsSync(path.join(directory, 'saved-plan.bundle')));
  result = run('upload');
  assert.notEqual(result.status, 0);
  assert.ok(!fs.existsSync(path.join(directory, 'saved-plan.bundle')));
  result = run('download', { MOCK_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.ok(!fs.existsSync(path.join(directory, 'saved-plan')));
  result = run('download');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(path.join(directory, 'saved-plan.bundle')));
  assert.doesNotThrow(() => verifyPlan(context, 'plan.tfplan', path.join(directory, 'saved-plan'), 'prod'));
  assert.equal(fs.readFileSync(path.join(root, 'plan.tfplan')).length, 2 * 1024 * 1024 + 17);
});

test('post-import plan passes filenames as literal arguments and propagates command failure', t => {
  const { base } = fixture(t);
  const manifest = fs.readFileSync(path.join(__dirname, '..', 'terraform-import', 'action.yml'), 'utf8').replace(/\r\n/g, '\n');
  const step = manifest.split('    - name: Terraform Plan (post-import)\n')[1].split('    - name: Post Terraform PR comment\n')[0];
  const script = step.split('      run: |\n')[1].split('      env:\n')[0]
    .split('\n').map(line => line.replace(/^        /, '')).join('\n');
  const variable = 'vars file"; $(echo injected >&2).tfvars';
  const plan = 'plan"; $(echo injected >&2).tfplan';
  const run = exitCode => cp.spawnSync('bash', ['-c',
    `terraform() { printf '<%s>\\n' "$@"; return ${exitCode}; }\n${script}`], {
    cwd: base, encoding: 'utf8',
    env: { ...process.env, RUNNER_TEMP: '.', TF_VAR_FILE: variable, TF_PLAN_FILE: plan }
  });
  const success = run(0);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stderr, '');
  assert.equal(success.stdout, `<plan>\n<-no-color>\n<-var-file=${variable}>\n<-out=${plan}>\n`);
  assert.equal(fs.readFileSync(path.join(base, 'tf-plan-output.txt'), 'utf8'), success.stdout);
  assert.equal(run(9).status, 9);
  assert.match(step, /TF_VAR_FILE: \$\{\{ inputs\.terraform-var-file \}\}/);
  assert.match(step, /TF_PLAN_FILE: \$\{\{ inputs\.plan-file-name \}\}/);
  assert.doesNotMatch(script, /\$\{\{\s*inputs\./);
});

test('all plan producers and split apply use the storage helper without plan artifact fallback', () => {
  const repo = path.join(__dirname, '..');
  for (const action of ['terraform-plan', 'terraform-plan-readonly', 'terraform-plan-and-apply', 'terraform-import']) {
    const manifest = fs.readFileSync(path.join(repo, action, 'action.yml'), 'utf8');
    assert.match(manifest, /terraform plan [^\n]*-out=/);
    assert.match(manifest, /save-plan/);
    assert.match(manifest, /uses: \$\/terraform-plan-storage/);
    assert.doesNotMatch(manifest, /actions\/upload-artifact@/);
    assert.ok(manifest.indexOf('save-plan') < manifest.indexOf('operation: upload'));
    if (action === 'terraform-plan-and-apply') assert.ok(manifest.indexOf('operation: upload') < manifest.indexOf('name: Terraform Apply'));
  }
  const apply = fs.readFileSync(path.join(repo, 'terraform-apply', 'action.yml'), 'utf8');
  assert.doesNotMatch(apply, /actions\/download-artifact@/);
  assert.ok(apply.indexOf('name: Terraform Init') < apply.indexOf('operation: download'));
  assert.ok(apply.indexOf('operation: download') < apply.indexOf('verify-plan'));
  assert.ok(apply.indexOf('verify-plan') < apply.indexOf('name: Terraform Apply'));
  const storage = fs.readFileSync(path.join(__dirname, 'action.yml'), 'utf8');
  assert.match(storage, /azure\/login@/);
  assert.match(storage, /--auth-mode login --overwrite false --if-none-match '\*'/);
  assert.match(storage, /--auth-mode login --only-show-errors/);
  assert.doesNotMatch(storage, /--account-key|--connection-string/);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const fmt = require('./format');

const secret = 'SYNTHETIC_SECRET_WORKLOAD';
const context = { repo: { owner: 'owner', repo: 'repo' }, issue: { number: 12 } };
const success = { outcome: 'success', exitcode: '0' };

function fakeGitHub() {
  const updates = [];
  const creates = [];
  const requests = [];
  const github = {
    rest: { issues: {
      listComments: () => { throw new Error('Existing comments must not be read'); },
      updateComment: () => { throw new Error('Existing comments must not be updated'); },
      createComment: async request => { creates.push(request); },
    } },
    paginate: () => { throw new Error('Existing comments must not be read'); },
  };
  return { github, updates, creates, requests };
}

test('comments include selected labels but not plan content or arbitrary text', () => {
  const options = {
    kind: 'plan', workflow: 'deploy', folder: 'infra/network', workspace: 'default',
    environment: 'production', title: secret, marker: secret,
    validate: { ...success, stdout: secret, stderr: secret },
    plan: { ...success, stderr: secret, stdout: [
      `  # module.test.resource["${secret}"] must be replaced`,
      `      value = "${secret}"`,
      'Plan: 2 to add, 3 to change, 1 to destroy.',
      '╷', `│ Warning: Deprecated ${secret}`, `│ Error: ${secret}`, '╵',
    ].join('\n') },
    apply: { outcome: 'failure', exitcode: secret, stderr: secret },
  };
  const body = fmt.buildComment(options);
  assert.doesNotMatch(body, /<!--|[a-f0-9]{64}/);
  assert.ok(!body.includes(secret));
  assert.match(body, /\*\*Validate: Passed\*\*/);
  assert.match(body, /\*\*Plan: Passed\*\*/);
  assert.match(body, /\*\*Apply: Failed\*\*/);
  assert.match(body, /\*\*Warning: Destructive changes are planned\.\*\*/);
  for (const [label, count] of [['Add', 2], ['Change', 3], ['Destroy', 1]]) {
    assert.ok(body.includes(`| ${label} | ${count} |`));
  }
  assert.doesNotMatch(body, /Resource|Deprecated|stderr/);
  assert.match(body, /\*\*Workflow:\*\*/);
  assert.match(body, /\*\*Terraform folder:\*\*/);
  assert.match(body, /\*\*Workspace:\*\*/);
  assert.match(body, /\*\*Target environment:\*\*/);
});

test('unavailable, failed, malformed, ambiguous and diagnostic output never becomes raw comment text', () => {
  for (const output of [null, '', secret, `Warning: ${secret}\nPlan: 9 to add, 8 to change, 7 to destroy.`,
    `Error: ${secret}\nPlan: 9 to add, 8 to change, 7 to destroy.`,
    `│ Warning: ${secret}\nPlan: 9 to add, 8 to change, 7 to destroy.`,
    `╷\n│ Warning: ${secret}\nPlan: 9 to add, 8 to change, 7 to destroy.\n╵`,
    `Plan: 1 to add, 0 to change, 0 to destroy.\nPlan: 9 to add, 8 to change, 7 to destroy.`,
    `Plan: 9007199254740992 to add, 0 to change, 1 to destroy.`]) {
    const body = fmt.buildComment({ kind: 'plan', plan: { ...success, stdout: output } });
    assert.match(body, /\*\*Plan summary: Unavailable\*\*/);
    assert.ok(!body.includes(secret));
    assert.doesNotMatch(body, /\| Destroy \|/);
  }
  for (const plan of [
    { outcome: 'failure', exitcode: '0', stdout: secret, stderr: secret },
    { outcome: 'success', exitcode: '', stdout: secret },
    { outcome: 'failure', exitcode: '1', stdout: `Plan: 0 to add, 0 to change, 8 to destroy.\n${secret}` },
  ]) {
    const body = fmt.buildComment({ kind: 'import', validate: { outcome: 'failure', exitcode: secret }, plan });
    assert.match(body, /\*\*Validate: Failed\*\*/);
    assert.match(body, /\*\*Plan: Failed\*\*/);
    assert.ok(!body.includes(secret));
    assert.doesNotMatch(body, /\| Destroy \|/);
  }
  assert.deepEqual(fmt.parsePlanSummary(`╷\n│ Warning: ${secret}\n╵\nPlan: 0 to add, 1 to change, 0 to destroy.`),
    { add: 0, change: 1, destroy: 0 });
  assert.deepEqual(fmt.parsePlanSummary('No changes. Your infrastructure matches the configuration.'),
    { add: 0, change: 0, destroy: 0 });
  assert.equal(fmt.readOutputFile(path.join(__dirname, 'missing-synthetic-plan-output')), null);
});

test('indented heredoc diagnostics and fake summaries do not hide the real destructive plan', () => {
  const output = [
    '  # example.payload must be replaced',
    '  ~ resource "example" "payload" {',
    '      text = <<-EOT',
    '        Warning: this is application content',
    '        Error: this is also application content',
    '        Plan: 0 to add, 0 to change, 0 to destroy.',
    '        ╷',
    '        ╵',
    '      EOT',
    '    }',
    'Plan: 1 to add, 0 to change, 1 to destroy.',
  ].join('\n');
  assert.deepEqual(fmt.parsePlanSummary(output), { add: 1, change: 0, destroy: 1 });
  const body = fmt.buildComment({ kind: 'plan', plan: { ...success, stdout: output } });
  assert.match(body, /Destructive changes are planned/);
  assert.match(body, /\| Destroy \| 1 \|/);
  assert.doesNotMatch(body, /application content/);
});

test('comments have no marker and render context labels safely', () => {
  const base = { kind: 'plan', plan: { ...success, stdout: 'No changes. Your infrastructure matches the configuration.' } };
  const body = fmt.buildComment(base);
  assert.equal(body, fmt.buildComment({ ...base, varFile: `tfvars/${secret}.tfvars`, marker: secret }));
  assert.doesNotMatch(body, /<!--|[a-f0-9]{64}/);
  assert.throws(() => fmt.buildComment({ kind: secret }), /Unsupported/);
  const injected = fmt.buildComment({ ...base, workflow: '@example\n<script>', folder: 'infra/x',
    workspace: 'dev`</code><!--', environment: 'prod' });
  assert.doesNotMatch(injected, /@example|<script>|<!--|dev`/);
  assert.match(injected, /&#64;&#101;&#120;&#97;&#109;&#112;&#108;&#101;/);
  assert.match(injected, /\*\*Target environment:\*\* <code>&#112;&#114;&#111;&#100;<\/code>/);
  assert.match(fmt.buildComment({ ...base, folder: 'x'.repeat(257) }), /\(truncated\)/);
});

test('workspace selection and target environment follow Terraform settings without changing them', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-comment-workspace-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'infra');
  fs.mkdirSync(path.join(root, '.terraform'), { recursive: true });
  const env = { GITHUB_WORKSPACE: base, TF_COMMENT_FOLDER: 'infra' };
  assert.equal(fmt.workspaceName('', env), 'default');
  fs.writeFileSync(path.join(root, '.terraform', 'environment'), 'selected\n');
  assert.equal(fmt.workspaceName('', env), 'selected');
  assert.equal(fmt.workspaceName('', { ...env, TF_WORKSPACE: 'env-workspace' }), 'env-workspace');
  assert.equal(fmt.workspaceName('explicit', { ...env, TF_WORKSPACE: 'env-workspace' }), 'explicit');
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'environment'), 'custom');
  assert.equal(fmt.workspaceName('', { ...env, TF_DATA_DIR: 'data' }), 'custom');
  assert.equal(fmt.workspaceName('', {}), '');
  assert.equal(fmt.environmentName('override', 'tfvars/dev.tfvars'), 'override');
  assert.equal(fmt.environmentName('', 'tfvars\\production.tfvars'), 'production');
  assert.equal(fmt.environmentName('', ''), '');
});

test('matrix runs append independent comments without reading or updating old bodies', async () => {
  const options = { kind: 'plan', workflow: 'deploy', folder: 'terraform/network',
    workspace: 'default', environment: 'prod',
    plan: { ...success, stdout: `# sensitive["${secret}"] will be destroyed\nPlan: 0 to add, 0 to change, 1 to destroy.` } };
  const api = fakeGitHub();
  await fmt.postComment(api.github, context, options);
  await fmt.postComment(api.github, context, { ...options, folder: 'terraform/app',
    plan: { ...success, stdout: 'Plan: 2 to add, 0 to change, 0 to destroy.' } });
  await fmt.postComment(api.github, context, { ...options, environment: 'test',
    plan: { ...success, stdout: 'Plan: 1 to add, 0 to change, 0 to destroy.' } });
  assert.equal(api.requests.length, 0);
  assert.equal(api.updates.length, 0);
  assert.equal(api.creates.length, 3);
  assert.match(api.creates[0].body, /\| Destroy \| 1 \|/);
  assert.match(api.creates[1].body, /\| Add \| 2 \|/);
  const rendered = api.creates.map(request => request.body.replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value))));
  assert.match(rendered[0], /Terraform folder:\*\* <code>terraform\/network<\/code>/);
  assert.match(rendered[1], /Terraform folder:\*\* <code>terraform\/app<\/code>/);
  assert.match(rendered[0], /Target environment:\*\* <code>prod<\/code>/);
  assert.match(rendered[2], /Target environment:\*\* <code>test<\/code>/);
  for (const request of api.creates) {
    assert.ok(!request.body.includes(secret));
    assert.doesNotMatch(request.body, /<!--|[a-f0-9]{64}/);
  }
});

test('each action comment script wires only intended context and plan status inputs', () => {
  for (const [name, kind] of [['terraform-plan', 'plan'], ['terraform-plan-readonly', 'plan-readonly'],
    ['terraform-plan-and-apply', 'plan-and-apply'], ['terraform-import', 'import']]) {
    const manifest = fs.readFileSync(path.join(__dirname, '..', name, 'action.yml'), 'utf8').replace(/\r\n/g, '\n');
    assert.match(manifest, /pr-comment-workspace:/);
    assert.doesNotMatch(manifest, /pr-comment-(?:expand-summary-details|highlight-changes)/);
    const comment = manifest.split('    - name: Post Terraform PR comment\n')[1].split('\n    - name: ')[0];
    const script = comment.split('        script: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
    assert.match(script, new RegExp(`kind: '${kind}'`));
    assert.doesNotMatch(comment, /VALIDATE_STDOUT|VALIDATE_STDERR|PLAN_STDERR/);
    assert.match(comment, /TF_COMMENT_FOLDER: \$\{\{ inputs\.terraform-folder \}\}/);
    assert.match(comment, /TF_COMMENT_WORKSPACE: \$\{\{ inputs\.pr-comment-workspace \}\}/);
    assert.match(comment, /TF_COMMENT_ENVIRONMENT: \$\{\{ inputs\.terraform-environment \}\}/);
    assert.match(comment, /TF_COMMENT_VAR_FILE: \$\{\{ inputs\.terraform-var-file \}\}/);
    assert.match(script, /workflow: process\.env\.GITHUB_WORKFLOW/);
    assert.match(script, /folder: process\.env\.TF_COMMENT_FOLDER/);
    assert.match(script, /workspace: fmt\.workspaceName\(process\.env\.TF_COMMENT_WORKSPACE, process\.env\)/);
    assert.match(script, /environment: fmt\.environmentName\(process\.env\.TF_COMMENT_ENVIRONMENT, process\.env\.TF_COMMENT_VAR_FILE\)/);
    assert.match(script, /stdout: fmt\.readOutputFile\(process\.env\.PLAN_OUTPUT_FILE\)/);
    assert.match(script, /exitcode: process\.env\.PLAN_EXITCODE/);
    assert.match(script, /outcome: process\.env\.PLAN_OUTCOME/);
    assert.match(script, /await fmt\.postComment\(github, context,/);
  }
});

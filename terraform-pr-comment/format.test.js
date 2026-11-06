const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('comments contain fixed status and counts, never resource, diagnostic, input or custom text', () => {
  const options = {
    kind: 'plan', varFile: `tfvars/${secret}.tfvars`, workspace: secret,
    title: secret, marker: secret, environment: secret,
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

test('comments have no marker or input-derived identifier', () => {
  const base = { kind: 'plan', plan: { ...success, stdout: 'No changes. Your infrastructure matches the configuration.' } };
  const body = fmt.buildComment(base);
  assert.equal(body, fmt.buildComment({ ...base, varFile: `tfvars/${secret}.tfvars`, workspace: secret, marker: secret }));
  assert.doesNotMatch(body, /<!--|[a-f0-9]{64}/);
  assert.throws(() => fmt.buildComment({ kind: secret }), /Unsupported/);
});

test('matrix runs append independent comments without reading or updating old bodies', async () => {
  const options = { kind: 'plan', varFile: `tfvars/${secret}.tfvars`, workspace: secret,
    plan: { ...success, stdout: `# sensitive["${secret}"] will be destroyed\nPlan: 0 to add, 0 to change, 1 to destroy.` } };
  const api = fakeGitHub();
  await fmt.postComment(api.github, context, options);
  await fmt.postComment(api.github, context, { ...options, workspace: 'other', varFile: 'tfvars/other.tfvars',
    plan: { ...success, stdout: 'Plan: 2 to add, 0 to change, 0 to destroy.' } });
  assert.equal(api.requests.length, 0);
  assert.equal(api.updates.length, 0);
  assert.equal(api.creates.length, 2);
  assert.match(api.creates[0].body, /\| Destroy \| 1 \|/);
  assert.match(api.creates[1].body, /\| Add \| 2 \|/);
  for (const request of api.creates) {
    assert.ok(!request.body.includes(secret));
    assert.doesNotMatch(request.body, /<!--|[a-f0-9]{64}/);
  }
});

test('each action comment script sends only allowlisted bodies on success and failure', async () => {
  for (const [name, kind] of [['terraform-plan', 'plan'], ['terraform-plan-readonly', 'plan-readonly'],
    ['terraform-plan-and-apply', 'plan-and-apply'], ['terraform-import', 'import']]) {
    const manifest = fs.readFileSync(path.join(__dirname, '..', name, 'action.yml'), 'utf8').replace(/\r\n/g, '\n');
    const comment = manifest.split('    - name: Post Terraform PR comment\n')[1].split('\n    - name: ')[0];
    const script = comment.split('        script: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
    assert.match(script, new RegExp(`kind: '${kind}'`));
    assert.doesNotMatch(comment, /VALIDATE_STDOUT|VALIDATE_STDERR|PLAN_STDERR|TF_WORKSPACE|TF_VAR_FILE/);
    const execute = new Function('require', 'process', 'github', 'context',
      `return (async () => { ${script} })();`);
    for (const outcome of ['success', 'failure']) {
      const api = fakeGitHub();
      const shim = { ...fmt, readOutputFile: () => `# resource["${secret}"] must be replaced\nPlan: 1 to add, 0 to change, 1 to destroy.\nWarning: ${secret}` };
      await execute(() => shim, { env: {
        TF_WORKSPACE: secret, TF_VAR_FILE: `tfvars/${secret}.tfvars`, PLAN_OUTPUT_FILE: secret,
        PLAN_OUTCOME: outcome, PLAN_EXITCODE: outcome === 'success' ? '0' : '1',
        VALIDATE_OUTCOME: outcome, VALIDATE_EXITCODE: outcome === 'success' ? '0' : '1',
        PLAN_STDERR: secret, VALIDATE_STDERR: secret,
      } }, api.github, context);
      assert.equal(api.creates.length, 1, name);
      assert.equal(api.updates.length, 0, name);
      for (const request of [...api.creates, ...api.updates]) assert.ok(!request.body.includes(secret), name);
      assert.doesNotMatch(api.creates[0].body, /<!--|[a-f0-9]{64}/);
      assert.match(api.creates[0].body, outcome === 'success' ? /Plan: Passed/ : /Plan: Failed/);
      if (outcome === 'success') assert.match(api.creates[0].body, /Destructive changes are planned/);
      else assert.doesNotMatch(api.creates[0].body, /Destructive changes are planned/);
    }
  }
});

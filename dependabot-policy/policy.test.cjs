'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { evaluateAuthor } = require('./policy.cjs');

test('approved bot logins are eligible and legacy Dependabot identity stays specific', () => {
  for (const [user, isDependabot] of [
    [{ login: 'dependabot[bot]' }, 'true'],
    [{ login: 'mx-io-idp-bot[bot]', type: 'Bot' }, 'false'],
    [{ login: 'mx-io-idp-bot', type: 'Bot' }, 'false']
  ]) {
    const result = evaluateAuthor(user);
    assert.equal(result.is_dependabot, isDependabot);
    assert.equal(result.is_eligible_author, 'true');
    assert.equal(result.auto_merge_allowed, 'true');
    assert.equal(result.policy_code, 'eligible_author');
  }
});

test('unknown, missing and unapproved authors are ineligible', () => {
  for (const user of [undefined, null, {}, { login: 'someone' },
    { login: 'mx-io-idp-bot', type: 'User' }, { login: 'dependabot' },
    { login: 'dependabot[bot]-impostor' }]) {
    const result = evaluateAuthor(user);
    assert.equal(result.is_eligible_author, 'false');
    assert.equal(result.auto_merge_allowed, 'false');
    assert.equal(result.policy_code, 'ineligible_author');
  }
});

test('actual action script ignores update metadata and changed-file evidence', async () => {
  const action = fs.readFileSync(path.join(__dirname, 'action.yml'), 'utf8');
  const match = action.match(/        script: \|\r?\n((?:          .*\r?\n)+)/);
  assert.ok(match, 'action script must be present');
  const script = match[1].split(/\r?\n/).map(line => line.slice(10)).join('\n');
  const run = new (Object.getPrototypeOf(async function () {}).constructor)(
    'require', 'context', 'core', 'process', script
  );
  const cases = [
    { updateType: 'version-update:semver-patch', files: ['package-lock.json'] },
    { updateType: 'version-update:semver-minor', files: ['main.tf'] },
    { updateType: 'version-update:semver-major', files: ['.terraform.lock.hcl'] },
    { updateType: 'security-update:semver-major', files: ['.github/workflows/terraform.yml'] },
    { updateType: 'security-update:semver-patch', files: ['.tool-versions'] },
    { updateType: 'security-update:semver-minor', files: ['terraform/action.yml'] },
    {}
  ];
  for (const login of ['dependabot[bot]', 'mx-io-idp-bot[bot]']) {
    for (const evidence of cases) {
      const outputs = {};
      await run(require, { payload: { pull_request: {
        user: { login }, update_type: evidence.updateType, changed_files: evidence.files
      } } }, { info() {}, setOutput(name, value) { outputs[name] = value; } },
      { env: { POLICY_ACTION_PATH: __dirname } });
      assert.equal(outputs.auto_merge_allowed, 'true', `${login}: ${JSON.stringify(evidence)}`);
      assert.equal(outputs.update_type, 'unknown');
      assert.equal(outputs.dependency_names, 'unknown');
      assert.equal(outputs.major_label_applied, 'false');
    }
  }
});

test('consumer enables auto-merge for either eligible author without bypassing checks', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'dependabot-automerge.yml'), 'utf8');
  assert.match(workflow, /needs\.auto-merge-policy\.outputs\.auto_merge_allowed == 'true'/);
  assert.match(workflow, /gh pr merge --auto --squash --match-head-commit/);
  assert.doesNotMatch(workflow, /--admin/);
});

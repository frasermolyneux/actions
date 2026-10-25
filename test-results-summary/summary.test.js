'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { marker, validateReport, normalize, publish } = require('./summary');

const passing = { schema: 1, suite: 'Unit', status: 'passed', reason: 'completed', total: 2, executed: 2,
  passed: 2, failed: 0, skipped: 0, durationSeconds: 1.5, artifactId: '123' };
const jobs = result => JSON.stringify({ build: { result, outputs: { test_report: JSON.stringify(passing) } } });

test('validates counters and strips untrusted extra fields', () => {
  assert.deepEqual(validateReport({ ...passing, unsafe: '@someone' }), passing);
  for (const overrides of [{ passed: 0 }, { failed: 1 }, { suite: '@someone' }, { durationSeconds: Infinity }, { executed: 0 }, { schema: 2 }]) {
    assert.equal(validateReport({ ...passing, ...overrides }), null);
  }
});

test('job failures override passing test results', () => {
  assert.equal(normalize(jobs('failure'))[0].reason, 'job-failed');
  assert.equal(normalize(jobs('cancelled'))[0].status, 'cancelled');
  assert.equal(normalize(jobs('skipped'))[0].status, 'not-run');
});

test('missing and malformed outputs are explicit non-success reports', () => {
  for (const outputs of [{}, { test_report: '' }, { test_report: '{bad' }]) {
    assert.equal(normalize(JSON.stringify({ build: { result: 'success', outputs } }))[0].status, 'invalid');
  }
  for (const text of ['{}', '[]', 'null', '{bad', 'x'.repeat(131073)]) assert.throws(() => normalize(text));
});

test('supports multiple named reports without duplicating unrelated outputs', () => {
  const result = normalize(JSON.stringify({ build: { result: 'success', outputs: {
    test_report: JSON.stringify(passing), integration_test_report: JSON.stringify({ ...passing, suite: 'Integration' }),
    build_version: '1.0.0',
  } } }));
  assert.deepEqual(result.map(report => report.suite), ['Unit', 'Integration']);
});

function setup(t, { event = 'pull_request', actor = 'developer', author = 'developer', repo = 'owner/repo', comments = [], latest } = {}) {
  const previous = { ...process.env };
  const environment = {
    TEST_SUMMARY_JOBS: jobs('success'), TEST_SUMMARY_PUBLISH: 'true', TEST_SUMMARY_EVIDENCE: 'false',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/build.yml@refs/heads/main', GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
  };
  Object.assign(process.env, environment);
  t.after(() => {
    for (const key of Object.keys(environment)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const calls = [];
  const context = { repo: { owner: 'owner', repo: 'repo' }, sha: 'a'.repeat(40), runId: 100, eventName: event, actor,
    ref: 'refs/heads/main', job: 'test-results',
    payload: { pull_request: { number: 3, head: { sha: 'b'.repeat(40), repo: { full_name: repo } }, user: { login: author } } } };
  const core = { setOutput: (name, value) => calls.push(['output', value, name]), info() {}, warning() {},
    summary: { addRaw(body) { calls.push(['summary', body]); return this; }, async write() {} } };
  const github = { paginate: async () => comments, rest: {
    pulls: { get: async () => { calls.push(['get']); return { data: latest || { state: 'open', head: { sha: context.payload.pull_request.head.sha } } }; } },
    issues: { listComments() {}, createComment: async value => calls.push(['create', value]),
      updateComment: async value => calls.push(['update', value]) },
  } };
  return { calls, context, core, github };
}

test('retains only sanitized suites with exact run-attempt and workflow identity', async t => {
  const fixture = setup(t, { event: 'push' });
  process.env.TEST_SUMMARY_EVIDENCE = 'true';
  process.env.GITHUB_RUN_ATTEMPT = '2';
  process.env.TEST_SUMMARY_JOBS = JSON.stringify({ build: { result: 'failure',
    outputs: { test_report: JSON.stringify({ ...passing, secret: 'must-not-retain' }), unrelated: 'must-not-retain' } } });
  await publish(fixture);
  const file = fixture.calls.find(call => call[2] === 'evidence-path')[1];
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(path.dirname(file)); });
  const text = fs.readFileSync(file, 'utf8');
  const evidence = JSON.parse(text);
  assert.equal(evidence.repository, 'owner/repo');
  assert.equal(evidence.runId, '100');
  assert.equal(evidence.attempt, 2);
  assert.equal(evidence.workflowSha, 'a'.repeat(40));
  assert.equal(evidence.originSha, fixture.context.sha);
  assert.equal(evidence.reports[0].status, 'failed');
  assert.equal(evidence.reports[0].reason, 'job-failed');
  assert.equal(evidence.reports[0].artifactId, '123');
  assert.ok(!text.includes('must-not-retain'));
  assert.ok(Buffer.byteLength(text) <= 49152);
  assert.ok(!fixture.calls.some(([name]) => ['create', 'update'].includes(name)));
});

test('evidence publication fails explicitly for missing or mismatched workflow identity', async t => {
  const fixture = setup(t);
  process.env.TEST_SUMMARY_EVIDENCE = 'true';
  for (const reference of ['', 'another/repo/.github/workflows/build.yml@refs/heads/main',
    'owner/repo/.github/workflows/build.yml@refs/heads/another']) {
    process.env.GITHUB_WORKFLOW_REF = reference;
    await assert.rejects(publish(fixture), /originating workflow identity/);
  }
  assert.ok(!fixture.calls.some(call => call[2] === 'evidence-path'));
});

test('prepared evidence remains available when PR comment publication fails', async t => {
  const fixture = setup(t);
  process.env.TEST_SUMMARY_EVIDENCE = 'true';
  fixture.github.rest.issues.createComment = async () => { throw new Error('permission denied'); };
  await assert.rejects(publish(fixture), /permission denied/);
  const file = fixture.calls.find(call => call[2] === 'evidence-path')[1];
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(path.dirname(file)); });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).reports[0].total, 2);
});

test('creates one bounded comment with artifact links', async t => {
  const fixture = setup(t);
  await publish(fixture);
  const create = fixture.calls.find(([name]) => name === 'create')[1];
  assert.ok(create.body.startsWith(`${marker}\n`));
  assert.match(create.body, /actions\/runs\/100\/artifacts\/123/);
  assert.equal(fixture.calls.filter(([name]) => name === 'get').length, 2);
});

test('updates only a marker owned by github-actions bot', async t => {
  const fixture = setup(t, { comments: [
    { id: 1, user: { login: 'developer', type: 'User' }, body: `${marker}\nspoof` },
    { id: 2, user: { login: 'github-actions[bot]', type: 'Bot' }, body: `${marker}\nprior` },
  ] });
  await publish(fixture);
  assert.equal(fixture.calls.find(([name]) => name === 'update')[1].comment_id, 2);
});

for (const [name, options] of [
  ['fork', { repo: 'fork/repo' }], ['dependabot author', { author: 'dependabot[bot]' }],
  ['dependabot actor', { actor: 'dependabot[bot]' }], ['push', { event: 'push' }],
  ['pull_request_target', { event: 'pull_request_target' }],
]) {
  test(`${name} only gets a step summary, without write API calls`, async t => {
    const fixture = setup(t, options);
    await publish(fixture);
    assert.deepEqual(fixture.calls.map(([name]) => name), ['output', 'summary']);
  });
}

test('head changes and closed PRs suppress comments', async t => {
  const fixture = setup(t, { latest: { state: 'closed', head: { sha: 'c'.repeat(40) } } });
  await publish(fixture);
  assert.ok(!fixture.calls.some(([name]) => ['create', 'update'].includes(name)));
});

test('newer runs and attempts cannot be overwritten', async t => {
  const fixture = setup(t, { comments: [{ id: 1, user: { login: 'github-actions[bot]', type: 'Bot' },
    body: `${marker}\n<!-- shared-test-results-run:{"runId":"101","attempt":"1"} -->` }] });
  await publish(fixture);
  assert.ok(!fixture.calls.some(([name]) => ['create', 'update'].includes(name)));
});

test('API failures remain visible', async t => {
  const fixture = setup(t);
  fixture.github.rest.issues.createComment = async () => { throw new Error('permission denied'); };
  await assert.rejects(publish(fixture), /permission denied/);
});

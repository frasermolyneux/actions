'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function trx(outcomes, { stack = '', summary = 'Completed' } = {}) {
  const passed = outcomes.filter(value => value === 'Passed').length;
  const failed = outcomes.filter(value => !['Passed', 'NotExecuted'].includes(value)).length;
  const executed = passed + failed;
  return `<TestRun><Times start="2026-01-01T00:00:00Z" finish="2026-01-01T00:00:02Z"/>
    <Results>${outcomes.map((outcome, index) => `<UnitTestResult testName="Test ${index}" outcome="${outcome}"><Output><ErrorInfo><Message>Failure &amp; detail</Message><StackTrace>${stack}</StackTrace></ErrorInfo></Output></UnitTestResult>`).join('')}</Results>
    <ResultSummary outcome="${summary}"><Counters total="${outcomes.length}" executed="${executed}" passed="${passed}" failed="${failed}"/></ResultSummary></TestRun>`;
}

function run(t, files, args = [], options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-report-'"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const results = path.join(root, 'results');
  fs.mkdirSync(results);
  for (let index = 0; index < files.length; index++) fs.writeFileSync(path.join(results, `${index}.trx`), files[index]);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'Test.cs'), '// fixture');
  const output = path.join(root, 'output');
  const summary = path.join(root, 'summary');
  const process = spawnSync('pwsh', ['-NoProfile', '-File', path.join(__dirname, 'report-test-results.ps1'),
    '-Suite', 'Unit', '-ResultsDirectory', 'results', '-RepositoryRoot', root, ...args], {
    encoding: 'utf8',
    env: { ...global.process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, GITHUB_ACTIONS: 'true', ...options.env },
  });
  const reportLine = fs.existsSync(output) && fs.readFileSync(output, 'utf8').split('\n').find(line => line.startsWith('report='));
  assert.ok(reportLine, process.stderr);
  return { code: process.status, report: JSON.parse(reportLine.slice(7)), stdout: process.stdout, summary: fs.readFileSync(summary, 'utf8') };
}

test('single TRX preserves bounded schema and artifact ID', t => {
  const result = run(t, [trx(['Passed', 'NotExecuted'])], ['-RunOutcome', 'success', '-ArtifactId', '123']);
  assert.equal(result.code, 0);
  assert.deepEqual(result.report, { schema: 1, suite: 'Unit', status: 'passed', reason: 'completed',
    total: 2, executed: 1, passed: 1, failed: 0, skipped: 1, durationSeconds: 2, artifactId: '123' });
});

test('default rejects multiple TRX and does not silently choose one', t => {
  const result = run(t, [trx(['Passed']), trx(['Passed'])], ['-RunOutcome', 'success']);
  assert.notEqual(result.code, 0);
  assert.equal(result.report.reason, 'multiple-reports');
});

test('opt-in aggregates projects/frameworks, including a filtered empty project', t => {
  const result = run(t, [trx(['Passed', 'NotExecuted']), trx(['Passed']), trx([])], ['-AllowMultiple', '-RunOutcome', 'success']);
  assert.equal(result.code, 0);
  assert.equal(result.report.total, 3);
  assert.equal(result.report.passed, 2);
  assert.equal(result.report.skipped, 1);
  assert.equal(result.report.durationSeconds, 6);
});

for (const [name, files, reason] of [
  ['missing', [], 'report-missing'],
  ['zero', [trx([])], 'zero-tests'],
  ['all skipped', [trx(['NotExecuted'])], 'all-skipped'],
  ['malformed', ['<invalid'], 'report-invalid'],
  ['DTD', ['<!DOCTYPE TestRun [<!ENTITY x "unsafe">]><TestRun>&x;</TestRun>'], 'report-invalid'],
  ['inconsistent', [trx(['Passed']).replace('passed="1"', 'passed="0"')], 'report-invalid'],
  ['too many files', Array(129).fill(trx(['Passed'])), 'report-invalid'],
]) {
  test(`${name} cannot become a passing successful invocation`, t => {
    const result = run(t, files, ['-AllowMultiple', '-RunOutcome', 'success']);
    assert.notEqual(result.code, 0);
    assert.equal(result.report.reason, reason);
  });
}

test('malformed second report invalidates the whole aggregate', t => {
  const result = run(t, [trx(['Passed']), '<invalid'], ['-AllowMultiple', '-RunOutcome', 'success']);
  assert.notEqual(result.code, 0);
  assert.equal(result.report.total, 0);
  assert.equal(result.report.status, 'invalid');
});

test('failures annotate even without a source pattern and are bounded', t => {
  const result = run(t, [trx(Array(10).fill('Failed'))], ['-RunOutcome', 'failure']);
  assert.equal(result.report.failed, 10);
  assert.equal((result.stdout.match(/::error /g) || []).length, 8);
  assert.match(result.summary, /first 8 of 10/);
});

test('failed command cannot report passing despite passing TRX', t => {
  const result = run(t, [trx(['Passed'])], ['-RunOutcome', 'failure']);
  assert.equal(result.report.status, 'failed');
  assert.equal(result.report.reason, 'run-failed');
});

test('success outcome fails the reporter if any project failed', t => {
  const result = run(t, [trx(['Passed']), trx(['Failed'])], ['-AllowMultiple', '-RunOutcome', 'success']);
  assert.notEqual(result.code, 0);
  assert.equal(result.report.status, 'failed');
  assert.equal(result.report.total, 2);
});

test('source-mapped deterministic paths resolve within the repository', t => {
  const result = run(t, [trx(['Failed'], { stack: ' at Test.Method() in /_/src/Test.cs:line 3' })], ['-SourcePathPattern', '^src/.*']);
  assert.match(result.stdout, /file=src\/Test.cs,line=3/);
});

test('outside paths cannot get file annotations with a permissive pattern', t => {
  const outside = __filename.replace(/&/g, '&amp;');
  const result = run(t, [trx(['Failed'], { stack: ` at Test.Method() in ${outside}:line 1` })], ['-SourcePathPattern', '.*']);
  assert.match(result.stdout, /::error /);
  assert.doesNotMatch(result.stdout, /::error [^\n]*file=/);
});

test('cancelled and skipped outcomes cannot reuse passing results', t => {
  for (const outcome of ['cancelled', 'skipped']) {
    const result = run(t, [trx(['Passed'])], ['-RunOutcome', outcome]);
    assert.equal(result.report.status, outcome === 'skipped' ? 'not-run' : 'cancelled');
  }
});

test('invalid artifact IDs never enter reports', t => {
  const result = run(t, [trx(['Passed'])], ['-ArtifactId', 'abc']);
  assert.equal(result.report.artifactId, null);
});

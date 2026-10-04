'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

function cobertura(classes) {
  return `<coverage><packages><package><classes>${classes.map(([filename, lines]) =>
    `<class filename="${filename}"><lines>${lines.map(([number, hits]) =>
      `<line number="${number}" hits="${hits}"/>`).join('')}</lines></class>`).join('')}</classes></package></packages></coverage>`;
}

function run(t, xml, source = 'a'.repeat(40)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-coverage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'coverage.cobertura.xml');
  const output = path.join(root, 'output');
  fs.writeFileSync(file, xml);
  const process = spawnSync('pwsh', ['-NoProfile', '-File', path.join(__dirname, 'report-coverage.ps1'),
    '-CoverageFile', file, '-SourceSha', source, '-CoverageVersion', '18.11.2'], {
    encoding: 'utf8', env: { ...global.process.env, GITHUB_OUTPUT: output },
  });
  const line = fs.existsSync(output) && fs.readFileSync(output, 'utf8').split('\n')
    .find(value => value.startsWith('coverage-report='));
  return { ...process, report: line ? JSON.parse(line.slice('coverage-report='.length)) : null };
}

test('native collection hashes the actual report and deduplicates source lines across classes/frameworks', t => {
  const xml = cobertura([['src/A.cs', [[1, 0], [2, 1]]], ['src/A.cs', [[1, 2]]]]);
  const result = run(t, xml);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report, {
    schema: 1, status: 'collected', format: 'cobertura', sourceSha: 'a'.repeat(40),
    toolVersion: '18.11.2', sha256: createHash('sha256').update(xml).digest('hex'),
    lines: { total: 2, covered: 2 },
  });
  assert.equal('analysisId' in result.report, false);
});

test('different case-sensitive source filenames stay distinct', t => {
  const result = run(t, cobertura([['src/A.cs', [[1, 1]]], ['src/a.cs', [[1, 0]]]]));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.lines, { total: 2, covered: 1 });
});

test('zero covered lines remains measurable instrumentation, not missing coverage', t => {
  const result = run(t, cobertura([['src/A.cs', [[1, 0], [2, 0]]]]));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.lines, { total: 2, covered: 0 });
});

for (const [name, xml] of [
  ['missing instrumentation', cobertura([])],
  ['wrong native format', '<results/>'],
  ['malformed XML', '<coverage'],
  ['DTD', '<!DOCTYPE coverage [<!ENTITY x "unsafe">]><coverage>&x;</coverage>'],
  ['missing source filename', cobertura([['', [[1, 1]]]])],
  ['invalid source line', cobertura([['src/A.cs', [[0, 1]]]])],
  ['negative hits', cobertura([['src/A.cs', [[1, -1]]]])],
  ['overflowing hits', cobertura([['src/A.cs', [[1, '999999999999999999999']]]])],
  ['oversized report', ' '.repeat(32 * 1024 * 1024 + 1)],
]) {
  test(`${name} fails explicitly without success-shaped coverage evidence`, t => {
    const result = run(t, xml);
    assert.notEqual(result.status, 0);
    assert.equal(result.report, null);
    assert.ok(result.stderr.length > 0);
  });
}

test('invalid source revision cannot become collected evidence', t => {
  const result = run(t, cobertura([['src/A.cs', [[1, 1]]]]), 'main');
  assert.notEqual(result.status, 0);
  assert.equal(result.report, null);
});

test('coverage is disabled by default and independently pinned', () => {
  const action = fs.readFileSync(path.join(__dirname, 'action.yml'), 'utf8');
  assert.match(action, /coverage:\s+description: [^\n]+\s+required: false\s+default: "false"/);
  const pin = JSON.parse(fs.readFileSync(path.join(__dirname, 'coverage-tools.json'), 'utf8'));
  assert.deepEqual(pin, { package: 'dotnet-coverage', version: '18.11.2', format: 'cobertura' });
  assert.equal((action.match(/git -C \$env:TEST_WORKING_DIRECTORY rev-parse HEAD/g) || []).length, 2);
});

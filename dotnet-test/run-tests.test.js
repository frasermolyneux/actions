'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(t, { coverage = false, exitCode = 0, noBuild = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-wrapper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const results = path.join(root, 'results');
  fs.mkdirSync(results);
  const capture = path.join(root, 'arguments.json');
  const script = `
    function global:dotnet {
      [IO.File]::WriteAllText($env:CAPTURE, (ConvertTo-Json -InputObject @($args) -Compress))
      $global:LASTEXITCODE = [int]$env:STUB_EXIT_CODE
    }
    function global:fixture-coverage {
      [IO.File]::WriteAllText($env:CAPTURE, (ConvertTo-Json -InputObject @($args) -Compress))
      $global:LASTEXITCODE = [int]$env:STUB_EXIT_CODE
    }
    & $env:TEST_SCRIPT -WorkingDirectory $env:TEST_ROOT -Project 'a solution.slnx' -Configuration Release `
    + `-NoBuild $env:NO_BUILD -Filter 'FullyQualifiedName!~IntegrationTests|Category=Some value' `
    + `-ResultsDirectory $env:RESULTS -CoverageCommand $env:COVERAGE_COMMAND -CoverageFile $env:COVERAGE_FILE
    if (-not $?) { exit 1 }
  `;
  const process = spawnSync('pwsh', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    env: { ...global.process.env, TEST_SCRIPT: path.join(__dirname, 'run-tests.ps1'),
      TEST_ROOT: root, RESULTS: results, CAPTURE: capture, STUB_EXIT_CODE: String(exitCode),
      NO_BUILD: String(noBuild), COVERAGE_COMMAND: coverage ? 'fixture-coverage' : '',
      COVERAGE_FILE: coverage ? path.join(results, 'coverage.cobertura.xml') : '' },
  });
  return { ...process, arguments: fs.existsSync(capture) ? JSON.parse(fs.readFileSync(capture, 'utf8')) : null };
}

test('default invocation retains test selection and argument boundaries without coverage', t => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.arguments.slice(0, 4), ['test', 'a solution.slnx', '--configuration', 'Release']);
  assert.ok(result.arguments.includes('--no-build'));
  assert.equal(result.arguments.at(-1), 'FullyQualifiedName!~IntegrationTests|Category=Some value');
});

test('optional coverage wraps the same dotnet command rather than reconstructing a shell string', t => {
  const result = run(t, { coverage: true, noBuild: false });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.arguments.slice(0, 4), ['collect', '--output-format', 'cobertura', '--output']);
  assert.deepEqual(result.arguments.slice(5, 8), ['dotnet', 'test', 'a solution.slnx']);
  assert.equal(result.arguments.includes('--no-build'), false);
  assert.equal(result.arguments.at(-1), 'FullyQualifiedName!~IntegrationTests|Category=Some value');
});

for (const coverage of [false, true]) {
  test(`${coverage ? 'coverage-wrapped' : 'ordinary'} failed invocation propagates failure`, t => {
    const result = run(t, { coverage, exitCode: 7 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /failed with exit code 7/);
  });
}

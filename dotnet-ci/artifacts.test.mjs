import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const manifest = readFileSync(new URL('./action.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const script = /      run: \|\n((?:        .*\n|\n)+)/.exec(manifest)[1].replace(/^        /gm, '');

test('artifact naming preserves defaults and rejects ambiguous aliases', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dotnet-ci-test-'));
  try {
    const output = join(temp, 'output');
    const run = (primary, secondary) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env: { ...process.env, PRIMARY_NAME: primary, SECONDARY_NAMES: secondary, SRC_FOLDER: 'src', RUNNER_TEMP: temp, GITHUB_OUTPUT: output },
    });
    assert.equal(run('', '').status, 0);
    assert.match(readFileSync(output, 'utf8'), /primary=test-results-src/);
    assert.equal(run('main', 'web-one\nweb-two').status, 0);
    assert.match(readFileSync(output, 'utf8'), /secondary1=web-one/);
    assert.match(readFileSync(output, 'utf8'), /secondary2=web-two/);
    assert.notEqual(run('main', 'main').status, 0);
    assert.notEqual(run('main', 'one\ntwo\nthree').status, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('aliases retain upload failure and one authoritative report', () => {
  assert.equal((manifest.match(/name: Upload secondary test results/g) || []).length, 2);
  assert.equal((manifest.match(/uses: frasermolyneux\/actions\/dotnet-test@/g) || []).length, 1);
  assert.match(manifest, /steps\.tests\.outputs\.results-directory/);
  assert.equal((manifest.match(/if-no-files-found: \$\{\{ inputs\.test-reporting == 'true' && 'error' \|\| 'warn' \}\}/g) || []).length, 2);
  assert.doesNotMatch(manifest, /continue-on-error/);
});

test('failed directory allocation cannot upload from a root-level TRX glob', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dotnet-ci-allocation-'));
  try {
    const output = join(temp, 'output');
    const invalidRoot = join(temp, 'not-a-directory');
    writeFileSync(invalidRoot, 'file');
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env: { ...process.env, PRIMARY_NAME: 'primary', SECONDARY_NAMES: 'one\ntwo', SRC_FOLDER: 'src', RUNNER_TEMP: invalidRoot, GITHUB_OUTPUT: output },
    });
    assert.notEqual(result.status, 0);
    const outputs = readFileSync(output, 'utf8');
    assert.match(outputs, /secondary1=one/);
    assert.match(outputs, /secondary2=two/);
    assert.doesNotMatch(outputs, /legacy-directory=/);
    const conditions = [...manifest.matchAll(/name: Upload secondary test results \d\n\s+if: (.+)/g)];
    assert.equal(conditions.length, 2);
    for (const [, condition] of conditions) {
      assert.match(condition, /^always\(\) && steps\.test-artifacts\.outcome == 'success' && /);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

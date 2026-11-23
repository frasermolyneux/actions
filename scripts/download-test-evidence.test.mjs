import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import downloader from './download-test-evidence.cjs';

async function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'evidence-download-'));
  const archive = Buffer.from('fixture archive bytes');
  const metadata = { id: 42, workflow_run: { id: 123 }, expired: false, digest: `sha256:${createHash('sha256').update(archive).digest('hex')}` };
  const outputs = {};
  let waits = 0;
  let calls = 0;
  const options = {
    directory, artifactId: '42', runId: '123', owner: 'owner', repo: 'repo',
    core: { setOutput: (name, value) => { outputs[name] = value; }, info() {}, warning() {} },
    wait: async milliseconds => { assert.equal(milliseconds, 5000); waits++; },
    github: { rest: { actions: {
      getArtifact: async () => ({ data: metadata }),
      downloadArtifact: async input => {
        assert.equal(input.artifact_id, 42);
        assert.equal(input.request.redirect, 'manual');
        calls++;
        return { status: 302, headers: { location: 'https://example.invalid/archive' } };
      },
    } } },
    fetchArchive: async () => ({ ok: true, arrayBuffer: async () => archive }),
  };
  try {
    await run({ options, outputs, metadata, archive, waits: () => waits, calls: () => calls });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('listed artifact archive 404 retries the same ID then verifies the downloaded digest', () => fixture(async f => {
  const download = f.options.github.rest.actions.downloadArtifact;
  let attempts = 0;
  f.options.github.rest.actions.downloadArtifact = async input => {
    if (++attempts <= 2) throw Object.assign(new Error('Not Found'), { status: 404 });
    return download(input);
  };
  await downloader.download(f.options);
  assert.equal(attempts, 3);
  assert.equal(f.waits(), 2);
  assert.deepEqual(readFileSync(f.outputs['archive-path']), f.archive);
}));

test('archive storage 404 also retries, without returning cached local evidence', () => fixture(async f => {
  const fetchArchive = f.options.fetchArchive;
  let attempts = 0;
  f.options.fetchArchive = async () => ++attempts === 1 ? { ok: false, status: 404 } : fetchArchive();
  await downloader.download(f.options);
  assert.equal(f.calls(), 2);
  assert.equal(f.waits(), 1);
}));

test('persistent absence fails after six attempts and emits no successful output', () => fixture(async f => {
  f.options.github.rest.actions.downloadArtifact = async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); };
  await assert.rejects(downloader.download(f.options), /Not Found/);
  assert.equal(f.waits(), 5);
  assert.deepEqual(f.outputs, {});
}));

test('permission failure is not treated as propagation delay', () => fixture(async f => {
  f.options.github.rest.actions.downloadArtifact = async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); };
  await assert.rejects(downloader.download(f.options), /Forbidden/);
  assert.equal(f.waits(), 0);
}));

test('wrong originating run and corrupt archives fail without retry or output', async () => {
  await fixture(async f => {
    f.metadata.workflow_run.id = 456;
    await assert.rejects(downloader.download(f.options), /current run/);
    assert.equal(f.calls(), 0);
    assert.equal(f.waits(), 0);
  });
  await fixture(async f => {
    f.metadata.digest = `sha256:${'0'.repeat(64)}`;
    await assert.rejects(downloader.download(f.options), /digest does not match/);
    assert.equal(f.waits(), 0);
    assert.deepEqual(f.outputs, {});
  });
});

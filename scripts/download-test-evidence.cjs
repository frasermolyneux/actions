'use strict';

const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { setTimeout } = require('node:timers/promises');

async function download({ github, core, owner, repo, runId, artifactId, directory, fetchArchive = fetch, wait = setTimeout }) {
  if (!/^[1-9][0-9]*$/.test(String(artifactId))) throw new Error('Invalid evidence artifact ID.');
  const attempts = 6;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { data: metadata } = await github.rest.actions.getArtifact({ owner, repo, artifact_id: Number(artifactId) });
      if (String(metadata.id) !== String(artifactId) || String(metadata.workflow_run?.id) !== String(runId) || metadata.expired) {
        throw new Error('Evidence artifact does not belong to the current run or has expired.');
      }
      if (!/^sha256:[a-f0-9]{64}$/.test(metadata.digest)) throw new Error('Evidence artifact has no valid archive digest.');
      const redirect = await github.rest.actions.downloadArtifact({
        owner, repo, artifact_id: Number(artifactId), archive_format: 'zip',
        request: { redirect: 'manual' },
      });
      if (redirect.status !== 302 || !redirect.headers.location) throw new Error('Evidence archive did not return a download redirect.');
      const response = await fetchArchive(redirect.headers.location);
      if (!response.ok) {
        const error = new Error(`Evidence archive returned HTTP ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      const archive = Buffer.from(await response.arrayBuffer());
      if (archive.length === 0 || archive.length > 1024 * 1024) throw new Error('Evidence archive is empty or exceeds 1 MiB.');
      if (`sha256:${createHash('sha256').update(archive).digest('hex')}` !== metadata.digest) {
        throw new Error('Evidence archive digest does not match its uploaded identity.');
      }
      mkdirSync(directory, { recursive: true });
      const path = join(directory, 'evidence.zip');
      writeFileSync(path, archive);
      core.setOutput('archive-path', path);
      core.info(`Downloaded and verified evidence artifact ${artifactId}.`);
      return;
    } catch (error) {
      if (error.status !== 404 || attempt === attempts) throw error;
      core.warning(`Evidence artifact ${artifactId} is not yet downloadable (attempt ${attempt}/${attempts}); retrying in 5 seconds.`);
      await wait(5000);
    }
  }
}

module.exports = { download };

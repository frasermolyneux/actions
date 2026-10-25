const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { observe, contextFile, output, sha256, environmentName } = require('../terraform-setup/context.cjs');
const operations = new Set(['validate', 'plan', 'apply', 'output', 'state-check', 'state-rm', 'import', 'destroy', 'destroy-resources']);
function receipt(context, env) {
  if (!operations.has(env.TF_OPERATION) || !['success', 'failure'].includes(env.TF_OUTCOME)) {
    throw new Error('Invalid execution operation/outcome');
  }
  if (!/^[^/]+\/[^/]+$/.test(env.GITHUB_REPOSITORY) ||
      !/^\d+$/.test(env.GITHUB_RUN_ID) || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT) ||
      !/^[a-f0-9]{40}$/.test(context.sourceCommit)) throw new Error('Missing execution lineage');
  const result = {
    schemaVersion: 'terraform-execution-v1', repository: env.GITHUB_REPOSITORY,
    sourceCommit: context.sourceCommit, rootDirectory: context.rootDirectory,
    runId: env.GITHUB_RUN_ID, runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    workflowRef: env.GITHUB_WORKFLOW_REF, workflowSha: env.GITHUB_WORKFLOW_SHA,
    job: env.GITHUB_JOB, eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF,
    environment: environmentName(env.TF_ENVIRONMENT, env.TF_VAR_FILE),
    operation: env.TF_OPERATION, outcome: env.TF_OUTCOME,
    observedAt: new Date().toISOString(), terraformVersion: context.terraformVersion,
    platform: context.platform, providerSelections: context.observedProviderSelections || context.providerSelections,
    lockSha256: context.lockSha256, executionId: crypto.randomUUID()
  };
  // Downloaded actions do not normally contain Git metadata. Never report the caller SHA as producer.
  if (/^[a-f0-9]{40}$/.test(env.TF_PRODUCER_REVISION || '')) result.producerRevision = env.TF_PRODUCER_REVISION;
  return result;
}
function main() {
  const context = observe(contextFile(process.env.TF_CONTEXT), process.env.TF_OUTCOME === 'success');
  const data = receipt(context, process.env);
  const directory = fs.mkdtempSync(path.join(process.env.TF_CONTEXT, 'receipt-'));
  const file = path.join(directory, 'terraform-execution.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  const job = data.job.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
  const name = `terraform-execution-${job}-${data.runId}-${data.runAttempt}-${data.operation}-${sha256(data.rootDirectory).slice(0, 12)}-${data.executionId}`;
  output('file', file);
  output('name', name);
  console.log(`Terraform ${data.operation} outcome: ${data.outcome}. Receipt publication does not replay this operation.`);
}
module.exports = { receipt };
if (require.main === module) {
  try { main(); } catch (error) { console.error(`Terraform receipt unavailable: ${error.message}. Do not replay mutations to repair evidence.`); process.exitCode = 1; }
}

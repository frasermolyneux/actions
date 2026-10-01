'use strict';

const marker = '<!-- shared-test-results:v1 -->';
const statuses = new Set(['passed', 'failed', 'invalid', 'not-run', 'cancelled']);
const reasons = {
  completed: 'Completed',
  'test-failures': 'Tests or test host failed',
  'run-failed': 'Test command failed',
  'report-missing': 'No report; tests may not have started',
  'multiple-reports': 'Unexpected multiple reports',
  'report-invalid': 'Invalid report',
  'zero-tests': 'No tests discovered',
  'all-skipped': 'All tests skipped',
  'not-started': 'Tests not started',
  cancelled: 'Cancelled',
  'job-failed': 'Job failed (including setup, build or artifacts)',
  'job-skipped': 'Job skipped',
};
const counters = ['total', 'executed', 'passed', 'failed', 'skipped'];

function parse(text, limit) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > limit) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function validateReport(value) {
  if (!value || value.schema !== 1 || typeof value.suite !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,63}$/.test(value.suite) ||
      !statuses.has(value.status) || !Object.hasOwn(reasons, value.reason) ||
      counters.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1000000) ||
      value.executed + value.skipped !== value.total || value.passed + value.failed !== value.executed ||
      !Number.isFinite(value.durationSeconds) || value.durationSeconds < 0 || value.durationSeconds > 366 * 86400 ||
      (value.status === 'passed' && (!value.executed || value.failed || value.reason !== 'completed'))) return null;
  const report = { schema: 1, suite: value.suite, status: value.status, reason: value.reason };
  for (const key of counters) report[key] = value[key];
  report.durationSeconds = value.durationSeconds;
  report.artifactId = typeof value.artifactId === 'string' && /^[1-9][0-9]{0,19}$/.test(value.artifactId) ? value.artifactId : null;
  return report;
}

function normalize(jobsText) {
  const jobs = parse(jobsText, 131072);
  if (!jobs || Array.isArray(jobs) || typeof jobs !== 'object' ||
      !Object.keys(jobs).length || Object.keys(jobs).length > 32) throw new Error('Expected 1-32 test jobs.');
  const reports = [];
  for (const [jobName, job] of Object.entries(jobs)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,99}$/.test(jobName) ||
        !job || !['success', 'failure', 'cancelled', 'skipped'].includes(job.result)) {
      throw new Error('Invalid test job identity or outcome.');
    }
    const outputs = Object.entries(job.outputs || {}).filter(([key]) => /(?:^|_)test_report$/.test(key));
    if (!outputs.length) outputs.push(['test_report', '']);
    for (const [key, text] of outputs) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,99}$/.test(key)) throw new Error('Invalid test report output name.');
      let report = validateReport(parse(text, 4096));
      if (!report) {
        report = {
          schema: 1, suite: jobName.slice(0, 64), status: 'invalid',
          reason: text ? 'report-invalid' : 'report-missing',
          total: 0, executed: 0, passed: 0, failed: 0, skipped: 0, durationSeconds: 0, artifactId: null,
        };
      }
      if (job.result !== 'success') {
        report.status = { failure: 'failed', cancelled: 'cancelled', skipped: 'not-run' }[job.result];
        report.reason = { failure: 'job-failed', cancelled: 'cancelled', skipped: 'job-skipped' }[job.result];
      }
      reports.push({ ...report, job: jobName, output: key });
      if (reports.length > 64) throw new Error('Too many test reports.');
    }
  }
  return reports;
}

function identity(context) {
  const current = {
    repo: `${context.repo.owner}/${context.repo.repo}`,
    sha: context.sha,
    headSha: context.payload.pull_request?.head?.sha || context.sha,
    runId: String(context.runId),
    attempt: process.env.GITHUB_RUN_ATTEMPT || '1',
    serverUrl: process.env.GITHUB_SERVER_URL || 'https://github.com',
  };
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(current.repo) ||
      !/^[a-f0-9]{40,64}$/.test(current.sha) || !/^[a-f0-9]{40,64}$/.test(current.headSha) ||
      !/^[1-9][0-9]{0,19}$/.test(current.runId) || !/^[1-9][0-9]{0,5}$/.test(current.attempt) ||
      !/^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(current.serverUrl)) throw new Error('Invalid workflow identity.');
  return current;
}

function escape(text) {
  return text.replace(/[&<>"'`_*|[\]\\]/g, char => `&#${char.charCodeAt(0)};`);
}

function render(reports, current) {
  const url = `${current.serverUrl}/${current.repo}/actions/runs/${current.runId}`;
  const lines = [
    '## Test results', '',
    `Head: \`${current.headSha.slice(0, 12)}\` | Tested: \`${current.sha.slice(0, 12)}\` | [Run ${current.runId}, attempt ${current.attempt}](${url})`,
    '',
    '| Job / report / suite | Status | Passed | Failed | Skipped | Total | TRX windows | Results |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const report of reports) {
    const artifact = report.artifactId ? `[TRX](${url}/artifacts/${report.artifactId})` : `[Run logs](${url})`;
    lines.push(`| ${escape(report.job)} / ${escape(report.output)} / ${escape(report.suite)} | ${report.status}: ${reasons[report.reason]} | ${report.passed} | ${report.failed} | ${report.skipped} | ${report.total} | ${report.durationSeconds.toFixed(3)} s | ${artifact} |`);
  }
  lines.push('', 'Counts include each project/framework execution; summed TRX windows are not wall-clock time. No cross-suite totals are inferred.',
    'The test/build jobs remain authoritative. Missing reports and unsuccessful job outcomes are never presented as passing.');
  return lines.join('\n');
}

async function publish({ github, core, context }) {
  const reports = normalize(process.env.TEST_SUMMARY_JOBS);
  const current = identity(context);
  const output = JSON.stringify(reports);
  if (Buffer.byteLength(output) > 32768) throw new Error('Aggregate report exceeds its output limit.');
  core.setOutput('report', output);
  const summary = render(reports, current);
  await core.summary.addRaw(summary).write();
  if (reports.some(report => report.status !== 'passed')) {
    core.warning('One or more test jobs failed, were skipped, or have missing/invalid reports.');
  }
  if (!['true', 'false'].includes(process.env.TEST_SUMMARY_PUBLISH)) throw new Error('publish-comment must be true or false.');
  if (process.env.TEST_SUMMARY_PUBLISH === 'false') return;
  const pr = context.payload.pull_request;
  if (context.eventName !== 'pull_request' || !pr || pr.head.repo?.full_name !== current.repo ||
      context.actor === 'dependabot[bot]' || pr.user?.login === 'dependabot[bot]') {
    core.info('Comment skipped: no eligible same-repository pull request write context.');
    return;
  }
  const parameters = { ...context.repo, pull_number: pr.number };
  const latest = await github.rest.pulls.get(parameters);
  if (latest.data.state !== 'open' || latest.data.head.sha !== current.headSha) {
    core.info('Comment skipped: the PR is closed or its head changed.');
    return;
  }
  const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: pr.number, per_page: 100 });
  const owned = comments.filter(comment => comment.user?.login === 'github-actions[bot]' && comment.user?.type === 'Bot' &&
    typeof comment.body === 'string' && comment.body.startsWith(`${marker}\n`));
  for (const comment of owned) {
    const metadata = /<!-- shared-test-results-run:([^\n]+) -->/.exec(comment.body);
    const prior = metadata && parse(metadata[1], 512);
    if (prior && /^[1-9][0-9]{0,19}$/.test(String(prior.runId)) && /^[1-9][0-9]{0,5}$/.test(String(prior.attempt)) &&
        (BigInt(prior.runId) > BigInt(current.runId) ||
         (String(prior.runId) === current.runId && Number(prior.attempt) > Number(current.attempt)))) {
      core.info('Comment skipped: a newer run or attempt already reported.');
      return;
    }
  }
  const metadata = JSON.stringify({ runId: current.runId, attempt: current.attempt, headSha: current.headSha });
  const body = `${marker}\n<!-- shared-test-results-run:${metadata} -->\n${summary}`;
  if (Buffer.byteLength(body) > 60000) throw new Error('Comment exceeds its size limit.');
  const beforeWrite = await github.rest.pulls.get(parameters);
  if (beforeWrite.data.state !== 'open' || beforeWrite.data.head.sha !== current.headSha) {
    core.info('Comment skipped: the PR changed while preparing the report.');
    return;
  }
  if (owned.length) {
    await github.rest.issues.updateComment({ ...context.repo, comment_id: owned[0].id, body });
  } else {
    await github.rest.issues.createComment({ ...context.repo, issue_number: pr.number, body });
  }
}

module.exports = { marker, validateReport, normalize, render, publish };

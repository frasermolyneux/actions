// Shared, allowlisted Terraform PR comment formatting.
const fs = require('node:fs');
const path = require('node:path');

const titles = Object.freeze({
  plan: 'Terraform Plan',
  'plan-readonly': 'Terraform Plan (Read-Only)',
  'plan-and-apply': 'Terraform Plan and Apply',
  import: 'Terraform Import',
});

function readOutputFile(filePath) {
  if (!filePath) return null;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Terraform plan output could not be read.');
    return null;
  }
}

function parsePlanSummary(output) {
  if (typeof output !== 'string') return null;
  const lines = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').split(/\r?\n/);
  const matches = [];
  let boxed = false;
  let diagnostic = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '╷') { boxed = true; continue; }
    if (boxed && line === '╵') { boxed = false; continue; }
    if (boxed) continue;
    if (/^(?:│\s*)?(?:Warning|Error):/.test(line)) diagnostic = true;
    if (diagnostic) continue;
    const match = /^Plan: (\d+) to add, (\d+) to change, (\d+) to destroy\.$/.exec(line);
    if (match) {
      const counts = match.slice(1).map(Number);
      if (counts.some(count => !Number.isSafeInteger(count))) return null;
      matches.push({ add: counts[0], change: counts[1], destroy: counts[2] });
    } else if (line === 'No changes. Your infrastructure matches the configuration.') {
      matches.push({ add: 0, change: 0, destroy: 0 });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function workspaceName(explicit, env) {
  if (explicit) return explicit;
  if (env.TF_WORKSPACE) return env.TF_WORKSPACE;
  if (!env.GITHUB_WORKSPACE || !env.TF_COMMENT_FOLDER) return '';
  const root = path.resolve(env.GITHUB_WORKSPACE, env.TF_COMMENT_FOLDER);
  const data = path.resolve(root, env.TF_DATA_DIR || '.terraform');
  try {
    const name = fs.readFileSync(path.join(data, 'environment'), 'utf8').trim();
    return name || '';
  } catch (error) {
    if (error.code === 'ENOENT') return 'default';
    console.warn('Terraform workspace could not be determined.');
    return '';
  }
}

function environmentName(explicit, varFile) {
  if (explicit) return explicit;
  return path.posix.basename((varFile || '').replaceAll('\\', '/')).replace(/\.tfvars$/i, '');
}

function display(value) {
  if (typeof value !== 'string' || !value.trim()) return 'Not specified';
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').trim();
  if (!clean) return 'Not specified';
  const characters = Array.from(clean);
  const truncated = characters.length > 256;
  const encoded = characters.slice(0, 256).map(character => `&#${character.codePointAt(0)};`).join('');
  return `<code>${encoded}</code>${truncated ? ' (truncated)' : ''}`;
}

function buildComment(options) {
  if (!Object.hasOwn(titles, options.kind)) throw new Error('Unsupported Terraform comment kind');
  let body = `### ${titles[options.kind]}\n\n`;
  body += `**Workflow:** ${display(options.workflow)}  \n`;
  body += `**Terraform folder:** ${display(options.folder)}  \n`;
  body += `**Workspace:** ${display(options.workspace)}  \n`;
  body += `**Target environment:** ${display(options.environment)}\n\n`;
  for (const [label, step] of [['Validate', options.validate], ['Plan', options.plan], ['Apply', options.apply]]) {
    if (!step || !['success', 'failure'].includes(step.outcome)) continue;
    const passed = step.outcome === 'success' && step.exitcode === '0';
    body += `**${label}: ${passed ? 'Passed' : 'Failed'}**\n\n`;
    if (label !== 'Plan' || !passed) continue;
    const summary = parsePlanSummary(step.stdout);
    if (!summary) {
      body += '**Plan summary: Unavailable**\n\n';
      continue;
    }
    if (summary.destroy > 0) body += '**Warning: Destructive changes are planned.**\n\n';
    body += `| Change | Count |\n|:--|--:|\n| Add | ${summary.add} |\n| Change | ${summary.change} |\n| Destroy | ${summary.destroy} |\n\n`;
  }
  return body;
}

async function postComment(github, context, options) {
  const body = buildComment(options);
  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.issue.number,
    body,
  });
}

module.exports = { readOutputFile, parsePlanSummary, workspaceName, environmentName, buildComment, postComment };

// Shared formatting utilities for Terraform PR comments.
// Used by terraform-plan, terraform-plan-readonly, terraform-plan-and-apply, and terraform-import actions.

/**
 * Strip ANSI escape codes from a string.
 */
function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\[0m/g, '');
}

/**
 * Parse the plan summary line, e.g.:
 *   "Plan: 6 to add, 2 to change, 1 to destroy."
 *   "No changes. Your infrastructure matches the configuration."
 */
function parsePlanSummary(output) {
  const cleaned = stripAnsi(output);

  // Match "Plan: X to add, Y to change, Z to destroy."
  const planMatch = cleaned.match(/Plan:\s*(\d+)\s*to add,\s*(\d+)\s*to change,\s*(\d+)\s*to destroy/);
  if (planMatch) {
    return {
      add: parseInt(planMatch[1], 10),
      change: parseInt(planMatch[2], 10),
      destroy: parseInt(planMatch[3], 10),
      noChanges: false,
    };
  }

  // Match "No changes."
  if (/No changes\./i.test(cleaned)) {
    return { add: 0, change: 0, destroy: 0, noChanges: true };
  }

  return null;
}

/**
 * Parse individual resource actions from plan output.
 * Looks for lines like:
 *   # azurerm_dns_cname_record.web will be created
 *   # azurerm_resource_group.rg will be updated in-place
 *   # azurerm_resource_group.rg will be destroyed
 *   # azurerm_resource_group.rg must be replaced
 */
function parseResourceActions(output) {
  const cleaned = stripAnsi(output);
  const resources = [];
  const regex = /^[ \t]*#\s+(\S+)\s+(?:will be|must be)\s+(created|updated in-place|destroyed|replaced|read during apply)/gm;
  let match;
  while ((match = regex.exec(cleaned)) !== null) {
    const action = match[2];
    let emoji, label;
    switch (action) {
      case 'created':
        emoji = '➕'; label = 'Create'; break;
      case 'updated in-place':
        emoji = '🔄'; label = 'Update'; break;
      case 'destroyed':
        emoji = '➖'; label = 'Destroy'; break;
      case 'replaced':
        emoji = '♻️'; label = 'Replace'; break;
      case 'read during apply':
        emoji = '📖'; label = 'Read'; break;
      default:
        emoji = '❓'; label = action; break;
    }
    resources.push({ resource: match[1], action: label, emoji });
  }
  return resources;
}

/**
 * Build the summary counts table.
 */
function buildSummaryTable(summary) {
  if (!summary) return '';
  if (summary.noChanges) {
    return '> ✅ **No changes.** Your infrastructure matches the configuration.\n\n';
  }
  let table = '| | Count |\n';
  table += '|:--|--:|\n';
  if (summary.add > 0) table += `| ➕ Add | ${summary.add} |\n`;
  if (summary.change > 0) table += `| 🔄 Change | ${summary.change} |\n`;
  if (summary.destroy > 0) table += `| ➖ Destroy | ${summary.destroy} |\n`;
  if (summary.add === 0 && summary.change === 0 && summary.destroy === 0) {
    return '> ✅ **No changes.** Your infrastructure matches the configuration.\n\n';
  }
  table += '\n';
  return table;
}

/**
 * Build the resource actions table.
 */
function buildResourceTable(resources) {
  if (!resources || resources.length === 0) return '';
  let table = '<details><summary>📋 Resource Details</summary>\n\n';
  table += '| Action | Resource |\n';
  table += '|:--|:--|\n';
  for (const r of resources) {
    table += `| ${r.emoji} ${r.action} | \`${r.resource}\` |\n`;
  }
  table += '\n</details>\n\n';
  return table;
}

/**
 * Build a collapsible section with raw output.
 */
function buildCollapsibleOutput(title, output, lang) {
  if (!output || !output.trim()) return '';
  let trimmed = output.trim();
  if (trimmed.length > 55000) {
    trimmed = trimmed.substring(trimmed.length - 55000);
    trimmed = '... (truncated)\n' + trimmed;
  }
  const cleaned = stripAnsi(trimmed);
  return `<details><summary>${title}</summary>\n\n\`\`\`${lang || ''}\n${cleaned}\n\`\`\`\n\n</details>\n\n`;
}

/**
 * Derive environment name from a var-file path.
 * e.g. "tfvars/dev.tfvars" → "dev", "tfvars/prd.tfvars" → "prd"
 */
function deriveEnvironment(varFile) {
  if (!varFile) return '';
  const basename = varFile.replace(/\\/g, '/').split('/').pop() || '';
  return basename.replace(/\.tfvars$/i, '');
}

/**
 * Build a full PR comment body for a plan-type action.
 *
 * @param {object} opts
 * @param {string} opts.marker - HTML comment marker for upsert
 * @param {string} opts.title - Comment heading (e.g. "Terraform Plan")
 * @param {string} opts.workspace - Optional workspace suffix
 * @param {string} [opts.environment] - Environment name (derived from var-file)
 * @param {object} [opts.validate] - { stdout, stderr, exitcode, outcome }
 * @param {object} [opts.plan] - { stdout, stderr, exitcode, outcome }
 * @param {object} [opts.apply] - { stdout, stderr, exitcode, outcome }
 */
function buildComment(opts) {
  const ws = opts.workspace ? ` (${opts.workspace})` : '';
  let body = `${opts.marker}\n`;
  body += `### ${opts.title}${ws}\n\n`;

  if (opts.environment) {
    body += `> 🌍 **Environment:** \`${opts.environment}\`\n\n`;
  }

  // Validate section
  if (opts.validate && (opts.validate.outcome === 'success' || opts.validate.outcome === 'failure')) {
    const icon = opts.validate.exitcode === '0' ? '✅' : '❌';
    body += `**${icon} Validate** — ${opts.validate.exitcode === '0' ? 'Passed' : 'Failed'}\n\n`;
    const valOutput = (opts.validate.stdout || '') + (opts.validate.stderr || '');
    if (opts.validate.exitcode !== '0' && valOutput.trim()) {
      body += buildCollapsibleOutput('Validation Output', valOutput, '');
    }
  }

  // Plan section
  if (opts.plan && (opts.plan.outcome === 'success' || opts.plan.outcome === 'failure')) {
    const icon = opts.plan.exitcode === '0' ? '✅' : '❌';
    const planOutput = (opts.plan.stdout || '') + (opts.plan.stderr || '');

    if (opts.plan.exitcode === '0') {
      const summary = parsePlanSummary(planOutput);
      const resources = parseResourceActions(planOutput);

      body += `**${icon} Plan**\n\n`;

      // Top-level warning when resources will be destroyed or replaced
      const destroyCount = summary ? summary.destroy : 0;
      const replaceResources = resources.filter(r => r.action === 'Replace');
      const totalDestructive = destroyCount + replaceResources.length;
      if (totalDestructive > 0) {
        const parts = [];
        if (destroyCount > 0) parts.push(`**${destroyCount}** resource${destroyCount !== 1 ? 's' : ''} will be destroyed`);
        if (replaceResources.length > 0) parts.push(`**${replaceResources.length}** resource${replaceResources.length !== 1 ? 's' : ''} will be replaced (destroy + recreate)`);
        body += `> ⚠️ **Destructive Changes:** ${parts.join(' and ')}. Review carefully before merging.\n\n`;
      }

      body += buildSummaryTable(summary);
      body += buildResourceTable(resources);
    } else {
      body += `**${icon} Plan** — Failed\n\n`;
    }

    body += buildCollapsibleOutput('Full Plan Output', planOutput, 'hcl');
  }

  // Apply section (for plan-and-apply)
  if (opts.apply && (opts.apply.outcome === 'success' || opts.apply.outcome === 'failure')) {
    const icon = opts.apply.exitcode === '0' ? '✅' : '❌';
    body += `**${icon} Apply** — ${opts.apply.exitcode === '0' ? 'Succeeded' : 'Failed'}\n\n`;
    const applyOutput = (opts.apply.stdout || '') + (opts.apply.stderr || '');
    if (applyOutput.trim()) {
      body += buildCollapsibleOutput('Apply Output', applyOutput, '');
    }
  }

  return body;
}

/**
 * Post a new PR comment after marking any previous comments with the same
 * marker as superseded. Old comments are collapsed so the latest result is
 * always the most visible.
 */
async function postComment(github, context, marker, body) {
  const { data: comments } = await github.rest.issues.listComments({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.issue.number,
    per_page: 100,
  });

  // Mark all previous comments with this marker as superseded
  const existing = comments.filter(c => c.body && c.body.includes(marker));
  for (const old of existing) {
    // Skip if already superseded
    if (old.body.includes('⛔ **Superseded**')) continue;
    const supersededBody = `${marker}\n<details><summary>⛔ <strong>Superseded</strong> — A newer run has replaced this result.</summary>\n\n${old.body.replace(marker, '').trim()}\n\n</details>\n`;
    await github.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: old.id,
      body: supersededBody,
    });
  }

  // Always create a new comment with the latest results
  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.issue.number,
    body,
  });
}

module.exports = { stripAnsi, parsePlanSummary, parseResourceActions, buildSummaryTable, buildResourceTable, buildCollapsibleOutput, buildComment, postComment, deriveEnvironment };

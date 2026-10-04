function array(value, label) {
  if (!Array.isArray(value)) throw new Error(`Missing or malformed ${label}`);
  return value;
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Missing or malformed ${label}`);
  return value;
}

function noErrors(value, label) {
  if (array(value, label).length) throw new Error(`${label} prevents complete analysis`);
}

function validateSarif(report) {
  if (report?.version !== "2.1.0" || !array(report.runs, "SARIF runs").length) {
    throw new Error("Missing or malformed SARIF document");
  }
  return report.runs.flatMap((run) => {
    if (!run.tool?.driver?.name || run.invocations?.some((entry) => entry.executionSuccessful === false)) {
      throw new Error("Incomplete SARIF invocation");
    }
    return array(run.results, "SARIF results");
  });
}

function semgrep(report, version, inputs) {
  if (report?.version !== version) throw new Error("Unexpected Semgrep version");
  noErrors(report.errors, "Semgrep errors");
  const scanned = new Set(array(report.paths?.scanned, "Semgrep scanned paths"));
  if (inputs.some((file) => !scanned.has(file))) throw new Error("Semgrep did not analyze every selected source file");
  return array(report.results, "Semgrep results");
}

function checkov(report) {
  const frameworks = Array.isArray(report) ? report : [report];
  if (!frameworks.length) throw new Error("Missing Checkov frameworks");
  return frameworks.flatMap((entry) => {
    if (!entry?.check_type) throw new Error("Malformed Checkov framework");
    const errors = count(entry.summary?.parsing_errors, "Checkov parsing errors");
    if (errors || array(entry.results?.parsing_errors, "Checkov parsing error details").length) {
      throw new Error("Checkov parsing errors prevent complete analysis");
    }
    const passed = array(entry.results.passed_checks, "Checkov passed checks");
    const failed = array(entry.results.failed_checks, "Checkov failed checks");
    const skipped = array(entry.results.skipped_checks, "Checkov skipped checks");
    if (count(entry.summary.passed, "Checkov passed count") !== passed.length ||
        count(entry.summary.failed, "Checkov failed count") !== failed.length ||
        count(entry.summary.skipped, "Checkov skipped count") !== skipped.length) {
      throw new Error("Inconsistent Checkov report counts");
    }
    if (!passed.length && !failed.length && !skipped.length) throw new Error("Checkov evaluated no source policies");
    return failed;
  });
}

function bandit(report, inputs) {
  noErrors(report?.errors, "Bandit errors");
  if (!report.metrics || inputs.some((file) => !report.metrics[file] && !report.metrics[`./${file}`])) {
    throw new Error("Bandit did not analyze every selected source file");
  }
  return array(report.results, "Bandit results");
}

function shellcheck(report) {
  const findings = array(report?.comments, "ShellCheck comments");
  if (findings.some((entry) => !Number.isSafeInteger(entry.code) || entry.code < 2000)) {
    throw new Error("ShellCheck parsing errors prevent complete analysis");
  }
  return findings;
}

function powershell(report, version, inputs) {
  if (report?.version !== version) throw new Error("Unexpected PSScriptAnalyzer version");
  noErrors(report.errors, "PowerShell parsing errors");
  const scanned = array(report.scanned, "PowerShell scanned paths");
  if (scanned.length !== inputs.length) throw new Error("PSScriptAnalyzer source coverage is incomplete");
  return array(report.results, "PSScriptAnalyzer results");
}

export function validateReport(tool, report, version, inputs) {
  if (!Array.isArray(inputs) || !inputs.length) throw new Error("Nonempty source coverage is required");
  switch (tool) {
    case "zizmor": return validateSarif(report);
    case "semgrep-ce": return semgrep(report, version, inputs);
    case "checkov": return checkov(report);
    case "bandit": return bandit(report, inputs);
    case "shellcheck": return shellcheck(report);
    case "psscriptanalyzer": return powershell(report, version, inputs);
    default: throw new Error("Unsupported local analyzer");
  }
}

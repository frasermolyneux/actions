import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReport } from "./reports.mjs";

const NAMES = {
  zizmor: "zizmor", "semgrep-ce": "Semgrep", checkov: "checkov", bandit: "Bandit",
  shellcheck: "ShellCheck", psscriptanalyzer: "PSScriptAnalyzer",
};

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function sourcePath(value, files, root, tool) {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= 4096 &&
    !value.includes("\0"), "Native finding has an invalid source path");
  let filename = value;
  if (filename.startsWith("file:")) filename = fileURLToPath(filename);
  if (path.isAbsolute(filename)) {
    const relative = path.relative(root, filename).split(path.sep).join("/");
    if (files.has(relative)) return relative;
    // Checkov's leading slash denotes the scanned directory, not the filesystem root.
    if (tool === "checkov" && files.has(filename.slice(1))) return filename.slice(1);
    throw new Error("Native finding is outside the actual analyzed source");
  }
  if (filename.startsWith("./")) filename = filename.slice(2);
  requireValue(files.has(filename), "Native finding is outside the actual analyzed source");
  return filename;
}

function region(start, end, column, endColumn) {
  if (start === undefined || start === null || start === 0) {
    requireValue(end === undefined || end === null || end === 0,
      "Native finding has an end line without a start");
    return undefined;
  }
  requireValue(Number.isSafeInteger(start) && start > 0 &&
    (end === undefined || (Number.isSafeInteger(end) && end >= start)),
  "Native finding has an invalid line range");
  const result = { startLine: start, ...(end === undefined ? {} : { endLine: end }) };
  if (column !== undefined) {
    requireValue(Number.isSafeInteger(column) && column > 0, "Native finding has an invalid column");
    result.startColumn = column;
  }
  if (endColumn !== undefined) {
    requireValue(Number.isSafeInteger(endColumn) && endColumn > 0 &&
      ((end ?? start) !== start || column === undefined || endColumn >= column),
    "Native finding has an invalid end column");
    result.endColumn = endColumn;
  }
  return result;
}

function level(value, tool) {
  if (tool === "psscriptanalyzer" && typeof value === "number") {
    requireValue(Number.isInteger(value) && value >= 0 && value <= 2,
      "Native PowerShell parsing error or unknown diagnostic severity");
    return ["note", "warning", "error"][value];
  }
  requireValue(value === undefined || value === null || typeof value === "string",
    "Native finding has an invalid severity");
  switch (value?.toLowerCase()) {
    case "error": case "high": case "critical": return "error";
    case "note": case "low": case "info": case "information": case "style": return "note";
    default: return "warning";
  }
}

function descriptor(tool, finding) {
  switch (tool) {
    case "semgrep-ce":
      return { id: finding.check_id, message: finding.extra?.message, severity: finding.extra?.severity,
        file: finding.path, start: finding.start?.line, end: finding.end?.line,
        column: finding.start?.col, endColumn: finding.end?.col };
    case "checkov":
      return { id: finding.check_id, message: finding.check_name, severity: finding.severity,
        file: finding.file_path, start: finding.file_line_range?.[0], end: finding.file_line_range?.[1] };
    case "bandit":
      return { id: finding.test_id, message: finding.issue_text, severity: finding.issue_severity,
        file: finding.filename, start: finding.line_number };
    case "shellcheck":
      return { id: `SC${finding.code}`, message: finding.message, severity: finding.level,
        file: finding.file, start: finding.line, end: finding.endLine,
        column: finding.column, endColumn: finding.endColumn };
    case "psscriptanalyzer":
      return { id: finding.RuleName, message: finding.Message, severity: finding.Severity,
        file: finding.ScriptPath, start: finding.Line, column: finding.Column };
    default: throw new Error("Unsupported SARIF conversion tool");
  }
}

function nativeSarif(native, files, root, version) {
  const documents = Array.isArray(native) ? native : [native];
  function location(value, required = false) {
    if (!value.physicalLocation && !required) return value;
    const physical = value.physicalLocation;
    const artifact = physical?.artifactLocation;
    requireValue(typeof artifact?.uri === "string", "Native zizmor result needs an artifact URI");
    const filename = sourcePath(artifact.uri.startsWith("file:") ? artifact.uri : decodeURIComponent(artifact.uri),
      files, root, "zizmor");
    if (physical.region) {
      const span = physical.region;
      region(span.startLine, span.endLine, span.startColumn, span.endColumn);
    }
    return { ...value, physicalLocation: { ...physical,
      artifactLocation: { uri: filename.split("/").map(encodeURIComponent).join("/") } } };
  }
  return documents.flatMap((document) => document.runs).map((run) => {
    requireValue(run.tool.driver.name === "zizmor" &&
      [run.tool.driver.version, run.tool.driver.semanticVersion].every((observed) =>
        observed === undefined || observed === version), "Unexpected native zizmor driver identity");
    const results = run.results.map((result) => {
      requireValue(Array.isArray(result.locations) && result.locations.length > 0,
        "Native zizmor result needs a source location");
      return { ...result, locations: result.locations.map((entry) => location(entry, true)),
        ...(result.relatedLocations ? { relatedLocations: result.relatedLocations.map((entry) => location(entry)) } : {}),
        ...(result.codeFlows ? { codeFlows: result.codeFlows.map((flow) => ({ ...flow,
          threadFlows: flow.threadFlows.map((thread) => ({ ...thread,
            locations: thread.locations.map((entry) => ({ ...entry, location: location(entry.location) })),
          })),
        })) } : {}) };
    });
    return { ...run, tool: { ...run.tool, driver: { ...run.tool.driver, version } }, results,
      automationDetails: { id: "/tool:zizmor/" } };
  });
}

export function toSarif(tool, native, version, executions, sourceRoot) {
  requireValue(NAMES[tool] && /^\d+(?:\.\d+){2,3}(?:[+-][A-Za-z0-9.-]+)?$/.test(version) &&
    Array.isArray(executions) && executions.length > 0 && path.isAbsolute(sourceRoot),
  "An actual version, source root and validated analyzer executions are required");
  const reports = Array.isArray(native) ? native : [native];
  const documents = tool === "checkov" && executions.length === 1 ? [reports] : reports;
  requireValue(documents.length === executions.length, "Native reports do not match analyzer executions");
  const findings = documents.flatMap((document, index) =>
    validateReport(tool, document, version, executions[index].files, executions[index].frameworks)
      .map((finding) => ({ finding, files: new Set(executions[index].files) })));
  let runs;
  if (tool === "zizmor") {
    const original = documents.flatMap((document, index) =>
      nativeSarif(document, new Set(executions[index].files), sourceRoot, version));
    const driver = original[0].tool.driver;
    const rules = new Map();
    const results = [];
    for (const run of original) {
      for (const rule of run.tool.driver.rules ?? []) {
        requireValue(!rules.has(rule.id) || JSON.stringify(rules.get(rule.id)) === JSON.stringify(rule),
          "Native zizmor batches disagree on rule identity");
        rules.set(rule.id, rule);
      }
      for (const result of run.results) {
        requireValue(typeof result.ruleId === "string" && rules.has(result.ruleId),
          "Native zizmor finding has no bound rule identity");
        const { ruleIndex: _batchIndex, ...finding } = result;
        results.push(finding);
      }
    }
    runs = [{ tool: { driver: { ...driver, rules: [...rules.values()] } },
      automationDetails: { id: "/tool:zizmor/" }, results,
      invocations: original.flatMap((run) => run.invocations) }];
  } else {
    const rules = new Map();
    const results = findings.map(({ finding, files }) => {
      const value = descriptor(tool, finding);
      requireValue(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 512 &&
        typeof value.message === "string" && value.message.trim().length > 0,
      "Native finding lacks its actual rule/message identity");
      const filename = sourcePath(value.file, files, sourceRoot, tool);
      const span = region(value.start, value.end, value.column, value.endColumn);
      rules.set(value.id, { id: value.id });
      return { ruleId: value.id, level: level(value.severity, tool), message: { text: value.message },
        properties: { originalSeverity: value.severity ?? null },
        locations: [{ physicalLocation: {
          artifactLocation: { uri: filename.split("/").map(encodeURIComponent).join("/") },
          ...(span ? { region: span } : {}),
        } }] };
    });
    runs = [{ tool: { driver: { name: NAMES[tool], version, rules: [...rules.values()] } },
      automationDetails: { id: `/tool:${tool}/` }, results,
      invocations: [{ executionSuccessful: true }] }];
  }
  requireValue(runs.reduce((total, run) => total + run.results.length, 0) === findings.length,
    "SARIF conversion changed the actual finding count");
  return { version: "2.1.0", $schema: "https://json.schemastore.org/sarif-2.1.0.json", runs };
}

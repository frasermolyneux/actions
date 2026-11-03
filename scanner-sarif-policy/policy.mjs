import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_SARIF_BYTES = 100 * 1024 * 1024;
const INFORMATIONAL_RULES = new Map([
  ["zizmor/self-repository", "Prefer commit-bound self-repository syntax; this is source-binding policy, not an exploitable finding."],
]);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function applyPolicy(document) {
  requireValue(document?.version === "2.1.0" && Array.isArray(document.runs),
    "Expected a SARIF 2.1.0 document");

  let findings = 0;
  for (const run of document.runs) {
    requireValue(run?.tool?.driver && Array.isArray(run.results),
      "Each SARIF run must include a tool driver and results");
    const isZizmor = run.tool.driver.name?.toLowerCase() === "zizmor";
    for (const result of run.results) {
      requireValue(typeof result.ruleId === "string" && result.ruleId.length > 0,
        "Each SARIF result must retain its rule identity");
      findings += 1;
      if (!isZizmor) continue;

      const rationale = INFORMATIONAL_RULES.get(result.ruleId);
      if (rationale) {
        result.properties = {
          ...result.properties,
          scannerPolicyClass: "informational-static-policy",
          scannerPolicyRationale: rationale,
          scannerOriginalLevel: result.level ?? null,
        };
        result.level = "note";
      } else {
        result.properties = {
          ...result.properties,
          scannerPolicyClass: "security",
        };
      }
    }
  }

  const retained = document.runs.reduce((total, run) => total + run.results.length, 0);
  requireValue(retained === findings, "Scanner policy must not add or remove findings");
  return document;
}

export async function run(sarifFile = process.env.SCANNER_SARIF_FILE) {
  requireValue(typeof sarifFile === "string" && sarifFile.length > 0,
    "sarif-file is required");
  const resolved = await realpath(sarifFile);
  const metadata = await stat(resolved);
  requireValue(metadata.isFile() && metadata.size <= MAX_SARIF_BYTES,
    "SARIF input must be a file within the size bound");

  const document = applyPolicy(JSON.parse(await readFile(resolved, "utf8")));
  await writeFile(resolved, `${JSON.stringify(document)}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}

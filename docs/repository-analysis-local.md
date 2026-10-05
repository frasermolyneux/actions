# Local repository analysis

`repository-analysis-local` runs one local analyzer selected by the live
`repository-analysis-v1` preflight. It implements the permitted local backends; it does not
execute CodeQL or Sonar, upload to GitHub Security, deploy, publish packages, or implement
the complete estate schedule/freshness/build/coverage contract.

Use an exact reviewed `repository-analysis-local/v1.X.Y` tag. The action requires a Linux
runner with trusted `/usr/bin/git` and `/usr/bin/pwsh`. It installs Node.js 22 through the released
preflight and Python 3.12 where needed. The metadata token is used only by preflight; scanner
processes receive an explicit environment allowlist without provider or Actions credentials.
Python analyzers use isolated virtual environments. PowerShell uses an explicitly pinned
saved module. Semgrep downloads the pinned public rule revision without authentication.
Scanner entry points use the installed virtual environment's absolute paths, not a target
repository's executable search path.

The six backends and versions are owned by `repository-analysis-local/tools.json`.
Semgrep CE uses the pinned community security rules, metrics/version checks disabled,
without login, cloud publication, local builds or autofix. The current upstream rules use
the [Semgrep Rules License](https://semgrep.dev/legal/rules-license): internal use only,
not rule redistribution or providing a scanning service to others. Each runner downloads
its own immutable upstream revision; the action does not redistribute the rules.
TypeScript selects both its own rules directory and the shared JavaScript/TypeScript rules.
Semgrep runs each selected language separately, retaining the native report collection;
unknown module/script extensions cannot be sent to unrelated language parsers.
Private C++ analysis is explicitly unavailable; the community C rules are not claimed to
analyze C++. Public C++ remains eligible for the separate CodeQL workflow.
zizmor runs offline with strict
collection. Checkov runs only the selected IaC frameworks, without platform authentication
or external module downloads. Bandit, ShellCheck and PSScriptAnalyzer parse source locally.
These alternatives are not claimed to be CodeQL-equivalent.

## Source and result boundaries

The actual Git checkout must match `expected-sha` and the immutable workflow repository
identity. Tracked changes are rejected. Index modes distinguish owned source from
submodule gitlinks; dependencies are not recursed or copied, and selected tracked symlinks
are rejected even if a checkout materializes the link as a regular file.
Selected maintained source is copied into an
isolated snapshot; no target analyzer configuration, ignored untracked file, user credential
configuration or dependency/vendor/build-output/fixture directory is used. Extensionless
supported-shebang scripts are included regardless of their maintained-source location,
subject to the same vendor/build-output exclusions. Terraform includes `.tf`, `.tf.json`,
`.tfvars` and `.tfvars.json`; JSON resource definitions require the native `terraform_json`
Checkov framework, not merely the Terraform source-inventory count.
The pinned Checkov JSON runner cannot bind co-located `.tfvars`/`.tfvars.json` overrides.
That layout fails explicitly without a completed result; adding the HCL runner does not
fix the native limitation. Variable inputs alone are not standalone policy evaluation.
Extensionless PowerShell is analyzed as script text with its originating source path;
completed PowerShell reports must identify every selected file, not just match a count.
Every selected capability needs nonempty source.
First-party monorepo source under `packages/` is included. TypeScript module files
(`.mts`, `.cts`) and Bash/Dash/Ksh file extensions are included.
Bandit receives no additional native filename exclusions: the isolated tracked
inventory already defines its source set. Its default `.git` substring exclusion
would otherwise silently omit selected `.github` Python automation. Per-file
completion remains mandatory; missing metrics never become clean evidence.

The runner verifies actual engine versions and native report structure, counts, parsing
errors, selected framework completeness and available per-file evidence. A second checkout
identity/change check prevents publishing results after source changed during execution.
Failed execution, malformed output, missing source coverage and no evaluated IaC policies
fail explicitly. Findings are valid completed results,
not scanner failures. This component does not impose a new historical-backlog merge gate.

Outputs point to `report.json`, the native report in `native.json` and finding-preserving
SARIF in `analysis.sarif` (`sarif-file`). Conversion retains actual rule/message/location
identities, version and counts; incomplete native output or unanalysed finding paths
cannot become completed SARIF. File-level diagnostics do not invent line numbers.
ShellCheck style diagnostics retain their original severity and publish as notes.
PowerShell numeric severities follow the pinned module's actual enum
(`Information=0`, `Warning=1`, `Error=2`); parsing errors fail, rather than being
represented as completed security findings.
The `source-directory` input defaults to the workspace and can select a separate target
checkout, keeping trusted shared helpers outside the scanned Git tree. The bounded local
result identifies repository/visibility, frozen source SHA, policy/engine/rule digests,
actual tool/package versions, source coverage, finding count and completion time.
The engine digest includes a filename/length-delimited hash manifest of the composite,
all execution helpers and its commit-bound sibling context action/policy.
The preflight uses native `$/` self-repository resolution rather than a mutable ref
or target workspace helper. Positional inputs use an end-of-options delimiter and byte-bounded
batches; every native batch must validate before completion. `native.json` retains a report
collection for language-scoped or multi-batch execution, without suppressing partial failures.
Publication is **originating-repository artifact only**; callers must keep private artifacts
and summaries private. Never send these native reports or finding excerpts to public estate
reporting. The shared public/native publication and aggregate result workflows are separate
migration packages.
The [selected local workflow](repository-analysis-workflows.md) implements the local
tool matrix and public-native publishing portion; it is not full-profile completion.
Failed native runs also expose an originating-repository-only diagnostic directory.
Diagnostics are never completed scan evidence and may contain source/finding excerpts;
keep them private when the originating repository is private.

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
  with:
    persist-credentials: false
- id: local
  uses: frasermolyneux/actions/repository-analysis-local@repository-analysis-local/v1.X.Y
  with:
    profile: ${{ vars.REPOSITORY_ANALYSIS_PROFILE }}
    tool: bandit
    expected-sha: ${{ github.sha }}
    github-token: ${{ github.token }}
```

The `Local analysis contracts` workflow runs portable policy/analyzer contracts on both
Ubuntu and Windows, and executes all six real pinned tools on Linux against synthetic
private-policy fixtures with deliberately detectable findings, including both Terraform
representations, selected `.github` Python automation, native ShellCheck style
diagnostics, the actual installed PowerShell severity enum, supported Ansible
certificate-validation policies and an uninitialized
dependency gitlink. Those fixtures do not contain
private repository source and are not evidence that the estate callers have been migrated.
Negative contract tests cover invalid selection, credential isolation and malformed,
incomplete or parsing-error reports. Native zizmor completion requires nonempty
invocations with explicit success, and conversion preserves those invocations rather
than fabricating successful completion. Actual private-repository execution remains a rollout
acceptance requirement.

```powershell
node --test repository-analysis-local\scan.test.mjs repository-analysis-local\sarif.test.mjs
git diff --check
```

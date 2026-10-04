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

The six backends and versions are owned by `repository-analysis-local/tools.json`.
Semgrep CE uses the pinned community security rules, metrics/version checks disabled,
without login, cloud publication, local builds or autofix. zizmor runs offline with strict
collection. Checkov runs only the selected IaC frameworks, without platform authentication
or external module downloads. Bandit, ShellCheck and PSScriptAnalyzer parse source locally.
These alternatives are not claimed to be CodeQL-equivalent.

## Source and result boundaries

The actual Git checkout must match `expected-sha` and the immutable workflow repository
identity. Tracked changes are rejected. Selected maintained source is copied into an
isolated snapshot; no target analyzer configuration, ignored untracked file, user credential
configuration or dependency/vendor/build-output/fixture directory is used. Extensionless
supported scripts are included. Every selected capability needs nonempty source.

The runner verifies actual engine versions and native report structure, counts, parsing
errors, selected framework completeness and available per-file evidence. A second checkout
identity/change check prevents publishing results after source changed during execution.
Failed execution, malformed output, missing source
coverage and no evaluated IaC policies fail explicitly. Findings are valid completed results,
not scanner failures. This component does not impose a new historical-backlog merge gate.

Outputs point to `report.json` and the native report in `native.json`. The bounded local
result identifies repository/visibility, frozen source SHA, policy/engine/rule digests,
actual tool/package versions, source coverage, finding count and completion time.
Publication is **originating-repository artifact only**; callers must keep private artifacts
and summaries private. Never send these native reports or finding excerpts to public estate
reporting. The shared public/native publication and aggregate result workflows are separate
migration packages.

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

The `Local analysis contracts` workflow executes all six real pinned tools against synthetic
private-policy fixtures with deliberately detectable findings. Those fixtures do not contain
private repository source and are not evidence that the estate callers have been migrated.
Negative contract tests cover invalid selection, credential isolation and malformed,
incomplete or parsing-error reports. Actual private-repository execution remains a rollout
acceptance requirement.

```powershell
node --test repository-analysis-local\scan.test.mjs
git diff --check
```
Scanner entry points use the installed virtual environment's absolute paths, not a target
repository's executable search path.

# .NET Test Environment and Reporting

Two composites support repositories that run `dotnet test` suites (optionally alongside an npm-based
front end) and want consistent TRX reporting without duplicating the parsing/annotation logic in every
consumer repo.

## `dotnet-node-setup`

Sets up the .NET SDK from `global.json`, Node.js from `.node-version`, npm caching, and NuGet package
caching in one step. Intended for repositories that combine a .NET solution with an npm-managed front
end (e.g. Razor/Blazor apps bundling SCSS/TypeScript).

```yaml
- uses: frasermolyneux/actions/dotnet-node-setup@dotnet-node-setup/v1
  with:
    npm-cache-dependency-path: src/MyApp/package-lock.json
```

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `npm-cache-dependency-path` | yes | - | Path to `package-lock.json`, passed through to `actions/setup-node`. |
| `global-json-file` | no | `global.json` | Path used to resolve the .NET SDK version. |
| `node-version-file` | no | `.node-version` | Path containing the required Node.js version. |
| `nuget-cache-key-files` | no | common project/lock globs | Newline-separated glob list hashed for the NuGet cache key. |

Output: `dotnet-version` - the resolved SDK version (`dotnet --version`).

Repository-specific steps (npm install, solution build, browser installs, etc.) stay in the consumer
repository; this composite only covers runtime setup and caching.

## `dotnet-test-report`

Parses exactly one TRX file into a bounded, schema-1 JSON report, uploads the TRX (and any other
diagnostics) as an artifact, writes a step summary table, and emits `::error` annotations for failures
(optionally mapped back to a repository-relative source file/line).

```yaml
- name: Run Unit tests
  id: tests
  continue-on-error: true
  run: dotnet test src/MyApp.Tests --configuration Release --logger trx --results-directory TestResults/Unit

- uses: frasermolyneux/actions/dotnet-test-report@dotnet-test-report/v1
  with:
    suite: Unit
    results-directory: TestResults/Unit
    run-outcome: ${{ steps.tests.outcome }}
    artifact-name: test-results-Unit
    source-path-pattern: '^src/MyApp\.Tests/.+\.cs$'
```

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `suite` | yes | - | Label for the suite (e.g. `Unit`, `HttpIntegration`). |
| `results-directory` | yes | - | Directory expected to contain exactly one `*.trx`. |
| `run-outcome` | no | `unknown` | Outcome of the preceding test step. A `success` outcome that doesn't resolve to a passing report fails this action. |
| `artifact-name` | no | *(none)* | When set, uploads `artifact-paths` (default: everything under `results-directory`) as an artifact. |
| `artifact-paths` | no | `results-directory/**` | Newline-separated paths to upload. |
| `retention-days` | no | `7` | Artifact retention. |
| `source-path-pattern` | no | *(none)* | Regex a repository-relative source path must match before a failure gets a file/line annotation. Omit to skip source-mapped annotations. |
| `repository-root` | no | `GITHUB_WORKSPACE` | Root used to resolve relative source paths. |

Outputs: `report` (the JSON report) and `artifact-id`.

The report schema is intentionally minimal - `schema`, `suite`, `status`, `reason`, `total`, `executed`,
`passed`, `failed`, `skipped`, `durationSeconds`, `artifactId` - so it is safe to pass between jobs as a
job output and aggregate across suites in a consuming repository. It does not include coverage or
performance-baseline data: repositories that need that (for example a coverage/perf-baseline gate) layer
their own enrichment step on top of this action's `report` output before publishing or gating on it.

# .NET Test Environment and Reporting

These composites support repositories that run `dotnet test` suites (optionally alongside an npm-based
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

Output: `dotnet-version` - the resolved SDK version (`dotnet --version`).

Repository-specific steps (npm install, solution build, browser installs, etc.) stay in the consumer
repository; this composite only covers runtime setup and caching.

## `dotnet-test-report`

Parses TRX files into a bounded, schema-1 JSON report, uploads the TRX (and any other
diagnostics) as an artifact, writes a step summary table, and emits `::error` annotations for failures
(optionally mapped back to a repository-relative source file/line).

```yaml
- name: Run Unit tests
  id: tests
  run: dotnet test src/MyApp.Tests --configuration Release --logger trx --results-directory TestResults/Unit

- uses: frasermolyneux/actions/dotnet-test-report@dotnet-test-report/v1
  if: always()
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
| `results-directory` | yes | - | Directory expected to contain exactly one `*.trx` by default; relative paths resolve against `repository-root`. |
| `allow-multiple` | no | `false` | Accept all project/framework TRX files from one isolated invocation (v1.1+). Never point this at a reused results directory. |
| `run-outcome` | no | `unknown` | Outcome of the preceding test step. A `success` outcome that doesn't resolve to a passing report fails this action. |
| `artifact-name` | no | *(none)* | When set, uploads `artifact-paths` (default: everything under `results-directory`) as an artifact. |
| `artifact-paths` | no | `results-directory/**` | Newline-separated paths to upload. |
| `retention-days` | no | `7` | Artifact retention. |
| `artifact-id` | no | *(none)* | Reuse an already-uploaded artifact's ID instead of uploading a new one (e.g. when another step already uploaded these results). Takes precedence over `artifact-name`/`artifact-paths`. |
| `source-path-pattern` | no | *(none)* | Regex a repository-relative source path must match before a failure gets a file/line annotation. Omit to skip source-mapped annotations. |
| `repository-root` | no | `GITHUB_WORKSPACE` | Root used to resolve relative source paths. |

Outputs: `report` (the JSON report) and `artifact-id`.

The report schema is intentionally minimal - `schema`, `suite`, `status`, `reason`, `total`, `executed`,
`passed`, `failed`, `skipped`, `durationSeconds`, `artifactId` - so it is safe to pass between jobs as a
job output and aggregate across suites in a consuming repository. It does not include coverage or
performance-baseline data: repositories that need that (for example a coverage/perf-baseline gate) layer
their own enrichment step on top of this action's `report` output before publishing or gating on it.

Version 1.1 keeps single-file validation as the default. Multi-file mode accepts at most 128 files,
32 MiB per file and 128 MiB combined, with at most one million results. Every file is validated;
one malformed file invalidates the complete report. Counts include separate target-framework runs,
and `durationSeconds` sums their TRX windows, not elapsed wall-clock time. Empty filtered projects
are allowed only when the invocation as a whole executes tests. Zero tests and all-skipped
invocations fail when the test step claimed success.

The original test step must remain authoritative: **do not use `continue-on-error` on it**.
Reporting runs with `if: always()` to retain failure evidence, but a `failure` input does not itself
throw (it reports the already-failed command). Invalid reports from a `success` command do throw.

## `dotnet-test`

Runs the existing `dotnet test` command in a fresh, unique runner-temporary directory, using
automatically generated TRX filenames rather than overwriting one fixed filename across projects
or frameworks. It always reports/uploads evidence after the test command and never suppresses
its failure. It requires an already-configured .NET SDK and repository checkout.

```yaml
- uses: frasermolyneux/actions/dotnet-test@dotnet-test/v1
  id: tests
  with:
    suite: Unit
    working-directory: src
    artifact-name: test-results-Unit
```

| Input | Default | Description |
| --- | --- | --- |
| `suite` | `Unit` | Report label. |
| `working-directory` | `src` | Solution/project directory. |
| `project` | `.` | Project or solution relative to that directory. |
| `configuration` | `Release` | Build configuration. |
| `no-build` | `true` | Reuse current outputs; `false` builds/restores before testing. |
| `filter` | `FullyQualifiedName!~IntegrationTests` | Preserves existing unit-test selection. Set `""` to run all tests in a selected integration project. |
| `artifact-name` | `test-results-Unit` | Must be unique within the workflow run, including matrix jobs. |
| `source-path-pattern` | `^src/.+\.(?:cs\|fs\|feature)$` | Eligible source annotations; paths outside the checkout are always rejected. |

Outputs: `report` and `artifact-id`. TRX artifacts are retained for seven days. Browser installation,
coverage profiles, external-service setup and repository-specific diagnostics remain with consumers.
This runner targets the VSTest/TRX contract; it does not change projects to Microsoft.Testing.Platform.

### Opt in from existing CI composites

`dotnet-ci`, `dotnet-web-ci` and `dotnet-func-ci` v2.1 add `test-reporting: "true"` and the
`test-report` output. `dotnet-playwright-tests` v1.2 supports the same opt-in while retaining its
existing solution-wide integration filter. Defaults remain unchanged so repositories without test
projects are not broken by rolling tags. Opted-in repositories must actually execute tests.
Build/version/package/application outputs and artifact names are unchanged.

## `test-results-summary`

Generalizes portal-web's bounded summaries and owned, stale-run-aware PR comment publishing.
Run it in a separate job **without a repository checkout**. Pass `toJSON(needs)` from only the test
jobs. Each job exposes `test_report`, or multiple outputs ending in `_test_report`; build-version
and other unrelated outputs are ignored. Missing/invalid reports are explicit non-success rows,
and failed/cancelled/skipped job outcomes override passing TRX.

```yaml
jobs:
  build-and-test:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    outputs:
      test_report: ${{ steps.ci.outputs.test-report }}
    steps:
      - id: ci
        uses: frasermolyneux/actions/dotnet-ci@dotnet-ci/v2.1
        with:
          dotnet-version: 10.0.x
          test-reporting: "true"

  test-results:
    if: always()
    needs: build-and-test
    permissions:
      pull-requests: write
    runs-on: ubuntu-latest
    concurrency:
      group: test-results-${{ github.repository }}-${{ github.event.pull_request.number || github.ref }}
      cancel-in-progress: false
    steps:
      - uses: frasermolyneux/actions/test-results-summary@test-results-summary/v1
        with:
          jobs: ${{ toJSON(needs) }}
```

The action writes a step summary on every event. It creates/updates a single marker-owned
`github-actions[bot]` comment only on same-repository `pull_request` events, excluding Dependabot
actors/authors. Forks and other events need no write credentials and still receive summaries and
test-job artifacts. It checks the PR head/state before writing and refuses to overwrite a newer
run or attempt. Keep the shown job-level concurrency to serialize same-PR publishers.
`publish-comment: "false"` disables comment publication. API failures fail the isolated publisher
job explicitly; the test/build jobs remain the authoritative gate.

The summary accepts at most 32 jobs/64 reports and outputs at most 32 KiB of sanitized JSON.
It never includes test names, stack traces, arbitrary report fields, or inferred cross-suite totals.
Portal-web keeps its richer coverage/provenance, browser bootstrap and required-suite policy local.

## Validation

`node --test dotnet-test-report/report.test.js test-results-summary/summary.test.js` exercises parsing,
failure propagation, source annotations, and comment ownership/write-context/stale-run behavior.
The `Test reporting contracts` workflow additionally runs two real xUnit projects on both .NET 9
and .NET 10 on Linux and Windows, and asserts that all four executions and the artifact ID survive.

# Code Quality reusable workflow

Use this reusable workflow to run SonarCloud analysis, CodeQL, and shared build/test composites without duplicating boilerplate across repositories. It supports regular .NET solutions (`dotnet-ci`), ASP.NET/web apps (`dotnet-web-ci`), Azure Functions (`dotnet-func-ci`), and C++/CMake projects (`cmake-ci`).

For .NET Sonar analyses, the requested SDKs are installed before installing or
starting the scanner, including when the scanner is cached. The supplied SDK
versions must satisfy the caller's `global.json`.
The workflow is released as the `codequality` package. Resolve its latest exact
patch tag to a full commit SHA before substituting `<FULL_RELEASE_SHA>` below.
The commit-bound first-party dependencies require runner 2.336.0 or later.

## Inputs and secrets

The [workflow definition](../.github/workflows/codequality.yml) is the source
for inputs, defaults, outputs and secrets. Set `skip-sonar` or `skip-codeql`
when the corresponding analysis is not wanted. `SONAR_TOKEN` is optional in
the workflow interface but is needed when running SonarCloud analysis.
For web and Functions builds, provide `dotnet-project`; the web action expects
a single project name without path separators. Opt-in `test-reporting` requires
real test execution; see [test reporting](dotnet-test-reporting.md).

## Structured test evidence

When .NET `test-reporting` is enabled, a separate always-run job publishes the selected composite's report through `test-results-summary`. It receives only the sanitized test output and authoritative analysis-job outcome, checks out no source, has no GitHub token permissions, and never publishes PR comments. Scanner/setup/build/artifact failures cannot be replaced by passing test counters.

The optional workflow output `quality-evidence-artifact-id` identifies the exact uploaded `estate-quality.json` artifact. This producer is enabled consistently for every existing opted-in .NET caller; no caller-side extra summary is needed. CMake and callers without real test reporting remain unchanged.

Consumers must independently qualify the originating caller repository, default-branch workflow, revision and exact run attempt. PR/fork runs are not estate-health evidence. The report represents this workflow's measured Unit scope, not integration/browser suites run elsewhere, actual deployment, native coverage-provider import or proof of arbitrary custom checkout revisions. An estate producer declaration therefore names the **caller** workflow, not this reusable file in the actions repository.

## Usage
Reference the workflow directly from consuming repositories:
Replace the SDK and target-framework placeholders with values from the consumer.

### Standard .NET solution
```yaml
name: Code Quality

on:
  push:
    branches:
      - main
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  actions: read
  security-events: write

jobs:
  quality:
    uses: frasermolyneux/actions/.github/workflows/codequality.yml@<FULL_RELEASE_SHA> # codequality/vX.Y.Z
    with:
      sonar-project-key: frasermolyneux_my-project
      build-target: dotnet-ci
      skip-format-check: true
      dotnet-version: <YOUR_SDK_VERSION>
      src-folder: src
    secrets:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

### ASP.NET / Web app
```yaml
name: Code Quality

on:
  push:
    branches:
      - main
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  actions: read
  security-events: write

jobs:
  quality:
    uses: frasermolyneux/actions/.github/workflows/codequality.yml@<FULL_RELEASE_SHA> # codequality/vX.Y.Z
    with:
      sonar-project-key: frasermolyneux_my-webapp
      build-target: dotnet-web-ci
      skip-format-check: true
      dotnet-project: My.WebApp
      dotnet-version: <YOUR_SDK_VERSION>
      src-folder: src
      publish-frameworks: <YOUR_TARGET_FRAMEWORK>
    secrets:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

### Azure Functions
```yaml
name: Code Quality

on:
  push:
    branches:
      - main
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  actions: read
  security-events: write

jobs:
  quality:
    uses: frasermolyneux/actions/.github/workflows/codequality.yml@<FULL_RELEASE_SHA> # codequality/vX.Y.Z
    with:
      sonar-project-key: frasermolyneux_portal-server-events
      build-target: dotnet-func-ci
      skip-format-check: true
      dotnet-project: XtremeIdiots.Portal.ServerEvents.App
      dotnet-version: <YOUR_SDK_VERSION>
      src-folder: src
    secrets:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

The workflow caches the SonarCloud scanner and package cache, initializes CodeQL for the configured language(s), runs the selected composite build, and finalizes Sonar analysis. Keep `fetch-depth: 0` in place to ensure CodeQL and Sonar have full history context.

When a repository contains the platform-managed `.sonarcloud.json`, the workflow validates its
exact versioned schema and translates its exclusions and ignored rules into scanner properties.
The scanner is launched with an argument array so managed values are never evaluated by a shell.
Missing policy files preserve the previous scanner behavior; malformed or unsafe files fail the
analysis. The file is generated from `platform-workloads` declarations by `platform-devex` and
must not be edited locally.

The shared DevOps Secure Scanning workflow applies the released
`scanner-sarif-policy` action before upload. It retains every finding and leaves security
rules at their native severity. Only the exact `zizmor/self-repository` source-binding
recommendation is classified as informational static policy, with its original level and
rationale retained in SARIF properties.

### C++ / CMake project

The CMake argument-list inputs are parsed using Python 3 `shlex` on PATH. Quotes
and backslash escapes group arguments; shell expansion, globbing, substitution,
redirection and pipelines are not executed, and unmatched quotes fail the step.
The same contract applies to the current `cmake-ci` action.
The workflow's web build uses the `dotnet-web-ci` action from the same commit
as the reusable workflow, rather than depending on a separately published tag.

```yaml
name: Code Quality

on:
  push:
    branches:
      - main
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  actions: read
  security-events: write

jobs:
  quality:
    uses: frasermolyneux/actions/.github/workflows/codequality.yml@<FULL_RELEASE_SHA> # codequality/vX.Y.Z
    with:
      sonar-project-key: frasermolyneux_portal-cod4x-plugin
      build-target: cmake-ci
      codeql-languages: cpp
      codeql-category: /language:cpp
      cmake-source-dir: .
      cmake-build-dir: build
      cmake-configure-args: -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
      cmake-build-args: --config Release
      ctest-args: --output-on-failure --build-config Release
    secrets:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

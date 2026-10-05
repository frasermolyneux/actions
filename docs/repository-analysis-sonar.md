# Source-bound Sonar analysis

`repository-analysis-sonar` and
`.github/workflows/repository-analysis-sonar.yml` provide the Sonar portion of the
estate analysis implementation. This is **not a complete profile**: CodeQL/local
results, authenticated freshness reuse and full-profile aggregation remain separate.
The workstream has not adopted this caller across the estate.

## Admission and execution

The reusable workflow accepts `profile`, `recipe`, `build` and `expected-sha`, plus
the existing `SONAR_TOKEN` secret. Its real scanner job is named `Code Quality` so
a caller job named `quality` retains the protected `quality / Code Quality` context;
this is the actual build/scan/provider verification, not an unconditional bridge.
It reads live GitHub repository visibility before
checkout or installation. Private, exempt, foreign-PR and draft-PR execution is
refused, not reported as a successful empty scan. Installation/build entry points
also recheck public eligibility; native begin/end require the prepared producer.
The driver must match the catalog source languages: C# for .NET, C++ for CFamily,
and JavaScript/TypeScript/Python/PHP for the CLI. Fixture acceptance declares its
fixture language explicitly without changing Actions' estate source profile.

The actual run attempt independently binds repository ID, caller path/revision,
actual checkout, logical PR head and the executing reusable definition. Foreign
callers must use an immutable `repository-analysis-sonar/vX.Y.Z` release. Only
Actions' own contracts can use an executing branch/merge definition. Production
admission is not relaxed for candidate acceptance.

### Accepted first-party trust boundary

The estate owner explicitly chose the **trusted-first-party** policy rather than
isolated publication. Withholding tokens from build/test environment variables is
credential minimization, **not process isolation**: trusted build code on the same
runner can alter the scanner or observe a later token-bearing process. This
residual risk is accepted only inside the following authenticated boundary.

Before source checkout in planning, and again before prepare/begin/end/CLI upload,
live originating metadata must authorize the exact current PR head, repository
and personal owner. PR authors must be the repository owner or the exact GitHub
Copilot/Dependabot service identities (login, immutable ID and bot type). The run
actor must be that owner or matching approved automation; `github-actions[bot]`
is accepted only when paired with a verified Dependabot author. Other bots,
collaborators, fork authors, draft/closed PRs and superseded heads are denied.
Outside PRs, analysis is confined to the default branch or explicit owner dispatch.
Completed proofs record this trust policy and accepted same-runner boundary.
On reruns, the authenticated current triggering actor is checked; an owner rerun
can authorize an already approved automation origin but never an untrusted author.

This policy does not authorize generic bot publication or change deployment,
account, visibility or human-final-merge rules. New automation origins require a
separate explicit policy decision; denials are surfaced rather than reported clean.

Sonar's live project metadata must show a public project in `frasermolyneux`,
the exact GitHub repository binding and `autoscanEnabled: false`. Permission
errors, unknown method state and ownership/visibility changes fail explicitly.
This implementation never toggles Automatic Analysis or changes project settings.
The existing method remains unchanged until its replacement is accepted.

Only `contents: read` and `actions: read` are used. There is no merge App key,
OIDC permission, cloud credential, private SARIF upload or deployment step.
Provider tokens are supplied only to provider/preflight/scanner steps, not builds
or tests. Scanners do not use mutable, version-independent tool caches.

## Recipes

Scanner recipe:

```json
{
  "version": 1,
  "driver": "dotnet",
  "projectKey": "frasermolyneux_dotnet-caching",
  "sourceDirectory": "src",
  "coverage": "cobertura"
}
```

Supported drivers are `dotnet`, `cli` and `cpp`. Source directories must be
repository-relative and physically inside the exact unchanged Git worktree.
CLI/C++ reauthorize that unchanged tree, producer and live project immediately
after repository build scripts and before the token-bearing upload.
Tracked-file changes and all untracked files (including Git-ignored
source and unknown scanner-supported extensions) outside the driver's known excluded/generated output directories fail
before publication. A lifecycle hook cannot silently add scanned source to the
authenticated commit.
Supported coverage is C# `cobertura` or explicit `not-applicable`.
The recipe digest includes the declared build recipe, not just project/source.

SDK build recipe:

```json
{
  "kind": "dotnet",
  "sdk": ["9.0.x", "10.0.x"],
  "globalJson": "global.json",
  "solution": ".",
  "skipFormat": true,
  "tests": true
}
```

Declared SDKs and the repository's actual `global.json` SDK are installed
**before** installing or beginning the pinned Sonar .NET scanner **11.3.0**.
The final SDK-selection filename must be exactly `global.json`, not a matching
suffix that the .NET CLI would not discover.
It must be in the source directory or one of its repository ancestors, not an
unrelated sibling or descendant. Solution inputs are paths, never option-prefixed
values that could make restore/build return successful help without compilation.
Restore, original format policy and Release/CI build are preserved. Successful
unit tests use the existing `FullyQualifiedName!~IntegrationTests` selection and
pinned native `dotnet-coverage` **18.11.2**, without test-package dependency changes.
Verification reads the producer's same package pin, accepts its supported native
build-metadata suffix, and preserves the observed version without admitting another package version.
Separate existing integration/browser jobs and runsettings are not replaced.
Repositories with no declared tests select `tests: false` and
`coverage: not-applicable`; no zero-test success is fabricated.

`netfx` uses Windows, declared analysis SDKs, `nuget restore <solution>` and the
original MSBuild Release/Any CPU arguments. It requires explicit absent tests and
coverage; Framework 4.8 is exercised by a real hosted build fixture.

`cmake` retains the original argument arrays. Its bounded supported configuration
contains `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`, optional
`-DCMAKE_BUILD_TYPE=Release` and the existing
`-DPORTAL_COD4X_BUILD_PLUGIN_BINARY=OFF` selection. It builds Release, runs the
original ctest arguments and requires real nonempty compile commands. This does
not enable a plugin binary or invent a coverage collector.

`script` retains `nodeVersion` (`20.x` or `22`) and explicit `npmInstall`.
The static-site recipe does not pretend its echo-only build is application testing
or invoke Static Web Apps deployment. CLI/C++ use the reviewed official scan action,
scanner **8.1.0.6389** and signature verification.

## Completed evidence, not accepted uploads

The verifier reads the fixed-provider receipt, enforces an absolute ten-minute
deadline (including provider latency, with each request bounded by its remaining
budget), and waits for the
actual compute task, and requires `REPORT`/`SUCCESS`, the expected project,
current invocation timing and source/producer properties.

Only the exact `Project scanner properties:` section supplies identity.
Server settings and repeated `Scanner properties of module:` sections may contain
different project keys; they cannot override the root. Duplicate root sections or
keys fail. Raw scanner context is parsed in memory and **never logged or retained**.
Coverage-import properties are checked in every section and are allowed only
for the selected Cobertura property in the one root section. Server/module
coverage settings are rejected without retaining their values;
another configured coverage source cannot supply the selected report's measures.

The output binds the actual task/analysis ID, repository/source/policy/recipe,
caller/definition and originating run attempt. It explicitly retains
`scope: sonar-task-and-selected-coverage-only` and `fullProfileEvidence: false`.
Successful task completion is distinct from quality-gate status and finding counts.
The existing Sonar check and DevEx advisory classifier still own their respective gates.

Coverage collection verifies the actual report hash and source, pinned collector,
positive instrumentation and genuinely passing executed TRX tests. Its selection
must contain this job's single isolated invocation. Before the token-bearing
.NET end step and again during verification, every path matched by the recursive
report glob is enumerated: exactly one canonical regular collected report is
required. Nested extra reports, symbolic links, foreign invocation directories
and oversized/deep trees fail instead of contributing unvalidated provider metrics.

Default-branch import verification cross-checks the exact current analysis key and
revision against unique exact-date historical `lines_to_cover`/`uncovered_lines`
points, then rechecks that analysis after reading the metrics. Latest component
measures alone are never called analysis-bound import proof. Ambiguous dates,
superseded analyses and absent import evidence fail explicitly.
An instrumented report with zero covered lines remains **collected**, even when
the provider has exact-source 0% metrics: that metric shape cannot distinguish an
imported report from missing coverage.

**Remaining acceptance boundary:** PR collection is recorded as collected, not
server-imported. The project-analysis history API has no PR selector; borrowing
default-branch history would manufacture evidence. Genuine new-producer coverage
import and the PR-specific verification surface must be accepted before full-profile
rollout is declared complete. Existing historical provider observations, local
collector output and hosted build fixtures are not replacement-workflow acceptance.

Current Sonar documentation independently supports the native C# Cobertura property:

- [dotnet-coverage examples](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/test-coverage/dotnet-test-coverage#dotnetcoverage)
- [C# coverage parameters](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/test-coverage/test-coverage-parameters#c)

## Contracts and release closure

Run the focused contracts with:

```powershell
node --test repository-analysis-sonar\sonar.test.mjs repository-analysis-sonar\build.test.mjs repository-analysis-sonar\workflow.test.mjs
```

The hosted contracts exercise both OS families, genuine pinned installation, real
SDK multi-target builds, Framework restore/MSBuild and C++ compilation/ctest.
Fixtures never publish source or claim completed Sonar analysis.

Release detection and NBGV cover the reusable workflow, all Sonar code, context and
test/reporting dependencies. Nested reporting resolves from the executing definition
using commit-bound `$/` references. Consumer examples must adopt a real immutable
patch release after it exists, not float on `main` or predict an unreleased tag.

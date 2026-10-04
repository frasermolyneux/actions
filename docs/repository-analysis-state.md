# Repository analysis result and freshness contract

`repository-analysis-state` validates selected-tool completeness and default-branch
freshness against a newly resolved live capability context. It does not execute scanners,
grant publication admission, authenticate a producer, or prove a build/coverage import
occurred merely because someone supplies JSON. Trusted released scanner workflows must
provide verified facts; consumers must also bind the originating repository, reviewed
workflow definition, successful actual run/attempt and exact result artifact before using
them as evidence.

This is an estate migration primitive, not a claim that callers already run the new
engines. The completed-result schema is `repository-analysis-result-v1`; the capability
profile remains `repository-analysis-v1`.

## Result bundle

The `assemble` operation accepts a bounded JSON file beneath `RUNNER_TEMP`, containing:

| Field | Required facts |
| --- | --- |
| `engine` | Exact `<family>/vX.Y.Z` release, 40-hex release source revision and 64-hex engine/configuration digest |
| `source` | Actual `checkoutSha`, separate `logicalHeadSha`, `baseSha` (null for default branch), immutable `headRepositoryId`, `pullRequest` (null for default branch) |
| `run` | Actual run ID/attempt/event, caller workflow path/definition SHA and UTC start/completion |
| `pins` | Exactly one ID/version/rule revision/engine digest for every selected tool/category |
| `results` | Actual tool state, analyzed source SHA, matching pins, per-capability source counts, finding count, processing/publication identities and completion time |
| `coverage` | Explicit suite/import/unavailability evidence for the analyzed source; absence is not zero coverage |
| `finishedHeadSha` | Independently observed logical head after analysis; never relabel the actual analyzed source |

CodeQL IDs are `codeql/<language>` with `/language:<language>` categories. Local IDs are
`local/<tool>` with `/tool:<tool>` categories. Sonar uses `sonar` and `quality`, not a
fictional Sonar SARIF identity. The tool set is derived from live visibility and the catalog
profile, not a caller's arbitrary list. Tool pin order and validated engine/pin JSON
property ordering do not affect freshness.

Tool `status` is `completed`, `failed`, `pending` or `unavailable`. Incomplete tools need
an explicit `reason`, null `findingCount` and null `completedAt`; they cannot use a
zero-finding fallback. Completed tools need positive actual source coverage for every
selected capability and a nonnegative raw finding count. Findings themselves do not
make execution incomplete or introduce a gate on the historical backlog.

`processing` has `status` and `id`; `publication` has `destination`, `status` and `id`.
Native SARIF needs completed server processing and its actual upload identity. Sonar needs
its successful compute task and resulting analysis identity. Accepted uploads, pending
tasks or absent provider IDs are not completed results. The scanner engines must verify
those API facts and their source/project bindings before supplying them.

Public selected tools publish to `github-security`, or `sonar-public` for Sonar. Private
local tools use `originating-repository-artifact`; CodeQL/private native SARIF/private
Sonar execution remain prohibited. For local private results, artifact staging has no
provider ID: actual successful artifact upload/run binding is a separate consumer check.
Explicit unavailable private C++ or requested private Sonar stays incomplete, not clean.
Locally completed Semgrep is not asserted to be equivalent to CodeQL.

The resulting `completeness.status` is `completed`, `incomplete`, `superseded` or
`not-applicable`. Missing tools and unavailable capabilities are explicit arrays. A claimed
completion flag that disagrees with the selected tool evidence is rejected. Default-branch
actual/logical revisions must agree; PR merge-ref analysis keeps its actual, logical-head
and target/base revisions separate.

## Coverage

Each suite declares `imported`, `unavailable`, `not-applicable` or `failed`. Imported
OpenCover, VS coverage XML, Cobertura, LCOV or gcov evidence needs nonempty hashed report paths, positive instrumented
line/test counts, consistent passing executed-test totals and the same completed Sonar
analysis ID. Zero covered lines is a legitimate measurable result; zero instrumentation
or all-skipped tests is not evidence of an import. Scanner engines must validate the real
report contents, passing test invocation and actual provider import.
Report paths must be repository-relative, use forward slashes, and exclude traversal,
drive-qualified paths, backslashes and alternate data streams.

Every active profile needs at least one explicit suite entry, including workflow-only and
private profiles with a documented inapplicable/unavailable coverage provider. Omitting
the coverage array is not a way to hide that gap. Only an explicit applicability exemption
may omit suites without fabricating a test or import.

Microsoft's cross-platform `dotnet-coverage` can produce VS coverage XML or Cobertura
without adding a collector package to each test project. Sonar's current
[.NET coverage contract](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/test-coverage/dotnet-test-coverage)
supports both, while its
[C/C++ coverage contract](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/test-coverage/c-c-objective-c-test-coverage)
also supports Cobertura and gcov. These labels alone are not proof of a real import.

Unavailable/inapplicable coverage needs an explicit reason and null metrics/provider
identity, not manufactured zeroes. Failed collection leaves the overall result incomplete.
Existing integration/browser suites retain their original execution responsibilities.

## Daily checks and weekly rescans

`assess` accepts `{ "request": {...}, "previous": null | result }`. The request contains the
current exact engine/pins, independently verified default-branch `headSha`, optional
`expectedSha` (null if absent) and boolean `force`.

The source preparer must resolve the live default-branch head and freeze the checkout;
this state helper is not a source-authentication substitute. The scheduled caller and
consumer must also verify actual upstream run/artifact provenance.

- An expected revision different from the live head is `superseded`, even with force.
- Force requests a real current-head scan; it is not a freshness or source-identity bypass.
- Missing results, incomplete/superseded tools, PR-only results, changed source, changed
  visibility/profile/engine/scanner/rules or an age **at least seven days** require scanning.
- Unchanged complete source/policy within seven days is `current`; this is not a claim
  that GitHub's daily scheduled check has executed.
- Foreign, malformed or implausibly future-dated evidence fails explicitly. A forced
  verified current-head scan can replace unusable old evidence without trusting it.
- Explicit empty applicability exemptions need no fabricated source head or scanner.

Daily schedule execution is a separate operational signal. Missing/disabled/delayed
schedules remain visible even when a weekly result is otherwise current. Stale Sonar does
not globally suppress findings from other completed sources; consumers must retain
per-source status and confirm historical leads against current code.

`aggregateStatus` emits only whitelisted repository/visibility/completion/tool-availability
metadata. It does not expose private source excerpts, finding bodies or report paths.
Full result/native/coverage artifacts remain in their originating repository.

## Validation

```powershell
node --check repository-analysis-state\state.mjs
node --test repository-analysis-state\state.test.mjs
git diff --check
```

Hosted contracts run on Ubuntu and Windows. The real read-only composite fixture tests a
cold freshness decision with live repository metadata; its fixture pins are explicitly
synthetic and it never publishes fake completed scanner evidence.

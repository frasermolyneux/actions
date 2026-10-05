# Repository CodeQL analysis

`.github/workflows/repository-analysis-codeql.yml` is the selected-native
component, released with the `repository-analysis-codeql` folder. Foreign
callers must pin a published, exact `repository-analysis-codeql/vX.Y.Z` release;
mutable foreign branches are rejected before source checkout. Its required
inputs are the catalog `profile` and actual originating `expected-sha`. Compiled
profiles also declare their original `build` JSON and `source-directory`, using
the SDK, Windows Framework or CMake recipe contract documented for Sonar.
CodeQL eligibility does **not** depend on Sonar selection or credentials.

Metadata-only planning resolves live visibility, immutable called definition,
run attempt and actual/logical source before initializing licensed tooling.
Private or unsupported profiles emit an explicit empty native selection:
they never enter the native job and do not publish private SARIF. Public source
authorization retains the verified personal owner, Copilot and Dependabot
author/actor checks, including reruns, current non-draft PR head and same-repository
origin. SDK setup precedes manual CodeQL initialization. The analysis-only build
preserves original compilation commands and receives no Sonar or deployment token.

Each selected language must genuinely archive unchanged maintained source before
publication. JavaScript and TypeScript capability counts come from separately
identified **archived** files, not tracked candidates, estimates or diagnostic
SARIF result counts. Archived Vue and HTML/XHTML containers are classified from
their byte-verified embedded script language/type and actual inline content;
ordinary data, external-script references, empty or unsupported-language sections
do not fabricate JS/TS coverage. Each file counts at most once per capability, and
a container with both languages can legitimately count once for each. Native
archive counts remain source-file evidence, not evaluated-line or AST percentages.
A missing selected capability cannot complete. Reauthorization
precedes upload; independently verified native processing supplies the actual
finding count, analysis ID, source and producing job. The isolated per-language
reports and selected set bind the exact originating run/attempt, policy and
complete executable definition digest. No database or source archive is retained.

The selected set is `repository-analysis-codeql-set-v1`, with
`fullProfileEvidence: false`. It does not replace local analysis, Sonar, coverage,
authenticated freshness reuse or full-profile acceptance. Caller migration must
retain any required original producer until its immutable replacement actually
publishes verified current-source native results.

## Integration acceptance

`.github/workflows/repository-analysis-codeql-tests.yml` exercises the pinned
CodeQL action at `2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2` and the exact
2.27.1 bundle. This is integration acceptance for the estate engine workstream,
including the actual selected-native reusable for maintained source, not adoption
of a complete estate profile. Existing SDK/Framework/C++ fixture acceptance remains
compiler-family evidence, not a foreign production scan.
Separate Vue JavaScript-only and TypeScript-only fixture jobs require genuine
CodeQL database archive bytes and distinct capability counts. They also disable
database/SARIF publication and are fixture acceptance, never full-profile evidence.

Live metadata must identify a public repository with the selected language before
initialization. Private, unknown and foreign pull-request sources cannot enter
these jobs. Queries run without automatic database or SARIF publication.

For maintained Actions, JavaScript and Python source, the verifier checks the
actual checkout revision, unchanged tracked files, observed CLI version, queried
SARIF invocation and native database archive. Selected archived source bytes must
match their tracked checkout bytes under a single native archive root.
Overlapping repository paths use the longest candidate suffix, retaining duplicate
and mixed-root refusal. JavaScript candidate selection reads the actual pinned
bundle's complete `file_types` declaration, including Vue, HTML/XHTML and data
formats, rather than treating a hand-maintained JS/TS suffix subset as complete.
The resolved database source location must identify the actual runner checkout.
The shared source gate also rejects ordinary and Git-ignored untracked files
outside known dependency/compiler output directories before proof creation and
native publication. This gate does not infer safe source from a partial extension
list; generated build outputs remain explicitly distinguished from maintained source.
Estimated baseline lines are not extraction
evidence. Archive file counts are not evaluated-line or coverage percentages.
The raw SARIF `resultCount` can include diagnostic results and is not a native
security-alert count; alert disposition belongs to the processed provider output.
Live-public eligibility is checked again before the validated SARIF upload; the
existing native verifier independently binds processing, source and publication.

Separate SDK .NET, Windows Framework 4.8 and C++ fixtures exercise manual
extraction around the preserved analysis-only restore/build/test commands.
Fixture query output and databases are **never uploaded** to native code scanning.
Their bounded proof artifacts explicitly identify fixture-only scope.
Artifacts stay in the originating repository and expire after 14 days. Raw
database archives and source bytes are not copied into proof artifacts.

Every proof records `fullProfileEvidence: false`. A successful fixture or
individual language cannot satisfy full-profile freshness, Sonar coverage import,
consumer rollout or final estate acceptance.

```powershell
python -m unittest discover -s repository-analysis-codeql -p 'test_*.py'
node --test repository-analysis-codeql/engine.test.mjs repository-analysis-codeql/workflow.test.mjs repository-analysis-codeql/extractor.test.mjs
node --check repository-analysis-codeql/integration.mjs
```

The hosted workflow is required for genuine extraction, query and native
publication evidence; local synthetic archive tests are only boundary contracts.

# Selected local analysis workflow

`.github/workflows/repository-analysis-local.yml` runs every local analyzer selected by
the live catalog capability profile in a bounded, `fail-fast: false` Linux matrix.
It is a shared backend, **not the completed estate analysis orchestrator**: CodeQL
execution, Sonar/build/coverage, authenticated freshness reuse and caller rollout
remain separate integration work. Its `repository-analysis-local-set-v1` artifact
explicitly sets `fullProfileEvidence: false`; do not treat it as a complete profile,
post-merge finding-resolution proof, publication permission or freshness cache.

Invoke once per workflow run, using an exact reviewed `repository-analysis/vX.Y.Z`
tag. The package owns this reusable workflow and its helper/dependency closure,
including an internal evidence composite in `repository-analysis/action.yml`.
That composite is an implementation helper, not the workflow's consumer API.
Folder-scoped immutable and rolling tags
are published by the existing release workflow, but this analysis caller accepts
only immutable patch tags outside the shared repository's own integration tests.

```yaml
jobs:
  local-analysis:
    permissions:
      contents: read
      actions: read
      security-events: write
    uses: frasermolyneux/actions/.github/workflows/repository-analysis-local.yml@repository-analysis/vX.Y.Z
    with:
      profile: ${{ vars.REPOSITORY_ANALYSIS_PROFILE }}
      expected-sha: ${{ github.sha }}
```

Do not pass deployment credentials, App keys, a PAT or Sonar secrets; there are no
secret inputs. `security-events: write` is forwarded for the public-only publishing
job. Private/fork runs skip that job and do not receive its job token; their actual
scanner jobs use only `contents: read`. Public native publication requires current
eligibility, a supported event and a same-repository PR (if applicable).
`pull_request_target`, custom checkout SHAs and mutable release refs are rejected.
No historical finding-count merge gate is introduced.

## Definition, source and publication

Authenticated current-attempt run metadata resolves the SHA of the actual called
first-party workflow. GitHub's native `$/` self-repository references resolve helper
actions directly at that definition's commit; no metadata-selected definition
checkout is executed. Target source is checked out separately, and target
repositories cannot supply execution helpers through their own checkout.
Sibling preflights also resolve at the enclosing composite's exact commit.
This requires GitHub.com and runner 2.336.0 or later; the shared workflow uses
GitHub-hosted runners. See [GitHub's self-repository reference announcement](https://github.blog/changelog/2026-07-30-reference-same-repository-actions-with-self-repository-syntax/).
Source is frozen to the workflow's actual SHA, not confused with a PR's logical
head SHA. Local analyzers retain their existing isolated-source, credential
allowlist, exact native-version and positive capability-coverage checks.

Each originating-repository artifact retains `report.json`, `native.json`,
`analysis.sarif` and an `artifact.json` envelope. The envelope binds content hashes
to selected policy, actual/logical source, caller workflow identity, called
definition SHA/digest and the current run attempt. These are trusted-workflow
integrity/binding checks, not cryptographic independent producer attestation.
An unreviewed caller definition is not automatically trustworthy, and these
current-run artifacts are not authenticated historical reuse evidence.

Public publishing rechecks live visibility/policy, validates the current-attempt
artifact, uploads the actual finding-preserving SARIF and requires independent
successful native processing for its tool/category/source. Local and provider
finding counts are retained separately: provider normalization can deduplicate
findings; it does not replace the original scanner report.
Private repositories never execute the native uploader or CodeQL and never send
source, native reports, finding excerpts or summaries to a public repository.
The same private boundary applies to failed-run diagnostic artifacts.

Aggregation requires every selected local tool, exact report/SARIF identities and,
where applicable, every native completion proof. Missing tools, stale attempts,
mutated output, visibility changes or provider failures cannot produce a completed
local set. Findings are completed analysis, not execution failures.

## Release and acceptance

The package digest covers its reusable workflow, helper/version metadata and the
actual context/local/native-verifier execution dependency closure. The release
detector and NBGV path filters include that closure, so a dependency change cannot
leave an installed workflow silently using an unversioned implementation.
The package is released after its composite dependencies.
Local/state/native-verifier composites similarly release when their commit-bound
context dependency changes. External consumers retain folder-scoped release tags;
`$/` is used only for same-repository implementation composition.

`Analysis workflow contracts` executes the actual reusable workflow against this
public repository's maintained Actions, shell and PowerShell source, verifies real
native processing and checks the returned artifact. It runs envelope/definition/
source/visibility/hash/count contracts on Linux and Windows. `Local analysis
contracts` additionally executes all six pinned native tools against deliberately
detectable synthetic private-policy fixtures, including actual SARIF conversion.
Synthetic private policy is not real private-repository rollout acceptance.

```powershell
node --test repository-analysis\workflow.test.mjs repository-analysis-local\sarif.test.mjs repository-analysis-local\scan.test.mjs
git diff --check
```

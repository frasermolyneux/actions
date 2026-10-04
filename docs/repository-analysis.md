# Repository analysis capability contract

`repository-analysis-context` selects permitted execution and publication from a catalog
profile and **live GitHub repository metadata**. It is the preflight boundary for the estate
analysis migration, not a scanner implementation or completed-result report.

The `repository-analysis-v1` contract preserves current ownership and visibility. It does
not purchase subscriptions, enable private GitHub Code Security, transfer repositories or
change settings. Scanner consumers must implement the selected local/native tools and
validate their real results before publishing completion.

[`repository-analysis-state`](repository-analysis-state.md) defines selected-tool result
completeness and weekly freshness separately from this preflight. A selected tool, accepted
upload or fresh timestamp alone is not completed evidence.

## Profile

```json
{
  "version": "repository-analysis-v1",
  "languages": ["actions", "javascript", "terraform"],
  "sonar": false
}
```

Profiles are owned by the `platform-workloads` catalog. `languages` is a unique array of
actual maintained source capabilities: `actions`, `csharp`, `cpp`, `javascript`,
`typescript`, `python`, `php`, `terraform`, `bicep`, `dockerfile`, `ansible`, `powershell`
or `shell`. Preserve repository-specific build and validation alongside these scanners.
Detect extensionless scripts too; the primary GitHub language is not a complete profile.

`sonar` declares applicability, not entitlement or permission to publish private source.
Terraform/IaC/workflow-only profiles cannot request Sonar. Its eligible public project,
visibility, CI method and authentication must still be verified before scanner execution.
The current contract does not approve private Sonar execution.

An empty profile requires an explicit `exemption` with `kind`, `reason` and `reevaluate`.
Supported kinds are `documentation-only`, `empty`, `archived` and `upstream-fork`. Exempt
profiles select no scanners. The archive exemption takes precedence when an archived
repository is also a fork. Unarchiving it requires a reviewed active or upstream-fork
profile. Status changes to applicability require review, not automatic omission or unarchiving.

## Execution and publication

| Capability | Public repository | Private repository under the current contract |
| --- | --- | --- |
| Supported C#/C++, JS/TS, Python and Actions | CodeQL where applicable | No CodeQL execution, even for artifact-only output |
| C#, JS/TS, Python | Native CodeQL plus selected complementary tools | Locally executed Semgrep CE; Python also retains Bandit |
| C/C++ | Native CodeQL | Explicitly unavailable; community C rules are not C++ coverage |
| PHP | Local Semgrep CE | Local Semgrep CE |
| Workflow security | Local zizmor alongside applicable native analysis | Local zizmor |
| Terraform/Bicep/Dockerfile/Ansible | Local Checkov | Local Checkov |
| PowerShell/shell | PSScriptAnalyzer/ShellCheck | PSScriptAnalyzer/ShellCheck |
| GitHub SARIF publication | GitHub Security when event permissions support it | Unavailable; do not attempt uploads |
| Results and summaries | Originating repository | Originating private repository only |
| Public estate reporting | Aggregate status only | Aggregate status only; no source/finding excerpts |

Semgrep CE is not CodeQL-equivalent. Run it locally with pinned rules, metrics/version
checks disabled and no Semgrep platform login or cloud publishing. Local analyzers must
have pinned versions, actual source coverage and complete validated reports. An unsupported
capability, execution failure, missing report or publication failure is never zero findings.
Downloading public rules is distinct from sending repository source to a provider.
The current estate has no private C/C++ target. If one is onboarded, the explicit
unavailable capability requires a reviewed local backend decision; do not mark it clean,
silently omit it or invoke unlicensed CodeQL.

Caller-supplied visibility, entitlement and upload flags are rejected. The action reads
only `GET /repos/{owner}/{repository}` with a metadata-capable token. Failed requests,
inconsistent visibility and wrong-target metadata fail explicitly; a 403 is not proof of
inapplicability. Bind the response to both the repository name and immutable workflow
repository ID. Re-evaluate immediately before licensed execution/provider publication
when jobs have been queued; selection must still agree with live metadata.

The outputs include CodeQL languages, local tools and their capabilities, Sonar eligibility,
publication destinations, limitations and a SHA-256 `policy-digest`. The digest includes
repository identity, visibility and the normalized profile. Include it, the engine/rule
revisions and actual tool versions in result freshness/cache identities; a visibility change
must invalidate old decisions even when source SHA is unchanged.

## Use and validation

Use a reviewed immutable `repository-analysis-context/v1.X.Y` release (or the exact reviewed
commit) from a pinned scanner workflow. Pass only the profile and repository metadata-read
token, never an App private key, merge token, cloud credential or blanket inherited secrets.
The action installs Node.js 22 before running the helper; standalone use needs Node.js 22
or later. It fails before emitting outputs if metadata is invalid.
Do not execute the target repository's copy of the helper as trusted preflight code.

```powershell
node --check repository-analysis-context\policy.mjs
node --test repository-analysis-context\policy.test.mjs
git diff --check
```

The existing reusable scanners and estate callers are migrated separately under
`platform-devex/docs/plans/estate-analysis-alignment.md`; adding this helper alone does not
claim they use it or that the estate rollout is complete.

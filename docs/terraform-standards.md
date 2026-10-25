# Terraform action v2 contract

The ten execution actions (`terraform-plan`, `terraform-plan-readonly`,
`terraform-plan-and-apply`, `terraform-apply`, `terraform-output`,
`terraform-state-check`, `terraform-state-rm`, `terraform-import`,
`terraform-destroy`, `terraform-destroy-resources`) release as **v2.0.0**.
Existing v1 tags remain unchanged. Do not migrate consumers until the exact v2
tags exist after the reviewed change is merged and `actions-versioning` succeeds.

## Root toolchain

Each execution root must commit `.terraform-version` containing exactly one stable
`major.minor.patch` CLI version and a genuine Terraform-generated
`.terraform.lock.hcl` containing provider selections and checksums. Both files must
match checkout HEAD. Missing files, version ranges, dirty locks, missing providers,
selection disagreement and checksum failures fail closed. Bootstrap/update locks
deliberately with Terraform; ordinary jobs must not use `init -upgrade`.

All ten actions use commit-bound `$/terraform-setup` and `$/terraform-receipt`.
Their version filters and release detector cover this executable dependency
closure. All initialization uses `-input=false -lockfile=readonly`, including
destroy, import and state maintenance. Authentication remains Azure OIDC.
Production job/environment/approval/label gates belong to callers and are unchanged.

Every action accepts optional `terraform-version` as an exact assertion, **not an
override** of the root pin, plus optional `terraform-environment` for evidence.
Otherwise the environment is derived from the var-file basename (`prd.tfvars`
becomes `prd`). Split apply has no var-file input: supply `terraform-environment`
as a **required nonempty saved-plan identity**, matching either the producer's
explicit value or its var-file-derived environment. Empty identities are rejected
before applying a saved plan.

Direct CLI workflows can use `terraform-setup@terraform-setup/v1.0.0`:

```yaml
- uses: frasermolyneux/actions/terraform-setup@terraform-setup/v1.0.0
  id: terraform
  with:
    terraform-folder: terraform
    terraform_wrapper: 'false'
- shell: bash
  run: terraform -chdir=terraform init -backend=false -input=false -lockfile=readonly
```

Setup outputs `terraform-version` (also `version`) and a unique private `directory`
context for the receipt helper. It does not initialize a backend or emit execution
evidence itself. Underlying `terraform-bin` is used for clean version JSON even
when HashiCorp's wrapper is enabled. The root CLI pin remains the compatibility
selection; HCL constraints must also accept it. Source-identity Git commands use a
trusted system installation (`/usr/bin/git`, `/usr/local/bin/git`, or Program Files
Git on Windows), never a checkout/PATH-selected Git executable.

## Saved plan boundary

Plan and readonly-plan upload exactly the binary plan, its
`<plan-file-name>.metadata.json` and the selected root `.terraform.lock.hcl`.
Hidden-file upload is explicitly enabled only for these selected files, never an
entire Terraform directory. Plans can contain secrets; existing plan artifact
access controls still apply. Plan names must be simple filenames.

Metadata schema `terraform-saved-plan-v1` contains `sourceCommit`, `rootDirectory`,
`terraformVersion`, `lockSha256`, `environment`, and `planSha256`. Split apply
downloads into an isolated invocation directory rather than overwriting the
checkout lock, performs readonly init, verifies every identity/hash against the
current checkout, and only then copies/applies the binary plan. Legacy v1 artifacts
are intentionally rejected by v2 apply.

## Execution receipt

`terraform-receipt/v1.0.0` uploads a single `terraform-execution.json` with schema
`terraform-execution-v1`. The allowlisted fields are:

- `repository`: owner/name; `sourceCommit`: actual checkout `git rev-parse HEAD`;
  `rootDirectory`: repository-relative POSIX path (`.` for repository root).
- `runId`: decimal string; `runAttempt`: positive integer; `workflowRef`,
  `workflowSha`: caller workflow identities; `job`: `GITHUB_JOB` identifier;
  `eventName`, `ref`: GitHub execution identities.
- `environment`: explicit environment or var-file-derived name.
- `operation`: `validate`, `plan`, `apply`, `output`, `state-check`, `state-rm`,
  `import`, `destroy`, or `destroy-resources`; `outcome`: `success` or `failure`;
  `observedAt`: ISO UTC time; `executionId`: invocation UUID.
- `terraformVersion`: exact observed CLI; `platform`: OS/architecture;
  `providerSelections`: canonical registry address to exact observed selected
  version; `lockSha256`: lowercase SHA256 of the committed root lock.
- Optional `producerRevision`: exact actions SHA when determinable from the action
  ref. Mutable/semantic refs and the caller commit are never invented producer SHAs.

The operation actions report their principal operation (combined plan/apply reports
`apply`). Success requires successful command steps and verified selected providers.
Preparation/init/validation/operation failures cannot produce a successful receipt;
an unavailable receipt is explicit failed evidence, never successful execution.
State read errors are no longer silently converted into empty-state success.
`terraform-output` verifies an output read without publishing output values.

Artifacts are named
`terraform-execution-<job>-<run>-<attempt>-<operation>-<root-hash>-<UUID>`.
Fresh, non-symlink invocation directories and exact-file uploads prevent stale
receipt reuse and accidental state/plan/output/environment/backend disclosure.
Stable helper step names are `Record Terraform execution receipt` and
`Upload Terraform execution receipt`. Record/upload failure fails evidence
publication; **never rerun an apply/import/state-rm/destroy merely to repair
receipt publication**. Inspect the already-completed mutation and its logs first.

## Dependabot

`dependabot-policy/v1.2.0` requires manual review for actual Terraform/HCL files,
root locks/pins, Terraform toolchain version files and Terraform action-reference
changes. Labels and minor/patch metadata cannot override this guard. Changed files
are paged completely (100/page, maximum 30 pages/3,000 files), with count,
duplicate and head/base stability checks. Missing/truncated diffs or API failures
block auto-merge. Terraform variable files (including auto-loaded JSON variants),
`.tfbackend` backend files, and folded/multiline action/version values are included.
A blocked Terraform decision
revokes any existing auto-merge request; missing permission or unverifiable
revocation fails the action instead of silently leaving auto-merge enabled.
Unrelated dependency metadata and major-label behavior remain.

## Release operation

There is no publication dispatch or dispatch input. A reviewed push/merge to
`main` triggers `actions-versioning`; it computes the changed-action dependency
closure and publishes policy, setup, receipt, then the ten operations. Setup and
receipt sibling references use `$/`, binding the executable closure to the same
actions commit. Exact patch tags point to that main commit; the workflow then
updates rolling minor/major tags. Consumers requiring historical producer trust
must use the exact patch tag or reviewed actions commit SHA, not a rolling tag.

`producerRevision` is optional and is emitted only when the runtime action ref
itself is an exact 40-character SHA. Semantic patch refs do not invent a producer
SHA; admission must independently resolve and verify the exact caller action ref.
`sourceCommit` is always the actual consumer checkout SHA, not the producer SHA.
Lock hashes cover exact checkout bytes; Windows CRLF checkout differences require
an LF checkout policy or explicit unavailable coverage when compared with LF Git
blobs.

## Validation

```powershell
node --test terraform-setup/context.test.cjs dependabot-policy/terraform-guard.test.cjs
git diff --check
```

The contract suite runs on Windows and Linux. Set `TERRAFORM_NATIVE_TEST=1` with
Terraform 1.17.0 on PATH to also generate a genuine provider lock and exercise
readonly init, validation, source-bound saved-plan application, state/output reads
and destruction of an isolated local random-ID fixture. No cloud state is accessed.
Hosted CI additionally exercises the actual setup composite with the HashiCorp
wrapper enabled and uploads a real metadata-only validation receipt from the
committed, two-platform provider-lock fixture.

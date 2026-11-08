# Terraform action contracts

These contracts describe the current action definitions. Check each action's
`action.yml`, `version.json` and published release before upgrading; see
[action versioning](action-versioning.md). Upgrade saved-plan producers and
split apply together: older GitHub-artifact transfers are incompatible with the
current Azure Blob Storage boundary.

For plan, readonly-plan and combined plan-and-apply, pass `-detailed-exitcode` through
`terraform-additional-args`: a native exit code of 2 fails the action before
showing, binding, uploading or applying the plan; code 1 and show failures also
fail. Without that option, Terraform normally returns 0 even for a plan with
changes, and those plans continue to be shown, stored and, for the combined
action, applied. The combined action removes `-detailed-exitcode` and its
double-dash and `=true`/`=false` forms from the arguments passed to apply. A
caller that previously used the flag but intended to accept changes must remove
it before upgrading. Terraform environment
arguments that enable detailed exit codes have the same gate effect.
The post-import plan does not consume `terraform-additional-args`; set
`TF_CLI_ARGS_plan=-detailed-exitcode` to gate that plan. Import has already
changed state before its post-import gate runs, even if the gate fails.

The `plan-exitcode` output is the original native plan exit code, not a later
`terraform show` result; it is empty if the plan command never produced an
output. Without detailed exit codes, 0 alone does **not** prove no changes.
The release workflow allocates patch numbers from existing tags.

`terraform-additional-args` and `terraform-additional-apply-args` are parsed as
POSIX-style quoted argument lists using Python's `shlex`, not executed as shell
code. Whitespace, single and double quotes, and backslash escaping delimit
arguments; an unmatched quote fails the step. Shell variable and command
substitution, globbing, redirection and pipelines are not performed. Expand any
needed values before passing the input. These steps require `python` (Python 3)
on PATH. State addresses and targeted resources must be JSON arrays of strings;
each address is passed as one literal argument.

## Root toolchain

Each execution root must commit `.terraform-version` containing exactly one stable
`major.minor.patch` CLI version and a genuine Terraform-generated
`.terraform.lock.hcl` containing provider selections and checksums. Both files must
exist in checkout HEAD and match both its working tree and index. Receipt-time
verification repeats this admission and rejects a checkout change after setup.
Missing files, version ranges, dirty locks, missing providers,
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

Direct CLI workflows can use `terraform-setup`. Resolve a reviewed exact release
to its commit SHA as described in [action versioning](action-versioning.md):

```yaml
- uses: frasermolyneux/actions/terraform-setup@<FULL_RELEASE_SHA> # terraform-setup/vX.Y.Z
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

Plan, readonly-plan, combined plan-and-apply, and the post-import plan each save
one bundle containing the binary plan, its `<plan-file-name>.metadata.json`, and
the selected root `.terraform.lock.hcl`. No binary plan is uploaded to GitHub
artifacts. The combined action stores the plan before applying it. Import stores
its post-import plan after the import has already changed state: if storage fails,
inspect the completed import before retrying.

The commit-bound `terraform-plan-storage` helper uses `azure/login` with GitHub
OIDC and Azure CLI `--auth-mode login`. Jobs need `id-token: write`, Azure CLI,
and an identity with blob data write access (including readonly-plan) to the
pre-existing private `tfplan` container. Configure the federated identity and
container separately; the actions do not create them or use storage keys. The
account is the effective `storage_account_name` in the initialized `azurerm`
backend, including backend-file settings, explicit overrides and `TF_DATA_DIR`.
Missing or non-Azure backends and missing account names fail closed. No management
plane account lookup is required. Plans can contain secrets; account-level blob
permissions and the container's retention/lifecycle policy govern their access and
retention.

The binary plan and Terraform's human-readable plan output can contain sensitive
values. Plan and show commands write output to job logs, and the comment formatter
also reads a temporary copy from the runner. Restrict log and runner access and
retention as well as blob access; sanitized PR comments and metadata-only
receipts do not make those other surfaces safe to share.

The `plan-artifact-name` input is a **blob identifier**, not a
GitHub artifact name. A producer and split apply must use the same identifier,
plan filename, repository, workflow run and run attempt, as well as the same
backend account. Use distinct identifiers for matrix entries or multiple plans in
one run. Uploads are create-only: a duplicate identifier in the same attempt
fails rather than replacing an existing plan. A job-only rerun in a later attempt
cannot retrieve an earlier attempt's plan; rerun the producer as well. The
combined action defaults to `terraform-plan` and import to
`terraform-import-plan`. Plan names must be simple filenames.

Metadata schema `terraform-saved-plan-v1` contains `sourceCommit`, `rootDirectory`,
`terraformVersion`, `lockSha256`, `environment`, and `planSha256`. Split apply
performs readonly init, retrieves into an isolated invocation directory rather
than overwriting the checkout lock, verifies every identity/hash against the
current checkout, and only then copies/applies the binary plan. A missing blob,
failed transfer, corrupt bundle or failed verification stops apply. There is no
GitHub-artifact fallback.

## Pull request comments

The four plan-producing actions post the workflow name, Terraform folder, workspace
and target environment alongside fixed validation and plan status labels, numeric
add/change/destroy counts, and a generic warning when
the parsed destroy count is nonzero (including replacements). Missing, failed,
ambiguous or unparseable output never appears verbatim; a successful plan with no
parseable summary is marked unavailable. Resource addresses and diagnostic text
are not included in comment bodies. Context labels are escaped, bounded and
visible to readers of the pull request; do not put secrets in these labels.

Comments contain no hidden markers or input-derived identifiers. Each invocation
appends a separate comment, including matrix jobs and later runs; it does not
supersede or edit earlier comments. The workspace label uses the optional
`pr-comment-workspace` override, otherwise `TF_WORKSPACE`, the Terraform data
directory's selected workspace, or `default` when no selection file exists.
The target environment is `terraform-environment` when set, otherwise the
var-file basename. Missing context is shown as `Not specified`; labels longer
than 256 characters are truncated. The unused
`pr-comment-expand-summary-details` and `pr-comment-highlight-changes` inputs
have been removed; remove those inputs from caller workflows when upgrading.

## Execution receipt

`terraform-receipt` uploads a single `terraform-execution.json` with schema
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
- Optional `binaryInventory` uses
  `go-buildinfo-v1`. It records only CLI/provider identity, exact selection,
  platform, binary SHA-256 and embedded stable Go version. Provider observations
  additionally require the installed package's canonical h1 content checksum to
  match a committed lock checksum. No binary, build flags, module source, absolute
  paths, state, plans or environment values are uploaded.

The Go tool reads installed binary build metadata; it does not run the inspected
binary. The reader must exist in a trusted system/hosted-toolcache installation,
not a checkout-selected PATH location. Unsupported binaries, missing readers,
changing files, absent platform h1 checksums and bounded-out metadata leave
explicit partial/unavailable binary coverage. This never reruns an operation or
turns a failed operation into success. Receipt and operation artifacts remain
separate. All ten commit-bound operation packages acquire the reviewed helper
through their existing release dependency closure; caller contracts are unchanged.

`terraform-validate` uses the same commit-bound helpers for an isolated readonly
init (`-backend=false -lockfile=readonly`), validation and receipt. It has no Azure
login, plan, state read or apply. Add a literal root-specific job on approved main
to collect CI binary provenance without rerunning production mutations. Its
default empty environment is explicitly CI-only, not a production observation.
Matrix/dynamic invocation trust is not implied; Radar must authenticate the exact
released producer, caller root, completed run and successful job.

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

For the current `dependabot-policy`, auto-merge eligibility depends only on the
pull request author: `dependabot[bot]` or `mx-io-idp-bot[bot]`. Terraform files,
toolchain and action changes, all update types and missing metadata do not block
eligibility. The caller must enable GitHub auto-merge without bypassing branch
protection or required checks. `is_dependabot` continues to identify Dependabot
only; use `auto_merge_allowed` or `is_eligible_author` to include both bots.
The legacy metadata outputs return `unknown`, the major-label output returns
`false`, and the retained `major-update-label` input has no effect. Existing
callers using an older exact or minor tag retain the old behavior.

## Release operation

There is no publication dispatch or dispatch input. A reviewed push/merge to
`main` triggers `actions-versioning`; it computes the changed-action dependency
closure and publishes policy, setup, receipt and plan storage before their operation
consumers. Setup and
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
node --test terraform-setup/context.test.cjs terraform-plan-storage/storage.test.cjs terraform-pr-comment/format.test.js dependabot-policy/policy.test.cjs
git diff --check
```

The contract suite runs on Windows and Linux. Set `TERRAFORM_NATIVE_TEST=1` with
the Terraform version configured in [the contract workflow](../.github/workflows/terraform-standards-tests.yml)
and [native fixture](../terraform-setup/context.test.cjs)
on PATH to also generate a genuine provider lock and exercise
readonly init, validation, source-bound saved-plan application, state/output reads
and destruction of an isolated local random-ID fixture. No cloud state is accessed.
Hosted CI additionally exercises the actual setup composite with the HashiCorp
wrapper enabled and uploads a real metadata-only validation receipt from the
committed, two-platform provider-lock fixture.
It also runs `scripts/test_terraform_plan_exitcodes.py` against that pinned
wrapper and an isolated local Terraform configuration, without Azure access.
The separate Terraform plan runner gates workflow executes the original plan,
show and failure steps and their original conditions in generated composites
on GitHub-hosted runners. Storage, binding and apply are replaced by markers,
so no Azure access or mutation is performed; a real local apply is covered by
the wrapper contract suite instead.

The test harness intentionally runs checked-out action shell steps and the
test-supplied Terraform wrapper/binary. Run it only on an isolated runner with
trusted tool paths, no secrets and no Azure credentials; it is not an admission
boundary for untrusted scripts. The runner workflow uses a generated local
composite because `$/` resolves committed source rather than the generated
fixture. Its `pull_request` jobs have only `contents: read`, disable checkout
credential persistence and do not request an OIDC token. The narrowly scoped
Bandit subprocess and zizmor self-repository exceptions apply only to this test
execution, not to published actions.

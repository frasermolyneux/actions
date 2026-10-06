# Copilot Instructions

## Repository purpose and layout

This repository is a catalog of reusable composite GitHub Actions for .NET and CMake CI, Terraform automation, Azure deployments, and workflow utilities.

- Each published action is stored in a top-level folder containing `action.yml` and `version.json`.
- Reusable and repository workflows are under `.github/workflows/`.
- Repository documentation is under `docs/`.
- Action folders are named for the capability they provide and are invoked with folder-scoped tags such as `dotnet-ci/v2`.

## Validation

Read the complete manifest before changing an action and run the smallest validation that covers the changed behavior. There is no single local integration suite for all actions.

```powershell
git diff --check
Get-Content <action-name>\version.json -Raw | ConvertFrom-Json
nbgv get-version -p <action-name> -f json
```

For action implementation changes, also exercise the affected commands or a representative consumer workflow where practical. Documentation-only configuration changes do not require unrelated action integration tests.

## Composite-action conventions

- Preserve the existing `inputs`, `outputs`, and step behavior unless a contract change is intentional.
- Keep explicit `shell` values on `run` steps and follow the surrounding Bash or PowerShell style.
- Keep third-party action references pinned consistently with existing manifests. Use folder-scoped release tags for actions from this repository.
- Keep `fetch-depth: 0` when Nerdbank.GitVersioning or full repository history is required.
- Do not hard-code secrets, tokens, connection strings, or subscription GUIDs. Azure automation uses OIDC or managed identity.

## Versioning and releases

Nerdbank.GitVersioning operates independently in each action folder. Update that folder's `version.json` for feature or breaking changes; patch versions are derived from commit history. Pushes to `main` run `.github/workflows/actions-versioning.yml`, which tags only changed action folders with `<folder>/vX.Y.Z`, `<folder>/vX.Y`, and `<folder>/vX`.

When adding an action, include both required files and add its folder name to the workflow's `ACTIONS` array.

`repository-analysis` is an explicit reusable-workflow package with an internal evidence composite.
Its version filters, release detector and definition digest must all cover its
workflow and executable context/local/native-verifier dependency closure. Keep
that package after its dependencies in release order; callers use an exact patch
tag. See `docs/repository-analysis-workflows.md` for its partial-backend scope.
Its implementation composition uses native `$/` references, binding sibling
actions to the reviewed workflow/action commit without executing a dynamically
selected workspace checkout. Local/state/native-verifier releases include their
commit-bound context dependency; external callers retain folder-scoped tags.

`repository-analysis-sonar` likewise owns its reusable workflow and executable
context/test/reporting closure. Align its definition digest, version filters and
release detector; publish it after those dependencies. Native begin/end must retain
prepared public/project/source/producer admission. Collected PR coverage is not
server import, and this partial Sonar package is not estate rollout acceptance.

See [`docs/action-versioning.md`](../docs/action-versioning.md) for tag behavior and [`docs/nerdbank-gitversioning.md`](../docs/nerdbank-gitversioning.md) for .NET checkout requirements.

`repository-analysis-codeql` owns the selected-native reusable and its context,
state, source, compiler and processing-verifier closure. Its version filters,
release detector and digest must remain aligned. Public CodeQL selection is
independent of Sonar; private repositories must not initialize it. Each selected
capability needs genuinely archived source and independently completed native
processing. The resulting component set is never full-profile freshness evidence.

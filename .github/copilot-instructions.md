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

See [`docs/action-versioning.md`](../docs/action-versioning.md) for tag behavior and [`docs/nerdbank-gitversioning.md`](../docs/nerdbank-gitversioning.md) for .NET checkout requirements.

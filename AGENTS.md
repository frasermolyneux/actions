# AGENTS.md - actions

This repository publishes reusable composite GitHub Actions for .NET and CMake CI, Terraform automation, Azure deployments, and supporting workflow utilities.

Use `.github/copilot-instructions.md` for repository-wide conventions. This file contains only the portable execution details needed by agents that load `AGENTS.md`.

## Key locations

- `<action-name>/action.yml` - composite action metadata, inputs, outputs, and steps.
- `<action-name>/version.json` - the action folder's independent Nerdbank.GitVersioning baseline.
- [`.github/workflows/actions-versioning.yml`](.github/workflows/actions-versioning.yml) - publishes exact and rolling tags for changed action folders.
- [`docs/action-versioning.md`](docs/action-versioning.md) - tag shapes and release behavior.

## Validation

For a changed action, inspect the complete `action.yml`, validate its `version.json`, and run the smallest targeted consumer or command that exercises the changed steps. There is no repository-wide local integration suite for every action.

```powershell
git diff --check
Get-Content <action-name>\version.json -Raw | ConvertFrom-Json
nbgv get-version -p <action-name> -f json
```

Documentation-only Copilot configuration changes do not require action integration tests.

## Repository-specific constraints

- Keep every action self-contained in its folder and preserve the existing composite-action input/output contract unless the change intentionally updates it.
- Keep `fetch-depth: 0` where an action or workflow relies on Nerdbank.GitVersioning or full Git history.
- Pin third-party actions consistently with the existing manifests; internal actions use folder-scoped release tags.
- Use Azure OIDC or managed identity for Azure authentication. Do not add client secrets, connection strings, tokens, or subscription GUIDs to repository files.
- Update an action folder's `version.json` for feature or breaking changes. Patch tags are generated from commit history.
- Add a new action folder to the `ACTIONS` array in `.github/workflows/actions-versioning.yml`.

## Scoped documentation

- [`docs/nerdbank-gitversioning.md`](docs/nerdbank-gitversioning.md) - checkout and NBGV requirements for .NET composites.
- [`docs/codequality.md`](docs/codequality.md) - reusable code-quality workflow contract.
- [`docs/dotnet-test-reporting.md`](docs/dotnet-test-reporting.md) - `dotnet-node-setup` / `dotnet-test-report` composites for .NET + npm test environments and TRX reporting.

## Do not

- Do not modify unrelated action folders while changing a single composite action.
- Do not add custom Copilot setup unless the repository later requires runtime installation or dependency restore before an agent starts.

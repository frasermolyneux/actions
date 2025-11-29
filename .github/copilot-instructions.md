# GitHub Copilot Instructions

## Repo Purpose & Layout
- Repository ships reusable composite GitHub Actions; every top-level folder (bicep-lint-code, dotnet-*, deploy-*, terraform-*) contains a single `action.yml` describing the workflow.
- Actions are intended for Azure-first deployments and .NET build pipelines; assume they will be invoked from other repositories rather than run here directly.
- Keep new automation self-contained inside its folder; do not rely on repo-level scripts or shared modules.

## Shared Conventions
- Default runner shell switches between `pwsh` for versioning/JSON work and `bash` for cross-platform CLI steps; mirror the existing shell choice when extending actions.
- Azure credentials are always provided via OIDC inputs (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`); export them to Terraform through `ARM_*` env vars instead of logging in again.
- Artifact handling follows a download/build/upload pattern: composite actions never assume upstream paths, they read artifact names from inputs and use `actions/download-artifact@v4` or `actions/upload-artifact@v4` explicitly.
- Cache packages with `actions/cache@v4` using `hashFiles('**/packages.lock.json')`; avoid altering this unless lock files move.

## .NET Build & Test Actions
- `dotnet-ci` builds all projects under `src`, generates a semantic version using `majorMinorVersion` + `run_number` + `run_attempt`, and appends `-preview` when not on `main`.
- `dotnet-web-ci` publishes a single project to `$RUNNER_TEMP/dotnet-publish/<project>` before uploading artifacts; maintain that temp path when adding steps so downstream deploy actions keep working.
- `dotnet-func-ci` derives the publish folder from the target framework substring of `dotnet-version` (e.g., "9.0.x" -> `net9.0`); reuse the `ARTIFACT_PATH` logic for new frameworks.
- All dotnet actions run unit tests with `--filter FullyQualifiedName!~IntegrationTests`; use `run-api-integration-tests` when you actually want to execute the IntegrationTests subset with API credentials.

## Deployment Actions
- `deploy-app-service` expects a zipped web artifact in the downloaded folder and uses `azure/webapps-deploy@v3.0.1`; keep artifact names aligned with the build action outputs.
- `deploy-function-app` and `deploy-logic-app` both call `azure/functions-action@v1`; logic apps reuse the same zip deployment mechanism, so ensure artifacts match `actions.upload-artifact` outputs from CI.
- `deploy-sql-database` installs `microsoft.sqlpackage` as a global dotnet tool and publishes DACPACs with `azure/sql-action@v2.3`; keep SQL project path defaults (`src/database/database.sqlproj`) unless consumer repos diverge.

## Terraform Automation
- `terraform-plan` and `terraform-plan-readonly` write `${plan-file-name}` inside `${terraform-folder}` and upload it as `${plan-artifact-name}`; `terraform-apply` downloads the same artifact before running `terraform apply`.
- `terraform-plan-and-apply` performs plan + apply in one run using identical backend parameter assembly logic; reuse that PowerShell init block when adding new terraform composites to avoid drift.
- Backend configuration is supplied either through `terraform-backend-file` or explicit storage inputs; actions dynamically append only the non-empty flags, so new inputs should follow the same optional pattern.
- `terraform-destroy-resources` expects `resources` as a JSON array string and uses `jq` to iterate targets; make sure inputs are valid JSON (`['module.foo', 'azurerm_bar.example']`).
- `terraform-state-rm` removes addresses listed in the `state-addresses` JSON array and then runs a follow-up plan to show state changes; keep that safety check in place.
- `terraform-import` runs `terraform import` and then a plan, assuming the same var-file context as deploy plans; supply full Azure resource IDs in `import-id`.

## Linting, Packaging & Misc
- `bicep-lint-code` loops over every `.bicep` file, restores modules, builds templates, and runs `Microsoft/ps-rule@main` producing `reports/ps-rule-results.xml`; keep outputs in the `reports` folder for consistency.
- `publish-nuget-packages` pulls an artifact and executes `dotnet nuget push **\*.nupkg`; paths use Windows globbing because the publish workflow often runs on Windows runners.
- When introducing new composite actions, follow the existing naming scheme (`kebab-case` folder + action name) and ensure `actions/checkout@v6` is only added when repository files are required.

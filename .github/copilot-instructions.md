# GitHub Copilot Instructions

## Repo Shape & Versioning
- Each top-level folder (bicep-lint-code, dotnet-*, deploy-*, terraform-*, etc.) is a self-contained composite action: `action.yml` plus a folder-scoped `version.json` so Nerdbank.GitVersioning only advances that action’s tags.
- The `actions-versioning` workflow retags touched folders on pushes to `main` with `<folder>/vX.Y.Z`, `<folder>/vX.Y`, and `<folder>/vX`; edit the folder’s `version.json` before merge whenever you need a major/minor bump.
- Automation is meant to be consumed from other repos; never couple actions through shared scripts at the repo root and prefer duplicating small helpers inside the target folder.

## Execution Conventions
- Default shell choice is intentional: PowerShell (`pwsh`) covers versioning/backends/JSON assembly while Bash executes cross-platform CLI work; keep the same mix when inserting steps.
- Azure access always flows through OIDC inputs (`AZURE_CLIENT_ID|TENANT_ID|SUBSCRIPTION_ID`); terraform actions immediately surface them as `ARM_*` plus `ARM_USE_OIDC=true`, so do not re-run `az login` unless absolutely required.
- Artifact exchange always uses inputs for artifact names and explicit `actions/download-artifact@v4` / `actions/upload-artifact@v6` calls—no hard-coded paths from upstream jobs.
- Package caching is standardized on `actions/cache@v4` with `hashFiles('**/packages.lock.json')`; if you change lockfile locations, update the hash expression everywhere in that folder.

## .NET Build/Test Patterns
- `dotnet-ci`, `dotnet-web-ci`, and `dotnet-func-ci` all install `nbgv` into a throwaway `.nbgv-tool` folder, run `nbgv cloud`, and expose the computed build values via `$GITHUB_ENV`; respect the optional `perform-checkout` flag so consumers can reuse their own full-depth checkout.
- SDK resolution splits stable vs `*-preview` entries (see `dotnet-ci/action.yml` lines 32-78); keep that parsing helper whenever you need multi-channel SDK installs.
- Unit tests intentionally exclude integration coverage by default (`--filter FullyQualifiedName!~IntegrationTests`); the `run-api-integration-tests` action runs only the `IntegrationTests` subset and injects API creds via env vars (`api_base_url`, `api_key`, etc.).
- `dotnet-web-ci` publishes to `$RUNNER_TEMP/dotnet-publish/<project>` (see dotnet-web-ci/action.yml) so downstream deploy actions can download by project name; do not change that temp layout.
- `dotnet-func-ci` uploads the raw `src/<project>/bin/Release` folder as the deployment artifact and writes the path into `ARTIFACT_PATH` via PowerShell before the upload step.

## Deployment Actions
- `deploy-app-service` assumes the downloaded artifact root contains the web zip/publish folder and uses `azure/webapps-deploy@v3.0.1` with the provided RG + app name.
- `deploy-function-app` downloads into `artifacts/<artifact-name>` and points `azure/functions-action@v1` at that directory; keep the relative layout if you add pre-deploy validation.
- `deploy-logic-app` (logic-app-ci + deploy-logic-app) simply zips the `src/<logic-project>` folder; avoid renaming files inside the artifact because logic app deploy assumes the original folder structure.
- `deploy-sql-database` installs `microsoft.sqlpackage` as a global tool and deploys `src/database/database.sqlproj` via `azure/sql-action@v2.3`; only add path inputs if consumers consistently diverge.

## Terraform Workflows
- All terraform composites (`terraform-plan*`, `terraform-apply`, `terraform-destroy*`, `terraform-import`, `terraform-state-rm`) assemble backend arguments in PowerShell by appending only non-empty inputs or a provided backend file—reuse that pattern verbatim to avoid regression on optional storage settings.
- Plans always execute inside `${terraform-folder}` and write `${plan-file-name}` there; `terraform-plan` uploads it as `${plan-artifact-name}` and `terraform-apply` expects to download the same artifact before `terraform apply`.
- `terraform-plan-and-apply` keeps the plan file on disk and immediately applies it; if you introduce additional validation, ensure the plan file still exists before the apply step (see existing bash guard).
- `terraform-destroy-resources` requires the `resources` input to be a JSON array string (default example in the action). It pipes through `jq -r '.[]'` to iterate targets, so `jq` must stay available.
- `terraform-state-rm` and `terraform-import` both finish by running a follow-up `terraform plan` so users can see drift; never remove those safety steps.

## Linting, Packaging, Misc
- `bicep-lint-code` recurses through every `.bicep`, runs `bicep build` and `Microsoft/ps-rule@main`, and stores reports under `reports/ps-rule-results.xml`; if you add new checks, keep report output inside `reports/`.
- `publish-nuget-packages` runs on Windows runners and relies on PowerShell globbing (`**\*.nupkg`); preserve Windows-friendly quoting when extending.
- Composite folders follow kebab-case names and only include `actions/checkout@v6` when local files are needed; share knowledge via documentation instead of cross-folder scripts.

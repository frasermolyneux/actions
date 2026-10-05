# GitHub Actions
[![Actions Versioning](https://github.com/frasermolyneux/actions/actions/workflows/actions-versioning.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/actions-versioning.yml)
[![Code Quality](https://github.com/frasermolyneux/actions/actions/workflows/code-quality.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/code-quality.yml)
[![Codequality](https://github.com/frasermolyneux/actions/actions/workflows/codequality.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/codequality.yml)
[![Dependabot Auto-Merge](https://github.com/frasermolyneux/actions/actions/workflows/dependabot-automerge.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/dependabot-automerge.yml)
[![Devops Secure Scanning](https://github.com/frasermolyneux/actions/actions/workflows/devops-secure-scanning.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/devops-secure-scanning.yml)

## Documentation
- [docs/workflow-linting.md](docs/workflow-linting.md) - Released-parser compatibility
  for commit-bound self references without disabling workflow or ShellCheck rules.
- [docs/action-versioning.md](docs/action-versioning.md) - Tagging strategy and guidance for selecting version pins.
- [docs/codequality.md](docs/codequality.md) - Reusable workflow that wires SonarCloud, CodeQL, and composite builds.
- [docs/repository-analysis.md](docs/repository-analysis.md) - Visibility-aware scanner selection
  and private result boundaries for the estate analysis migration.
- [docs/repository-analysis-local.md](docs/repository-analysis-local.md) - Pinned local
  analyzers, isolated source execution and truthful native result validation.
- [docs/repository-analysis-workflows.md](docs/repository-analysis-workflows.md) - Reusable
  selected-local-tool matrix, private artifacts and verified public SARIF publication.
- [docs/repository-analysis-state.md](docs/repository-analysis-state.md) - Complete
  per-tool results, actual coverage provenance and bounded default-branch freshness.
- [docs/repository-analysis-sarif.md](docs/repository-analysis-sarif.md) - Native SARIF
  processing verification with actual source, selected tool and publication identities.
- [docs/repository-analysis-sonar.md](docs/repository-analysis-sonar.md) - Pinned,
  build-aware public Sonar tasks, same-source coverage and explicit partial acceptance.
- [docs/repository-publication-origin.md](docs/repository-publication-origin.md) - Metadata-only
  publication admission and verified downstream workflow lineage before App merge cutover.
- [docs/copilot-setup.md](docs/copilot-setup.md) - Copilot setup v2 contract and migration guidance for repositories that need custom environment setup.
- [docs/dotnet-test-reporting.md](docs/dotnet-test-reporting.md) - Shared .NET test execution, optional pinned native coverage, multi-project TRX reporting, test-environment setup and owned PR result summaries.
- [docs/nerdbank-gitversioning.md](docs/nerdbank-gitversioning.md) - How composites satisfy Nerdbank.GitVersioning requirements.

## Overview
Reusable composite GitHub Actions keep .NET and CMake builds, Terraform automation, deployment flows, and Copilot environment setup consistent across personal projects. Each action folder owns a version.json so Nerdbank.GitVersioning can stamp independent tags, refreshed by the actions-versioning workflow on main. Composites cover .NET solution, web, and Azure Functions CI, generic CMake configure/build/test CI, SDK setup and NBGV metadata, combined .NET + Node test-environment setup with bounded TRX reporting, Terraform plan/apply/destroy with Azure OIDC, optional Copilot runtime setup, deployment helpers for App Service, Functions, Logic Apps, and SQL, and repository devex automation helpers (`stale-branch-sweep`, `delegate-failed-checks`, `approve-copilot-workflow-runs`) consumed by `platform-devex`.

## Contributing
Please read the [contributing](CONTRIBUTING.md) guidance; this is a learning and development project.

## Security
Please read the [security](SECURITY.md) guidance; I am always open to security feedback through email or opening an issue.

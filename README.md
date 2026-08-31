# GitHub Actions
[![Actions Versioning](https://github.com/frasermolyneux/actions/actions/workflows/actions-versioning.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/actions-versioning.yml)
[![Code Quality](https://github.com/frasermolyneux/actions/actions/workflows/code-quality.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/code-quality.yml)
[![Codequality](https://github.com/frasermolyneux/actions/actions/workflows/codequality.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/codequality.yml)
[![Dependabot Auto-Merge](https://github.com/frasermolyneux/actions/actions/workflows/dependabot-automerge.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/dependabot-automerge.yml)
[![Devops Secure Scanning](https://github.com/frasermolyneux/actions/actions/workflows/devops-secure-scanning.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/devops-secure-scanning.yml)

## Documentation
- [docs/action-versioning.md](docs/action-versioning.md) - Tagging strategy and guidance for selecting version pins.
- [docs/codequality.md](docs/codequality.md) - Reusable workflow that wires SonarCloud, CodeQL, and composite builds.
- [docs/copilot-setup.md](docs/copilot-setup.md) - Copilot setup v2 contract and migration guidance for repositories that need custom environment setup.
- [docs/nerdbank-gitversioning.md](docs/nerdbank-gitversioning.md) - How composites satisfy Nerdbank.GitVersioning requirements.

## Overview
Reusable composite GitHub Actions keep .NET and CMake builds, Terraform automation, deployment flows, and Copilot environment setup consistent across personal projects. Each action folder owns a version.json so Nerdbank.GitVersioning can stamp independent tags, refreshed by the actions-versioning workflow on main. Composites cover .NET solution, web, and Azure Functions CI, generic CMake configure/build/test CI, SDK setup and NBGV metadata, Terraform plan/apply/destroy with Azure OIDC, optional Copilot runtime setup, and deployment helpers for App Service, Functions, Logic Apps, and SQL.
Each action's `action.yml` is the source of truth for its inputs, outputs, and behavior.

## Contributing
Please read the [contributing](CONTRIBUTING.md) guidance; this is a learning and development project.

## Security
Please read the [security](SECURITY.md) guidance; I am always open to security feedback through email or opening an issue.

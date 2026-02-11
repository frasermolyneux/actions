# GitHub Actions
[![Actions Versioning](https://github.com/frasermolyneux/actions/actions/workflows/actions-versioning.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/actions-versioning.yml)
[![Codequality](https://github.com/frasermolyneux/actions/actions/workflows/codequality.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/codequality.yml)
[![Dependabot Auto-Merge](https://github.com/frasermolyneux/actions/actions/workflows/dependabot-automerge.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/dependabot-automerge.yml)
[![Devops Secure Scanning](https://github.com/frasermolyneux/actions/actions/workflows/devops-secure-scanning.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/devops-secure-scanning.yml)

## Documentation
- [docs/action-versioning.md](docs/action-versioning.md) - Tagging strategy and guidance for selecting version pins.
- [docs/codequality.md](docs/codequality.md) - Reusable workflow that wires SonarCloud, CodeQL, and composite builds.
- [docs/nerdbank-gitversioning.md](docs/nerdbank-gitversioning.md) - How composites satisfy Nerdbank.GitVersioning requirements.

## Overview
Reusable composite GitHub Actions keep .NET builds, Terraform automation, and deployment flows consistent across personal projects. Each action folder owns a version.json so Nerdbank.GitVersioning can stamp independent tags, refreshed by the actions-versioning workflow on main. Composites cover .NET solution, web, and Azure Functions CI, SDK setup and NBGV metadata, Terraform plan/apply/destroy with Azure OIDC, and deployment helpers for App Service, Functions, Logic Apps, and SQL.

## Contributing
Please read the [contributing](CONTRIBUTING.md) guidance; this is a learning and development project.

## Security
Please read the [security](SECURITY.md) guidance; I am always open to security feedback through email or opening an issue.

# GitHub Actions
[![Actions Versioning](https://github.com/frasermolyneux/actions/actions/workflows/actions-versioning.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/actions-versioning.yml)
[![Code Quality](https://github.com/frasermolyneux/actions/actions/workflows/code-quality.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/code-quality.yml)
[![Codequality](https://github.com/frasermolyneux/actions/actions/workflows/codequality.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/codequality.yml)
[![Copilot Setup Steps](https://github.com/frasermolyneux/actions/actions/workflows/copilot-setup-steps.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/copilot-setup-steps.yml)
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

## Local dev: MCP wire-up
This repo is wired to load the shared `frasermolyneux-copilot` MCP server when running under Copilot CLI or the GitHub Copilot coding agent. The wire-up lives in `.github/workflows/copilot-setup-steps.yml` (checks out `frasermolyneux/.github-copilot` at tag `v0.1.0` and builds the MCP server) and `.github/copilot/mcp_config.json` (spawn config). For the full tool surface, content-root resolution, and per-client wire-up snippets, see `.github-copilot/mcp-server/README.md` in [`frasermolyneux/.github-copilot`](https://github.com/frasermolyneux/.github-copilot).

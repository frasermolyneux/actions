# GitHub Actions
> Reusable composite workflows covering .NET builds, Terraform automation, and supporting GitHub hygiene.

`GitHub Actions workflows (2)`
[![Actions Versioning](https://github.com/frasermolyneux/actions/actions/workflows/actions-versioning.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/actions-versioning.yml)
[![Dependabot Auto-Merge](https://github.com/frasermolyneux/actions/actions/workflows/dependabot-automerge.yml/badge.svg)](https://github.com/frasermolyneux/actions/actions/workflows/dependabot-automerge.yml)

## 📌 Overview
Opinionated composite actions keep .NET packaging, Terraform provisioning, and automation hygiene consistent across personal projects. Docs capture the tagging strategy plus Nerdbank.GitVersioning alignment so every action folder can be versioned predictably.

## 🧱 Technology & Frameworks
- `.NET SDK 9.0.x` – Restores, builds, and tests .NET solutions inside CI composites.
- `Terraform CLI 1.9.x+` – Plan/apply/destroy actions with Azure OIDC wiring.
- `PowerShell 7.x & Bash 5.x` – Default shells for script-heavy orchestration on `ubuntu-latest` runners.

## 📚 Documentation Index
- [docs/action-versioning.md](https://github.com/frasermolyneux/actions/blob/main/docs/action-versioning.md) – Tagging strategy and guidance for selecting version pins.
- [docs/nerdbank-gitversioning.md](https://github.com/frasermolyneux/actions/blob/main/docs/nerdbank-gitversioning.md) – How composite actions satisfy Nerdbank.GitVersioning requirements.

## 🚀 Getting Started
**Highlights**
- Folder-scoped semantic versioning keeps action updates predictable.
- Drop-in .NET CI composites cover restore, build, test, and artifact publishing.
- Terraform plan/apply/destroy composites enforce Azure OIDC flows out of the box.

**Sample Usage (optional)**
```yaml
jobs:
  build-and-plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run .NET CI
        uses: frasermolyneux/actions/dotnet-ci@dotnet-ci/v1
        with:
          src-folder: src
      - name: Terraform plan (dev)
        uses: frasermolyneux/actions/terraform-plan@terraform-plan/v1
        with:
          terraform-folder: terraform
          terraform-var-file: tfvars/dev.tfvars
          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
          AZURE_SUBSCRIPTION_ID: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
```

## 🛠️ Developer Quick Start
```shell
git clone https://github.com/frasermolyneux/actions.git
cd actions
# Inspect all composite definitions
pwsh -NoProfile -Command "Get-ChildItem -Recurse -Filter action.yml | Select-Object FullName"
# Optionally rehearse the tagging workflow locally (requires act)
act push -W .github/workflows/actions-versioning.yml
```

## 🤝 Contributing
Please read the [contributing](https://github.com/frasermolyneux/actions/blob/main/CONTRIBUTING.md) guidance; this is a learning and development project.

## 🔐 Security
Please read the [security](https://github.com/frasermolyneux/actions/blob/main/SECURITY.md) guidance; I am always open to security feedback through email or opening an issue.

## 📄 License
Distributed under the [GNU General Public License v3.0](https://github.com/frasermolyneux/actions/blob/main/LICENSE).

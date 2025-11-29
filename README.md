# GitHub Actions

## Overview

This repository contains GitHub Actions for my personal projects.

---

## Nerdbank.GitVersioning alignment

- Every .NET composite (`dotnet-ci`, `dotnet-web-ci`, `dotnet-func-ci`) now performs its own `actions/checkout@v6` with `fetch-depth: 0` to satisfy the [Nerdbank.GitVersioning cloud-build requirements](https://dotnet.github.io/Nerdbank.GitVersioning/docs/cloudbuild.html). If your workflow already checked out the repo (for example to pull submodules into a custom path), pass `perform-checkout: 'false'` and ensure your previous checkout used `fetch-depth: 0` as well.
- Nerdbank.GitVersioning is installed per run using `dotnet tool install --tool-path <workspace> nbgv`, exactly as the documentation describes, before executing `nbgv cloud` and `nbgv get-version`. This guarantees that `nbgv` can compute correct semantic versions and update the cloud build number.

---

## Contributing

Please read the [contributing](CONTRIBUTING.md) guidance; this is a learning and development project.

---

## Security

Please read the [security](SECURITY.md) guidance; I am always open to security feedback through email or opening an issue.

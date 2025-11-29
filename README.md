# GitHub Actions

## Overview

This repository contains GitHub Actions for my personal projects.

---

## Action versioning

- Each composite action folder owns a dedicated `version.json` so Nerdbank.GitVersioning can calculate versions that only advance when files inside that folder change.
- Pushing to `main` automatically runs the `actions-versioning` workflow, which installs `nbgv`, recomputes versions for the folders touched in the push, and creates tags shaped like `actions/<folder>/v<semver>` (for example `actions/dotnet-ci/v1.0.15`).
- Consumers should reference these tags (or a major alias you create) when invoking the actions, e.g. `frasermolyneux/actions/dotnet-ci@actions/dotnet-ci/v1`.
- To bump a major or minor version, edit the corresponding folder's `version.json` before merging to `main`; patch versions are derived automatically from commit height.

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

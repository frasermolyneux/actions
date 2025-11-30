# GitHub Actions

## Overview

This repository contains GitHub Actions for my personal projects.

---

## Action versioning

- Each composite action folder owns a dedicated `version.json` so Nerdbank.GitVersioning can calculate versions that only advance when files inside that folder change.
- Pushing to `main` automatically runs the `actions-versioning` workflow, which installs `nbgv`, recomputes versions for the folders touched in the push, and emits three tag shapes for each updated action:
	- Patch tags: `<folder>/v<semver>` (for example `dotnet-ci/v1.0.15`).
	- Rolling major tags: `<folder>/v<major>` (for example `dotnet-ci/v1`) that always point at the newest `v1.*.*` release.
	- Rolling minor tags: `<folder>/v<major.minor>` (for example `dotnet-ci/v1.2`) that always point at the newest `v1.2.*` release.
- Consumers should reference whichever tag scope matches their tolerance for updates when invoking the actions (see examples below).
- To bump a major or minor version, edit the corresponding folder's `version.json` before merging to `main`; patch versions are derived automatically from commit height.

### Choosing a version tag

```yaml
jobs:
	build:
		steps:
			- uses: actions/checkout@v4
			- name: Run dotnet CI
				uses: frasermolyneux/actions/dotnet-ci@dotnet-ci/v1.0.15   # Pin to an exact patch release

			- name: Run dotnet CI (minor rolling)
				uses: frasermolyneux/actions/dotnet-ci@dotnet-ci/v1.2      # Always latest patch within v1.2

			- name: Run dotnet CI (major rolling)
				uses: frasermolyneux/actions/dotnet-ci@dotnet-ci/v1        # Always latest patch within v1.*
```

| Tag shape         | Example             | Update cadence                                   |
| ----------------- | ------------------- | ------------------------------------------------ |
| `<folder>/vX.Y.Z` | `dotnet-ci/v1.0.15` | Never moves; change only when you edit workflow. |
| `<folder>/vX.Y`   | `dotnet-ci/v1.2`    | Moves whenever a new `v1.2.*` patch publishes.   |
| `<folder>/vX`     | `dotnet-ci/v1`      | Moves whenever any `v1.*.*` patch publishes.     |

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

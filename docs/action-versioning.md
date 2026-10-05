# Action Versioning

Each composite action in this repository owns a dedicated `version.json` so Nerdbank.GitVersioning can calculate versions that only advance when files inside that folder change.

The `repository-analysis` workflow package is the explicit exception: it has no
composite `action.yml`; its path filters and release detector include the reusable
local-analysis workflow and its actual context/local/native-verifier dependency
closure. Invoke that workflow using an exact `repository-analysis/vX.Y.Z` tag;
changes to any execution dependency trigger a new immutable package release.

## Publishing Flow

- Pushing to `main` runs the `actions-versioning` workflow, which installs `nbgv`, recomputes versions for the folders touched in the push, and emits three tag shapes for each updated action.
- The `ACTIONS` array is release order, not just a catalog. Put new dependencies before their consumers (for example, `dotnet-test-report`, then `dotnet-test`, then the CI wrappers) so a partial release cannot publish a wrapper pointing at missing tags.
- Consumers should reference whichever tag scope matches their tolerance for updates when invoking the actions (see examples below).
- To bump a major or minor version, edit the corresponding folder's `version.json` before merging to `main`; patch versions are derived automatically from commit height.

## Choosing a Version Tag

```yaml
jobs:
  build:
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0
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

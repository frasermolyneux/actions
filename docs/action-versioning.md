# Action Versioning

Each composite action in this repository owns a dedicated `version.json` so Nerdbank.GitVersioning can calculate versions that only advance when files inside that folder change.

The `repository-analysis` workflow package is the explicit exception: its internal
evidence composite supports a reusable workflow consumer API. Its path filters and release detector include the reusable
local-analysis workflow and its actual context/local/native-verifier dependency
closure. Invoke that workflow using the full commit SHA of an exact `repository-analysis/vX.Y.Z` tag;
changes to any execution dependency trigger a new immutable package release.
Same-repository implementation dependencies use GitHub's commit-bound `$/`
references. The local/state/native-verifier composites include their context
dependency in release detection and repository-root-anchored version filters.

The `codequality` and `devops-secure-scanning` workflow packages own
`.github/workflows/codequality.yml` and `.github/workflows/devops-secure-scanning.yml`
respectively. They have version metadata but no standalone composite action.
Their release filters include the workflow and its first-party execution closure;
commit-bound `$/` dependencies require runner 2.336.0 or later. Exact external
action pins must be updated explicitly when adopting new dependency releases:
detecting a dependency change does not rewrite a pinned SHA.

## Publishing Flow

- Pushing to `main` runs the `actions-versioning` workflow, which installs `nbgv`, recomputes versions for the folders touched in the push, and emits three tag shapes for each updated action.
- The `ACTIONS` array is release order, not just a catalog. Put new dependencies before their consumers (for example, `dotnet-test-report`, then `dotnet-test`, then the CI wrappers) so a partial release cannot publish a wrapper pointing at missing tags.
- Consumers should resolve the latest reviewed exact patch tag to its full commit SHA, pin that SHA, and retain the tag as a comment. Recheck the tag after each prerequisite release.
- To bump a major or minor version, edit the corresponding folder's `version.json` before merging to `main`; the release workflow allocates the next patch after the highest existing exact patch tag.

## Choosing a Version Tag

```yaml
jobs:
  build:
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0
      - name: Run dotnet CI
        uses: frasermolyneux/actions/dotnet-ci@<FULL_RELEASE_SHA> # dotnet-ci/vX.Y.Z
```

| Tag shape         | Example             | Update cadence                                   |
| ----------------- | ------------------- | ------------------------------------------------ |
| `<folder>/vX.Y.Z` | `dotnet-ci/v1.0.15` | Never moves; change only when you edit workflow. |
| `<folder>/vX.Y`   | `dotnet-ci/v1.2`    | Moves whenever a new `v1.2.*` patch publishes.   |
| `<folder>/vX`     | `dotnet-ci/v1`      | Moves whenever any `v1.*.*` patch publishes.     |

These tags identify releases; the caller pin is the resolved commit SHA, not a
rolling tag. For workflow packages, use the same release tag prefix to resolve
the commit, then pin the reusable workflow path at that SHA.

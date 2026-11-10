# NuGet package publishing

`publish-nuget-packages/v3` publishes packages and symbols to NuGet.org using
GitHub OIDC and NuGet trusted publishing only. This is a breaking change from v2:
the caller must supply `nuget-user` and grant the publishing job
`id-token: write`. A caller-provided `NUGET_API_KEY` is no longer used, even if
OIDC login fails or returns no key. There is no stored-key fallback.

## Caller prerequisites

- Configure a [NuGet trusted publishing policy](https://learn.microsoft.com/nuget/nuget-org/trusted-publishing)
  matching the originating repository, caller workflow filename and environment
  (if the policy specifies one). Use the NuGet username of the **policy creator**,
  which is not necessarily the package owner. The shared action does not create
  or modify policies.
- Grant the publishing job `id-token: write` and `contents: read`. Composites cannot
  grant these permissions themselves; reusable-workflow callers must also allow
  them. Keep existing publication admission and environment protections.
- Provide a runner with Bash and the .NET SDK, plus support for the pinned
  checkout and artifact actions. The login action uses **Node 24**, which requires
  Actions Runner **v2.327.1 or later**. The reported private ARC runner v2.338.2
  exceeds that minimum; its image must still provide Bash and .NET.
- Supply an artifact containing the `.nupkg` and optional `.snupkg` files. For
  cross-run downloads, retain `artifact-run-id` and a `github-token` authorized to
  read that run's artifacts (normally `actions: read`).

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Publish packages
        # Use the released exact patch tag or its dereferenced full commit SHA
        # for an immutable production pin; v3 is a moving major alias.
        uses: frasermolyneux/actions/publish-nuget-packages@publish-nuget-packages/v3
        with:
          nuget-user: your-policy-creator
          artifact-name: nuget-packages
```

For production, replace the ref after
`@` with a released `publish-nuget-packages/v3.0.N` tag or its full commit SHA.
Never predict a patch suffix: the main-push versioning workflow allocates it.

## Inputs and migration

| Input | Requirement / default |
|---|---|
| `nuget-user` | Required; NuGet trusted publishing policy creator username |
| `artifact-name` | Required; artifact containing packages |
| `artifact-run-id` | Optional; empty means the current workflow run |
| `github-token` | Optional; required for cross-run artifact downloads |
| `artifact-output-path` | Optional; defaults to `.` |
| `perform-checkout` | Optional; defaults to `"true"`; use `"false"` only after checkout with `fetch-depth: 0` |

When migrating from v2, add the username and job permission and stop passing the
stored key to this action. Consumer repository changes and credential retirement
are separate rollout work; releasing v3 does not change existing v2 consumers.
The action has no outputs and never exports the ephemeral key through
`GITHUB_ENV`, action outputs or artifacts.

## Authentication and preserved publishing behavior

After optional checkout and either current-run or cross-run artifact download,
the action invokes official
[`NuGet/login` v1.2.0](https://github.com/NuGet/login/releases/tag/v1.2.0),
pinned to reviewed commit
`8d196754b4036150537f80ac539e15c2f1028841`. The manifest and distributed
`dist/index.js` entrypoint were reviewed at that commit: it requests the
`https://www.nuget.org` audience, exchanges the OIDC token at
`https://www.nuget.org/api/v2/token`, masks the returned key, sets
`NUGET_API_KEY` as a step output and fails on missing username/OIDC, rejected
exchange or a missing key. No custom endpoint or audience is exposed here.
Login is immediately before the push step, keeping the key's lifetime away from
checkout, downloads and builds.

Only the push step receives that output as its local `NUGET_API_KEY` environment
variable, overriding any inherited value. An empty output fails before invoking
`dotnet`. Neither the username nor artifact path is interpolated into shell code.
The quoted key and path remain literal arguments, including shell metacharacters.

Package and symbol behavior is unchanged: push `**/*.nupkg` with
`--skip-duplicate`; push existing `**/*.snupkg` only when package output includes
`Successfully published`. All-duplicate packages skip symbols, successful
packages without symbols skip the symbol push, and package/symbol push failures
fail the action (`set -euo pipefail` preserves pipeline failures). Login failure
prevents the push step entirely.

The focused contract suite runs with
`python -m unittest discover -s scripts -p 'test_publish_nuget_packages.py'`.
It executes the production Bash push script with a fake `dotnet`, without
requesting OIDC tokens or publishing packages. A real package publish additionally
depends on the consumer's matching NuGet policy and job identity.

Node 24 runner support is documented in the
[Actions Runner v2.327.1 release](https://github.com/actions/runner/releases/tag/v2.327.1).

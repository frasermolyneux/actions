# Copilot setup

`copilot-setup` is a deterministic environment setup action for GitHub Copilot cloud agent setup workflows. It provides optional repository checkout and opt-in installation of the .NET, Node.js, and Python runtimes.

Use it only when a repository needs custom runtime installation or dependency restore before an agent starts. Resolve a reviewed release as described in [action versioning](action-versioning.md).

The action:

- expects instructions and other agent configuration to be stored in the consumer repository;
- defaults `checkout-repo` to `false`;
- installs no runtime unless its corresponding `setup-*` input is `true`; and
- requires the matching runtime version input when a runtime is enabled.

Copilot cloud agent checks out the repository after setup when setup does not need repository files. Set `checkout-repo: 'true'` only when a later setup step needs files from the repository, such as a lockfile used for deterministic dependency restore.

## Inputs

The [action manifest](../copilot-setup/action.yml) defines all inputs and defaults.

Runtime versions are deliberately consumer-owned. The shared action does not select or update versions and does not configure dependency caching because lockfile locations and cache requirements are repository-specific.

## Examples

Replace release and runtime placeholders with the consumer's reviewed release
and runtime versions.

### No custom setup

When no runtime or pre-session dependency restore is required, omit the shared action and the `copilot-setup-steps.yml` workflow. Copilot cloud agent will create its environment and check out the repository without custom setup.

### .NET runtime and repository checkout

```yaml
steps:
  - name: Set up Copilot environment
    uses: frasermolyneux/actions/copilot-setup@<FULL_RELEASE_SHA> # copilot-setup/vX.Y.Z
    with:
      checkout-repo: 'true'
      setup-dotnet: 'true'
      dotnet-version: <YOUR_SDK_VERSION>

  - name: Restore dependencies
    run: dotnet restore
```

### Node.js runtime and repository checkout

```yaml
steps:
  - name: Set up Copilot environment
    uses: frasermolyneux/actions/copilot-setup@<FULL_RELEASE_SHA> # copilot-setup/vX.Y.Z
    with:
      checkout-repo: 'true'
      setup-node: 'true'
      node-version: <YOUR_NODE_VERSION>

  - name: Restore dependencies
    run: npm ci
```

Dependency restore remains in each consumer's `.github/workflows/copilot-setup-steps.yml` after the shared action. This keeps restore commands, working directories, lockfiles, and cache configuration repository-specific.

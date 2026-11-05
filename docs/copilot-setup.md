# Copilot setup

`copilot-setup` v2 is a deterministic environment setup action for GitHub Copilot cloud agent setup workflows. It provides optional repository checkout and opt-in installation of the .NET, Node.js, and Python runtimes.

The action is published at `copilot-setup/v2`. Use it only when a repository needs custom runtime installation or dependency restore before an agent starts.

The action:

- expects instructions and other agent configuration to be stored in the consumer repository;
- defaults `checkout-repo` to `false`;
- installs no runtime unless its corresponding `setup-*` input is `true`; and
- requires the matching runtime version input when a runtime is enabled.

Copilot cloud agent checks out the repository after setup when setup does not need repository files. Set `checkout-repo: 'true'` only when a later setup step needs files from the repository, such as a lockfile used for deterministic dependency restore.

## Inputs

| Input | Default | Description |
|---|---:|---|
| `checkout-repo` | `'false'` | Checkout the current repository during setup. Enable only when later setup steps need repository files. |
| `checkout-fetch-depth` | `'1'` | Fetch depth used when `checkout-repo` is enabled. |
| `setup-dotnet` | `'false'` | Install .NET SDK versions supplied through `dotnet-version`. |
| `dotnet-version` | `''` | .NET SDK version or versions. Required when `setup-dotnet` is enabled. |
| `setup-node` | `'false'` | Install the Node.js version supplied through `node-version`. |
| `node-version` | `''` | Node.js version. Required when `setup-node` is enabled. |
| `setup-python` | `'false'` | Install the Python version supplied through `python-version`. |
| `python-version` | `''` | Python version. Required when `setup-python` is enabled. |

Runtime versions are deliberately consumer-owned. The shared action does not select or update versions and does not configure dependency caching because lockfile locations and cache requirements are repository-specific.

## Examples

### No custom setup

When no runtime or pre-session dependency restore is required, omit the shared action and the `copilot-setup-steps.yml` workflow. Copilot cloud agent will create its environment and check out the repository without custom setup.

### .NET runtime and repository checkout

```yaml
steps:
  - name: Set up Copilot environment
    uses: frasermolyneux/actions/copilot-setup@copilot-setup/v2
    with:
      checkout-repo: 'true'
      setup-dotnet: 'true'
      dotnet-version: |
        9.0.x
        10.0.x

  - name: Restore dependencies
    run: dotnet restore
```

### Node.js runtime and repository checkout

```yaml
steps:
  - name: Set up Copilot environment
    uses: frasermolyneux/actions/copilot-setup@copilot-setup/v2
    with:
      checkout-repo: 'true'
      setup-node: 'true'
      node-version: 20.x

  - name: Restore dependencies
    run: npm ci
```

Dependency restore remains in each consumer's `.github/workflows/copilot-setup-steps.yml` after the shared action. This keeps restore commands, working directories, lockfiles, and cache configuration repository-specific.

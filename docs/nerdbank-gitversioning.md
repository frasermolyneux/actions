# Nerdbank.GitVersioning Alignment

- The .NET CI composites (`dotnet-ci`, `dotnet-web-ci`, `dotnet-func-ci`) check out with `fetch-depth: 0` by default to satisfy the [Nerdbank.GitVersioning cloud-build requirements](https://dotnet.github.io/Nerdbank.GitVersioning/docs/cloudbuild.html). If the caller already checked out the repository, set `perform-checkout: 'false'` and use `fetch-depth: 0` there.
- The `nbgv-metadata` action installs its configured CLI version into a local tool path, then runs `nbgv cloud` and `nbgv get-version`. Its [manifest](../nbgv-metadata/action.yml) owns the default and inputs.

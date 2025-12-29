# Code Quality reusable workflow

Use this reusable workflow to run SonarCloud analysis, CodeQL, and the standard .NET build/test composites without duplicating boilerplate across repositories. It supports regular .NET solutions (`dotnet-ci`), ASP.NET/web apps (`dotnet-web-ci`), and Azure Functions (`dotnet-func-ci`).

## Inputs
- `sonar-project-key` (required): SonarCloud project key, e.g., `frasermolyneux_portal-event-ingest`.
- `sonar-organization` (default `frasermolyneux`): SonarCloud organization key.
- `sonar-host-url` (default `https://sonarcloud.io`): Sonar endpoint.
- `build-target` (default `dotnet-ci`): `dotnet-ci`, `dotnet-web-ci`, or `dotnet-func-ci` composite to run.
- `dotnet-project`: Required when `build-target` is `dotnet-web-ci` or `dotnet-func-ci`; project name to upload as the artifact.
- `publish-frameworks` (default empty): For `dotnet-web-ci`, optional comma/newline list of target frameworks to publish explicitly.
- `nuget-artifact-name` (default `nuget-packages`): For `dotnet-web-ci`, artifact name for NuGet packages.
- `dotnet-version` (default `9.0.x`): SDK version(s) to install.
- `src-folder` (default `src`): Folder containing the solution/projects.
- `use-framework-output-root` (default `false`): For Functions builds, upload the first framework-specific output folder instead of `bin/Release`.

## Secrets
- `SONAR_TOKEN` (required): SonarCloud token with analysis permissions.

## Usage
Reference the workflow directly from consuming repositories:

### Standard .NET solution
```yaml
name: Code Quality

on: [push, pull_request]

jobs:
  quality:
    uses: frasermolyneux/actions/.github/workflows/codequality.yml@main
    with:
      sonar-project-key: frasermolyneux_my-project
      build-target: dotnet-ci
      dotnet-version: 9.0.x
      src-folder: src
    secrets:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

### ASP.NET / Web app
```yaml
name: Code Quality

on: [push, pull_request]

jobs:
  quality:
    uses: frasermolyneux/actions/.github/workflows/codequality.yml@main
    with:
      sonar-project-key: frasermolyneux_my-webapp
      build-target: dotnet-web-ci
      dotnet-project: My.WebApp
      dotnet-version: 9.0.x
      src-folder: src
      publish-frameworks: net9.0
    secrets:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

### Azure Functions
```yaml
name: Code Quality

on: [push, pull_request]

jobs:
  quality:
    uses: frasermolyneux/actions/.github/workflows/codequality.yml@main
    with:
      sonar-project-key: frasermolyneux_portal-event-ingest
      build-target: dotnet-func-ci
      dotnet-project: XtremeIdiots.Portal.Events.Ingest.App.V1
      dotnet-version: 9.0.x
      src-folder: src
    secrets:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

The workflow caches the SonarCloud scanner and package cache, initializes CodeQL for C#, runs the selected composite build, and finalizes Sonar analysis. Keep `fetch-depth: 0` in place to ensure CodeQL and Sonar have full history context.

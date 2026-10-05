#requires -Version 7.2
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$build = $env:SONAR_BUILD | ConvertFrom-Json
function Invoke-BuildCommand {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Analysis build command $Command failed (exit $LASTEXITCODE)." }
}
Push-Location -LiteralPath $env:SONAR_SCANNER_SOURCE
try {
    switch ($build.kind) {
        'dotnet' {
            Invoke-BuildCommand dotnet @('restore', $build.solution)
            if (-not $build.skipFormat) {
                Invoke-BuildCommand dotnet @('format', $build.solution, '--no-restore', '--verify-no-changes')
            }
            Invoke-BuildCommand dotnet @('build', $build.solution, '--configuration', 'Release', '--no-restore',
                '/p:ContinuousIntegrationBuild=true', '/p:IncludeSymbols=true', '/p:SymbolPackageFormat=snupkg')
        }
        'netfx' {
            Invoke-BuildCommand nuget @('restore', $build.solution)
            Invoke-BuildCommand msbuild @($build.solution, '/p:Configuration=Release', '/p:Platform=Any CPU')
        }
        'cmake' {
            Invoke-BuildCommand cmake (@('-S', '.', '-B', 'build') + @($build.configureArgs))
            Invoke-BuildCommand cmake (@('--build', 'build') + @($build.buildArgs))
            Invoke-BuildCommand ctest (@('--test-dir', 'build') + @($build.testArgs))
            $commands = Get-Content -LiteralPath 'build/compile_commands.json' -Raw | ConvertFrom-Json
            if (@($commands).Count -eq 0) { throw 'C++ analysis requires real nonempty compile commands.' }
        }
        'script' {
            if ($build.npmInstall) { Invoke-BuildCommand npm @('install') }
        }
        default { throw 'Unsupported analysis build family.' }
    }
}
finally { Pop-Location }

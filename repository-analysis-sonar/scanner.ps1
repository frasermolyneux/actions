#requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('install', 'begin', 'end')][string]$Mode
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$pin = '11.3.0'
if ($Mode -eq 'install') {
    $directory = Join-Path $env:RUNNER_TEMP "sonar-dotnet-$([guid]::NewGuid().ToString('N'))"
    dotnet tool install dotnet-sonarscanner --version $pin --tool-path $directory
    if ($LASTEXITCODE -ne 0) { throw 'Pinned Sonar .NET scanner installation failed.' }
    $command = Join-Path $directory ('dotnet-sonarscanner' + $(if ($IsWindows) { '.exe' } else { '' }))
    $installed = dotnet tool list --tool-path $directory
    if ($LASTEXITCODE -ne 0 -or ($installed -join "`n") -notmatch "(?m)^dotnet-sonarscanner\s+$([regex]::Escape($pin))\s+dotnet-sonarscanner\s*$" -or
        -not (Test-Path -LiteralPath $command -PathType Leaf)) {
        throw 'Installed Sonar .NET scanner does not match the pin.'
    }
    "command=$command" >> $env:GITHUB_OUTPUT
    return
}
if ([string]::IsNullOrWhiteSpace($env:SONAR_TOKEN)) { throw 'An existing Sonar token is required.' }
$arguments = @($Mode)
if ($Mode -eq 'begin') {
    $properties = $env:SONAR_PROPERTIES | ConvertFrom-Json -AsHashtable
    foreach ($key in $properties.Keys) {
        if ($key -eq 'sonar.projectKey') { $arguments += "/k:$($properties[$key])" }
        elseif ($key -eq 'sonar.organization') { $arguments += "/o:$($properties[$key])" }
        else { $arguments += "/d:${key}=$($properties[$key])" }
    }
}
$arguments += "/d:sonar.token=$env:SONAR_TOKEN"
Push-Location -LiteralPath $env:SONAR_SCANNER_SOURCE
try {
    $output = & $env:SONAR_SCANNER_COMMAND @arguments 2>&1
    $exitCode = $LASTEXITCODE
    foreach ($line in $output) {
        Write-Host ([string]$line).Replace($env:SONAR_TOKEN, '***')
    }
    if ($exitCode -ne 0) { throw "Pinned Sonar .NET $Mode failed (exit $exitCode)." }
}
finally { Pop-Location }

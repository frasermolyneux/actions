#requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$WorkingDirectory,
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$Configuration,
    [ValidateSet('true', 'false')][string]$NoBuild = 'true',
    [AllowEmptyString()][string]$Filter = '',
    [Parameter(Mandatory)][string]$ResultsDirectory,
    [string]$CoverageCommand,
    [string]$CoverageFile
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ResultsDirectory = [IO.Path]::GetFullPath($ResultsDirectory)
if (@(Get-ChildItem -LiteralPath $ResultsDirectory -Force).Count -ne 0) {
    throw 'Test results directory must be empty for this invocation.'
}
if ([bool]$CoverageCommand -ne [bool]$CoverageFile) {
    throw 'Coverage requires both its pinned executable and isolated report path.'
}
$arguments = @('test', $Project, '--configuration', $Configuration, '--verbosity', 'normal',
    '--logger', 'trx', '--results-directory', $ResultsDirectory)
if ($NoBuild -eq 'true') { $arguments += '--no-build' }
if ($Filter) { $arguments += @('--filter', $Filter) }

Push-Location -LiteralPath $WorkingDirectory
try {
    if ($CoverageCommand) {
        & $CoverageCommand collect --output-format cobertura --output $CoverageFile dotnet @arguments
    } else {
        & dotnet @arguments
    }
    if ($LASTEXITCODE -ne 0) { throw "dotnet test failed with exit code $LASTEXITCODE." }
}
finally { Pop-Location }

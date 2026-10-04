param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$ModuleRoot
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $ModuleRoot "PSScriptAnalyzer/$Version/PSScriptAnalyzer.psd1")
$files = @(Get-ChildItem -LiteralPath $Source -Recurse -File |
    Where-Object { $_.Extension -in '.ps1', '.psm1', '.psd1' })
$diagnostics = @()
$parseErrors = @()
foreach ($file in $files) {
    $tokens = $null
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    $parseErrors += @($errors | ForEach-Object { $_.ErrorId })
    $diagnostics += @(Invoke-ScriptAnalyzer -Path $file.FullName -Settings @{
        IncludeDefaultRules = $true
    } | Select-Object RuleName, Severity, Message, Line, Column, ScriptPath)
}
@{
    version = (Get-Module PSScriptAnalyzer).Version.ToString()
    scanned = @($files.FullName)
    errors = $parseErrors
    results = $diagnostics
} | ConvertTo-Json -Depth 8 -Compress

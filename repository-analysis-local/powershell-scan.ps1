param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$ModuleRoot
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $ModuleRoot "PSScriptAnalyzer/$Version/PSScriptAnalyzer.psd1")
$root = (Resolve-Path -LiteralPath $Source).Path
$files = @(Get-ChildItem -LiteralPath $root -Recurse -File)
$diagnostics = @()
$parseErrors = @()
foreach ($file in $files) {
    $tokens = $null
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    $parseErrors += @($errors | ForEach-Object { $_.ErrorId })
    $parameters = @{ Settings = @{ IncludeDefaultRules = $true } }
    if ($file.Extension) {
        $parameters.Path = $file.FullName
    } else {
        $parameters.ScriptDefinition = Get-Content -LiteralPath $file.FullName -Raw
    }
    $diagnostics += @(Invoke-ScriptAnalyzer @parameters |
        Select-Object RuleName, Severity, Message, Line, Column,
            @{ Name = 'ScriptPath'; Expression = { $file.FullName } })
}
@{
    version = (Get-Module PSScriptAnalyzer).Version.ToString()
    scanned = @($files | ForEach-Object {
        [System.IO.Path]::GetRelativePath($root, $_.FullName).Replace('\', '/')
    })
    errors = $parseErrors
    results = $diagnostics
} | ConvertTo-Json -Depth 8 -Compress

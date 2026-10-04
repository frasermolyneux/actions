#requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CoverageFile,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceSha,
    [Parameter(Mandatory)][ValidatePattern('^\d+(?:\.\d+){2,3}(?:[+-][A-Za-z0-9.-]+)?$')][string]$CoverageVersion
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$file = Get-Item -LiteralPath $CoverageFile
if ($file -isnot [IO.FileInfo] -or $file.Length -eq 0 -or $file.Length -gt 32MB) {
    throw 'Coverage must be a nonempty bounded regular file.'
}
$entry = $file
while ($entry) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Coverage file and its ancestors must not be symbolic links.'
    }
    $entry = if ($entry -is [IO.FileInfo]) { $entry.Directory } else { $entry.Parent }
}
$stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
$snapshot = [IO.MemoryStream]::new()
try {
    $buffer = [byte[]]::new(64KB)
    while (($length = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        if ($snapshot.Length + $length -gt 32MB) { throw 'Coverage grew beyond its bounded file contract.' }
        $snapshot.Write($buffer, 0, $length)
    }
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($snapshot.ToArray())).ToLowerInvariant()
    $snapshot.Position = 0
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $settings.MaxCharactersInDocument = 32MB
    $reader = [Xml.XmlReader]::Create($snapshot, $settings)
    try {
        $document = [Xml.XmlDocument]::new()
        $document.XmlResolver = $null
        $document.Load($reader)
    }
    finally { $reader.Dispose() }
}
finally {
    $stream.Dispose()
    $snapshot.Dispose()
}
if ($document.DocumentElement.LocalName -ne 'coverage') {
    throw 'Expected native Cobertura coverage.'
}
$lines = [Collections.Generic.Dictionary[string, bool]]::new([StringComparer]::Ordinal)
$classes = $document.SelectNodes("/*[local-name()='coverage']/*[local-name()='packages']/*[local-name()='package']/*[local-name()='classes']/*[local-name()='class']")
foreach ($class in $classes) {
    $filename = $class.GetAttribute('filename')
    if ([string]::IsNullOrWhiteSpace($filename)) { throw 'Coverage class lacks a source filename.' }
    foreach ($line in $class.SelectNodes("./*[local-name()='lines']/*[local-name()='line']")) {
        $number = 0
        $hits = [long]0
        if (-not [int]::TryParse($line.GetAttribute('number'), [ref]$number) -or $number -le 0 -or
            -not [long]::TryParse($line.GetAttribute('hits'), [ref]$hits) -or $hits -lt 0) {
            throw 'Invalid coverage source line or hit count.'
        }
        $key = "$($filename.Replace('\', '/'))`0$number"
        $lines[$key] = ($hits -gt 0) -or ($lines.ContainsKey($key) -and $lines[$key])
    }
}
if ($lines.Count -eq 0) { throw 'Coverage contains no instrumented source lines.' }
$report = [ordered]@{
    schema = 1
    status = 'collected'
    format = 'cobertura'
    sourceSha = $SourceSha
    toolVersion = $CoverageVersion
    sha256 = $hash
    lines = @{ total = $lines.Count; covered = @($lines.Values | Where-Object { $_ }).Count }
}
$json = $report | ConvertTo-Json -Depth 4 -Compress
"coverage-report=$json" >> $env:GITHUB_OUTPUT
[IO.File]::WriteAllText((Join-Path $file.DirectoryName 'coverage.json'), $json)

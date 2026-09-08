$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\install.ps1'))
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($function in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    Invoke-Expression $function.Extent.Text
}
function Assert-Runtime([bool] $Expected, [string] $Message) {
    if ((Test-CozyAgentsRuntime $fixture) -ne $Expected) { throw $Message }
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('cozy-existing-runtime-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    $metadata = Join-Path $fixture 'install.json'
    $runtimeNode = Join-Path $fixture 'node.exe'
    $bundle = Join-Path $fixture 'cozyagents.mjs'
    Assert-Runtime $false 'missing metadata must require setup'
    Set-Content -LiteralPath $metadata -Value '{broken'
    Assert-Runtime $false 'malformed metadata must require setup'
    Set-Content -LiteralPath $runtimeNode -Value 'fixture node'
    Set-Content -LiteralPath $bundle -Value 'fixture bundle'
    @{ node = $runtimeNode; bundle = @{ path = $bundle } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metadata
    Assert-Runtime $true 'legacy runtime metadata must support gateway updates'
    @{ schemaVersion = 1; node = $runtimeNode; assets = @(@{ name = 'cozyagents.mjs'; path = $bundle }) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metadata
    Assert-Runtime $true 'current runtime metadata must support gateway updates'
    $locked = [IO.File]::Open($bundle, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { Assert-Runtime $false 'unreadable runtime must not be silently reused' } finally { $locked.Dispose() }
    Remove-Item -LiteralPath $bundle
    Assert-Runtime $false 'missing bundle must require setup'
    [IO.File]::WriteAllText($bundle, '')
    Assert-Runtime $false 'empty bundle must require setup'
    Set-Content -LiteralPath $bundle -Value 'fixture bundle'
    Remove-Item -LiteralPath $runtimeNode
    Assert-Runtime $false 'missing Node must require setup'
    Set-Content -LiteralPath $runtimeNode -Value 'fixture node'
    @{ schemaVersion = 99; node = $runtimeNode; assets = @(@{ name = 'cozyagents.mjs'; path = $bundle }) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metadata
    Assert-Runtime $false 'unknown schema must not be silently reused'
    @{ node = 'node.exe'; bundle = @{ path = $bundle } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metadata
    Assert-Runtime $false 'relative executable paths must not depend on the current directory'
    Write-Output 'PASS existing Windows runtime validation'
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe fixture cleanup' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

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
    $failed = $false
    try { Install-CozyAgentsHarness $fixture 'unused' 'unused' $true } catch { $failed = $_.Exception.Message -like '*runtime changed*' }
    if (-not $failed) { throw 'runtime invalidated after preflight must abort instead of downloading an installer' }

    # Real current install records bind the owned bundle to its release size and hash.
    # Keep the same path and nonzero length when corrupting it: readability is insufficient.
    $realNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    $original = 'console.log("original");'
    [IO.File]::WriteAllText($bundle, $original)
    $asset = @{ name = 'cozyagents.mjs'; path = $bundle; url = 'https://example.invalid/cozyagents.mjs'; size = (Get-Item -LiteralPath $bundle).Length; sha256 = (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant() }
    $current = @{ schemaVersion = 1; home = $fixture; version = 'v0.2.15'; installedAt = 1; manifestUrl = 'https://example.invalid/agents-release.json'; node = $realNode; assets = @($asset) }
    $current | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metadata
    Assert-Runtime $true 'valid current recorded bundle integrity must permit reuse'
    [IO.File]::WriteAllText($bundle, ('x' * $original.Length))
    Assert-Runtime $false 'nonempty same-size corruption must fail recorded bundle hash validation'
    $failed = $false
    try { Install-CozyAgentsHarness $fixture 'unused' 'unused' $true } catch { $failed = $_.Exception.Message -like '*runtime changed*' }
    if (-not $failed) { throw 'corrupt reused runtime must abort before setup or download' }
    [IO.File]::WriteAllText($bundle, $original)
    $asset.size += 1
    $current | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metadata
    Assert-Runtime $false 'recorded bundle size mismatch must refuse reuse even when the hash matches'
    $asset.size -= 1
    $asset.sha256 = 'invalid'
    $current | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metadata
    Assert-Runtime $false 'malformed recorded integrity must not fall back to readability'
    $asset.sha256 = (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant()
    $asset.size = $null
    $current | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metadata
    Assert-Runtime $false 'null recorded size must not be treated as absent'
    @{ node = $realNode; bundle = @{ path = $bundle; sha256 = $asset.sha256 } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metadata
    Assert-Runtime $true 'legacy recorded hash without a size must permit the matching bundle'
    [IO.File]::WriteAllText($bundle, ('x' * $original.Length))
    Assert-Runtime $false 'legacy recorded hash must also reject nonempty corruption'
    @{ node = $realNode; bundle = @{ path = $bundle } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metadata
    Assert-Runtime $true 'legacy metadata without integrity fields must retain readability compatibility'
    Write-Output 'PASS existing Windows runtime validation'
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    $separator = [IO.Path]::DirectorySeparatorChar
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd($separator) + $separator
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe fixture cleanup' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

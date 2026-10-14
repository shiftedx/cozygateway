$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
foreach ($name in @('Update-HermesHarness')) {
    $definition = $null
    foreach ($source in @('scripts/install.ps1')) {
        $tokens = $null; $errors = $null
        $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $repo $source), [ref]$tokens, [ref]$errors)
        $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
        if ($definition) { break }
    }
    if (-not $definition) { throw "Missing function $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}
function Write-Info { param($Message) }
function Write-Ok { param($Message) }
function Fail { param($Message) throw $Message }
function Assert { param($Condition, $Message) if (-not $Condition) { throw $Message } }
$temp = Join-Path ([IO.Path]::GetTempPath()) ('cozy-harness-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $hermes = Join-Path $temp 'hermes.cmd'
    $script:launcherChecks = 0
    $script:compatible = $true
    function Get-HermesVersion { param($HermesPath) return [pscustomobject]@{ Text = '0.21.0' } }
    function Ensure-HermesLauncherInterpreter { param($HermesPath) $script:launcherChecks++ }
    function Test-CompatibleHermesVersion { param($Version) return $script:compatible }
    [IO.File]::WriteAllText($hermes, "@echo off`r`nif not `%1==update exit /b 9`r`nif not `%2==--yes exit /b 9`r`nexit /b 0`r`n")
    $result = Update-HermesHarness $hermes
    Assert ($result.Status -eq 'succeeded' -and $script:launcherChecks -eq 1) 'Hermes update must verify launcher'
    [IO.File]::WriteAllText($hermes, "@echo useful Hermes progress`r`n@echo nonfatal warning 1>&2`r`n@exit /b 0`r`n")
    $emitted = @(Update-HermesHarness $hermes 6>&1)
    $result = $emitted | Where-Object { $_ -isnot [Management.Automation.InformationRecord] }
    Assert ($result.Status -eq 'succeeded') 'Hermes nonfatal stderr must allow success'
    Assert (($emitted | Out-String).Contains('useful Hermes progress')) 'Hermes progress must be visible'
    $script:compatible = $false
    $failure = $null
    try { Update-HermesHarness $hermes | Out-Null } catch { $failure = $_.Exception.Message }
    Assert ([bool]$failure) 'Hermes incompatible updated version must fail'
    [IO.File]::WriteAllText($hermes, "@echo secret-sentinel`r`n@exit /b 2`r`n")
    $failure = $null
    try { Update-HermesHarness $hermes | Out-Null } catch { $failure = $_.Exception.Message }
    Assert ([bool]$failure -and -not $failure.Contains('secret-sentinel')) 'Hermes refusal must fail without raw output'
    Update-HermesHarness (Join-Path $temp 'missing.exe') -DryRun $true
    Write-Host 'PASS Windows harness updater contract and error redaction'
} finally {
    $resolved = [IO.Path]::GetFullPath($temp)
    $root = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\install.ps1'))
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($function in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) { Invoke-Expression $function.Extent.Text }
function Assert-Equal($Actual, $Expected, [string]$Message) { if ($Actual -ne $Expected) { throw "${Message}: got $Actual" } }
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('cozy-windows-flow-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    Complete-Pairing 'must-not-run.cmd' $true $false
    Set-WindowsSetupStage $fixture 'gateway' 'started' 'hermes' $true
    $plan = Get-WindowsSetupPlan $fixture
    Assert-Equal $plan.Harness 'hermes' 'interrupted setup must retain the Hermes plan'
    Assert-Equal $plan.PairingPending $true 'interrupted setup must retain pending pairing'
    Invoke-WindowsSetupStage $fixture 'gateway' { }
    $failed = $false
    try { Invoke-WindowsSetupStage $fixture 'hermes' { throw 'fixture failure' } } catch { $failed = $true }
    Assert-Equal $failed $true 'component failure must propagate'
    $receipt = Get-Content -LiteralPath (Join-Path $fixture 'local\windows-setup.json') -Raw | ConvertFrom-Json
    Assert-Equal $receipt.components.gateway 'succeeded' 'later failure must keep gateway success'
    Assert-Equal $receipt.components.hermes 'failed' 'receipt must record incomplete component'
    Invoke-WindowsSetupStage $fixture 'hermes' { }
    $receipt = Get-Content -LiteralPath (Join-Path $fixture 'local\windows-setup.json') -Raw | ConvertFrom-Json
    Assert-Equal $receipt.components.hermes 'succeeded' 'rerun must reconcile failed component'
    Assert-Equal (Get-WindowsSetupPlan $fixture).PairingPending $true 'successful components must retain pending pairing'
    Set-WindowsSetupStage $fixture 'gateway' 'succeeded' '' $false
    Assert-Equal (Get-WindowsSetupPlan $fixture) $null 'completed setup must not override later selections'
    Write-Output 'PASS Windows Hermes setup, pairing and component outcomes'
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe fixture cleanup' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

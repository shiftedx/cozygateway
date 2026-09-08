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
    $state = Join-Path $fixture 'install-state'
    $config = Join-Path $fixture 'config.json'
    Set-Content -LiteralPath $state -Value 'harness=both'
    Set-Content -LiteralPath $config -Value '{"hermesEndpoints":[]}'
    $script:questions = 0
    function Test-PromptAvailable { return $true }
    function Get-PromptAnswer { $script:questions++; return '1' }
    function Find-Hermes { return 'fixture-hermes.exe' }
    Assert-Equal (Select-Harness '' $state $config) 'both' 'rerun must retain installed harnesses'
    Assert-Equal $script:questions 0 'routine updates must not ask a harness question'
    Assert-Equal (Select-Harness 'hermes' $state $config) 'both' 'explicit choice must preserve the other harness'
    Complete-Pairing 'must-not-run.cmd' $true $false
    Assert-Equal $script:questions 0 'routine updates must not ask for optional pairing'
    Invoke-WindowsSetupStage $fixture 'gateway' { }
    $failed = $false
    try { Invoke-WindowsSetupStage $fixture 'cozyagents' { throw 'fixture failure' } } catch { $failed = $true }
    Assert-Equal $failed $true 'component failure must propagate'
    $receipt = Get-Content -LiteralPath (Join-Path $fixture 'local\windows-setup.json') -Raw | ConvertFrom-Json
    Assert-Equal $receipt.components.gateway 'succeeded' 'later failure must keep gateway success'
    Assert-Equal $receipt.components.cozyagents 'failed' 'receipt must record incomplete component'
    Invoke-WindowsSetupStage $fixture 'cozyagents' { }
    $receipt = Get-Content -LiteralPath (Join-Path $fixture 'local\windows-setup.json') -Raw | ConvertFrom-Json
    Assert-Equal $receipt.components.cozyagents 'succeeded' 'rerun must reconcile failed component'
    $customHome = Join-Path $fixture 'custom-agents'
    Set-WindowsSetupStage $fixture 'gateway' 'started' 'both' $customHome
    $script:PendingSetupPlan = Get-WindowsSetupPlan $fixture
    Assert-Equal $script:PendingSetupPlan.Harness 'both' 'interrupted setup must retain requested harnesses'
    Assert-Equal $script:PendingSetupPlan.AgentsHome $customHome 'interrupted setup must retain the custom home'
    $previousHome = $env:COZYAGENTS_HOME
    try {
        $env:COZYAGENTS_HOME = ''
        Assert-Equal (Resolve-CozyAgentsHome) $customHome 'retry must reuse the saved home'
        $env:COZYAGENTS_HOME = Join-Path $fixture 'explicit-agents'
        Assert-Equal (Resolve-CozyAgentsHome) $env:COZYAGENTS_HOME 'explicit home must take precedence'
    } finally { $env:COZYAGENTS_HOME = $previousHome }
    Invoke-WindowsSetupStage $fixture 'gateway' { }
    Assert-Equal (Get-WindowsSetupPlan $fixture) $null 'completed setup must not override later selections'
    Write-Output 'PASS Windows setup selection, pairing and component outcomes'
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe fixture cleanup' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

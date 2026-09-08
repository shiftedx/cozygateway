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
    $savedModelEnvironment = @{}
    foreach ($name in @('COZYGATEWAY_RUNNER_MODEL_PROVIDER', 'COZYGATEWAY_RUNNER_MODEL_ENDPOINT', 'COZYGATEWAY_RUNNER_MODEL_ID')) {
        $savedModelEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    try {
        function Find-CodexLogin { return '' }
        # Local discovery has its own fixture suite; never query the user's servers.
        function Find-CozyLocalModels { return @() }
        function Get-WindowsSavedProviderCatalog { return [pscustomobject]@{Provider='';DefaultModel='';Models=@();AuthConfigured=$false;RequiresSharedConfig=$false} }
        function Get-WindowsSavedProviderChoices { return @() }
        function Get-PromptAnswer {
            param($Prompt, $InputVariable, $Fallback)
            if ($script:modelInputs.Count -eq 0) { throw "Unexpected prompt: $Prompt" }
            $value = [string]$script:modelInputs.Dequeue()
            if ([string]::IsNullOrWhiteSpace($value)) { return $Fallback }
            return $value
        }
        foreach ($case in @(
            @{ Inputs = @('1', 'test-model'); Provider = 'openai-codex'; Endpoint = '' },
            @{ Inputs = @('', 'test-model'); Provider = 'openai-codex'; Endpoint = '' },
            @{ Inputs = @('2', '', 'test-model'); Provider = ''; Endpoint = 'http://127.0.0.1:1234/v1' },
            @{ Inputs = @('2', 'https://localhost:9000/v1', 'test-model'); Provider = ''; Endpoint = 'https://localhost:9000/v1' },
            @{ Inputs = @('3', 'anthropic', 'test-model'); Provider = 'anthropic'; Endpoint = '' },
            @{ Inputs = @('99', '1', 'test-model'); Provider = 'openai-codex'; Endpoint = '' },
            @{ Inputs = @('2', 'not-a-url', '1', 'test-model'); Provider = 'openai-codex'; Endpoint = '' },
            @{ Inputs = @('3', 'not a provider', '1', 'test-model'); Provider = 'openai-codex'; Endpoint = '' },
            @{ Inputs = @('openai-codex', 'test-model'); Provider = 'openai-codex'; Endpoint = '' },
            @{ Inputs = @('http://localhost:8000/v1', 'test-model'); Provider = ''; Endpoint = 'http://localhost:8000/v1' }
        )) {
            $script:modelInputs = New-Object Collections.Queue
            foreach ($value in $case.Inputs) { $script:modelInputs.Enqueue($value) }
            $model = Confirm-CozyAgentsModel (Join-Path $fixture 'missing-runner.env')
            Assert-Equal $model.Provider $case.Provider 'numbered provider selection'
            Assert-Equal $model.Endpoint $case.Endpoint 'numbered endpoint selection'
            Assert-Equal $model.Id 'test-model' 'model answer must remain separate from the menu'
            Assert-Equal $script:modelInputs.Count 0 'all expected answers must be consumed'
        }
    } finally {
        foreach ($name in $savedModelEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedModelEnvironment[$name], 'Process') }
    }
    Write-Output 'PASS Windows setup selection, pairing and component outcomes'
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe fixture cleanup' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
& (Join-Path $PSScriptRoot 'windows-local-model-discovery.test.ps1')
& (Join-Path $PSScriptRoot 'windows-saved-provider.test.ps1')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\install.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($function in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]}, $false)) { Invoke-Expression $function.Extent.Text }
foreach ($name in @('Get-CozyLocalModelIds','Find-CozyLocalModels','Select-CozyLocalModel')) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "Missing local discovery helper: $name" }
}
function Assert-Equal($Actual, $Expected, [string] $Message) { if ($Actual -ne $Expected) { throw "ASSERT: $Message (got $Actual)" } }
function Test-PromptAvailable { return $true }
function Find-CodexLogin { return '' }
function Get-WindowsSavedProviderCatalog { return [pscustomobject]@{Provider='';DefaultModel='';Models=@();AuthConfigured=$false;RequiresSharedConfig=$false} }
function Get-WindowsSavedProviderChoices { return @() }
function Get-WindowsPiAgentHome { return $script:piDirectory }
function Get-PromptAnswer {
    param($Prompt, $InputVariable, $Fallback)
    $script:promptCount++
    if ($script:inputs.Count -eq 0) { throw "Unexpected prompt: $Prompt" }
    $answer = [string]$script:inputs.Dequeue()
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Fallback }
    return $answer
}
function Set-Answers([string[]] $Answers) {
    $script:inputs = New-Object Collections.Queue
    foreach ($answer in $Answers) { $script:inputs.Enqueue($answer) }
    $script:promptCount = 0
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('cozy-local-discovery-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$script:piDirectory = Join-Path $root 'fixture-pi'
New-Item -ItemType Directory -Path $script:piDirectory | Out-Null
$savedEnvironment = @{}
foreach ($name in @('COZYGATEWAY_RUNNER_MODEL_PROVIDER','COZYGATEWAY_RUNNER_MODEL_ENDPOINT','COZYGATEWAY_RUNNER_MODEL_ID')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
try {
    $script:requests = New-Object Collections.Generic.List[string]
    $script:response = ''
    $script:requestError = $false
    $script:requestFailureKind = 'timeout'
    $script:endpointResponses = @{}
    function Invoke-CozyLocalModelsRequest {
        param([string] $Endpoint)
        $script:requests.Add($Endpoint)
        if ($script:endpointResponses.ContainsKey($Endpoint)) {
            $response = $script:endpointResponses[$Endpoint]
            if ($response -is [Exception]) { throw $response }
            return $response
        }
        if ($script:requestError) {
            if ($script:requestFailureKind -eq 'other') { throw [InvalidOperationException]::new('fixture network failure') }
            throw [Net.WebException]::new('fixture timeout', [Net.WebExceptionStatus]::Timeout)
        }
        return $script:response
    }
    foreach ($case in @(
        @{Body='{"data":[{"id":"local/model"}]}';Expected='local/model'},
        @{Body='{"data":[{"id":"a"},{"id":"b:latest"},{"id":"a"},{"id":"A"}]}';Expected='a,b:latest,A'},
        @{Body='{"data":[]}';Expected=''},
        @{Body='not json';Expected=''},
        @{Body='{}';Expected=''},
        @{Body='{"data":[null,{}, {"id":42},{"id":"unsafe model"},{"id":"good"}]}';Expected='good'}
    )) {
        $script:response = $case.Body
        Assert-Equal (@(Get-CozyLocalModelIds 'http://127.0.0.1:1234/v1') -join ',') $case.Expected 'model response parsing must filter malformed entries and deduplicate valid ids'
    }
    $script:response = (@{data=@(1..100|ForEach-Object{@{id="model-$_"}})}|ConvertTo-Json -Depth 3 -Compress)
    Assert-Equal @(Get-CozyLocalModelIds 'http://127.0.0.1:11434/v1').Count 64 'discovery must cap model entries'
    $script:requests.Clear()
    foreach ($endpoint in @('http://example.invalid/v1','http://127.0.0.1:9000/v1','https://127.0.0.1:1234/v1','http://user:pass@127.0.0.1:1234/v1')) {
        Assert-Equal @(Get-CozyLocalModelIds $endpoint).Count 0 'automatic discovery must refuse unapproved endpoints'
    }
    Assert-Equal $script:requests.Count 0 'refused endpoints must not issue requests'
    $script:requestError = $true
    Assert-Equal @(Get-CozyLocalModelIds 'http://127.0.0.1:1234/v1').Count 0 'timeout must fall back to manual setup'
    $script:requestFailureKind = 'other'
    Assert-Equal @(Get-CozyLocalModelIds 'http://127.0.0.1:1234/v1').Count 0 'request errors must fall back to manual setup'
    $script:requestError = $false
    $script:response = '{"data":[{"id":"detected"}]}'
    $script:requests.Clear()
    $found = @(Find-CozyLocalModels)
    Assert-Equal $found.Count 2 'both known servers must be discoverable'
    Assert-Equal ($script:requests -join ',') 'http://127.0.0.1:1234/v1,http://127.0.0.1:11434/v1' 'discovery must probe only the two approved loopback endpoints'
    $script:endpointResponses = @{
        'http://127.0.0.1:1234/v1' = [Net.WebException]::new('fixture timeout', [Net.WebExceptionStatus]::Timeout)
        'http://127.0.0.1:11434/v1' = '{"data":[{"id":"ollama-only"}]}'
    }
    $found = @(Find-CozyLocalModels)
    Assert-Equal $found.Count 1 'one failed local server must not hide the other server'
    Assert-Equal $found[0].Id 'ollama-only' 'working local server must remain selectable'
    $first = [pscustomobject]@{Server='LM Studio';Endpoint='http://127.0.0.1:1234/v1';Id='local/one'}
    $second = [pscustomobject]@{Server='Ollama';Endpoint='http://127.0.0.1:11434/v1';Id='local:two'}
    Set-Answers @()
    Assert-Equal (Select-CozyLocalModel @($first)).Id $first.Id 'one discovered model must be selected automatically'
    Assert-Equal $script:promptCount 0 'single model must need no model prompt'
    Set-Answers @('99','2')
    Assert-Equal (Select-CozyLocalModel @($first,$second)).Id $second.Id 'multiple models must reprompt invalid selection and accept numbered model'
    Assert-Equal $script:inputs.Count 0 'numbered model answers must be consumed'
    Set-Answers @('0')
    Assert-Equal (Select-CozyLocalModel @($first,$second)) $null 'manual model choice must return to endpoint entry'
    Set-Answers @()
    Assert-Equal (Select-CozyLocalModel @()) $null 'empty discovery must use manual setup'

    # Only the discovery result boundary is replaced for onboarding integration.
    # No request is allowed to reach a real local service or account.
    function Find-CozyLocalModels { $script:discoveries++; return $script:models }
    $script:models = @($first); $script:discoveries = 0
    Set-Answers @('2')
    $model = Confirm-CozyAgentsModel (Join-Path $root 'missing.env')
    Assert-Equal $model.Endpoint $first.Endpoint 'local selection must retain discovered endpoint'
    Assert-Equal $model.Id $first.Id 'local selection must retain discovered model'
    Assert-Equal $script:inputs.Count 0 'discovered model must not request a duplicate manual model id'
    Assert-Equal $script:discoveries 1 'fresh onboarding must discover local servers only once'
    Set-Answers @('')
    $model = Confirm-CozyAgentsModel (Join-Path $root 'missing.env')
    Assert-Equal $model.Id $first.Id 'Enter must choose the sole local model when no saved cloud default exists'
    $script:models = @($first,$second)
    Set-Answers @('','2')
    $model = Confirm-CozyAgentsModel (Join-Path $root 'missing.env')
    Assert-Equal $model.Id $second.Id 'Enter must choose local discovery and accept a numbered model when several are available'
    $script:models = @()
    Set-Answers @('2','','manual-model')
    $model = Confirm-CozyAgentsModel (Join-Path $root 'missing.env')
    Assert-Equal $model.Id 'manual-model' 'empty discovery must permit manual fallback'
    Assert-Equal $model.Endpoint 'http://127.0.0.1:1234/v1' 'manual fallback must retain default endpoint'

    $script:catalog = [pscustomobject]@{Provider='anthropic';DefaultModel='saved-default';Models=@([pscustomobject]@{Id='saved-default';Name='Default';Source='saved'});AuthConfigured=$true;RequiresSharedConfig=$false}
    function Get-WindowsSavedProviderChoices { return @($script:catalog) }
    function Get-WindowsSavedProviderCatalog { param($Provider) return $script:catalog }
    $script:models = @($first)
    Set-Answers @('','n')
    $model = Confirm-CozyAgentsModel (Join-Path $root 'missing.env')
    Assert-Equal $model.Provider 'anthropic' 'saved cloud provider must take precedence over sole local default'
    Assert-Equal $model.Id 'saved-default' 'saved cloud default must not require manual model input'
    Assert-Equal $model.ShareHostAuth $false 'declining saved provider consent must not share credentials'
    Assert-Equal $model.NeedsAccount $true 'declining credentials must leave account setup explicitly required'
    $script:catalog = [pscustomobject]@{Provider='anthropic';DefaultModel='';Models=@([pscustomobject]@{Id='cloud-a';Name='A';Source='saved'},[pscustomobject]@{Id='cloud-b';Name='B';Source='saved'});AuthConfigured=$true;RequiresSharedConfig=$false}
    Set-Answers @('4','2','y')
    $model = Confirm-CozyAgentsModel (Join-Path $root 'missing.env')
    Assert-Equal $model.Id 'cloud-b' 'saved provider menu must accept a numbered model'
    Assert-Equal $script:inputs.Count 0 'saved-model menu must consume only the expected answers'
    Assert-Equal $model.ShareHostAuth $true 'saved provider credentials must be shared only after explicit consent'
    Assert-Equal $model.SharedPiAgentDir $script:piDirectory 'sharing must record the fixture Pi directory that was offered'
    Set-Answers @('4','0','manual-cloud','n')
    $model = Confirm-CozyAgentsModel (Join-Path $root 'missing.env')
    Assert-Equal $model.Id 'manual-cloud' 'saved provider menu must allow manual model fallback'
    Assert-Equal $model.NeedsAccount $true 'manual cloud selection without credential consent must require account setup'
    $script:catalog = [pscustomobject]@{Provider='anthropic';DefaultModel='';Models=@([pscustomobject]@{Id='cached-cloud';Name='Cached';Source='saved'});AuthConfigured=$false;RequiresSharedConfig=$false}
    Set-Answers @('')
    $model = Confirm-CozyAgentsModel (Join-Path $root 'missing.env')
    Assert-Equal $model.Id $first.Id 'unauthenticated cloud cache must not outrank detected local models'
    Assert-Equal $model.Endpoint $first.Endpoint 'default must stay on the available local endpoint'
    Set-Answers @('4')
    $model = Confirm-CozyAgentsModel (Join-Path $root 'missing.env')
    Assert-Equal $model.Id 'cached-cloud' 'explicit unauthenticated cached model must remain selectable'
    Assert-Equal $model.NeedsAccount $true 'cached cloud model without credentials must require account setup'
    Assert-Equal $model.ShareHostAuth $false 'unavailable cloud credentials must not be marked shared'

    $script:discoveries = 0
    Set-Answers @()
    $saved = Join-Path $root 'runner.env'
    [IO.File]::WriteAllText($saved,"COZYRUNNER_MODEL_ENDPOINT=http://127.0.0.1:1234/v1`nCOZYRUNNER_MODEL_ID=saved-model`nCOZYRUNNER_TOKEN=fixture-secret`n")
    $before = [IO.File]::ReadAllText($saved)
    $model = Confirm-CozyAgentsModel $saved
    Assert-Equal $model.Id 'saved-model' 'valid saved model must be preserved'
    Assert-Equal $script:discoveries 0 'saved model must bypass local discovery'
    Assert-Equal ([IO.File]::ReadAllText($saved)) $before 'saved configuration must not be rewritten during selection'
    [IO.File]::WriteAllText($saved,"COZYRUNNER_MODEL_PROVIDER=anthropic`nCOZYRUNNER_MODEL_ID=saved-cloud`n")
    $model = Confirm-CozyAgentsModel $saved
    Assert-Equal $model.Id 'saved-cloud' 'valid saved cloud model must be preserved'
    Assert-Equal $script:discoveries 0 'saved cloud model must bypass local discovery'
    $env:COZYGATEWAY_RUNNER_MODEL_ENDPOINT='http://127.0.0.1:11434/v1'
    $env:COZYGATEWAY_RUNNER_MODEL_ID='explicit-model'
    $model = Confirm-CozyAgentsModel $saved
    Assert-Equal $model.Id 'explicit-model' 'explicit model must override saved settings'
    Assert-Equal $script:discoveries 0 'explicit model must bypass local discovery'
    Assert-Equal $script:promptCount 0 'saved and explicit settings must not prompt'
    Write-Host 'PASS Windows local model discovery and onboarding'
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    $resolved=[IO.Path]::GetFullPath($root)
    $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if (-not $resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

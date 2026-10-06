$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\install.ps1'),[ref]$tokens,[ref]$errors)
foreach($fn in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) { Invoke-Expression $fn.Extent.Text }
function Assert-Saved($Condition,$Message) { if(-not $Condition){throw $Message} }
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('cozy-saved-models-'+[guid]::NewGuid().ToString('N'))
$priorPi=$env:PI_CODING_AGENT_DIR; $priorAuth=$env:COZYGATEWAY_CODEX_AUTH_PATH
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    $env:PI_CODING_AGENT_DIR=$fixture; $env:COZYGATEWAY_CODEX_AUTH_PATH=''
    $empty=Get-WindowsSavedProviderCatalog
    Assert-Saved ($empty.Provider -eq '' -and $empty.Models.Count -eq 0 -and -not $empty.AuthConfigured) 'Missing files must return empty discovery'
    [IO.File]::WriteAllText((Join-Path $fixture 'settings.json'),'{"defaultProvider":"openai-codex","defaultModel":"saved-model"}')
    [IO.File]::WriteAllText((Join-Path $fixture 'models.json'),'{"providers":{"openai-codex":{"apiKey":"secret-sentinel","models":[{"id":"saved-model"},{"id":"custom-model","name":"Custom model"},{"id":"bad model"}]}}}')
    [IO.File]::WriteAllText((Join-Path $fixture 'models-store.json'),'{"openai-codex":{"checkedAt":1,"models":[{"id":"custom-model"},{"id":"cached-model","name":"bad\nname"}]}}')
    $auth=Join-Path $fixture 'auth.json'
    [IO.File]::WriteAllText($auth,'{"openai-codex":{"type":"oauth","access":"secret-sentinel","refresh":"secret-refresh","expires":1}}')
    $before=(Get-FileHash $auth).Hash
    $result=Get-WindowsSavedProviderCatalog
    Assert-Saved ($result.Provider -eq 'openai-codex' -and $result.DefaultModel -eq 'saved-model' -and $result.AuthConfigured) 'Saved provider/default/auth must be detected'
    Assert-Saved ($result.Models.Count -eq 3 -and $result.Models[2].Name -eq 'cached-model') 'Models deduplicate and sanitize display names'
    Assert-Saved $result.RequiresSharedConfig 'Custom provider settings require sharing the Pi config before runtime use'
    Assert-Saved (-not (($result | ConvertTo-Json -Depth 5).Contains('secret-'))) 'Discovery must not return credential fields'
    Assert-Saved ((Find-CodexLogin) -eq $auth -and (Get-FileHash $auth).Hash -eq $before) 'Expired refreshable account detection must not change credentials'
    $other=Get-WindowsSavedProviderCatalog 'anthropic'
    Assert-Saved ($other.DefaultModel -eq '' -and $other.Models.Count -eq 0) 'Saved default must never cross provider scope'
    foreach($invalid in @('{}','{"other":{"type":"oauth","access":"x","refresh":"y","expires":1}}','{"openai-codex":{"type":"oauth","access":"x"}}','invalid')) {
        [IO.File]::WriteAllText($auth,$invalid)
        Assert-Saved (-not (Find-CodexLogin)) 'Unrelated or malformed credential is not a Codex account'
    }
    [IO.File]::WriteAllText($auth,(' ' * 1048577))
    Assert-Saved (-not (Find-CodexLogin)) 'Oversized account file must be ignored'
    [IO.File]::WriteAllText((Join-Path $fixture 'settings.json'),'[]')
    Assert-Saved ((Get-WindowsSavedProviderCatalog).Provider -eq '') 'Malformed settings shape must be ignored'
    $choices=@(Get-WindowsSavedProviderChoices)
    Assert-Saved ($choices.Count -eq 1 -and $choices[0].Provider -eq 'openai-codex') 'Saved catalog providers must be enumerated without a default setting'
    $env:COZYGATEWAY_CODEX_AUTH_PATH=Join-Path $fixture 'explicit-auth.json'
    [IO.File]::WriteAllText($env:COZYGATEWAY_CODEX_AUTH_PATH,'{"openai-codex":{"type":"oauth","access":"a","refresh":"r","expires":2}}')
    Assert-Saved ((Find-CodexLogin) -eq $env:COZYGATEWAY_CODEX_AUTH_PATH) 'Explicit auth fixture override must remain supported'
    $shared=Join-Path $fixture 'Pi directory #1'
    New-Item -ItemType Directory -Path $shared | Out-Null
    $runner=Join-Path $fixture 'runner.env'
    [IO.File]::WriteAllText($runner,"COZYRUNNER_TOKEN=keep-token`n")
    $answers=@{Provider='openai-codex';Endpoint='';Id='model';ShareHostAuth=$true;SharedPiAgentDir=$shared}
    Write-RunnerModelEnv $runner $answers
    $parseFixture=Join-Path $fixture 'parse.cjs'
    [IO.File]::WriteAllText($parseFixture,'const fs=require("node:fs");console.log(require("node:util").parseEnv(fs.readFileSync(process.argv[2],"utf8")).PI_CODING_AGENT_DIR)')
    $parsed=& node.exe $parseFixture $runner
    Assert-Saved ($LASTEXITCODE -eq 0 -and $parsed -ceq $shared) 'Shared directory must survive actual Node dotenv parsing including spaces and #'
    $before=(Get-FileHash $runner).Hash
    $answers.SharedPiAgentDir="bad`npath"
    $failed=$false;try {Write-RunnerModelEnv $runner $answers} catch {$failed=$true}
    Assert-Saved ($failed -and (Get-FileHash $runner).Hash -eq $before) 'Invalid sharing directory must fail before changing model files'
    $answers.PreserveExisting=$true
    Write-RunnerModelEnv $runner $answers
    Assert-Saved ((Get-FileHash $runner).Hash -eq $before) 'PreserveExisting must keep directory and consent byte-identical'
    $answers.Remove('PreserveExisting');$answers.ShareHostAuth=$false
    Write-RunnerModelEnv $runner $answers
    $text=[IO.File]::ReadAllText($runner)
    Assert-Saved ($text.Contains('COZYRUNNER_TOKEN=keep-token') -and -not $text.Contains('COZYRUNNER_SHARE_HOST_MODEL_AUTH') -and -not $text.Contains('PI_CODING_AGENT_DIR')) 'Declining consent on changed settings must clear old sharing but retain pairing'
    Write-Host 'PASS Windows saved provider discovery'
} finally {
    $env:PI_CODING_AGENT_DIR=$priorPi; $env:COZYGATEWAY_CODEX_AUTH_PATH=$priorAuth
    $resolved=[IO.Path]::GetFullPath($fixture)
    if(-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe fixture cleanup'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

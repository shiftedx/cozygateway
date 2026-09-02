# The Windows harness choice: the CozyAgents branch of the all-in-one bootstrap, the model and
# provider questions it asks, the network question, the QR rule, the frozen Hermes bridge, and the
# uninstall that gives the harness back to its own uninstaller.
#
# Everything the CozyAgents branch reaches out to is stubbed here: the CozyAgents installer is a
# local script behind -CozyAgentsInstaller, the shared installer is a fake bash that materializes
# the gateway files a real run would leave, and the gateway CLI answers `pair` without a gateway.
# Nothing in this file touches the network.
$ErrorActionPreference = 'Stop'

function Assert-True {
    param([bool] $Condition, [string] $Message)
    if (-not $Condition) { throw "ASSERT: $Message" }
}

function Assert-Contains {
    param([string] $Haystack, [string] $Needle, [string] $Message)
    if (-not $Haystack.Contains($Needle)) {
        throw "ASSERT: $Message`n--- expected to contain ---`n$Needle`n--- actual ---`n$Haystack`n--- end ---"
    }
}

function Assert-Missing {
    param([string] $Haystack, [string] $Needle, [string] $Message)
    if ($Haystack.Contains($Needle)) {
        throw "ASSERT: $Message`n--- expected NOT to contain ---`n$Needle`n--- actual ---`n$Haystack`n--- end ---"
    }
}

function Write-Utf8NoBom {
    param([string] $Path, [string] $Content)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Assert-NoBroadReadAcl {
    param([string] $Path)
    $users = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::BuiltinUsersSid, $null)
    $acl = Get-Acl -LiteralPath $Path
    $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    Assert-True (-not ($rules | Where-Object { $_.IdentityReference -eq $users -and $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow })) "$Path must not grant the built-in Users group access"
}

function Invoke-Bootstrap {
    param([string] $Installer, [hashtable] $Environment, [string[]] $Arguments = @())
    $old = @{}
    foreach ($key in $Environment.Keys) {
        $old[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], 'Process')
    }
    try {
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Installer @Arguments 2>&1
        return @{ ExitCode = $LASTEXITCODE; Output = (($output | ForEach-Object { [string]$_ }) -join "`n") }
    } finally {
        $ErrorActionPreference = $previousPreference
        foreach ($key in $Environment.Keys) {
            [Environment]::SetEnvironmentVariable($key, $old[$key], 'Process')
        }
    }
}

function Read-LogText {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    return (Get-Content -LiteralPath $Path -Raw)
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$installer = if ($env:COZYGATEWAY_TEST_INSTALLER_UNDER_TEST) { $env:COZYGATEWAY_TEST_INSTALLER_UNDER_TEST } else { Join-Path $repoRoot 'scripts\install.ps1' }
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCommand) { throw 'ASSERT: these tests need node.exe on PATH' }
$node = $nodeCommand.Source
$temp = Join-Path ([IO.Path]::GetTempPath()) ("cozygateway-windows-agents-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

try {
    Assert-True (Test-Path -LiteralPath $installer) 'scripts/install.ps1 must exist'

    # ---------------------------------------------------------------------------
    # Fixtures
    # ---------------------------------------------------------------------------
    $fixtures = Join-Path $temp 'release assets'
    $assets = @{
        'cozygateway.mjs' = "console.log('fixture');`n"
        'cozygateway-hermes-attach-plugin.tar.gz' = 'plugin-fixture'
        'cozygateway-installer.sh' = "#!/usr/bin/env bash`nexit 0`n"
        'install.ps1' = "param([switch]`$Repair)`nexit 0`n"
    }
    foreach ($entry in $assets.GetEnumerator()) {
        $path = Join-Path $fixtures $entry.Key
        Write-Utf8NoBom $path $entry.Value
        $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-Utf8NoBom "$path.sha256" "$hash  $($entry.Key)`n"
    }

    $eventLog = Join-Path $temp 'events.log'
    $agentsLog = Join-Path $temp 'agents.log'
    $cliLog = Join-Path $temp 'cli.log'

    # The gateway CLI a real install leaves behind: `pair` is the only command this bootstrap runs
    # through it. It reads the config the way the real bundle does, from the local directory.
    $gatewayFixture = Join-Path $temp 'stage-common\bin\gateway-fixture.js'
    Write-Utf8NoBom $gatewayFixture @'
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.COZYGATEWAY_TEST_CLI_LOG) {
  fs.appendFileSync(process.env.COZYGATEWAY_TEST_CLI_LOG, 'cli ' + args.join(' ') + '\n');
}
if (args[0] === 'pair') {
  const configAt = args.indexOf('--config');
  const config = configAt === -1 ? 'cozygateway.config.json' : args[configAt + 1];
  const configured = JSON.parse(fs.readFileSync(config, 'utf8'));
  const kindAt = args.indexOf('--kind');
  const kind = kindAt === -1 ? 'device' : args[kindAt + 1];
  const wildcard = configured.host === '0.0.0.0' || configured.host === '::';
  const host = wildcard ? (process.env.COZYGATEWAY_TEST_PAIRING_LAN_ADDRESS || '127.0.0.1') : configured.host;
  const gatewayUrl = configured.publicUrl || ('http://' + host + ':' + configured.port);
  const code = kind === 'runner' ? 'RUNNER-TEST-CODE' : 'TEST-CODE';
  process.stdout.write('QRQRQR fake-qr QRQRQR\n');
  process.stdout.write(JSON.stringify(kind === 'runner' ? { gatewayUrl, setupCode: code, kind } : { gatewayUrl, setupCode: code }) + '\n');
  process.stdout.write('Gateway URL: ' + gatewayUrl + '\n');
  process.stdout.write('Setup code:  ' + code + '\n');
}
'@

    # Two staged gateway trees, one per listener answer. The fake bash copies the one it is told
    # to, which is what a real shared-installer run would have written by the time it returns.
    function New-GatewayStage {
        param([string] $Root, [string] $ListenHost)
        $bin = Join-Path $Root 'bin'
        $local = Join-Path $Root 'local'
        New-Item -ItemType Directory -Force -Path $bin, $local | Out-Null
        Copy-Item -LiteralPath $gatewayFixture -Destination (Join-Path $bin 'gateway-fixture.js') -Force
        $cmd = @(
            '@echo off',
            'cd /d "%~dp0..\local"',
            "`"$node`" `"%~dp0gateway-fixture.js`" %*"
        ) -join "`r`n"
        Write-Utf8NoBom (Join-Path $bin 'cozygateway.cmd') ($cmd + "`r`n")
        Write-Utf8NoBom (Join-Path $local 'cozygateway.config.json') "{`n  `"name`": `"cozygateway`",`n  `"host`": `"$ListenHost`",`n  `"port`": 8787,`n  `"dbPath`": `"cozygateway.sqlite`"`n}`n"
        Write-Utf8NoBom (Join-Path $local 'install-state') "harness=cozyagents`ncozyagents_home=/c/cozyagents`n"
    }
    New-GatewayStage (Join-Path $temp 'stage-lan') '0.0.0.0'
    New-GatewayStage (Join-Path $temp 'stage-loopback') '127.0.0.1'

    # The fake bash: it records what the bootstrap handed it, and materializes the gateway files a
    # real run would leave behind, so the pairing and the QR have something to talk to.
    $fakeBash = Join-Path $temp 'Git With Spaces\bash.cmd'
    Write-Utf8NoBom $fakeBash @"
@echo off
echo bash:%*>>"$eventLog"
echo bash-owner:%COZYGATEWAY_WINDOWS_HARNESS_OWNER%>>"$eventLog"
echo bash-agents-home:%COZYAGENTS_HOME%>>"$eventLog"
if "%COZYGATEWAY_TEST_BASH_FAIL%"=="1" exit /b 23
if not "%COZYGATEWAY_TEST_GATEWAY_STAGE%"=="" (
  xcopy /e /i /y /q "%COZYGATEWAY_TEST_GATEWAY_STAGE%" "%COZYGATEWAY_TEST_GATEWAY_DEST%" >nul
)
if not "%COZYGATEWAY_TEST_GATEWAY_REMOVE%"=="" (
  if exist "%COZYGATEWAY_TEST_GATEWAY_REMOVE%" rmdir /s /q "%COZYGATEWAY_TEST_GATEWAY_REMOVE%"
)
exit /b 0
"@

    # The CozyAgents runner bundle a real install leaves behind: it records every command this
    # bootstrap gives it, and `runner pair` writes the runner credential so a rerun can prove the
    # pairing is kept.
    $agentsFixture = Join-Path $temp 'agents-fixture.js'
    Write-Utf8NoBom $agentsFixture @'
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const log = process.env.COZYAGENTS_TEST_LOG;
fs.appendFileSync(log, 'argv ' + args.join(' ') + '\n');
fs.appendFileSync(log, 'env COZYAGENTS_PAIR_CODE=' + (process.env.COZYAGENTS_PAIR_CODE || '') + '\n');
const homeAt = args.indexOf('--home');
const home = homeAt === -1 ? '' : args[homeAt + 1];
if (args[0] === 'runner' && args[1] === 'pair') {
  fs.appendFileSync(path.join(home, 'runner.env'), 'COZYRUNNER_TOKEN=paired-token\nCOZYRUNNER_NAME=test-runner\nCOZYRUNNER_GATEWAY_URL=http://127.0.0.1:8787\n');
}
if (args[0] === 'uninstall') {
  fs.appendFileSync(log, 'uninstall ' + args.join(' ') + '\n');
}
'@

    # The stubbed CozyAgents Windows installer, with the contract scripts/install.ps1 in CozyAgents
    # keeps: -NoPair, -InstallHome, and an install.json naming the node and the bundle.
    $agentsInstaller = Join-Path $temp 'agents.ps1'
    Write-Utf8NoBom $agentsInstaller @"
[CmdletBinding()]
param(
    [string] `$Version,
    [string] `$InstallHome,
    [string] `$BinDir,
    [string] `$Gateway,
    [string] `$Name,
    [switch] `$NoPair,
    [switch] `$DryRun,
    [switch] `$Help
)
`$log = `$env:COZYAGENTS_TEST_LOG
Add-Content -LiteralPath `$log -Value "install NoPair=`$NoPair InstallHome=`$InstallHome"
Add-Content -LiteralPath `$log -Value "install env COZYAGENTS_HOME=`$(`$env:COZYAGENTS_HOME)"
if (`$env:COZYAGENTS_TEST_INSTALL_FAIL -eq '1') { throw 'stub CozyAgents install failure' }
`$target = `$InstallHome
New-Item -ItemType Directory -Force -Path (Join-Path `$target 'bin') | Out-Null
Copy-Item -LiteralPath '$agentsFixture' -Destination (Join-Path `$target 'bin\cozyagents-fixture.js') -Force
`$state = [ordered]@{
    version = 'v0.0.0-test'
    node = '$node'
    bundle = [ordered]@{ url = ''; sha256 = ''; path = (Join-Path `$target 'bin\cozyagents-fixture.js') }
}
Set-Content -LiteralPath (Join-Path `$target 'install.json') -Value (`$state | ConvertTo-Json -Depth 5)
"@

    $baseEnvironment = @{
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYAGENTS_TEST_LOG' = $agentsLog
        'COZYAGENTS_INSTALL_URL' = $agentsInstaller
        # A hosted runner holds an administrator token, and the CozyAgents path refuses one. Every
        # case says it is not elevated except the one that is about the refusal.
        'COZYGATEWAY_TEST_ASSUME_ELEVATED' = '0'
        'COZYGATEWAY_TEST_CLI_LOG' = $cliLog
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $temp 'no-such-hermes.exe')
        'LOCALAPPDATA' = (Join-Path $temp 'localappdata')
        'PATH' = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
    }
    function New-Environment {
        param([hashtable] $Overrides)
        $environment = @{}
        foreach ($key in $baseEnvironment.Keys) { $environment[$key] = $baseEnvironment[$key] }
        foreach ($key in $Overrides.Keys) { $environment[$key] = $Overrides[$key] }
        return $environment
    }

    # ---------------------------------------------------------------------------
    # 1. The harness question
    # ---------------------------------------------------------------------------
    Write-Utf8NoBom (Join-Path $temp 'answer-enter') "`n"
    Write-Utf8NoBom (Join-Path $temp 'answer-two') "2`n"
    Write-Utf8NoBom (Join-Path $temp 'answer-retry') "nonsense`n1`n"

    $enter = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Enter Gateway')
        'COZYGATEWAY_INSTALL_DRYRUN' = '1'
        'COZYGATEWAY_TEST_HARNESS_PROMPT_INPUT' = (Join-Path $temp 'answer-enter')
    })
    Assert-True ($enter.ExitCode -eq 0) "the harness question must not fail the dry run: $($enter.Output)"
    Assert-Contains $enter.Output 'Which harness runs your bots? [1] CozyAgents (recommended) [2] Hermes Agent [1]' 'the harness question must be asked'
    Assert-Contains $enter.Output 'harness: cozyagents' 'Enter must take the recommended harness'

    $two = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Two Gateway')
        'COZYGATEWAY_INSTALL_DRYRUN' = '1'
        'COZYGATEWAY_TEST_HARNESS_PROMPT_INPUT' = (Join-Path $temp 'answer-two')
    })
    Assert-Contains $two.Output 'harness: hermes' 'answering 2 must take Hermes'
    Assert-Contains $two.Output 'would install Hermes Agent' 'the Hermes answer must plan the Hermes bootstrap'

    $retry = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Retry Gateway')
        'COZYGATEWAY_INSTALL_DRYRUN' = '1'
        'COZYGATEWAY_TEST_HARNESS_PROMPT_INPUT' = (Join-Path $temp 'answer-retry')
    })
    Assert-Contains $retry.Output 'Please answer 1 or 2.' 'an unusable answer must be asked again'
    Assert-Contains $retry.Output 'harness: cozyagents' 'the retry must land on the answer that was given'

    $flag = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Flag Gateway')
        'COZYGATEWAY_INSTALL_DRYRUN' = '1'
        'COZYGATEWAY_TEST_HARNESS_PROMPT_INPUT' = (Join-Path $temp 'answer-two')
    }) @('-Harness', 'cozyagents')
    Assert-Missing $flag.Output 'Which harness runs your bots?' '-Harness must answer the question'
    Assert-Contains $flag.Output 'harness: cozyagents (from -Harness)' '-Harness must say where the answer came from'

    $silent = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Silent Gateway')
        'COZYGATEWAY_INSTALL_DRYRUN' = '1'
    })
    Assert-Missing $silent.Output 'Which harness runs your bots?' 'a run with no terminal must not ask'
    Assert-Contains $silent.Output 'would install CozyAgents from' 'a run with no terminal must take the recommended harness'

    $bad = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Bad Harness Gateway')
        'COZYGATEWAY_INSTALL_DRYRUN' = '1'
    }) @('-Harness', 'whatever')
    Assert-True ($bad.ExitCode -ne 0) 'an unknown -Harness must fail'

    # ---------------------------------------------------------------------------
    # 2. The CozyAgents dry-run plan names nothing Hermes owns
    # ---------------------------------------------------------------------------
    Assert-Contains $silent.Output 'no Hermes attach plugin' 'the CozyAgents plan must say it fetches no attach plugin'
    Assert-Contains $silent.Output 'with -NoPair, then pair this computer as a runner with a code minted here' 'the CozyAgents plan must name the pairing it does'
    Assert-Contains $silent.Output "would install CozyAgents from $agentsInstaller" 'the CozyAgents plan must name the installer it would run'
    Assert-Missing $silent.Output 'Hermes Agent' 'the CozyAgents plan must not name Hermes at all'
    Assert-Missing $silent.Output 'Dashboard' 'the CozyAgents plan must not name the Hermes Dashboard'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $temp 'Silent Gateway'))) 'a dry run must write nothing'

    # ---------------------------------------------------------------------------
    # 2b. An elevated token is refused on the CozyAgents path, before anything is installed
    # ---------------------------------------------------------------------------
    $elevatedHome = Join-Path $temp 'Elevated Gateway'
    Remove-Item -LiteralPath $eventLog, $agentsLog -Force -ErrorAction SilentlyContinue
    $elevated = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = $elevatedHome
        'COZYAGENTS_HOME' = (Join-Path $temp 'elevated-cozyagents')
        'COZYGATEWAY_TEST_ASSUME_ELEVATED' = ''
        'COZYAGENTS_INSTALL_ASSUME_ELEVATED' = '1'
        'COZYGATEWAY_TEST_GATEWAY_STAGE' = (Join-Path $temp 'stage-loopback')
        'COZYGATEWAY_TEST_GATEWAY_DEST' = $elevatedHome
    }) @('-Harness', 'cozyagents')
    Assert-True ($elevated.ExitCode -ne 0) 'an elevated run must exit non-zero on the CozyAgents path'
    Assert-Contains $elevated.Output 'installs per user under your profile and never needs administrator; rerun as yourself.' 'the no-admin sentence must name what is refused'
    Assert-True (-not (Test-Path -LiteralPath $elevatedHome)) 'an elevated run must install nothing'
    Assert-True ((Read-LogText $eventLog) -eq '') 'an elevated run must not reach the shared installer'
    Assert-True ((Read-LogText $agentsLog) -eq '') 'an elevated run must not reach the CozyAgents installer'

    # The Hermes path is untouched: it has always installed whatever token it was given.
    $elevatedHermes = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Elevated Hermes Gateway')
        'COZYGATEWAY_TEST_ASSUME_ELEVATED' = ''
        'COZYAGENTS_INSTALL_ASSUME_ELEVATED' = '1'
        'COZYGATEWAY_INSTALL_DRYRUN' = '1'
    }) @('-Harness', 'hermes')
    Assert-True ($elevatedHermes.ExitCode -eq 0) "an elevated Hermes run must be refused by nothing new: $($elevatedHermes.Output)"
    Assert-Missing $elevatedHermes.Output 'never needs administrator' 'the Hermes path must print no no-admin sentence'

    # ---------------------------------------------------------------------------
    # 3. A live CozyAgents install: model onboarding, the LAN question, the QR
    # ---------------------------------------------------------------------------
    $liveHome = Join-Path $temp 'Live Cozy Gateway'
    $liveAgents = Join-Path $temp 'live-cozyagents'
    $liveCodex = Join-Path $temp 'live-profile\.pi\agent\auth.json'
    Write-Utf8NoBom $liveCodex "{`"stub`":true}`n"
    Write-Utf8NoBom (Join-Path $temp 'model-answers') "openai-codex`ngpt-5.6-luna`ny`n"
    Write-Utf8NoBom (Join-Path $temp 'lan-yes') "yes`n"
    $livePathLog = Join-Path $temp 'live-user-path.txt'
    Remove-Item -LiteralPath $eventLog, $agentsLog, $cliLog -Force -ErrorAction SilentlyContinue
    $live = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = $liveHome
        'COZYAGENTS_HOME' = $liveAgents
        'COZYGATEWAY_CODEX_AUTH_PATH' = $liveCodex
        'COZYGATEWAY_TEST_MODEL_PROMPT_INPUT' = (Join-Path $temp 'model-answers')
        'COZYGATEWAY_TEST_LAN_PROMPT_INPUT' = (Join-Path $temp 'lan-yes')
        'COZYGATEWAY_TEST_PAIRING_LAN_ADDRESS' = '192.0.2.10'
        'COZYGATEWAY_TEST_GATEWAY_STAGE' = (Join-Path $temp 'stage-lan')
        'COZYGATEWAY_TEST_GATEWAY_DEST' = $liveHome
        'COZYGATEWAY_TEST_USER_PATH' = 'C:\Existing Tools'
        'COZYGATEWAY_TEST_USER_PATH_LOG' = $livePathLog
    }) @('-CozyAgentsInstaller', $agentsInstaller)
    Assert-True ($live.ExitCode -eq 0) "the live CozyAgents install failed: $($live.Output)"

    # The questions, in the approved order: harness, model, network, then the QR.
    Assert-Contains $live.Output 'Which provider should new bots use?' 'the provider question must be asked'
    Assert-Contains $live.Output 'Share the Codex login on this computer' 'a Codex login on this machine must be offered'
    Assert-Contains $live.Output 'Allow CozyChat to access this Gateway over your local network? [y/N]' 'the network question must be asked'
    Assert-Contains $live.Output 'default model for new bots: gpt-5.6-luna on openai-codex' 'the model answers must be reported'

    # The shared installer was asked for a CozyAgents gateway, with the listener the person chose,
    # and told that this bootstrap owns the harness half.
    $events = Read-LogText $eventLog
    Assert-Contains $events '--harness cozyagents' 'the shared installer must be asked for the CozyAgents harness'
    Assert-Contains $events '--bind-host 0.0.0.0' 'the LAN answer must reach the shared installer as the listener'
    Assert-Contains $events 'bash-owner:1' 'the shared installer must be told the Windows bootstrap owns the harness'
    Assert-Contains $events 'bash-agents-home:' 'the shared installer must run without a native CozyAgents home'
    Assert-Missing $events '--plugin-archive' 'a CozyAgents gateway must not be given a Hermes attach plugin'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $liveHome 'bin\cozygateway-hermes-attach-plugin.tar.gz'))) 'a CozyAgents install must not fetch the Hermes attach plugin'
    Assert-True (Test-Path -LiteralPath (Join-Path $liveHome 'bin\agent-install.sh')) 'the verified shared installer must be promoted'
    Assert-True (Test-Path -LiteralPath (Join-Path $liveHome 'bin\cozygateway-bootstrap.ps1')) 'the verified repair bootstrap must be promoted'
    Assert-True (@(Get-ChildItem -LiteralPath $liveHome -Filter '.bootstrap-*' -Force).Count -eq 0) 'a successful bootstrap must remove its staging directory'

    # The model answers landed in the runner env CozyAgents reads, owner-only, with no key.
    $runnerEnv = Join-Path $liveAgents 'runner.env'
    $runnerEnvText = Read-LogText $runnerEnv
    Assert-Contains $runnerEnvText 'COZYRUNNER_MODEL_ID=gpt-5.6-luna' 'the model id must reach the runner env'
    Assert-Contains $runnerEnvText 'COZYRUNNER_MODEL_PROVIDER=openai-codex' 'the provider must reach the runner env'
    Assert-Contains $runnerEnvText 'COZYRUNNER_SHARE_HOST_MODEL_AUTH=1' 'the shared Codex login must reach the runner env'
    Assert-Missing $runnerEnvText 'COZYRUNNER_MODEL_ENDPOINT' 'a provider answer must not also write an endpoint'
    Assert-True (-not ($runnerEnvText -match '(?i)api_key')) 'the installer must never write a model key'
    Assert-NoBroadReadAcl $runnerEnv
    Assert-True ((Get-Acl -LiteralPath $runnerEnv).AreAccessRulesProtected) 'the runner env must not inherit access rules'

    # The person typed no pairing code: the bootstrap minted a runner code and handed it over in
    # the environment. A credential in waiting never reaches an argument, where any process on this
    # machine could read it.
    $agentsText = Read-LogText $agentsLog
    Assert-Contains $agentsText 'install NoPair=True' 'the CozyAgents installer must be run with -NoPair'
    Assert-Contains $agentsText "install NoPair=True InstallHome=$liveAgents" 'the CozyAgents installer must be given the install home'
    Assert-Contains $agentsText 'argv runner pair --gateway http://127.0.0.1:8787 --name ' 'the runner must be paired to this gateway'
    Assert-Contains $agentsText 'env COZYAGENTS_PAIR_CODE=RUNNER-TEST-CODE' 'the pairing code must travel in the environment'
    $argvLines = @(Get-Content -LiteralPath $agentsLog | Where-Object { $_ -like 'argv *' })
    Assert-True (-not ($argvLines | Where-Object { $_.Contains('RUNNER-TEST-CODE') })) 'the pairing code must never reach an argument'
    Assert-Missing $live.Output 'RUNNER-TEST-CODE' 'the pairing code must never be printed'
    Assert-Missing $events 'RUNNER-TEST-CODE' 'the pairing code must never reach the shared installer'
    Assert-Contains (Read-LogText $cliLog) 'cli pair --kind runner --ttl 10' 'the runner code must be minted through the gateway CLI'

    # First-time setup ends on the QR, and the LAN answer is what it encodes.
    Assert-Contains $live.Output 'fake-qr' 'first-time setup must end on a pairing QR'
    Assert-Contains $live.Output '"setupCode":"TEST-CODE"' 'the QR must carry a device pairing code'
    Assert-Contains $live.Output '"gatewayUrl":"http://192.0.2.10:8787"' 'the QR must encode the listener the person chose'
    Assert-Contains $live.Output 'codes expire after 10 minutes' 'the pairing card must say how long a code lasts'
    Assert-Contains $live.Output 'for a tunnel, rerun the installer with: --public-url' 'the pairing card must name the tunnel option the POSIX card names'
    Assert-Missing $live.Output 'Dashboard' 'a CozyAgents install must not mention the Hermes Dashboard'
    $registeredPath = Get-Content -LiteralPath $livePathLog -Raw
    $liveBin = Join-Path $liveHome 'bin'
    Assert-True ($registeredPath.Contains($liveBin)) 'the CozyAgents path must add the command directory to the user PATH'
    Assert-True ((@($registeredPath -split ';' | Where-Object { $_ -eq $liveBin })).Count -eq 1) 'the command directory must be registered once'

    # ---------------------------------------------------------------------------
    # 4. The second run: no harness question, no LAN question, no new pairing
    # ---------------------------------------------------------------------------
    Write-Utf8NoBom (Join-Path $temp 'pair-no') "no`n"
    Remove-Item -LiteralPath $agentsLog, $eventLog -Force -ErrorAction SilentlyContinue
    $rerunPathLog = Join-Path $temp 'rerun-user-path.txt'
    $rerun = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = $liveHome
        'COZYAGENTS_HOME' = $liveAgents
        'COZYGATEWAY_CODEX_AUTH_PATH' = $liveCodex
        'COZYGATEWAY_TEST_HARNESS_PROMPT_INPUT' = (Join-Path $temp 'answer-two')
        'COZYGATEWAY_TEST_PAIR_PROMPT_INPUT' = (Join-Path $temp 'pair-no')
        'COZYGATEWAY_TEST_GATEWAY_STAGE' = (Join-Path $temp 'stage-lan')
        'COZYGATEWAY_TEST_GATEWAY_DEST' = $liveHome
        'COZYGATEWAY_TEST_USER_PATH' = "C:\Existing Tools;$liveBin"
        'COZYGATEWAY_TEST_USER_PATH_LOG' = $rerunPathLog
    })
    Assert-True ($rerun.ExitCode -eq 0) "the second run failed: $($rerun.Output)"
    Assert-Missing $rerun.Output 'Which harness runs your bots?' 'a machine that answered the harness question is never asked again'
    Assert-Contains $rerun.Output 'harness: cozyagents (already installed here)' 'the recorded harness is the one the install owns'
    Assert-Missing $rerun.Output 'Allow CozyChat to access this Gateway over your local network?' 'the network question is asked once'
    Assert-Contains $rerun.Output 'Create a new CozyChat pairing code? [y/N]' 'an update must ask before minting a new code'
    Assert-Contains $rerun.Output 'no new pairing code created' 'answering no must mint nothing'
    Assert-Missing $rerun.Output 'fake-qr' 'answering no must print no QR'
    Assert-Contains $rerun.Output 'already paired to CozyGateway as a runner' 'a rerun must keep the pairing this computer has'
    Assert-Missing (Read-LogText $agentsLog) 'runner pair' 'a rerun must not re-pair the runner'
    $rerunPath = Get-Content -LiteralPath $rerunPathLog -Raw
    Assert-True ((@($rerunPath -split ';' | Where-Object { $_ -eq $liveBin })).Count -eq 1) 'a second run must not duplicate the PATH entry'

    # The QR question answered yes mints a new code; --no-qr never asks or prints one.
    Write-Utf8NoBom (Join-Path $temp 'pair-yes') "yes`n"
    $yes = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = $liveHome
        'COZYAGENTS_HOME' = $liveAgents
        'COZYGATEWAY_TEST_PAIR_PROMPT_INPUT' = (Join-Path $temp 'pair-yes')
        'COZYGATEWAY_TEST_GATEWAY_STAGE' = (Join-Path $temp 'stage-lan')
        'COZYGATEWAY_TEST_GATEWAY_DEST' = $liveHome
        'COZYGATEWAY_TEST_USER_PATH' = "C:\Existing Tools;$liveBin"
        'COZYGATEWAY_TEST_USER_PATH_LOG' = (Join-Path $temp 'yes-user-path.txt')
    })
    Assert-True ($yes.ExitCode -eq 0) "answering yes to a new pairing code failed: $($yes.Output)"
    Assert-Contains $yes.Output 'fake-qr' 'answering yes must print a QR'

    $noQr = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = $liveHome
        'COZYAGENTS_HOME' = $liveAgents
        'COZYGATEWAY_TEST_PAIR_PROMPT_INPUT' = (Join-Path $temp 'pair-yes')
        'COZYGATEWAY_TEST_GATEWAY_STAGE' = (Join-Path $temp 'stage-lan')
        'COZYGATEWAY_TEST_GATEWAY_DEST' = $liveHome
        'COZYGATEWAY_TEST_USER_PATH' = "C:\Existing Tools;$liveBin"
        'COZYGATEWAY_TEST_USER_PATH_LOG' = (Join-Path $temp 'no-qr-user-path.txt')
    }) @('--no-qr')
    Assert-True ($noQr.ExitCode -eq 0) "--no-qr failed: $($noQr.Output)"
    Assert-Missing $noQr.Output 'fake-qr' '--no-qr must print no QR'
    Assert-Missing $noQr.Output 'Create a new CozyChat pairing code?' '--no-qr must not ask'
    Assert-Contains $noQr.Output 'no pairing QR was printed (--no-qr)' '--no-qr must say why there is no QR'

    # ---------------------------------------------------------------------------
    # 5. A loopback answer stays loopback, and a local endpoint is written as one
    # ---------------------------------------------------------------------------
    $loopbackHome = Join-Path $temp 'Loopback Cozy Gateway'
    $loopbackAgents = Join-Path $temp 'loopback-cozyagents'
    Write-Utf8NoBom (Join-Path $temp 'endpoint-answers') "http://127.0.0.1:1234/v1`nqwen3-coder`n"
    Write-Utf8NoBom (Join-Path $temp 'lan-no') "no`n"
    Remove-Item -LiteralPath $agentsLog, $eventLog -Force -ErrorAction SilentlyContinue
    $loopback = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = $loopbackHome
        'COZYAGENTS_HOME' = $loopbackAgents
        'COZYGATEWAY_CODEX_AUTH_PATH' = (Join-Path $temp 'no-such-auth.json')
        'HERMES_HOME' = (Join-Path $temp 'no-such-hermes-home')
        'COZYGATEWAY_TEST_MODEL_PROMPT_INPUT' = (Join-Path $temp 'endpoint-answers')
        'COZYGATEWAY_TEST_LAN_PROMPT_INPUT' = (Join-Path $temp 'lan-no')
        'COZYGATEWAY_TEST_GATEWAY_STAGE' = (Join-Path $temp 'stage-loopback')
        'COZYGATEWAY_TEST_GATEWAY_DEST' = $loopbackHome
        'COZYGATEWAY_TEST_USER_PATH' = 'C:\Existing Tools'
        'COZYGATEWAY_TEST_USER_PATH_LOG' = (Join-Path $temp 'loopback-user-path.txt')
    })
    Assert-True ($loopback.ExitCode -eq 0) "the loopback install failed: $($loopback.Output)"
    Assert-Contains (Read-LogText $eventLog) '--bind-host 127.0.0.1' 'a loopback answer must keep the listener on loopback'
    Assert-Contains $loopback.Output '"gatewayUrl":"http://127.0.0.1:8787"' 'the QR must encode the loopback listener'
    $loopbackRunnerEnv = Read-LogText (Join-Path $loopbackAgents 'runner.env')
    Assert-Contains $loopbackRunnerEnv 'COZYRUNNER_MODEL_ENDPOINT=http://127.0.0.1:1234/v1' 'a local endpoint must be written as one'
    Assert-Missing $loopbackRunnerEnv 'COZYRUNNER_MODEL_PROVIDER' 'an endpoint answer must not also write a provider'
    Assert-Missing $loopback.Output 'Share the Codex login on this computer' 'no Codex login means the opt-in is never offered'

    # ---------------------------------------------------------------------------
    # 6. A Hermes bridge nobody chose to replace freezes the run
    # ---------------------------------------------------------------------------
    $orphanHome = Join-Path $temp 'Orphan Gateway'
    Write-Utf8NoBom (Join-Path $orphanHome 'local\cozygateway.config.json') @'
{
  "name": "cozygateway",
  "host": "127.0.0.1",
  "port": 8787,
  "hermesEndpoints": [{ "id": "default", "url": "ws://127.0.0.1:9119/api/ws", "authMode": "token", "tokenEnv": "COZYGATEWAY_HERMES_TOKEN", "profile": "default" }]
}
'@
    Remove-Item -LiteralPath $agentsLog -Force -ErrorAction SilentlyContinue
    $orphan = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = $orphanHome
        'COZYAGENTS_HOME' = (Join-Path $temp 'orphan-cozyagents')
        'COZYGATEWAY_INSTALL_DRYRUN' = '1'
        'COZYGATEWAY_TEST_MODEL_PROMPT_INPUT' = (Join-Path $temp 'model-answers')
    })
    Assert-Contains $orphan.Output 'keeping it. Rerun with -Harness cozyagents to replace it.' 'a kept Hermes bridge must say how to replace it'
    Assert-Contains $orphan.Output 'continuing as a Hermes install; nothing CozyAgents-owned is installed, paired, or configured here.' 'a kept bridge must make the whole run a Hermes install'
    Assert-Contains $orphan.Output '& ([scriptblock]::Create((irm https://cozylabs.ai/install.ps1))) -Harness cozyagents' 'a kept bridge must show the form that can carry the flag'
    Assert-Missing $orphan.Output 'Which provider should new bots use?' 'a kept bridge must ask no CozyAgents question'
    Assert-Missing $orphan.Output 'would install CozyAgents from' 'a kept bridge must install no CozyAgents harness'
    Assert-True ((Read-LogText $agentsLog) -eq '') 'a kept bridge must run nothing CozyAgents owns'
    Assert-True ((Read-LogText (Join-Path $orphanHome 'local\cozygateway.config.json')).Contains('hermesEndpoints')) 'a kept bridge must survive the run'

    # Asking for it outright is the one thing that takes the bridge out.
    $chosen = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = $orphanHome
        'COZYAGENTS_HOME' = (Join-Path $temp 'orphan-cozyagents')
        'COZYGATEWAY_INSTALL_DRYRUN' = '1'
    }) @('-Harness', 'cozyagents')
    Assert-Missing $chosen.Output 'keeping it. Rerun with -Harness cozyagents' 'an explicit choice must not be overruled by the bridge'
    Assert-Contains $chosen.Output 'would install CozyAgents from' 'an explicit choice must plan the CozyAgents install'

    # ---------------------------------------------------------------------------
    # 7. A tampered asset is refused before anything CozyAgents-owned runs
    # ---------------------------------------------------------------------------
    $tamperHome = Join-Path $temp 'Tampered Gateway'
    $originalBundleSha = Get-Content -LiteralPath (Join-Path $fixtures 'cozygateway.mjs.sha256') -Raw
    Write-Utf8NoBom (Join-Path $fixtures 'cozygateway.mjs.sha256') (('0' * 64) + "  cozygateway.mjs`n")
    Remove-Item -LiteralPath $agentsLog, $eventLog -Force -ErrorAction SilentlyContinue
    $tampered = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = $tamperHome
        'COZYAGENTS_HOME' = (Join-Path $temp 'tampered-cozyagents')
        'COZYGATEWAY_TEST_GATEWAY_STAGE' = (Join-Path $temp 'stage-loopback')
        'COZYGATEWAY_TEST_GATEWAY_DEST' = $tamperHome
    }) @('-Harness', 'cozyagents')
    Assert-True ($tampered.ExitCode -ne 0) 'a tampered asset must fail the install'
    Assert-Contains $tampered.Output 'checksum mismatch' 'a tampered asset must be named as a checksum mismatch'
    Assert-True ((Read-LogText $eventLog) -eq '') 'a tampered asset must fail before the shared installer runs'
    Assert-True ((Read-LogText $agentsLog) -eq '') 'a tampered asset must fail before the CozyAgents installer runs'
    Assert-True (@(Get-ChildItem -LiteralPath $tamperHome -Filter '.bootstrap-*' -Force).Count -eq 0) 'a failed bootstrap must remove its staging directory'
    Write-Utf8NoBom (Join-Path $fixtures 'cozygateway.mjs.sha256') $originalBundleSha

    # ---------------------------------------------------------------------------
    # 8. Uninstall gives the harness back to its own uninstaller
    # ---------------------------------------------------------------------------
    Remove-Item -LiteralPath $agentsLog, $eventLog -Force -ErrorAction SilentlyContinue
    $uninstallPathLog = Join-Path $temp 'uninstall-user-path.txt'
    $uninstall = Invoke-Bootstrap $installer (New-Environment @{
        'COZYGATEWAY_HOME' = $loopbackHome
        'COZYAGENTS_HOME' = $loopbackAgents
        'COZYGATEWAY_TEST_GATEWAY_REMOVE' = $loopbackHome
        'COZYGATEWAY_TEST_USER_PATH' = "C:\Existing Tools;$(Join-Path $loopbackHome 'bin')"
        'COZYGATEWAY_TEST_USER_PATH_LOG' = $uninstallPathLog
    }) @('--uninstall')
    Assert-True ($uninstall.ExitCode -eq 0) "the CozyAgents uninstall failed: $($uninstall.Output)"
    $uninstallEvents = Read-LogText $eventLog
    Assert-Contains $uninstallEvents '--uninstall' 'the shared installer must be asked to remove the gateway'
    Assert-Contains $uninstallEvents 'bash-owner:1' 'the shared installer must know the bootstrap owns the harness'
    Assert-Contains (Read-LogText $agentsLog) 'uninstall --home' 'the harness must be removed through its own uninstaller'
    Assert-Contains $uninstall.Output 'removed the CozyAgents harness through its own uninstaller' 'the uninstall must say what it removed'
    $uninstalledPath = Get-Content -LiteralPath $uninstallPathLog -Raw
    Assert-True (-not $uninstalledPath.Contains((Join-Path $loopbackHome 'bin'))) 'the uninstall must remove the command directory from the user PATH'

    Write-Host 'windows agents bootstrap tests passed'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

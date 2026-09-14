# Portable orchestration coverage; Windows also exercises deletion of a private Node executable.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$installer = Join-Path $PSScriptRoot '../install.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $installer), [ref] $tokens, [ref] $errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Uninstall-WithCozyAgents', 'Complete-WindowsUninstall')) {
    $fn = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $false)
    Invoke-Expression $fn.Extent.Text
}
function Fail([string] $Message) { throw $Message }
function Write-Info([string] $Message) { }
function Write-Ok([string] $Message) { }
function Resolve-CozyAgentsHome { return $script:AgentsHome }
function Resolve-GitBash { return 'Invoke-FixtureGatewayUninstall' }
function Invoke-FixtureGatewayUninstall {
    if ($env:COZYGATEWAY_WINDOWS_HARNESS_OWNER -ne '1') { throw 'bootstrap must own final deletion' }
    $script:GatewayArguments = @($args)
    $global:LASTEXITCODE = 0
}
function Set-CozyGatewayCommandPath { $script:PathRemoved = $true }
function Assert-BootstrapPathAndParents { }
function Get-CozyAgentsCommand { return @{ Node = $script:Node; Bundle = $script:Bundle } }
function Assert([bool] $Condition, [string] $Message) { if (-not $Condition) { throw $Message } }

$root = Join-Path ([IO.Path]::GetTempPath()) ('cozygateway-uninstall-test-' + [guid]::NewGuid().ToString('N'))
$originalOwner = $env:COZYGATEWAY_WINDOWS_HARNESS_OWNER
$originalFailure = $env:COZY_UNINSTALL_TEST_FAIL
$node = (Get-Command node -ErrorAction Stop).Source
try {
    foreach ($mode in @('purge', 'keep', 'preview', 'failure')) {
        $script:InstallHome = Join-Path $root "$mode/gateway"
        $script:AgentsHome = Join-Path $root "$mode/agents"
        $script:PathRemoved = $false
        $script:GatewayArguments = @()
        New-Item -ItemType Directory -Path $script:InstallHome, "$script:AgentsHome/bots" -Force | Out-Null
        $installerPath = Join-Path $script:InstallHome 'agent-install.sh'
        Set-Content -LiteralPath $installerPath -Value 'fixture'
        Set-Content -LiteralPath "$script:AgentsHome/install.json" -Value '{}'
        Set-Content -LiteralPath "$script:AgentsHome/bots/history" -Value 'keep'
        $script:Bundle = Join-Path $script:AgentsHome 'uninstall.mjs'
        Set-Content -LiteralPath $script:Bundle -Value @'
import fs from 'node:fs';
const args = process.argv.slice(2);
const home = args[args.indexOf('--home') + 1];
if (args[0] !== 'uninstall' || !args.includes('--yes')) process.exit(2);
if (process.env.COZY_UNINSTALL_TEST_FAIL === '1') process.exit(3);
if (process.platform === 'win32' && process.execPath.toLowerCase().startsWith(home.toLowerCase() + '\\')) process.exit(4);
fs.writeFileSync(home + '/../arguments.json', JSON.stringify(args));
for (const entry of fs.readdirSync(home)) {
  if (entry === 'bots' && !args.includes('--purge')) continue;
  fs.rmSync(home + '/' + entry, {recursive: true, force: true});
}
if (args.includes('--purge')) fs.rmdirSync(home);
'@
        $script:Node = $node
        if ($env:OS -eq 'Windows_NT') {
            $script:Node = Join-Path $script:AgentsHome 'node.exe'
            Copy-Item -LiteralPath $node -Destination $script:Node
        }
        $env:COZY_UNINSTALL_TEST_FAIL = if ($mode -eq 'failure') { '1' } else { '0' }
        $forwarded = @('--uninstall')
        if ($mode -ne 'keep') { $forwarded += '--purge' }
        $failed = $false
        try { Uninstall-WithCozyAgents "$script:InstallHome/bin" $installerPath $forwarded ($mode -eq 'preview') }
        catch { if ($mode -ne 'failure') { throw }; $failed = $true }
        Assert ($failed -eq ($mode -eq 'failure')) "unexpected result in $mode"
        Assert ([string]$env:COZYGATEWAY_WINDOWS_HARNESS_OWNER -eq [string]$originalOwner) 'owner environment was not restored'
        Assert ($script:GatewayArguments -contains '--uninstall') 'gateway removal was not requested'
        if ($mode -in @('preview', 'failure')) {
            Assert (Test-Path -LiteralPath $installerPath) 'retry installer was removed'
            Assert (Test-Path -LiteralPath "$script:AgentsHome/bots/history") 'bot data changed on preview/failure'
        } else {
            Assert (-not (Test-Path -LiteralPath $script:InstallHome)) 'Gateway residue remains'
            Assert $script:PathRemoved 'command PATH was not removed'
            Assert ((Test-Path -LiteralPath "$script:AgentsHome/bots/history") -eq ($mode -eq 'keep')) 'bot purge semantics differ'
            $arguments = Get-Content -LiteralPath "$script:AgentsHome/../arguments.json" -Raw | ConvertFrom-Json
            Assert (($arguments -contains '--purge') -eq ($mode -eq 'purge')) 'purge was not forwarded correctly'
        }
        if ($mode -eq 'preview') { Assert (-not $script:PathRemoved) 'preview changed PATH' }
        Write-Host "ok    Windows uninstall orchestration: $mode"
    }
} finally {
    $env:COZYGATEWAY_WINDOWS_HARNESS_OWNER = $originalOwner
    $env:COZY_UNINSTALL_TEST_FAIL = $originalFailure
    Remove-Item -LiteralPath $root -Recurse -Force
}

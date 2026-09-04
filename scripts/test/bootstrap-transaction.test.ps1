param([string] $Installer = (Join-Path $PSScriptRoot '..\install.ps1'))
$ErrorActionPreference = 'Stop'
function Assert-True { param([bool] $Condition, [string] $Message) if (-not $Condition) { throw "ASSERT: $Message" } }
function Fail { param([string] $Message) throw $Message }
function Write-Info { param([string] $Message) }
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Installer), [ref] $tokens, [ref] $errors)
if ($errors.Count) { throw ($errors | Out-String) }
$needed = @('Recover-BootstrapTransaction', 'Finish-BootstrapRecovery', 'Start-BootstrapTransaction', 'Commit-BootstrapTransaction')
foreach ($name in $needed) {
  $fn = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true) | Select-Object -First 1
  Assert-True ($null -ne $fn) "installer must define $name"
  Invoke-Expression $fn.Extent.Text
}
$script:BootstrapLockPath = $null
$root = Join-Path ([IO.Path]::GetTempPath()) ('cozygateway-transaction-' + [guid]::NewGuid().ToString('N'))
try {
  $bin = Join-Path $root bin; New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $assets = @('cozygateway.mjs')
  [IO.File]::WriteAllText((Join-Path $bin 'cozygateway.mjs'), 'old')
  [IO.File]::WriteAllText((Join-Path $bin 'cozygateway.mjs.sha256'), 'old-sha')
  Start-BootstrapTransaction $root $bin $assets
  [IO.File]::WriteAllText((Join-Path $bin 'cozygateway.mjs'), 'new')
  [IO.File]::WriteAllText((Join-Path $bin 'cozygateway.mjs.sha256'), 'new-sha')
  Assert-True (Recover-BootstrapTransaction $root $bin $assets) 'first promotion recovery must report a restored release'
  Assert-True ([IO.File]::ReadAllText((Join-Path $bin 'cozygateway.mjs')) -eq 'old') 'first promotion recovery must restore old bytes'
  Finish-BootstrapRecovery $root
  Assert-True (-not (Test-Path (Join-Path $root '.bootstrap-transaction'))) 'recovery cleanup must clear journal'
  Start-BootstrapTransaction $root $bin @('fresh.mjs')
  [IO.File]::WriteAllText((Join-Path $bin 'fresh.mjs'), 'new-fresh')
  Assert-True (Recover-BootstrapTransaction $root $bin @('fresh.mjs')) 'fresh-install recovery must complete without a prior installer'
  Finish-BootstrapRecovery $root
  [IO.File]::WriteAllText((Join-Path $root '.bootstrap-transaction'), 'commit=installer-succeeded')
  Recover-BootstrapTransaction $root $bin $assets
  Assert-True (-not (Test-Path (Join-Path $root '.bootstrap-transaction'))) 'committed marker without backup must clean up'
  $backup = Join-Path $root '.bootstrap-previous'; New-Item -ItemType Directory -Force -Path $backup | Out-Null
  [IO.File]::WriteAllText((Join-Path $root '.bootstrap-transaction'), 'intent=replace-release-assets')
  [IO.File]::WriteAllText((Join-Path $backup 'inventory'), 'present:../outside')
  $bad = $false; try { Recover-BootstrapTransaction $root $bin $assets } catch { $bad = $true }
  Assert-True $bad 'malicious inventory path must fail closed'
  Write-Host 'bootstrap transaction helper tests passed'
} finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }

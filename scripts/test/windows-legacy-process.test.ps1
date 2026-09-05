$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\agent-install.sh'))
$match = [regex]::Match($source, '(?s)    function Same-Path\(.*?(?=    function Managed-GatewayProcesses)')
if (-not $match.Success) { throw 'production process predicates missing' }
Invoke-Expression $match.Value
$values = @{
 NODE='C:\Runtime\node.exe'; GATEWAY_ENV='C:\Gateway\local\gateway.env';
 DASHBOARD_ENV='C:\Gateway\local\dashboard.env'; HERMES_ROOT='C:\Hermes';
 HERMES='C:\Hermes\hermes.exe'; LAUNCHER='C:\Hermes\bin\hermes.exe';
 OWNER_HELPER='C:\Gateway\local\dashboard-owner.ps1'; DASHBOARD_PORT='9119';
 BUNDLE='C:\Gateway\bin\cozygateway.mjs'; CONFIG='C:\Gateway\local\config.json'; LEGACY_INLINE='1'
}
$before=@{}
try {
 foreach ($key in $values.Keys) {
   $name='COZYGATEWAY_EXPECTED_'+$key
   $before[$name]=[Environment]::GetEnvironmentVariable($name,'Process')
   [Environment]::SetEnvironmentVariable($name,$values[$key],'Process')
 }
 $args=@($values.NODE, '-', $values.GATEWAY_ENV, $values.DASHBOARD_ENV, $values.HERMES_ROOT, $values.HERMES, $values.LAUNCHER, $values.OWNER_HELPER, $values.DASHBOARD_PORT, $values.BUNDLE, $values.CONFIG)
 $command=($args | ForEach-Object { '"'+$_+'"' }) -join ' '
 if (-not (Is-ManagedGatewaySupervisor ([pscustomobject]@{CommandLine=$command}))) { throw 'exact released process not recognized' }
 foreach ($key in @('NODE','GATEWAY_ENV','DASHBOARD_ENV','HERMES_ROOT','HERMES','LAUNCHER','OWNER_HELPER','DASHBOARD_PORT','BUNDLE','CONFIG')) {
   $foreign=$command.Replace(('"'+$values[$key]+'"'), '"foreign"')
   if (Is-ManagedGatewaySupervisor ([pscustomobject]@{CommandLine=$foreign})) { throw "foreign $key accepted" }
 }
 $env:COZYGATEWAY_EXPECTED_LEGACY_INLINE='0'
 if (Is-ManagedGatewaySupervisor ([pscustomobject]@{CommandLine=$command})) { throw 'inline process accepted without verified legacy wrapper' }
 Write-Output 'PASS released legacy process recognition and unrelated-process refusals'
} finally {
 foreach ($name in $before.Keys) { [Environment]::SetEnvironmentVariable($name,$before[$name],'Process') }
}
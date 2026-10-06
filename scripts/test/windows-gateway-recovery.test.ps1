$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\install.ps1'),[ref]$tokens,[ref]$errors)
foreach($name in @('Fail','Assert-BootstrapPath','Assert-BootstrapPathAndParents','Assert-BootstrapRegularFile','Test-BootstrapPathEquals','Resolve-WindowsGatewayNodePath','Test-OwnedGatewayTask','Test-OwnedGatewayStartupEntry','Split-WindowsRecoveryCommandLine','Test-WindowsRecoveryProcess','Invoke-WindowsRecoveryTaskkill','Get-WindowsRecoveryOrphanDescriptors','Stop-OwnedGatewayForRecovery')) {
    $fn=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true) | Select-Object -First 1
    Invoke-Expression $fn.Extent.Text
}
function Assert-True([bool]$Value,[string]$Message){if(-not $Value){throw "ASSERT: $Message"}}
$script:task='<Task><Actions><Exec><Command>C:\Runtime\node.exe</Command><Arguments>"C:\Gateway Home\supervisor.cjs" --config "C:\Gateway Home\config.json"</Arguments></Exec></Actions></Task>'
$script:startup=$false
function Get-GatewayRegistrationForRecovery {return [pscustomobject]@{TaskXml=$script:task;StartupPresent=$script:startup;StartupPath='C:\Gateway Home\Startup.vbs'}}
function Get-GatewayTaskExec($TaskXml){$x=[xml]$TaskXml;return [pscustomobject]@{Command=[string]$x.Task.Actions.Exec.Command;Arguments=[string]$x.Task.Actions.Exec.Arguments}}
function Get-CimInstance {param($ClassName,$Filter) if($Filter){return $script:current}else{return $script:processes}}
function Invoke-WindowsRecoveryTaskkill {param([int]$ProcessId) $script:killed+=@($ProcessId);if(-not $script:stubborn){$script:processes=@();$script:current=$null}}
function Start-Sleep {param($Milliseconds)}
function New-Process {param($Executable='C:\Runtime\node.exe',$Arguments='"C:\Gateway Home\supervisor.cjs" --config "C:\Gateway Home\config.json"',$Created='original') return [pscustomobject]@{ProcessId=321;ExecutablePath=$Executable;CommandLine=('"'+$Executable+'" '+$Arguments);CreationDate=$Created}}
$script:stubborn=$false
$script:processes=@(New-Process);$script:current=$script:processes[0];$script:killed=@()
Stop-OwnedGatewayForRecovery 'C:\Gateway Home'
Assert-True ($script:killed.Count -eq 1 -and $script:killed[0] -eq 321) 'exact registered process must stop'
foreach($foreign in @((New-Process -Executable 'C:\Foreign\node.exe'),(New-Process -Arguments '"C:\Other\supervisor.cjs" --config "C:\Gateway Home\config.json"'),(New-Process -Arguments '"C:\Gateway Home\supervisor.cjs" --config "C:\Gateway Home\config.json" --extra'))) {
    $script:processes=@($foreign);$script:current=$foreign;$script:killed=@()
    Stop-OwnedGatewayForRecovery 'C:\Gateway Home'
    Assert-True ($script:killed.Count -eq 0) 'foreign executable or arguments must remain untouched'
}
$script:processes=@(New-Process);$script:current=New-Process -Created 'reused';$script:killed=@()
$failed=$false;try{Stop-OwnedGatewayForRecovery 'C:\Gateway Home'}catch{$failed=$true}
Assert-True ($script:killed.Count -eq 0 -and $failed) 'PID reuse must not kill and unresolved ownership must fail'
$script:processes=@(New-Process);$script:current=$script:processes[0];$script:killed=@();$script:stubborn=$true
$failed=$false;try{Stop-OwnedGatewayForRecovery 'C:\Gateway Home'}catch{$failed=$true}
Assert-True ($failed -and $script:killed.Count -eq 1) 'failed process stop must fail recovery'
$script:processes=@();$script:current=$null;$script:killed=@()
Stop-OwnedGatewayForRecovery 'C:\Gateway Home'
Assert-True ($script:killed.Count -eq 0) 'already stopped process must be a no-op'
$script:task='';$script:startup=$true;$script:stubborn=$false
$trusted=Join-Path ([Environment]::SystemDirectory) 'wscript.exe'
$script:processes=@(New-Process -Executable $trusted -Arguments '"C:\Gateway Home\Startup.vbs"');$script:current=$script:processes[0];$script:killed=@()
Stop-OwnedGatewayForRecovery 'C:\Gateway Home'
Assert-True ($script:killed.Count -eq 1) 'verified Startup launcher in trusted WScript must stop'
$script:processes=@(New-Process -Executable 'C:\Foreign\wscript.exe' -Arguments '"C:\Gateway Home\Startup.vbs"');$script:current=$script:processes[0];$script:killed=@()
Stop-OwnedGatewayForRecovery 'C:\Gateway Home'
Assert-True ($script:killed.Count -eq 0) 'untrusted WScript must remain untouched'
$root=Join-Path ([IO.Path]::GetTempPath()) ('cozy-orphan-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $root 'local') -Force | Out-Null
try {
    $script:task='';$script:startup=$false
    $state=Join-Path $root 'local\install-state'
    [IO.File]::WriteAllText($state,"node_resolved=C:\Runtime\node.exe`n")
    $args=@((Join-Path $root 'local\gateway-supervisor.cjs'),'--platform','Windows','--gateway-env',(Join-Path $root 'local\gateway.env'),'--bundle',(Join-Path $root 'bin\cozygateway.mjs'),'--config',(Join-Path $root 'local\cozygateway.config.json'),'--maintenance-socket','\\.\pipe\cozygateway-maintenance','--maintenance-worker',(Join-Path $root 'local\maintenance-worker.cjs'),'--database',(Join-Path $root 'local\cozygateway.sqlite'))
    $supervisorArgs=($args|ForEach-Object{'"'+$_+'"'})-join ' '
    # Both old Tasks and their state can name extensionless Node, while CIM
    # reports node.exe. Recovery must still stop only the exact owned processes.
    $runtime=Join-Path $root 'Runtime With Spaces\node.exe'
    New-Item -ItemType Directory -Path (Split-Path -Parent $runtime) | Out-Null
    [IO.File]::WriteAllText($runtime,'fixture executable identity')
    $extensionless=$runtime.Substring(0,$runtime.Length-4)
    $msys='/' + $extensionless.Substring(0,1).ToLowerInvariant() + $extensionless.Substring(2).Replace('\','/')
    [IO.File]::WriteAllText($state,"node_resolved=$msys`n")
    foreach ($command in @($extensionless,$runtime)) {
        $script:task='<Task><Actions><Exec><Command>'+ $command +'</Command><Arguments>'+ $supervisorArgs +'</Arguments></Exec></Actions></Task>'
        Assert-True (Test-OwnedGatewayTask $root $script:task) 'historical and canonical Tasks must match the same recorded Node executable'
        $script:processes=@(New-Process -Executable $runtime -Arguments $supervisorArgs);$script:current=$script:processes[0];$script:killed=@()
        Stop-OwnedGatewayForRecovery $root
        Assert-True ($script:killed.Count -eq 1) 'extensionless registered runtime must match its native process'
        $script:processes=@(New-Process -Executable $runtime -Arguments $supervisorArgs)
        $script:processes[0].CommandLine='"'+$extensionless+'" '+$supervisorArgs
        $script:current=$script:processes[0];$script:killed=@()
        Stop-OwnedGatewayForRecovery $root
        Assert-True ($script:killed.Count -eq 1) 'native process command line can retain the extensionless launch path'
    }
    $script:task=''
    foreach ($arguments in @($supervisorArgs,('"'+(Join-Path $root 'bin\cozygateway.mjs')+'" serve --config "'+(Join-Path $root 'local\cozygateway.config.json')+'"'))) {
        $script:processes=@(New-Process -Executable $runtime -Arguments $arguments);$script:current=$script:processes[0];$script:killed=@()
        Stop-OwnedGatewayForRecovery $root
        Assert-True ($script:killed.Count -eq 1) 'historical identity must locate the owned orphan supervisor and child'
    }
    $script:processes=@(New-Process -Executable $runtime -Arguments ($supervisorArgs+' --foreign value'));$script:current=$script:processes[0];$script:killed=@()
    Stop-OwnedGatewayForRecovery $root
    Assert-True ($script:killed.Count -eq 0) 'normalizing the runtime must not broaden argument ownership'
    [IO.File]::WriteAllText($state,"node_resolved=C:\Runtime\node.exe`n")
    foreach($arguments in @($supervisorArgs,('"'+(Join-Path $root 'bin\cozygateway.mjs')+'" serve --config "'+(Join-Path $root 'local\cozygateway.config.json')+'"'))) {
        $script:processes=@(New-Process -Arguments $arguments);$script:current=$script:processes[0];$script:killed=@()
        Stop-OwnedGatewayForRecovery $root
        Assert-True ($script:killed.Count -eq 1) 'orphan supervisor/child must stop using durable runtime identity after task deletion'
    }
    $script:processes=@(New-Process -Arguments ($supervisorArgs+' --foreign value'));$script:current=$script:processes[0];$script:killed=@()
    Stop-OwnedGatewayForRecovery $root
    Assert-True ($script:killed.Count -eq 0) 'orphan-like supervisor with foreign arguments must remain untouched'
    [IO.File]::WriteAllText($state,"node_resolved=C:\Runtime\node.exe`nnode_resolved=C:\Other\node.exe`n")
    $script:processes=@(New-Process -Arguments $supervisorArgs);$script:current=$script:processes[0];$script:killed=@()
    $failed=$false;try{Stop-OwnedGatewayForRecovery $root}catch{$failed=$true}
    Assert-True ($failed -and $script:killed.Count -eq 0) 'ambiguous runtime identity must refuse before killing any process'
} finally {
    $resolved=[IO.Path]::GetFullPath($root)
    if(-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)){throw 'unsafe cleanup'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Host 'Windows Gateway recovery ownership tests passed'

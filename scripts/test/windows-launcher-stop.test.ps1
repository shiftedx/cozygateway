$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\agent-install.sh'))
$predicates = [regex]::Match($source, '(?s)    function Same-Path\(.*?(?=    \$managed = @\(Managed-GatewayProcesses\))')
if (-not $predicates.Success) { throw 'production process ownership predicates missing' }
# Only evaluate predicates and inventory selection. No production termination or launcher runs.
Invoke-Expression $predicates.Value
$names = @('COZYGATEWAY_EXPECTED_VBS', 'COZYGATEWAY_EXPECTED_STARTUP_VBS', 'COZYGATEWAY_EXPECTED_NODE', 'COZYGATEWAY_EXPECTED_BUNDLE', 'COZYGATEWAY_EXPECTED_CONFIG')
$before = @{}
try {
    foreach ($name in $names) { $before[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    $env:COZYGATEWAY_EXPECTED_VBS = 'C:\Fixture Gateway\local\run-gateway.vbs'
    $env:COZYGATEWAY_EXPECTED_STARTUP_VBS = 'C:\Fixture Startup\CozyGateway.vbs'
    $env:COZYGATEWAY_EXPECTED_NODE = 'C:\Fixture Runtime\node.exe'
    $env:COZYGATEWAY_EXPECTED_BUNDLE = 'C:\Fixture Gateway\gateway.mjs'
    $env:COZYGATEWAY_EXPECTED_CONFIG = 'C:\Fixture Gateway\config.json'
    $trusted = Join-Path ([Environment]::SystemDirectory) 'wscript.exe'
    function New-LauncherFixture([string] $Executable, [string] $Entry, [string] $Extra = '') {
        [pscustomobject]@{ ProcessId = 123; ExecutablePath = $Executable; CommandLine = ('"' + $Executable + '" "' + $Entry + '"' + $Extra); CreationDate = [datetime]'2026-09-05T20:30:00Z' }
    }
    function Get-CimInstance {
        param($ClassName, [string] $Filter)
        if ($Filter) { return $script:fixtureProcesses | Where-Object { $_.ProcessId -eq [int]($Filter -replace 'ProcessId = ', '') } }
        return $script:fixtureProcesses
    }
    foreach ($entry in @($env:COZYGATEWAY_EXPECTED_VBS, $env:COZYGATEWAY_EXPECTED_STARTUP_VBS)) {
        # A retrying WScript may be the only remaining process during its minute-long sleep.
        $script:fixtureProcesses = @(New-LauncherFixture $trusted $entry)
        $managed = @(Managed-GatewayProcesses)
        if ($managed.Count -ne 1) { throw 'owned sleeping WScript must be selected even without a Node descendant' }
        foreach ($foreign in @(
            (New-LauncherFixture 'C:\Foreign\wscript.exe' $entry),
            (New-LauncherFixture $trusted 'C:\Foreign\run-gateway.vbs'),
            (New-LauncherFixture $trusted $entry ' --foreign')
        )) {
            $script:fixtureProcesses = @($foreign)
            if (@(Managed-GatewayProcesses).Count -ne 0) { throw 'foreign launcher must remain untouched' }
        }
    }
    $stop = [regex]::Match($source, '(?s)    function Stop-ManagedGatewayProcess\(.*?(?=    \$stopped = )')
    $loop = [regex]::Match($source, '(?s)    \$stopped = .*?(?=    Start-Sleep -Milliseconds 1200)')
    if (-not $stop.Success -or -not $loop.Success) { throw 'production stop loop missing' }
    Invoke-Expression $stop.Value
    # The only process mutation seam is an in-memory scriptblock, never taskkill.exe.
    $script:terminated = [Collections.Generic.List[int]]::new()
    $taskkill = { param($PidFlag, $FixtureId, $TreeFlag, $ForceFlag) $script:terminated.Add([int]$FixtureId) }
    $first = New-LauncherFixture $trusted $env:COZYGATEWAY_EXPECTED_VBS
    $second = New-LauncherFixture $trusted $env:COZYGATEWAY_EXPECTED_STARTUP_VBS
    $second.ProcessId = 124
    $child = [pscustomobject]@{
        ProcessId = 125; CreationDate = $first.CreationDate; ExecutablePath = $env:COZYGATEWAY_EXPECTED_NODE
        CommandLine = ('"{0}" "{1}" serve --config "{2}"' -f $env:COZYGATEWAY_EXPECTED_NODE, $env:COZYGATEWAY_EXPECTED_BUNDLE, $env:COZYGATEWAY_EXPECTED_CONFIG)
    }
    $script:fixtureProcesses = @($child, $first, $second)
    $managed = @(Managed-GatewayProcesses)
    Invoke-Expression $loop.Value
    if ($script:terminated.Count -ne 3 -or -not $script:terminated.Contains(123) -or -not $script:terminated.Contains(124)) { throw 'every exact duplicate launcher and child must stop' }
    if ($script:terminated[2] -ne 125) { throw 'outer retry launchers must stop before their Node children' }
    $child.ExecutablePath = 'C:\Foreign\node.exe'
    $script:fixtureProcesses = @($child)
    if (@(Managed-GatewayProcesses).Count -ne 0) { throw 'forged child executable must remain untouched' }
    $script:terminated.Clear()
    $reused = New-LauncherFixture $trusted $env:COZYGATEWAY_EXPECTED_VBS
    $reused.CreationDate = $first.CreationDate.AddSeconds(1)
    $script:fixtureProcesses = @($reused)
    Stop-ManagedGatewayProcess $first
    if ($script:terminated.Count -ne 0) { throw 'reused PID must not be terminated' }
    $foreign = New-LauncherFixture $trusted 'C:\Foreign\run-gateway.vbs'
    $script:fixtureProcesses = @($foreign)
    Stop-ManagedGatewayProcess $first
    if ($script:terminated.Count -ne 0) { throw 'changed command identity must not be terminated' }
    Write-Output 'PASS sleeping launcher cleanup, duplicate ownership, PID reuse and foreign-process refusals'
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $before[$name], 'Process') }
}

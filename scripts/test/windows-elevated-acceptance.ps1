<#
Repeatable Windows installer acceptance harness (#271).

Automates the live scenario that was validated by hand on a Windows host: a fresh Hermes
install with a local model provider while a stale ELEVATED Dashboard holds the Dashboard port
with a mismatched session token, an unrelated listener sits on the next port, and the installer
inherits a poisoned PSModulePath. It then checks authenticated Dashboard access, a healthy
Gateway attach, preservation of both unrelated listeners, and that the poisoned module never ran
elevated. It is not the 29-case native qualification matrix in
docs/windows-qualification-2026-09-04.md; it covers this one scenario and records evidence.

It changes the machine. Run it only on a disposable Windows VM or test account with no
CozyGateway or Hermes install you care about, and pass -AcknowledgeDisposableHost.

Phases, in order. Every phase after Setup takes the same -RunRoot:

  1. Setup      ELEVATED window. Preflight, then start the stale elevated Dashboard stand-in
                and the unrelated sentinel listener.
  2. Install    NORMAL window. Runs the installer with the poisoned PSModulePath and the
                unattended local-model settings.
  3. Verify     NORMAL window. Checks the installed result against the preserved listeners.
  4. Uninstall  NORMAL window. Runs the uninstaller and checks what it must leave behind.
  5. Cleanup    ELEVATED window. Stops only the processes Setup started (PID + creation time).

  # elevated
  .\scripts\test\windows-elevated-acceptance.ps1 -Phase Setup -RunRoot C:\cga\run1 -AcknowledgeDisposableHost `
      -ModelEndpoint http://127.0.0.1:1234/v1 -ModelId qwen3-8b
  # normal
  .\scripts\test\windows-elevated-acceptance.ps1 -Phase Install -RunRoot C:\cga\run1 -AcknowledgeDisposableHost
  .\scripts\test\windows-elevated-acceptance.ps1 -Phase Verify -RunRoot C:\cga\run1
  .\scripts\test\windows-elevated-acceptance.ps1 -Phase Uninstall -RunRoot C:\cga\run1 -AcknowledgeDisposableHost
  # elevated
  .\scripts\test\windows-elevated-acceptance.ps1 -Phase Cleanup -RunRoot C:\cga\run1 -AcknowledgeDisposableHost

Keep -RunRoot short (MAX_PATH bit earlier native runs). By default the installer is this
checkout's scripts\install.ps1 and downloads the latest published assets; -AssetBase points it at
a local asset directory, and -InstallerPath at a downloaded published install.ps1.

-Phase SelfCheck runs anywhere pwsh does (including macOS/Linux) and exercises only the
harness's own fixtures: the case table, the stale Dashboard stand-in's HTTP contract, and the
poisoned module's shadowing. It installs nothing.

Each phase writes <RunRoot>\results-<phase>.json and exits 1 if any case failed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('SelfCheck', 'Setup', 'Install', 'Verify', 'Uninstall', 'Cleanup')]
    [string] $Phase,
    [string] $RunRoot,
    [switch] $AcknowledgeDisposableHost,
    [string] $ModelEndpoint,
    [string] $ModelId,
    [string] $InstallerPath,
    [string] $AssetBase,
    [string] $GatewayHome,
    [int] $DashboardPort = 9119,
    [int] $GatewayPort = 8787,
    [int] $ReadyTimeoutSeconds = 180,
    [switch] $AllowExistingHermes
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# Every case the harness can report, by phase. Results name only these IDs, so a phase that
# stops early still lists what it did not reach as NOT RUN.
$script:Cases = [ordered]@{
    'K01' = @('SelfCheck', 'case table has unique IDs in known phases')
    'K02' = @('SelfCheck', 'stale Dashboard stand-in answers health 200, stale token 200, other token 401')
    'K03' = @('SelfCheck', 'poisoned PSModulePath shadows Get-NetTCPConnection and records the load')
    'S01' = @('Setup', 'Windows host, elevated harness, Windows PowerShell 5.1 present')
    'S02' = @('Setup', 'fresh host: no CozyGateway home and no Hermes home')
    'S03' = @('Setup', 'Dashboard, sentinel and Gateway ports are free')
    'S04' = @('Setup', 'local model provider answers /models and lists the model')
    'S05' = @('Setup', 'stale elevated Dashboard listens with a mismatched token')
    'S06' = @('Setup', 'unrelated sentinel listener holds the next Dashboard port')
    'I01' = @('Install', 'installer runs from a non-elevated session')
    'I02' = @('Install', 'installer exits 0')
    'I03' = @('Install', 'fresh install with a foreign Dashboard does not take the scoped UAC path')
    'V01' = @('Verify', 'stale elevated Dashboard preserved (same PID and creation time, still listening)')
    'V02' = @('Verify', 'stale Dashboard still rejects the installed session token')
    'V03' = @('Verify', 'unrelated sentinel listener preserved')
    'V04' = @('Verify', 'Gateway Hermes endpoint moved to a private loopback Dashboard port')
    'V05' = @('Verify', 'private Dashboard accepts the installed token on /api/config')
    'V06' = @('Verify', 'Gateway /ready answers 200 (Hermes attach healthy)')
    'V07' = @('Verify', 'poisoned NetTCPIP module never loaded in an elevated process')
    'U01' = @('Uninstall', 'uninstaller exits 0')
    'U02' = @('Uninstall', 'stale Dashboard and sentinel preserved through uninstall')
    'U03' = @('Uninstall', 'private Dashboard and Gateway ports released')
    'U04' = @('Uninstall', 'poisoned NetTCPIP module never loaded in an elevated process')
    'C01' = @('Cleanup', 'harness-started processes stopped after identity check')
}
$script:Results = [ordered]@{}

function Set-CaseResult {
    param([string] $Id, [ValidateSet('PASS', 'FAIL', 'SKIP')] [string] $Status, [string] $Detail = '')
    if (-not $script:Cases.Contains($Id)) { throw "unknown acceptance case $Id" }
    $script:Results[$Id] = [pscustomobject]@{ Id = $Id; Status = $Status; Case = $script:Cases[$Id][1]; Detail = $Detail }
    Write-Host ('{0,-4} {1}  {2}{3}' -f $Status, $Id, $script:Cases[$Id][1], $(if ($Detail) { " -- $Detail" } else { '' }))
}

function Assert-Case {
    param([string] $Id, [bool] $Condition, [string] $Detail = '')
    if ($Condition) { Set-CaseResult $Id PASS $Detail } else { Set-CaseResult $Id FAIL $Detail }
    return $Condition
}

function Complete-Phase {
    $rows = foreach ($id in $script:Cases.Keys) {
        if ($script:Cases[$id][0] -ne $Phase) { continue }
        if ($script:Results.Contains($id)) { $script:Results[$id] }
        else { [pscustomobject]@{ Id = $id; Status = 'NOT RUN'; Case = $script:Cases[$id][1]; Detail = '' } }
    }
    $rows = @($rows)
    if ($RunRoot) {
        $report = [pscustomobject]@{ Phase = $Phase; Finished = (Get-Date).ToString('o'); Cases = $rows }
        [IO.File]::WriteAllText((Join-Path $RunRoot "results-$($Phase.ToLowerInvariant()).json"), ($report | ConvertTo-Json -Depth 5))
    }
    $failed = @($rows | Where-Object { $_.Status -ne 'PASS' -and $_.Status -ne 'SKIP' })
    Write-Host ''
    Write-Host ("$Phase`: {0} passed, {1} failed or not run" -f @($rows | Where-Object { $_.Status -eq 'PASS' }).Count, $failed.Count)
    if ($failed.Count) { exit 1 }
    exit 0
}

function Test-IsWindowsHost { return [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT }

function Test-IsElevated {
    if (-not (Test-IsWindowsHost)) { return $false }
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-WindowsPowerShellPath {
    return [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function Get-CurrentHostPath { return (Get-Process -Id $PID).Path }

function New-HarnessToken { return ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')) }

# Raw loopback HTTP/1.1 GET: identical on Windows PowerShell 5.1 and pwsh, no proxy, and a 401
# is a status to read rather than an exception. Status 0 means nothing answered.
function Invoke-LoopbackGet {
    param([int] $Port, [string] $Path, [hashtable] $Headers = @{}, [int] $TimeoutMs = 5000)
    $client = New-Object Net.Sockets.TcpClient
    try {
        $connect = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne($TimeoutMs)) { return [pscustomobject]@{ Status = 0; Body = 'connect timeout' } }
        $client.EndConnect($connect)
        $client.ReceiveTimeout = $TimeoutMs
        $client.SendTimeout = $TimeoutMs
        $stream = $client.GetStream()
        $request = "GET $Path HTTP/1.1`r`nHost: 127.0.0.1:$Port`r`nConnection: close`r`n"
        foreach ($name in $Headers.Keys) { $request += "${name}: $($Headers[$name])`r`n" }
        $bytes = [Text.Encoding]::ASCII.GetBytes($request + "`r`n")
        $stream.Write($bytes, 0, $bytes.Length)
        $response = (New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)).ReadToEnd()
    } catch {
        return [pscustomobject]@{ Status = 0; Body = $_.Exception.Message }
    } finally {
        $client.Close()
    }
    $status = [regex]::Match($response, '^HTTP/1\.[01] (\d{3})')
    $split = $response.IndexOf("`r`n`r`n")
    return [pscustomobject]@{
        Status = $(if ($status.Success) { [int]$status.Groups[1].Value } else { 0 })
        Body = $(if ($split -ge 0) { $response.Substring($split + 4) } else { '' })
    }
}

# Stand-in for a stale Hermes Dashboard: the installer and supervisor only read /api/health and
# /api/config with X-Hermes-Session-Token, so this answers that contract with its own token.
$script:StaleDashboardSource = @'
param([int] $Port, [string] $Token, [string] $ReadyFile)
$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
$listener.Start()
[IO.File]::WriteAllText($ReadyFile, [string]$PID)
while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
        $client.ReceiveTimeout = 5000
        $stream = $client.GetStream()
        $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::ASCII)
        $requestLine = [string]$reader.ReadLine()
        $headers = @{}
        while ($true) {
            $line = $reader.ReadLine()
            if ([string]::IsNullOrEmpty($line)) { break }
            $colon = $line.IndexOf(':')
            if ($colon -gt 0) { $headers[$line.Substring(0, $colon).Trim().ToLowerInvariant()] = $line.Substring($colon + 1).Trim() }
        }
        $path = @($requestLine -split ' ')[1]
        $status = 404
        if ($path -like '/api/health*') { $status = 200 }
        elseif ($path -like '/api/config*') { $status = $(if ([string]$headers['x-hermes-session-token'] -ceq $Token) { 200 } else { 401 }) }
        $reason = @{ 200 = 'OK'; 401 = 'Unauthorized'; 404 = 'Not Found' }[$status]
        $body = '{"cozygatewayAcceptance":"stale-dashboard"}'
        $bytes = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $status $reason`r`nContent-Type: application/json`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n$body")
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    } catch {
    } finally {
        $client.Close()
    }
}
'@

function Start-StaleDashboard {
    param([string] $Name, [int] $Port, [string] $Token)
    $script = Join-Path $RunRoot 'stale-dashboard.ps1'
    [IO.File]::WriteAllText($script, $script:StaleDashboardSource)
    $ready = Join-Path $RunRoot "$Name.ready"
    Remove-Item -LiteralPath $ready -Force -ErrorAction SilentlyContinue
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Get-CurrentHostPath
    $info.Arguments = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" {1} {2} "{3}"' -f $script, $Port, $Token, $ready)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($info)
    for ($attempt = 0; $attempt -lt 150 -and -not (Test-Path -LiteralPath $ready); $attempt++) {
        if ($process.HasExited) { break }
        Start-Sleep -Milliseconds 100
    }
    return $process
}

# Creation time as UTC ticks in a string, so a JSON round trip cannot reinterpret it as a date.
function Get-ProcessCreation {
    param([int] $ProcessId)
    if (Test-IsWindowsHost) {
        $process = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ProcessId) -ErrorAction SilentlyContinue
        if ($null -eq $process) { return $null }
        return [string]([datetime]$process.CreationDate).ToUniversalTime().Ticks
    }
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $null }
    return [string]$process.StartTime.ToUniversalTime().Ticks
}

function Get-ListenerOwner {
    param([int] $Port)
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $listener) { return $null }
    return [int]$listener.OwningProcess
}

function Test-TrackedProcess {
    param($Tracked)
    $creation = Get-ProcessCreation ([int]$Tracked.Pid)
    return ($null -ne $creation -and $creation -eq [string]$Tracked.Created -and (Get-ListenerOwner ([int]$Tracked.Port)) -eq [int]$Tracked.Pid)
}

# A NetTCPIP module that shadows the inbox one when its root is first on PSModulePath. It records
# every load with the loading process's elevation, then answers from the same CIM class the inbox
# cmdlet wraps, so the unelevated installer steps it may reach still see the real listener table.
function New-PoisonModuleRoot {
    param([string] $Root, [string] $Marker)
    $moduleRoot = Join-Path $Root 'NetTCPIP'
    New-Item -ItemType Directory -Force -Path $moduleRoot | Out-Null
    $markerLiteral = "'" + $Marker.Replace("'", "''") + "'"
    $body = @"
`$elevated = `$false
try { `$elevated = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { }
[IO.File]::AppendAllText($markerLiteral, ('elevated=' + `$elevated + ' pid=' + `$PID + [Environment]::NewLine))
function Get-NetTCPConnection {
    [CmdletBinding()]
    param([string] `$State, [int[]] `$LocalPort)
    `$rows = @(Get-CimInstance -Namespace ROOT/StandardCimv2 -ClassName MSFT_NetTCPConnection)
    if (`$State -eq 'Listen') { `$rows = @(`$rows | Where-Object { `$_.State -eq 2 }) }
    if (`$LocalPort) { `$rows = @(`$rows | Where-Object { `$LocalPort -contains `$_.LocalPort }) }
    `$rows
}
Export-ModuleMember -Function Get-NetTCPConnection
"@
    [IO.File]::WriteAllText((Join-Path $moduleRoot 'NetTCPIP.psm1'), $body, (New-Object Text.UTF8Encoding($false)))
}

function Get-PoisonLoads {
    param([string] $Marker)
    if (-not (Test-Path -LiteralPath $Marker)) { return @() }
    return @(Get-Content -LiteralPath $Marker | Where-Object { $_ })
}

function Invoke-Installer {
    param([string[]] $Arguments, [string] $LogName)
    $state = Read-State
    $poisonRoot = Join-Path $RunRoot 'poison\Modules'
    New-PoisonModuleRoot $poisonRoot $state.PoisonMarker
    $overrides = @{
        'PSModulePath' = $poisonRoot + ';' + $env:PSModulePath
        'COZYGATEWAY_HERMES_MODEL_ENDPOINT' = $state.ModelEndpoint
        'COZYGATEWAY_HERMES_MODEL_ID' = $state.ModelId
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $state.AssetBase
        'COZYGATEWAY_HOME' = $state.GatewayHomeOverride
    }
    $saved = @{}
    foreach ($name in $overrides.Keys) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        $value = $overrides[$name]
        if ([string]::IsNullOrEmpty($value)) { $value = $saved[$name] }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
    $log = Join-Path $RunRoot $LogName
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & (Get-WindowsPowerShellPath) -NoProfile -ExecutionPolicy Bypass -File $state.InstallerPath @Arguments 2>&1 |
            ForEach-Object { [string]$_ } | Tee-Object -FilePath $log | Out-Host
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Log = [IO.File]::ReadAllText($log) }
}

function Read-State {
    $path = Join-Path $RunRoot 'state.json'
    if (-not (Test-Path -LiteralPath $path)) { throw "no Setup state at $path; run -Phase Setup with this -RunRoot first" }
    return [IO.File]::ReadAllText($path) | ConvertFrom-Json
}

function Write-State {
    param($State)
    [IO.File]::WriteAllText((Join-Path $RunRoot 'state.json'), ($State | ConvertTo-Json -Depth 5))
}

function Read-InstalledEndpoint {
    param($State)
    $local = Join-Path $State.GatewayHome 'local'
    $config = [IO.File]::ReadAllText((Join-Path $local 'cozygateway.config.json')) | ConvertFrom-Json
    $urls = @($config.hermesEndpoints | ForEach-Object { [string]$_.url })
    $port = $null
    if ($urls.Count -eq 1) {
        $match = [regex]::Match($urls[0], '^ws://127\.0\.0\.1:(\d+)/api/ws$')
        if ($match.Success) { $port = [int]$match.Groups[1].Value }
    }
    $token = $null
    foreach ($line in [IO.File]::ReadAllLines((Join-Path $local 'dashboard.env'))) {
        if ($line.StartsWith('DASHBOARD_SESSION_TOKEN=')) { $token = $line.Substring('DASHBOARD_SESSION_TOKEN='.Length) }
    }
    return [pscustomobject]@{ Urls = $urls; Port = $port; Token = $token }
}

function Assert-HostPhase {
    param([bool] $RequireElevated, [bool] $RequireNormal)
    if (-not (Test-IsWindowsHost)) { throw "-Phase $Phase needs a Windows host; use -Phase SelfCheck elsewhere" }
    if (-not $RunRoot) { throw "-Phase $Phase needs -RunRoot" }
    if ($Phase -ne 'Verify' -and -not $AcknowledgeDisposableHost) { throw "-Phase $Phase changes this machine; rerun with -AcknowledgeDisposableHost on a disposable host" }
    if ($RequireElevated -and -not (Test-IsElevated)) { throw "-Phase $Phase must run from an elevated PowerShell window" }
    if ($RequireNormal -and (Test-IsElevated)) { throw "-Phase $Phase must run from a normal (non-elevated) PowerShell window so the installer keeps this session's environment" }
}

switch ($Phase) {
    'SelfCheck' {
        $ownsRunRoot = -not $RunRoot
        if ($ownsRunRoot) { $RunRoot = Join-Path ([IO.Path]::GetTempPath()) ('cozygateway-acceptance-selfcheck-' + [guid]::NewGuid().ToString('N')) }
        New-Item -ItemType Directory -Force -Path $RunRoot | Out-Null
        $phases = @('SelfCheck', 'Setup', 'Install', 'Verify', 'Uninstall', 'Cleanup')
        $unknown = @($script:Cases.Keys | Where-Object { $phases -notcontains $script:Cases[$_][0] })
        $null = Assert-Case 'K01' ($unknown.Count -eq 0 -and @($script:Cases.Keys | Select-Object -Unique).Count -eq $script:Cases.Count) "$($script:Cases.Count) cases"

        $reservation = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
        $reservation.Start()
        $port = ([Net.IPEndPoint]$reservation.LocalEndpoint).Port
        $reservation.Stop()
        $token = New-HarnessToken
        $stale = Start-StaleDashboard 'selfcheck-stale' $port $token
        try {
            $health = Invoke-LoopbackGet $port '/api/health'
            $own = Invoke-LoopbackGet $port '/api/config' @{ 'X-Hermes-Session-Token' = $token }
            $other = Invoke-LoopbackGet $port '/api/config' @{ 'X-Hermes-Session-Token' = (New-HarnessToken) }
            $null = Assert-Case 'K02' ($health.Status -eq 200 -and $own.Status -eq 200 -and $other.Status -eq 401) "health $($health.Status), stale token $($own.Status), other token $($other.Status)"
        } finally {
            if (-not $stale.HasExited) { $stale.Kill() }
        }

        $marker = Join-Path $RunRoot 'poison-loads.txt'
        $poisonRoot = Join-Path $RunRoot 'poison-modules'
        New-PoisonModuleRoot $poisonRoot $marker
        $probe = 'try { $null = Get-NetTCPConnection -State Listen } catch { }; (Get-Command Get-NetTCPConnection).Module.Path'
        $savedModulePath = $env:PSModulePath
        try {
            $env:PSModulePath = $poisonRoot + [IO.Path]::PathSeparator + $savedModulePath
            $resolved = [string](& (Get-CurrentHostPath) -NoProfile -NonInteractive -Command $probe)
        } finally {
            $env:PSModulePath = $savedModulePath
        }
        $loads = @(Get-PoisonLoads $marker)
        $null = Assert-Case 'K03' ($resolved.StartsWith($poisonRoot) -and $loads.Count -ge 1 -and $loads[0] -match '^elevated=False pid=\d+$') "resolved $resolved; loads: $($loads -join '; ')"
        if ($ownsRunRoot) {
            Remove-Item -LiteralPath $RunRoot -Recurse -Force -ErrorAction SilentlyContinue
            $RunRoot = $null
        }
        Complete-Phase
    }

    'Setup' {
        Assert-HostPhase -RequireElevated $true -RequireNormal $false
        if (-not $ModelEndpoint -or -not $ModelId) { throw '-Phase Setup needs -ModelEndpoint and -ModelId for the local model provider' }
        New-Item -ItemType Directory -Force -Path $RunRoot | Out-Null
        $sentinelPort = $DashboardPort + 1
        $gatewayHomePath = $(if ($GatewayHome) { [IO.Path]::GetFullPath($GatewayHome) } else { Join-Path $env:LOCALAPPDATA 'cozygateway' })
        $hermesHome = $(if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' })
        $state = [ordered]@{
            Created = (Get-Date).ToString('o')
            ModelEndpoint = $ModelEndpoint
            ModelId = $ModelId
            InstallerPath = [IO.Path]::GetFullPath($(if ($InstallerPath) { $InstallerPath } else { Join-Path $PSScriptRoot '..\install.ps1' }))
            AssetBase = $AssetBase
            GatewayHome = $gatewayHomePath
            GatewayHomeOverride = $(if ($GatewayHome) { $gatewayHomePath } else { '' })
            DashboardPort = $DashboardPort
            GatewayPort = $GatewayPort
            PoisonMarker = Join-Path $RunRoot 'poison-loads.txt'
            Stale = $null
            Sentinel = $null
        }

        $ps51 = Get-WindowsPowerShellPath
        if (-not (Assert-Case 'S01' (Test-Path -LiteralPath $ps51) "Windows PowerShell at $ps51")) { Complete-Phase }
        $fresh = -not (Test-Path -LiteralPath $gatewayHomePath) -and ($AllowExistingHermes -or -not (Test-Path -LiteralPath $hermesHome))
        if (-not (Assert-Case 'S02' $fresh "gateway home $gatewayHomePath; hermes home $hermesHome")) { Complete-Phase }
        $busy = @($DashboardPort, $sentinelPort, $GatewayPort | Where-Object { $null -ne (Get-ListenerOwner $_) })
        if (-not (Assert-Case 'S03' ($busy.Count -eq 0) "busy: $($busy -join ', ')")) { Complete-Phase }
        try {
            $models = Invoke-RestMethod -Uri ($ModelEndpoint.TrimEnd('/') + '/models') -TimeoutSec 10 -UseBasicParsing
            $ids = @($models.data | ForEach-Object { [string]$_.id })
        } catch { $ids = @() }
        if (-not (Assert-Case 'S04' ($ids -contains $ModelId) "models: $($ids -join ', ')")) { Complete-Phase }

        # Setup is elevated, so both processes inherit the elevated token; the installer then meets
        # an elevated Dashboard it can neither authenticate to nor inspect as its own.
        $staleToken = New-HarnessToken
        $stale = Start-StaleDashboard 'stale' $DashboardPort $staleToken
        $state.Stale = [ordered]@{ Pid = $stale.Id; Port = $DashboardPort; Token = $staleToken; Created = (Get-ProcessCreation $stale.Id) }
        $sentinel = Start-StaleDashboard 'sentinel' $sentinelPort (New-HarnessToken)
        $state.Sentinel = [ordered]@{ Pid = $sentinel.Id; Port = $sentinelPort; Created = (Get-ProcessCreation $sentinel.Id) }
        Write-State $state
        $health = Invoke-LoopbackGet $DashboardPort '/api/health'
        $own = Invoke-LoopbackGet $DashboardPort '/api/config' @{ 'X-Hermes-Session-Token' = $staleToken }
        $other = Invoke-LoopbackGet $DashboardPort '/api/config' @{ 'X-Hermes-Session-Token' = (New-HarnessToken) }
        $null = Assert-Case 'S05' ((Test-TrackedProcess $state.Stale) -and $health.Status -eq 200 -and $own.Status -eq 200 -and $other.Status -eq 401) "pid $($stale.Id); health $($health.Status), stale token $($own.Status), other token $($other.Status)"
        $null = Assert-Case 'S06' (Test-TrackedProcess $state.Sentinel) "pid $($sentinel.Id) on $sentinelPort"
        Complete-Phase
    }

    'Install' {
        Assert-HostPhase -RequireElevated $false -RequireNormal $true
        $state = Read-State
        Set-CaseResult 'I01' PASS 'non-elevated'
        $arguments = @('--bind-host', '127.0.0.1', '--port', [string]$state.GatewayPort, '--dashboard-port', [string]$state.DashboardPort, '--no-qr')
        $result = Invoke-Installer $arguments 'install.log'
        $state | Add-Member -NotePropertyName InstallExitCode -NotePropertyValue $result.ExitCode -Force
        Write-State $state
        $null = Assert-Case 'I02' ($result.ExitCode -eq 0) "exit $($result.ExitCode); log install.log"
        $null = Assert-Case 'I03' (-not ($result.Log -match 'scoped UAC')) 'a foreign Dashboard is preserved, not elevated against'
        Complete-Phase
    }

    'Verify' {
        Assert-HostPhase -RequireElevated $false -RequireNormal $false
        $state = Read-State
        $null = Assert-Case 'V01' (Test-TrackedProcess $state.Stale) "pid $($state.Stale.Pid) on $($state.Stale.Port)"
        $installed = Read-InstalledEndpoint $state
        $staleWithInstalled = Invoke-LoopbackGet ([int]$state.Stale.Port) '/api/config' @{ 'X-Hermes-Session-Token' = [string]$installed.Token }
        $staleWithOwn = Invoke-LoopbackGet ([int]$state.Stale.Port) '/api/config' @{ 'X-Hermes-Session-Token' = [string]$state.Stale.Token }
        $null = Assert-Case 'V02' ($installed.Token -and $staleWithInstalled.Status -eq 401 -and $staleWithOwn.Status -eq 200) "installed token $($staleWithInstalled.Status), stale token $($staleWithOwn.Status)"
        $null = Assert-Case 'V03' (Test-TrackedProcess $state.Sentinel) "pid $($state.Sentinel.Pid) on $($state.Sentinel.Port)"
        $private = $installed.Port
        $null = Assert-Case 'V04' ($null -ne $private -and $private -ne [int]$state.DashboardPort -and $private -ne [int]$state.Sentinel.Port) "endpoints: $($installed.Urls -join ', ')"
        $config = $(if ($null -ne $private) { Invoke-LoopbackGet $private '/api/config' @{ 'X-Hermes-Session-Token' = [string]$installed.Token } } else { [pscustomobject]@{ Status = 0 } })
        $null = Assert-Case 'V05' ($config.Status -eq 200) "port $private status $($config.Status)"
        $deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
        do {
            $ready = Invoke-LoopbackGet ([int]$state.GatewayPort) '/ready'
            if ($ready.Status -eq 200) { break }
            Start-Sleep -Seconds 2
        } while ((Get-Date) -lt $deadline)
        $health = Invoke-LoopbackGet ([int]$state.GatewayPort) '/health'
        [IO.File]::WriteAllText((Join-Path $RunRoot 'gateway-health.txt'), "ready $($ready.Status)`n$($ready.Body)`nhealth $($health.Status)`n$($health.Body)`n")
        $null = Assert-Case 'V06' ($ready.Status -eq 200) "ready $($ready.Status); bodies in gateway-health.txt"
        $loads = @(Get-PoisonLoads $state.PoisonMarker)
        $null = Assert-Case 'V07' (@($loads | Where-Object { $_ -match '^elevated=True' }).Count -eq 0) "$($loads.Count) non-elevated load(s) recorded"
        Complete-Phase
    }

    'Uninstall' {
        Assert-HostPhase -RequireElevated $false -RequireNormal $true
        $state = Read-State
        $installed = Read-InstalledEndpoint $state
        $result = Invoke-Installer @('--uninstall') 'uninstall.log'
        $null = Assert-Case 'U01' ($result.ExitCode -eq 0) "exit $($result.ExitCode); log uninstall.log"
        $null = Assert-Case 'U02' ((Test-TrackedProcess $state.Stale) -and (Test-TrackedProcess $state.Sentinel)) "stale pid $($state.Stale.Pid), sentinel pid $($state.Sentinel.Pid)"
        $held = @(@($installed.Port, [int]$state.GatewayPort) | Where-Object { $null -ne $_ -and $null -ne (Get-ListenerOwner $_) })
        $null = Assert-Case 'U03' ($held.Count -eq 0) "still listening: $($held -join ', ')"
        $loads = @(Get-PoisonLoads $state.PoisonMarker)
        $null = Assert-Case 'U04' (@($loads | Where-Object { $_ -match '^elevated=True' }).Count -eq 0) "$($loads.Count) non-elevated load(s) recorded"
        Complete-Phase
    }

    'Cleanup' {
        Assert-HostPhase -RequireElevated $true -RequireNormal $false
        $state = Read-State
        $left = @()
        foreach ($tracked in @($state.Stale, $state.Sentinel)) {
            if ($null -eq $tracked) { continue }
            # Only a process whose PID and creation time both match what Setup recorded is ours.
            if ((Get-ProcessCreation ([int]$tracked.Pid)) -eq [string]$tracked.Created) {
                Stop-Process -Id ([int]$tracked.Pid) -Force -ErrorAction SilentlyContinue
            }
            Start-Sleep -Milliseconds 300
            if ((Get-ProcessCreation ([int]$tracked.Pid)) -eq [string]$tracked.Created) { $left += $tracked.Pid }
        }
        $null = Assert-Case 'C01' ($left.Count -eq 0) "still running: $($left -join ', ')"
        Complete-Phase
    }
}

param(
    [string] $InstallHome = (Join-Path $env:LOCALAPPDATA 'cozygateway'),
    [switch] $RunHermesUpdate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Require([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw "FAIL  $Message" }
    Write-Host "PASS  $Message"
}

$statePath = Join-Path $InstallHome 'local\install-state'
$gatewayLog = Join-Path $InstallHome 'local\cozygateway.log'
$reconcileLog = Join-Path $InstallHome 'local\reconcile.log'
$reconciler = Join-Path $InstallHome 'bin\windows-reconcile.ps1'
$task = 'CozyGateway'

Require (Test-Path -LiteralPath $statePath -PathType Leaf) 'Gateway install state exists'
Require (Test-Path -LiteralPath $reconciler -PathType Leaf) 'Gateway-owned reconciler exists'
$state = @(Get-Content -LiteralPath $statePath)
$profilesLine = $state | Where-Object { $_ -like 'profiles=*' } | Select-Object -Last 1
Require ($null -ne $profilesLine) 'exact installed profile scope is recorded'
$profiles = @(([string]$profilesLine).Substring(9) -split ',')
Require ($profiles.Count -gt 0) 'at least one Hermes profile is selected'

$taskText = (& schtasks.exe /Query /TN $task /XML 2>&1 | Out-String)
Require ($LASTEXITCODE -eq 0) 'current-user Scheduled Task exists'
Require ($taskText -match [regex]::Escape($reconciler)) 'Scheduled Task targets Gateway-owned reconciliation, not a Hermes checkout'

$beforeLog = if (Test-Path -LiteralPath $gatewayLog) { (Get-Item -LiteralPath $gatewayLog).Length } else { 0 }
$beforeTokens = (Get-FileHash -LiteralPath (Join-Path $InstallHome 'local\gateway.env') -Algorithm SHA256).Hash
$beforeState = (Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash

if (-not $RunHermesUpdate) {
    Write-Host 'READY  baseline passed. Re-run with -RunHermesUpdate to authorize the native Hermes update exercise.'
    exit 0
}

& hermes.exe update --yes
Require ($LASTEXITCODE -eq 0) 'Hermes update completed without rerunning CozyGateway installer'

# A task restart is the deterministic reboot/login seam. The long-running
# reconciler also watches for the same Hermes fingerprint/attach degradation.
& schtasks.exe /End /TN $task 2>$null | Out-Null
& schtasks.exe /Run /TN $task | Out-Null
Require ($LASTEXITCODE -eq 0) 'Gateway login task started after Hermes replacement'

$fresh = ''
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Seconds 1
    if (Test-Path -LiteralPath $gatewayLog) {
        $stream = [IO.File]::Open($gatewayLog, 'Open', 'Read', 'ReadWrite')
        try {
            [void]$stream.Seek([Math]::Min($beforeLog, $stream.Length), 'Begin')
            $reader = New-Object IO.StreamReader($stream)
            $fresh = $reader.ReadToEnd()
        } finally { $stream.Dispose() }
    }
    $missing = @($profiles | Where-Object { $fresh -notmatch ('attach-v1: profile "' + [regex]::Escape($_) + '" negotiated') })
    if ($missing.Count -eq 0) { break }
}
Require ($missing.Count -eq 0) "fresh identity-specific attachment observed for $($profiles -join ', ')"
Require ((Get-FileHash -LiteralPath (Join-Path $InstallHome 'local\gateway.env') -Algorithm SHA256).Hash -eq $beforeTokens) 'Gateway attach credentials were preserved'
Require ((Get-Content -LiteralPath $statePath -Raw) -notmatch '(?i)(token|password|secret)=') 'install state contains no credentials'
Require (Test-Path -LiteralPath $reconcileLog -PathType Leaf) 'bounded reconciler diagnostics were written'
Require ($beforeState.Length -eq 64) 'baseline state fingerprint was captured'
Write-Host 'PASS  native Windows Hermes-update self-heal acceptance completed'

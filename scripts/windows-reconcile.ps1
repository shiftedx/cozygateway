param(
    [Parameter(Mandatory = $true)]
    [string] $InstallHome,
    [switch] $Once,
    [switch] $NoLaunch,
    [switch] $SkipAttachProof
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$ProgressPreference = 'SilentlyContinue'
$script:LogPath = Join-Path $InstallHome 'local\reconcile.log'

function Write-Diagnostic {
    param([string] $Level, [string] $Message)
    $safe = $Message -replace '(?i)(token|password|secret|authorization)\s*[=:]\s*\S+', '$1=<REDACTED>'
    $line = '{0:o} {1} {2}' -f [DateTime]::UtcNow, $Level, $safe
    Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
}

function Fail { param([string] $Message) Write-Diagnostic 'FAIL' $Message; throw $Message }

function Read-StateValue {
    param([string[]] $Lines, [string] $Name)
    $line = $Lines | Where-Object { $_ -like "$Name=*" } | Select-Object -Last 1
    if ($null -eq $line) { return '' }
    return ([string]$line).Substring($Name.Length + 1)
}

function Assert-RegularOwnedPath {
    param([string] $Path, [switch] $Directory)
    if (-not (Test-Path -LiteralPath $Path)) { Fail "required Gateway-owned path is absent: $Path" }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail "refusing reparse-point Gateway path: $Path" }
    if ($Directory -and -not $item.PSIsContainer) { Fail "expected a Gateway directory: $Path" }
    if (-not $Directory -and $item.PSIsContainer) { Fail "expected a Gateway file: $Path" }
}

function Assert-VerifiedAsset {
    param([string] $Path)
    Assert-RegularOwnedPath $Path
    $sidecar = "$Path.sha256"
    Assert-RegularOwnedPath $sidecar
    $expected = ((Get-Content -LiteralPath $sidecar -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$' -or $actual -ne $expected) { Fail "cached asset checksum mismatch: $([IO.Path]::GetFileName($Path))" }
}

function Resolve-GitBash {
    param([string] $HermesRoot)
    $candidates = @(
        $env:COZYGATEWAY_GIT_BASH,
        [Environment]::GetEnvironmentVariable('HERMES_GIT_BASH_PATH', 'User'),
        (Join-Path $HermesRoot 'git\bin\bash.exe'),
        (Join-Path $HermesRoot 'git\usr\bin\bash.exe')
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) }
    }
    Fail 'Git Bash is unavailable after the Hermes update'
}

function Resolve-HermesLauncher {
    param([string] $HermesRoot, [string] $Recorded)
    foreach ($candidate in @((Join-Path $HermesRoot 'bin\hermes.exe'), (Join-Path $HermesRoot 'bin\hermes.cmd'), $Recorded)) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    Fail 'the stable Hermes launcher is unavailable after the update'
}

function Get-Fingerprint {
    param([string] $Hermes, [string] $HermesRoot, [string[]] $Profiles)
    $paths = @($Hermes)
    foreach ($profile in $Profiles) {
        $home = if ($profile -eq 'default') { $HermesRoot } else { Join-Path $HermesRoot "profiles\$profile" }
        $paths += Join-Path $home 'config.yaml'
        $paths += Join-Path $home 'plugins\cozygateway\.cozygateway-installer-owned'
    }
    return (($paths | ForEach-Object {
        if (Test-Path -LiteralPath $_) { $item = Get-Item -LiteralPath $_ -Force; "$($_)|$($item.Length)|$($item.LastWriteTimeUtc.Ticks)" } else { "$_|absent" }
    }) -join "`n")
}

function Invoke-Reconcile {
    param([string] $Bash, [string] $Hermes, [string[]] $Profiles, [long] $LogStart)
    $bin = Join-Path $InstallHome 'bin'
    $installer = Join-Path $bin 'agent-install.sh'
    $bundle = Join-Path $bin 'cozygateway.mjs'
    $plugin = Join-Path $bin 'cozygateway-hermes-attach-plugin.tar.gz'
    foreach ($asset in @($installer, $bundle, $plugin)) { Assert-VerifiedAsset $asset }
    $profileSpec = $Profiles -join ','
    $previousHermes = [Environment]::GetEnvironmentVariable('COZYGATEWAY_HERMES_BIN', 'Process')
    $previousPlatform = [Environment]::GetEnvironmentVariable('COZYGATEWAY_SERVICE_PLATFORM', 'Process')
    try {
        $env:COZYGATEWAY_HERMES_BIN = $Hermes
        $env:COZYGATEWAY_SERVICE_PLATFORM = 'Windows'
        $output = (& $Bash $installer --reconcile-only --service-platform Windows --gateway-dir $InstallHome --bundle $bundle --plugin-archive $plugin --profiles $profileSpec 2>&1 | Out-String)
        $code = $LASTEXITCODE
    } finally {
        [Environment]::SetEnvironmentVariable('COZYGATEWAY_HERMES_BIN', $previousHermes, 'Process')
        [Environment]::SetEnvironmentVariable('COZYGATEWAY_SERVICE_PLATFORM', $previousPlatform, 'Process')
    }
    foreach ($line in @($output -split "`r?`n" | Where-Object { $_ })) { Write-Diagnostic 'INFO' $line }
    if ($code -ne 0) { throw "profile reconciliation exited $code" }
    $affected = @([regex]::Matches($output, '(?m)^RECONCILE_AFFECTED ([A-Za-z0-9._-]+)$') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
    if (-not $SkipAttachProof -and $affected.Count -gt 0) {
        $gatewayLog = Join-Path $InstallHome 'local\cozygateway.log'
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            $fresh = if (Test-Path -LiteralPath $gatewayLog) {
                $stream = [IO.File]::Open($gatewayLog, 'Open', 'Read', 'ReadWrite')
                try { [void]$stream.Seek([Math]::Min($LogStart, $stream.Length), 'Begin'); $reader = New-Object IO.StreamReader($stream); $reader.ReadToEnd() } finally { $stream.Dispose() }
            } else { '' }
            $missing = @($affected | Where-Object { $fresh -notmatch ('attach-v1: profile "' + [regex]::Escape($_) + '" negotiated') })
            if ($missing.Count -eq 0) { return }
            Start-Sleep -Seconds 1
        }
        throw "fresh identity-specific attachment was not observed for: $($affected -join ',')"
    }
}

$fullHome = [IO.Path]::GetFullPath($InstallHome).TrimEnd('\')
New-Item -ItemType Directory -Force -Path (Join-Path $fullHome 'local') | Out-Null
Assert-RegularOwnedPath $fullHome -Directory
Assert-RegularOwnedPath (Join-Path $fullHome 'bin') -Directory
Assert-RegularOwnedPath (Join-Path $fullHome 'local') -Directory
$lockPath = Join-Path $fullHome 'local\reconcile.lock'
try { $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') } catch { Write-Diagnostic 'INFO' 'another reconciler owns this installation; leaving it to finish'; exit 0 }
try {
    $statePath = Join-Path $fullHome 'local\install-state'
    Assert-RegularOwnedPath $statePath
    $state = @(Get-Content -LiteralPath $statePath)
    if ((Read-StateValue $state 'harness') -ne 'hermes') { exit 0 }
    $profilesRaw = Read-StateValue $state 'profiles'
    if ($profilesRaw -notmatch '^(?:default|[A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:,(?:default|[A-Za-z0-9][A-Za-z0-9._-]{0,63}))*$') { Fail 'recorded profile scope is invalid' }
    $profiles = @($profilesRaw -split ',')
    $hermesRoot = if ($env:OS -eq 'Windows_NT') { Read-StateValue $state 'hermes_root_native' } else { Read-StateValue $state 'hermes_root' }
    if ([string]::IsNullOrWhiteSpace($hermesRoot)) { $hermesRoot = Read-StateValue $state 'hermes_root' }
    if ([string]::IsNullOrWhiteSpace($hermesRoot)) { Fail 'recorded Hermes root is absent' }
    $recordedHermes = if ($env:OS -eq 'Windows_NT') { Read-StateValue $state 'hermes_bin_native' } else { Read-StateValue $state 'hermes_bin' }
    if ([string]::IsNullOrWhiteSpace($recordedHermes)) { $recordedHermes = Read-StateValue $state 'hermes_bin' }
    $hermes = Resolve-HermesLauncher $hermesRoot $recordedHermes
    $bash = Resolve-GitBash $hermesRoot
    $gatewayLog = Join-Path $fullHome 'local\cozygateway.log'
    $logStart = if (Test-Path -LiteralPath $gatewayLog) { (Get-Item -LiteralPath $gatewayLog).Length } else { 0 }
    $lastError = ''
    foreach ($delay in @(0, 1, 2, 4, 8)) {
        if ($delay -gt 0) { Start-Sleep -Seconds $delay }
        try { Invoke-Reconcile $bash $hermes $profiles $logStart; $lastError = ''; break } catch { $lastError = $_.Exception.Message; Write-Diagnostic 'WARN' $lastError }
    }
    if ($lastError) { Fail "reconciliation exhausted bounded retries: $lastError" }
    if (-not $NoLaunch) {
        $wrapper = Join-Path $fullHome 'local\run-gateway.sh'
        Assert-RegularOwnedPath $wrapper
        $child = Start-Process -FilePath $bash -ArgumentList @($wrapper) -WindowStyle Hidden -PassThru
        Write-Diagnostic 'OK' "started Gateway supervisor pid=$($child.Id) after profile reconciliation"
    }
    if ($Once) { exit 0 }
    $fingerprint = Get-Fingerprint $hermes $hermesRoot $profiles
    while ($true) {
        Start-Sleep -Seconds 30
        $next = Get-Fingerprint $hermes $hermesRoot $profiles
        $degraded = $false
        try {
            $health = Invoke-RestMethod -UseBasicParsing -TimeoutSec 3 -Uri 'http://127.0.0.1:8787/health'
            $degraded = $health.attach.configured -gt 0 -and ($health.attach.online -ne $health.attach.configured -or $health.attach.deadLetters -ne 0)
        } catch { $degraded = $true }
        if ($next -ne $fingerprint -or $degraded) {
            $logStart = if (Test-Path -LiteralPath $gatewayLog) { (Get-Item -LiteralPath $gatewayLog).Length } else { 0 }
            try { Invoke-Reconcile $bash $hermes $profiles $logStart; $fingerprint = Get-Fingerprint $hermes $hermesRoot $profiles } catch { Write-Diagnostic 'WARN' $_.Exception.Message }
        }
        if ($null -ne $child -and $child.HasExited) {
            $child = Start-Process -FilePath $bash -ArgumentList @((Join-Path $fullHome 'local\run-gateway.sh')) -WindowStyle Hidden -PassThru
            Write-Diagnostic 'WARN' "Gateway supervisor exited; restarted pid=$($child.Id)"
        }
    }
} finally {
    if ($null -ne $lock) { $lock.Dispose() }
}

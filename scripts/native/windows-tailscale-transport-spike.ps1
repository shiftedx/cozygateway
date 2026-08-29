[CmdletBinding()]
param(
    [string] $TailscalePath = 'tailscale.exe',
    [string] $NodePath = 'node.exe',
    [string] $ProbeScript = (Join-Path $PSScriptRoot 'tailscale-transport-probe.mjs'),
    [ValidateRange(1, 65535)] [int] $ProbePort = 18787,
    [ValidateRange(1, 3600)] [int] $SoakSeconds = 10,
    [switch] $Apply,
    [switch] $PersonalTailnet,
    [string] $Confirm = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$confirmationText = 'APPLY COZYGATEWAY TAILSCALE SPIKE'

function Invoke-TailscaleJson {
    param([string[]] $Arguments)
    $output = @(& $TailscalePath @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Tailscale failed: $($Arguments -join ' ')" }
    $text = ($output | ForEach-Object { [string] $_ }) -join "`n"
    if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 262144) { throw 'Tailscale JSON exceeded 256 KiB' }
    try { return $text | ConvertFrom-Json } catch { throw "Tailscale returned invalid JSON for: $($Arguments -join ' ')" }
}

function Invoke-Tailscale {
    param([string[]] $Arguments)
    & $TailscalePath @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Tailscale failed: $($Arguments -join ' ')" }
}

function Get-Property {
    param($Object, [string] $Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties | Where-Object { $_.Name -ieq $Name } | Select-Object -First 1
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Test-HasPort443 {
    param($Value)
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [ValueType]) { return $false }
    if ($Value -is [Collections.IEnumerable] -and -not ($Value -is [pscustomobject])) {
        foreach ($item in $Value) { if (Test-HasPort443 $item) { return $true } }
        return $false
    }
    foreach ($property in $Value.PSObject.Properties) {
        if ($property.Name -match '(^|:)443$') { return $true }
        if (Test-HasPort443 $property.Value) { return $true }
    }
    return $false
}

function Get-Tcp443 {
    param($ServeState)
    $tcp = Get-Property $ServeState 'TCP'
    return Get-Property $tcp '443'
}

function Test-ExactMapping {
    param($ServeState, [string] $Target, [string] $Domain)
    $mapping = Get-Tcp443 $ServeState
    if ($null -eq $mapping) { return $false }
    $names = @($mapping.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names.Count -ne 2 -or -not ($names -icontains 'TCPForward') -or -not ($names -icontains 'TerminateTLS')) {
        return $false
    }
    return ([string](Get-Property $mapping 'TCPForward') -ceq $Target) -and
        ([string](Get-Property $mapping 'TerminateTLS') -ceq $Domain)
}

function Get-CertDomain {
    param($Status)
    if ([string](Get-Property $Status 'BackendState') -cne 'Running') {
        throw 'Tailscale is not authenticated and running'
    }
    $self = Get-Property $Status 'Self'
    $online = Get-Property $self 'Online'
    if ($null -eq $self -or $online -isnot [bool] -or $online -ne $true) {
        throw 'Tailscale Self is not online'
    }
    $tailnet = Get-Property $Status 'CurrentTailnet'
    if ([string]::IsNullOrWhiteSpace([string](Get-Property $tailnet 'Name'))) {
        throw 'Tailscale did not report an authenticated tailnet'
    }
    $dnsName = ([string](Get-Property $self 'DNSName')).TrimEnd('.')
    if ($dnsName -cne $dnsName.ToLowerInvariant() -or $dnsName.Length -gt 253 -or
        $dnsName -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.ts\.net$') {
        throw 'Tailscale reported an invalid lowercase ASCII .ts.net DNS name'
    }
    $domains = @(Get-Property $Status 'CertDomains')
    if (-not ($domains -ccontains $dnsName)) {
        throw 'The current Tailscale DNS name is not present in CertDomains'
    }
    return $dnsName
}

function Read-FullState {
    return @{
        Status = Invoke-TailscaleJson @('status', '--json')
        Serve = Invoke-TailscaleJson @('serve', 'status', '--json')
        Funnel = Invoke-TailscaleJson @('funnel', 'status', '--json')
    }
}

function Start-LoopbackProbe {
    param([string] $StdoutPath, [string] $StderrPath)
    $quotedProbe = '"' + $ProbeScript.Replace('"', '\"') + '"'
    $process = $null
    try {
        $process = Start-Process -FilePath $NodePath `
            -ArgumentList @($quotedProbe, 'serve', '--port', [string]$ProbePort) `
            -PassThru -NoNewWindow `
            -RedirectStandardOutput $StdoutPath `
            -RedirectStandardError $StderrPath
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($process.HasExited) {
                $detail = if (Test-Path -LiteralPath $StderrPath) { Get-Content -LiteralPath $StderrPath -Raw } else { '' }
                throw "Loopback probe exited before readiness: $detail"
            }
            if (Test-Path -LiteralPath $StdoutPath) {
                $ready = Get-Content -LiteralPath $StdoutPath -Raw
                if ($ready -match '"ready"\s*:\s*true') { return $process }
            }
            Start-Sleep -Milliseconds 50
        }
        throw 'Loopback probe readiness timed out after 5000ms'
    } catch {
        if ($null -ne $process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            $process.WaitForExit()
        }
        throw
    }
}

function Invoke-ExternalProbe {
    param([string] $Domain)
    & $NodePath $ProbeScript verify `
        --origin "https://$Domain" `
        --expected-host $Domain `
        --timeout-ms 5000 `
        --soak-seconds $SoakSeconds | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'TLS/health/WSS transport verification failed' }
}

function Invoke-Spike {
    $initial = Read-FullState
    $domain = Get-CertDomain $initial.Status
    $target = "127.0.0.1:$ProbePort"
    $funnel443 = Test-HasPort443 $initial.Funnel
    $serve443 = Test-HasPort443 $initial.Serve
    $compatible = Test-ExactMapping $initial.Serve $target $domain

    if ($funnel443) { throw 'Funnel occupies port 443; refusing to continue' }
    if ($serve443 -and -not $compatible) { throw 'Serve port 443 is occupied or conflicting; refusing to continue' }

    if (-not $Apply) {
        Write-Host "Inspection only: authenticated tailnet and $domain are valid; no state was changed."
        if ($compatible) { Write-Host "An exact compatible port 443 mapping already exists for $target." }
        else { Write-Host "Port 443 is available for the disposable transport spike." }
        return
    }
    if (-not $PersonalTailnet) { throw '-Apply requires -PersonalTailnet to attest this is a user-owned personal tailnet' }
    if ($Confirm -cne $confirmationText) { throw "-Apply requires -Confirm '$confirmationText'" }

    $temp = Join-Path ([IO.Path]::GetTempPath()) ("cozygateway-tailscale-probe-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temp | Out-Null
    $stdout = Join-Path $temp 'probe.stdout.log'
    $stderr = Join-Path $temp 'probe.stderr.log'
    $probeProcess = $null
    $mappingCreated = $false
    $cleanupError = $null
    try {
        $probeProcess = Start-LoopbackProbe $stdout $stderr
        $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ProbePort/health" -TimeoutSec 5
        if ($health.StatusCode -ne 200) { throw 'Disposable loopback health probe failed' }

        if (-not $compatible) {
            Invoke-Tailscale @('serve', '--bg', '--tls-terminated-tcp=443', "tcp://$target")
            $mappingCreated = $true
        }

        $after = Read-FullState
        if (Test-HasPort443 $after.Funnel) { throw 'Funnel appeared on port 443 after mutation' }
        if (-not (Test-ExactMapping $after.Serve $target $domain)) {
            throw 'Complete Serve state does not contain the exact TLS-terminated TCP mapping'
        }
        Invoke-ExternalProbe $domain
        Write-Host "Transport spike passed for https://$domain (trusted SAN, non-h2 ALPN, bounded health, bidirectional WSS)."
    } finally {
        if ($mappingCreated) {
            try {
                $cleanup = Read-FullState
                if (-not (Test-HasPort443 $cleanup.Funnel) -and (Test-ExactMapping $cleanup.Serve $target $domain)) {
                    Invoke-Tailscale @('serve', '--tls-terminated-tcp=443', 'off')
                    Write-Host 'Removed the exact spike-owned port 443 mapping.'
                } else {
                    Write-Warning 'Port 443 changed after creation; preserving the current mapping instead of removing it.'
                }
            } catch {
                $cleanupError = $_.Exception
            }
        }
        if ($null -ne $probeProcess -and -not $probeProcess.HasExited) {
            Stop-Process -Id $probeProcess.Id -Force -ErrorAction SilentlyContinue
            $probeProcess.WaitForExit()
        }
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
        if ($null -ne $cleanupError) {
            throw "Could not complete exact cleanup safely; live state was preserved. $($cleanupError.Message)"
        }
    }
}

try {
    Invoke-Spike
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}

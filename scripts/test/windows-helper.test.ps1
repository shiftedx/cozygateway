$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw "ASSERT: $Message" } }
function Write-Utf8NoBom { param([string]$Path, [string]$Content) [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false))) }

function Invoke-Helper {
    param([string]$Command, [Alias('Input')]$RequestBody = @{}, $Fixture = @{}, [string]$RawRequest)
    $fixturePath = Join-Path $script:Temp ("fixture-" + [guid]::NewGuid().ToString('N') + '.json')
    Write-Utf8NoBom $fixturePath (ConvertTo-Json -InputObject $Fixture -Depth 20 -Compress)
    $oldFixture = $env:COZYGATEWAY_WINDOWS_HELPER_TEST_FIXTURE
    $env:COZYGATEWAY_WINDOWS_HELPER_TEST_FIXTURE = $fixturePath
    try {
        $json = if ($PSBoundParameters.ContainsKey('RawRequest')) { $RawRequest } else { ConvertTo-Json -InputObject $RequestBody -Depth 10 -Compress }
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        $stdout = Join-Path $script:Temp ("stdout-" + [guid]::NewGuid().ToString('N'))
        $stderr = Join-Path $script:Temp ("stderr-" + [guid]::NewGuid().ToString('N'))
        $process = New-Object Diagnostics.Process
        $process.StartInfo.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        $process.StartInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script:Harness`" $Command"
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.RedirectStandardInput = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        $process.StartInfo.CreateNoWindow = $true
        [void]$process.Start()
        $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(10000)) {
            $process.Kill()
            throw "helper command timed out: $Command"
        }
        $out = $process.StandardOutput.ReadToEnd()
        $err = $process.StandardError.ReadToEnd()
        $trimmed = $out.Trim()
        $parsed = $null
        try { $parsed = $trimmed | ConvertFrom-Json } catch { throw "helper emitted invalid JSON: $trimmed / $err" }
        Assert-True ([Text.Encoding]::UTF8.GetByteCount($out) -le 65536) 'helper output exceeded 64 KiB'
        Assert-True (($trimmed -split "`n").Count -eq 1) 'helper must emit exactly one JSON object'
        Assert-True ([string]::IsNullOrWhiteSpace($err)) "helper leaked stderr: $err"
        return @{ ExitCode = $process.ExitCode; Raw = $trimmed; Json = $parsed; Request = $json }
    } finally {
        $env:COZYGATEWAY_WINDOWS_HELPER_TEST_FIXTURE = $oldFixture
        Remove-Item -LiteralPath $fixturePath -Force -ErrorAction SilentlyContinue
    }
}

function Assert-Reason { param($Result, [string]$Reason) Assert-True (-not $Result.Json.ok) "expected failure $Reason"; Assert-True ($Result.Json.reason -eq $Reason) "expected $Reason, got $($Result.Raw)" }
function Assert-Paused { param($Result, [string]$Reason) Assert-True ($Result.Json.ok -and $Result.Json.result.state -eq 'paused') "expected paused $Reason"; Assert-True ($Result.Json.result.reason -eq $Reason) "expected $Reason, got $($Result.Raw)" }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:Helper = Join-Path $repoRoot 'scripts\cozygateway-windows-helper.ps1'
$script:Temp = Join-Path ([IO.Path]::GetTempPath()) ("cozygateway-windows-helper-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $script:Temp | Out-Null
$script:Harness = Join-Path $script:Temp 'fixture-harness.ps1'
$quotedHelper = $script:Helper.Replace("'", "''")
Write-Utf8NoBom $script:Harness @"
param([string]`$Command)
`$requestedCommand = `$Command
. '$quotedHelper'
`$fixturePath = [Environment]::GetEnvironmentVariable('COZYGATEWAY_WINDOWS_HELPER_TEST_FIXTURE', 'Process')
`$fixture = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText(`$fixturePath))
`$code = Invoke-WindowsHelperMain `$requestedCommand `$fixture
exit `$code
"@

try {
    Assert-True (Test-Path -LiteralPath $script:Helper) 'missing scripts/cozygateway-windows-helper.ps1'
    $programFiles = Join-Path $script:Temp 'Program Files'
    $tailscaleDir = Join-Path $programFiles 'Tailscale'
    New-Item -ItemType Directory -Force -Path $tailscaleDir | Out-Null
    $daemon = Join-Path $tailscaleDir 'tailscaled.exe'
    $cli = Join-Path $tailscaleDir 'tailscale.exe'
    $legacy = Join-Path $tailscaleDir 'tailscale-ipn.exe'
    $events = Join-Path $script:Temp 'events.jsonl'
    Write-Utf8NoBom $daemon 'daemon'
    Write-Utf8NoBom $cli 'cli'

    $trusted = @{
        eventLog = $events
        programFiles = $programFiles
        service = @{ exists = $true; imagePath = "`"$daemon`" --cleanup"; startMode = 'Auto'; state = 'Running' }
        signatures = @{
            $daemon = @{ status = 'Valid'; organization = 'Tailscale Inc.' }
            $cli = @{ status = 'Valid'; organization = 'Tailscale Inc.' }
        }
    }
    $discovered = Invoke-Helper -Command 'discover-tailscale' -Input @{} -Fixture $trusted
    Assert-True ($discovered.ExitCode -eq 0 -and $discovered.Json.ok) "trusted discovery failed: request=$($discovered.Request) response=$($discovered.Raw)"
    Assert-True ($discovered.Json.result.cliPath -eq $cli) 'discovery must return fixed Program Files CLI'
    Assert-True ($discovered.Json.result.daemonPath -eq $daemon) 'discovery must correlate service daemon'

    $pathTrap = Join-Path $script:Temp 'PATH trap'
    New-Item -ItemType Directory -Force -Path $pathTrap | Out-Null
    Write-Utf8NoBom (Join-Path $pathTrap 'tailscale.exe') 'trap'
    $oldPath = $env:PATH
    $env:PATH = "$pathTrap;$oldPath"
    try {
        $absent = Invoke-Helper -Command 'discover-tailscale' -Input @{} -Fixture @{ programFiles = (Join-Path $script:Temp 'Empty Program Files'); service = @{ exists = $false } }
        Assert-Paused $absent 'tailscale_not_installed'
    } finally { $env:PATH = $oldPath }

    Remove-Item -LiteralPath $cli -Force
    Write-Utf8NoBom $legacy 'legacy'
    $legacyResult = Invoke-Helper -Command 'discover-tailscale' -Input @{} -Fixture $trusted
    Assert-Paused $legacyResult 'tailscale_legacy_unsupported'
    Remove-Item -LiteralPath $legacy -Force
    Write-Utf8NoBom $cli 'cli'

    $mismatch = @{} + $trusted
    $mismatch.service = @{ exists = $true; imagePath = 'C:\Users\Public\tailscaled.exe'; startMode = 'Auto'; state = 'Running' }
    Assert-Paused (Invoke-Helper -Command 'discover-tailscale' -Input @{} -Fixture $mismatch) 'tailscale_service_mismatch'

    $badSignature = @{} + $trusted
    $badSignature.signatures = @{
        $daemon = @{ status = 'Valid'; organization = 'Someone Else' }
        $cli = @{ status = 'Valid'; organization = 'Tailscale Inc.' }
    }
    Assert-Paused (Invoke-Helper -Command 'discover-tailscale' -Input @{} -Fixture $badSignature) 'tailscale_publisher_invalid'

    $browserFixture = @{ eventLog = $events }
    foreach ($valid in @(
        @{ purpose = 'login'; url = 'https://login.tailscale.com/a/opaque' },
        @{ purpose = 'https-consent'; url = 'https://login.tailscale.com/admin/machines' },
        @{ purpose = 'https-consent'; url = 'https://console.tailscale.com/admin/dns' }
    )) {
        $opened = Invoke-Helper -Command 'open-browser' -Input $valid -Fixture $browserFixture
        Assert-True ($opened.Json.ok) "approved browser URL failed: $($opened.Raw)"
    }
    foreach ($invalid in @(
        @{ purpose = 'login'; url = 'http://login.tailscale.com/a/x' },
        @{ purpose = 'login'; url = 'https://console.tailscale.com/a/x' },
        @{ purpose = 'login'; url = 'https://login.tailscale.com.evil/a/x' },
        @{ purpose = 'login'; url = 'https://user:pass@login.tailscale.com/a/x' },
        @{ purpose = 'login'; url = 'https://login.tailscale.com:444/a/x' },
        @{ purpose = 'login'; url = 'https://login.tailscale.com/a/x#secret' }
    )) { Assert-Reason (Invoke-Helper -Command 'open-browser' -Input $invalid -Fixture $browserFixture) 'browser_url_rejected' }

    $prefFixture = @{} + $trusted
    $prefFixture.eventLog = $events
    $prefFixture.uacExitCode = 0
    $prefFixture.cliGet = @{ unattended = $true; shieldsUp = $false }
    $set = Invoke-Helper -Command 'set-preference' -Input @{ preference = 'unattended'; enabled = $true } -Fixture $prefFixture
    Assert-True ($set.Json.ok) "preference failed: $($set.Raw)"
    $eventText = Get-Content -LiteralPath $events -Raw
    Assert-True ($eventText -match 'set.*--unattended=true') 'preference must use one targeted set flag'
    Assert-True ($eventText -match 'get.*--json.*unattended') 'preference must verify with targeted get --json'
    $shieldFixture = @{} + $trusted
    $shieldFixture.uacExitCode = 0
    $shieldFixture.cliGet = $false
    $shieldOff = Invoke-Helper -Command 'set-preference' -Input @{ preference = 'shields-up'; enabled = $false } -Fixture $shieldFixture
    Assert-True ($shieldOff.Json.ok) 'preference verification must accept the CLI get --json scalar Boolean form'
    $prefCancel = @{} + $prefFixture
    $prefCancel.uacExitCode = 1223
    Assert-Reason (Invoke-Helper -Command 'set-preference' -Input @{ preference = 'unattended'; enabled = $true } -Fixture $prefCancel) 'preference_cancelled'
    Assert-Reason (Invoke-Helper -Command 'set-preference' -Input @{ preference = 'accept-routes'; enabled = $true } -Fixture $prefFixture) 'invalid_request'

    $installer = Join-Path $script:Temp 'downloaded.exe'
    Write-Utf8NoBom $installer 'signed installer fixture'
    $installFixture = @{
        eventLog = $events
        installerSource = $installer
        installerSignature = @{ status = 'Valid'; organization = 'Tailscale Inc.' }
        redirects = @(
            'https://pkgs.tailscale.com/stable/one',
            'https://pkgs.tailscale.com/stable/two',
            'https://pkgs.tailscale.com/stable/three'
        )
        uacExitCode = 0
    }
    $installed = Invoke-Helper -Command 'install-tailscale' -Input @{} -Fixture $installFixture
    Assert-True ($installed.Json.ok) "installer fixture failed: $($installed.Raw)"
    $installEvents = Get-Content -LiteralPath $events -Raw
    Assert-True ($installEvents -match 'tailscale-setup-latest.exe') 'installer must start at the fixed official URL'
    Assert-True ($installEvents -notmatch '(?i)/quiet|/silent|/s\b') 'installer must not invent silent flags'

    $offOrigin = @{} + $installFixture
    $offOrigin.redirects = @('https://evil.example/installer.exe')
    Assert-Reason (Invoke-Helper -Command 'install-tailscale' -Input @{} -Fixture $offOrigin) 'download_redirect_rejected'
    $tooMany = @{} + $installFixture
    $tooMany.redirects = @('https://pkgs.tailscale.com/a','https://pkgs.tailscale.com/b','https://pkgs.tailscale.com/c','https://pkgs.tailscale.com/d')
    Assert-Reason (Invoke-Helper -Command 'install-tailscale' -Input @{} -Fixture $tooMany) 'download_redirect_rejected'
    $large = @{} + $installFixture
    $large.contentLength = 268435457
    Assert-Reason (Invoke-Helper -Command 'install-tailscale' -Input @{} -Fixture $large) 'download_too_large'
    $cancel = @{} + $installFixture
    $cancel.uacExitCode = 1223
    Assert-Reason (Invoke-Helper -Command 'install-tailscale' -Input @{} -Fixture $cancel) 'installer_cancelled'
    $reboot = @{} + $installFixture
    $reboot.uacExitCode = 3010
    Assert-Reason (Invoke-Helper -Command 'install-tailscale' -Input @{} -Fixture $reboot) 'installer_reboot_required'

    $root = Join-Path $script:Temp 'Gateway Root'
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $pending = Invoke-Helper -Command 'initialize-pending' -Input @{ root = $root } -Fixture @{ eventLog = $events; skipAcl = $true }
    Assert-True ($pending.Json.ok) "pending initialization failed: $($pending.Raw)"
    $pendingPath = Join-Path $root 'local\network-onboarding.json'
    $pendingJson = Get-Content -LiteralPath $pendingPath -Raw | ConvertFrom-Json
    Assert-True ($pendingJson.version -eq 1 -and $pendingJson.stage -eq 'pending_choice') 'pending marker schema is wrong'
    Assert-True (((Get-Content -LiteralPath $events -Raw) | Select-String -Pattern 'protect-acl' -AllMatches).Matches.Count -ge 4) 'pending initialization must protect its directory, sibling temp, and final marker'
    Assert-Reason (Invoke-Helper -Command 'initialize-pending' -Input @{ root = '.' } -Fixture @{ skipAcl = $true }) 'path_rejected'
    Assert-Reason (Invoke-Helper -Command 'initialize-pending' -Input @{ root = 'C:relative' } -Fixture @{ skipAcl = $true }) 'path_rejected'
    Assert-Reason (Invoke-Helper -Command 'initialize-pending' -Input @{ root = '\relative' } -Fixture @{ skipAcl = $true }) 'path_rejected'
    $outside = Join-Path $script:Temp 'outside.txt'
    Write-Utf8NoBom $outside 'outside'
    Assert-Reason (Invoke-Helper -Command 'protect-path' -Input @{ root = $root; path = $outside } -Fixture @{ skipAcl = $true }) 'path_rejected'

    $inventory = Invoke-Helper -Command 'adapter-inventory' -Input @{} -Fixture @{ adapters = @(
        @{ id = '{A}'; displayName = 'Ethernet localized'; ndisMedium = 0; physicalMedium = 14; hardwareInterface = $true; operationalStatus = 1; adminStatus = 1; ipv4Addresses = @('192.168.1.20') },
        @{ id = '{B}'; displayName = 'Whatever'; ndisMedium = 16; physicalMedium = 9; hardwareInterface = $true; operationalStatus = 2; adminStatus = 1; ipv4Addresses = @() },
        @{ id = '{C}'; displayName = 'VPN'; ndisMedium = 0; physicalMedium = 0; hardwareInterface = $false; operationalStatus = 1; adminStatus = 1; ipv4Addresses = @('10.0.0.1') }
    ) }
    Assert-True ($inventory.Json.result.schemaVersion -eq 1) 'inventory schema must be fixed'
    Assert-True ($inventory.Json.result.adapters[0].kind -eq 'ethernet' -and $inventory.Json.result.adapters[0].status -eq 'up') 'numeric Ethernet mapping failed'
    Assert-True ($inventory.Json.result.adapters[1].kind -eq 'wifi' -and $inventory.Json.result.adapters[1].status -eq 'down') 'numeric Wi-Fi mapping failed'
    Assert-True ($inventory.Json.result.adapters[2].kind -eq 'other') 'software adapters must stay other'

    Assert-Reason (Invoke-Helper -Command 'adapter-inventory' -Input @{ unexpected = $true } -Fixture @{ adapters = @() }) 'invalid_request'
    Assert-Reason (Invoke-Helper -Command 'set-preference' -RawRequest '{"preference":"unattended","preference":"shields-up","enabled":true}' -Fixture $prefFixture) 'invalid_request'
    Assert-Reason (Invoke-Helper -Command 'set-preference' -RawRequest '{"preference":"unattended","Preference":"shields-up","enabled":true}' -Fixture $prefFixture) 'invalid_request'
    Assert-Reason (Invoke-Helper -Command 'set-preference' -RawRequest '{"preference":"unattended","\u0070reference":"shields-up","enabled":true}' -Fixture $prefFixture) 'invalid_request'
    Assert-Reason (Invoke-Helper -Command 'open-browser' -RawRequest ('{"purpose":"login","url":"' + ('a' * 65536) + '"}') -Fixture $browserFixture) 'request_too_large'
    Assert-Reason (Invoke-Helper -Command 'made-up-command' -Input @{} -Fixture @{}) 'invalid_request'
    Write-Host 'windows helper tests passed'
} finally {
    Remove-Item -LiteralPath $script:Temp -Recurse -Force -ErrorAction SilentlyContinue
}

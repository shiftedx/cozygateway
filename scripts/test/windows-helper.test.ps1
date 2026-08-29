param([string] $PowerShellEngine = '')

$ErrorActionPreference = 'Stop'
$bundledUtility = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'
Import-Module $bundledUtility -Force -ErrorAction Stop
$bundledSecurity = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module $bundledSecurity -Force -ErrorAction Stop

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw "ASSERT: $Message" } }
function Write-Utf8NoBom { param([string]$Path, [string]$Content) [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false))) }

function New-TestJunction {
    param([string]$Path, [string]$Target)
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullTarget = [IO.Path]::GetFullPath($Target)
    foreach ($candidate in @($fullPath, $fullTarget)) {
        if (-not $candidate.StartsWith($script:Temp + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "junction escaped verified temp root: $candidate" }
    }
    New-Item -ItemType Junction -Path $fullPath -Target $fullTarget | Out-Null
    Assert-True (([IO.File]::GetAttributes($fullPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) "test junction was not a reparse point: $fullPath"
    $script:Junctions.Add($fullPath)
    return $fullPath
}

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
        $process.StartInfo.FileName = $script:PowerShellEngine
        $process.StartInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script:Harness`" $Command"
        $engineModules = Join-Path (Split-Path -Parent $script:PowerShellEngine) 'Modules'
        $process.StartInfo.EnvironmentVariables['PSModulePath'] = "$engineModules;$env:PSModulePath"
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

function Assert-PrivateDacl {
    param([string]$Path)
    $acl = Get-Acl -LiteralPath $Path
    Assert-True $acl.AreAccessRulesProtected 'protected path must disable inherited access rules'
    $owner = if ([string]$acl.Owner -match '^S-') { [string]$acl.Owner } else {
        ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value
    }
    Assert-True ($owner -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) 'protected path owner must be the current user'
    $rules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
    $expected = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18') | Sort-Object
    $actual = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object)
    Assert-True (($actual -join ',') -eq ($expected -join ',')) "protected path has unexpected explicit identities: $($actual -join ',')"
    foreach ($rule in $rules) {
        Assert-True (-not $rule.IsInherited) 'protected path rules must be explicit'
        Assert-True ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) 'protected path rules must be allow rules'
        Assert-True (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) 'protected path identities need full control'
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:Helper = Join-Path $repoRoot 'scripts\cozygateway-windows-helper.ps1'
$script:PowerShellEngine = if ([string]::IsNullOrWhiteSpace($PowerShellEngine)) {
    Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
} else {
    (Get-Command $PowerShellEngine -CommandType Application -ErrorAction Stop).Source
}
$script:TempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$script:Temp = Join-Path $script:TempBase ("cozygateway-windows-helper-" + [guid]::NewGuid().ToString('N'))
$script:TempVerified = $false
New-Item -ItemType Directory -Path $script:Temp | Out-Null
$script:Temp = (Resolve-Path -LiteralPath $script:Temp).Path
$tempLeaf = Split-Path -Leaf $script:Temp
if (-not $script:Temp.StartsWith($script:TempBase + '\', [StringComparison]::OrdinalIgnoreCase) -or $tempLeaf -notmatch '^cozygateway-windows-helper-[0-9a-f]{32}$') {
    throw "refusing unverified disposable temp path: $script:Temp"
}
$script:TempVerified = $true
$script:Junctions = New-Object System.Collections.Generic.List[string]
$script:ExternalRoots = New-Object System.Collections.Generic.List[string]
$script:Harness = Join-Path $script:Temp 'fixture-harness.ps1'
$quotedHelper = $script:Helper.Replace("'", "''")
Write-Utf8NoBom $script:Harness @"
param([string]`$Command)
`$requestedCommand = `$Command
. '$quotedHelper'
`$fixturePath = [Environment]::GetEnvironmentVariable('COZYGATEWAY_WINDOWS_HELPER_TEST_FIXTURE', 'Process')
`$fixture = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText(`$fixturePath))
`$testCommand = `$fixture.PSObject.Properties['testCommand']
if (`$null -ne `$testCommand) { `$requestedCommand = [string]`$testCommand.Value }
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

    Remove-Item -LiteralPath $cli -Force
    Assert-Paused (Invoke-Helper -Command 'discover-tailscale' -Input @{} -Fixture $trusted) 'tailscale_service_mismatch'
    Write-Utf8NoBom $cli 'cli'

    $missingService = @{} + $trusted
    $missingService.service = @{ exists = $false }
    Assert-Paused (Invoke-Helper -Command 'discover-tailscale' -Input @{} -Fixture $missingService) 'tailscale_service_mismatch'

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
    $cleanupUnelevated = @{} + $prefFixture
    $cleanupUnelevated.elevated = $false
    $eventsBeforeCleanup = Get-Content -LiteralPath $events -Raw
    Assert-Reason (Invoke-Helper -Command 'set-preference-cleanup' -Input @{ preference = 'unattended'; enabled = $true } -Fixture $cleanupUnelevated) 'preference_elevation_required'
    Assert-True ((Get-Content -LiteralPath $events -Raw) -eq $eventsBeforeCleanup) 'cleanup elevation refusal must occur before any CLI or RunAs event'

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

    $tempReparseRoot = Join-Path $script:Temp 'pending temp reparse root'
    $tempReparseLocal = Join-Path $tempReparseRoot 'local'
    $tempReparseTarget = Join-Path $script:Temp 'pending temp reparse target'
    New-Item -ItemType Directory -Path $tempReparseLocal, $tempReparseTarget | Out-Null
    $tempReparse = New-TestJunction (Join-Path $tempReparseLocal 'controlled-temp') $tempReparseTarget
    Assert-Reason (Invoke-Helper -Command 'initialize-pending' -Input @{ root = $tempReparseRoot } -Fixture @{ skipAcl = $true; pendingTemporaryPath = $tempReparse }) 'path_reparse_point'

    $rootReparseTarget = Join-Path $script:Temp 'root reparse target'
    New-Item -ItemType Directory -Path $rootReparseTarget | Out-Null
    $rootReparseFile = Join-Path $rootReparseTarget 'state.json'
    Write-Utf8NoBom $rootReparseFile '{}'
    $rootReparse = New-TestJunction (Join-Path $script:Temp 'root reparse link') $rootReparseTarget
    Assert-Reason (Invoke-Helper -Command 'protect-path' -Input @{ root = $rootReparse; path = (Join-Path $rootReparse 'state.json') } -Fixture @{ skipAcl = $true }) 'path_reparse_point'

    $ancestorRoot = Join-Path $script:Temp 'ancestor reparse root'
    $ancestorTarget = Join-Path $script:Temp 'ancestor reparse target'
    New-Item -ItemType Directory -Path $ancestorRoot, $ancestorTarget | Out-Null
    $ancestorFile = Join-Path $ancestorTarget 'state.json'
    Write-Utf8NoBom $ancestorFile '{}'
    $ancestorLink = New-TestJunction (Join-Path $ancestorRoot 'linked') $ancestorTarget
    Assert-Reason (Invoke-Helper -Command 'protect-path' -Input @{ root = $ancestorRoot; path = (Join-Path $ancestorLink 'state.json') } -Fixture @{ skipAcl = $true }) 'path_reparse_point'

    $destinationRoot = Join-Path $script:Temp 'destination reparse root'
    $destinationLocal = Join-Path $destinationRoot 'local'
    $destinationTarget = Join-Path $script:Temp 'destination reparse target'
    New-Item -ItemType Directory -Path $destinationLocal, $destinationTarget | Out-Null
    [void](New-TestJunction (Join-Path $destinationLocal 'network-onboarding.json') $destinationTarget)
    Assert-Reason (Invoke-Helper -Command 'initialize-pending' -Input @{ root = $destinationRoot } -Fixture @{ skipAcl = $true }) 'path_reparse_point'
    $outside = Join-Path $script:Temp 'outside.txt'
    Write-Utf8NoBom $outside 'outside'
    Assert-Reason (Invoke-Helper -Command 'protect-path' -Input @{ root = $root; path = $outside } -Fixture @{ skipAcl = $true }) 'path_rejected'

    $aclRoot = Join-Path $script:Temp 'real acl root'
    $aclFile = Join-Path $aclRoot 'protected.json'
    New-Item -ItemType Directory -Path $aclRoot | Out-Null
    Write-Utf8NoBom $aclFile '{}'
    $runnerStyleAcl = Get-Acl -LiteralPath $aclFile
    $runnerStyleAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')),
        [Security.AccessControl.FileSystemRights]::Modify,
        [Security.AccessControl.AccessControlType]::Allow
    )))
    Set-Acl -LiteralPath $aclFile -AclObject $runnerStyleAcl
    $realDirectoryProtection = Invoke-Helper -Command 'protect-path' -Input @{ root = $aclRoot; path = $aclRoot } -Fixture @{}
    Assert-True ($realDirectoryProtection.Json.ok) "real disposable directory DACL protection failed: $($realDirectoryProtection.Raw)"
    Assert-PrivateDacl $aclRoot
    $realProtection = Invoke-Helper -Command 'protect-path' -Input @{ root = $aclRoot; path = $aclFile } -Fixture @{}
    Assert-True ($realProtection.Json.ok) "real disposable DACL protection failed: $($realProtection.Raw)"
    Assert-PrivateDacl $aclFile

    $preparedRoot = Join-Path $script:Temp 'prepared install root'
    $prepared = Invoke-Helper -Command 'prepare-install-root' -Input @{ root = $preparedRoot } -Fixture @{}
    Assert-True $prepared.Json.ok "safe install-root preparation failed: $($prepared.Raw)"
    Assert-PrivateDacl $preparedRoot
    Assert-PrivateDacl (Join-Path $preparedRoot 'bin')

    foreach ($normalParent in @($env:LOCALAPPDATA, $env:OneDrive)) {
        if ([string]::IsNullOrWhiteSpace($normalParent) -or -not (Test-Path -LiteralPath $normalParent -PathType Container)) { continue }
        $normalRoot = Join-Path $normalParent ("cozygateway-helper-path-test-" + [guid]::NewGuid().ToString('N'))
        $script:ExternalRoots.Add($normalRoot)
        $normalPrepared = Invoke-Helper -Command 'prepare-install-root' -Input @{ root = $normalRoot } -Fixture @{}
        Assert-True $normalPrepared.Json.ok "normal user-owned install parent must remain supported: $normalParent / $($normalPrepared.Raw)"
        Assert-PrivateDacl $normalRoot
    }

    $unicodeRoot = Join-Path $script:Temp 'Gäteway 你好'
    $unicodePrepared = Invoke-Helper -Command 'prepare-install-root' -Input @{ root = $unicodeRoot } -Fixture @{}
    Assert-True $unicodePrepared.Json.ok "Unicode install-root preparation failed: $($unicodePrepared.Raw)"
    $unicodeFile = Join-Path $unicodeRoot 'bin\helper.ps1'
    Write-Utf8NoBom $unicodeFile 'fixture'
    $unicodeProtected = Invoke-Helper -Command 'protect-path' -Input @{ root = $unicodeRoot; path = $unicodeFile } -Fixture @{}
    Assert-True $unicodeProtected.Json.ok "Unicode boundary-file protection failed: $($unicodeProtected.Raw)"
    Assert-PrivateDacl $unicodeFile

    $unsafeRoot = Join-Path $script:Temp 'unsafe install root'
    New-Item -ItemType Directory -Path $unsafeRoot | Out-Null
    $unsafeAcl = Get-Acl -LiteralPath $unsafeRoot
    $unsafeAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        (New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),
        [Security.AccessControl.FileSystemRights]::Modify,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )))
    Set-Acl -LiteralPath $unsafeRoot -AclObject $unsafeAcl
    Assert-Reason (Invoke-Helper -Command 'prepare-install-root' -Input @{ root = $unsafeRoot } -Fixture @{}) 'unsafe_install_root'

    $hostileOwnerRoot = Join-Path $script:Temp 'hostile owner install root'
    New-Item -ItemType Directory -Path $hostileOwnerRoot | Out-Null
    Assert-Reason (Invoke-Helper -Command 'prepare-install-root' -Input @{ root = $hostileOwnerRoot } -Fixture @{
        unsafeInstallRootOwner = $true
    }) 'unsafe_install_root'

    $hostileOwnerParent = Join-Path $script:Temp 'hostile owner parent'
    New-Item -ItemType Directory -Path $hostileOwnerParent | Out-Null
    Assert-Reason (Invoke-Helper -Command 'prepare-install-root' -Input @{ root = (Join-Path $hostileOwnerParent 'cozygateway') } -Fixture @{
        unsafeInstallParentOwner = $true
    }) 'unsafe_install_root'

    foreach ($dangerousParentRight in @(
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
        [Security.AccessControl.FileSystemRights]::ChangePermissions,
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    )) {
        $sharedParent = Join-Path $script:Temp ("shared parent right " + [int64]$dangerousParentRight)
        New-Item -ItemType Directory -Path $sharedParent | Out-Null
        $sharedAcl = Get-Acl -LiteralPath $sharedParent
        $sharedAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),
            $dangerousParentRight,
            [Security.AccessControl.AccessControlType]::Allow
        )))
        Set-Acl -LiteralPath $sharedParent -AclObject $sharedAcl
        Assert-Reason (Invoke-Helper -Command 'prepare-install-root' -Input @{ root = (Join-Path $sharedParent 'cozygateway') } -Fixture @{}) 'unsafe_install_root'
    }

    $inheritedControlGrandparent = Join-Path $script:Temp 'inherited control grandparent'
    $inheritedControlParent = Join-Path $inheritedControlGrandparent 'parent'
    New-Item -ItemType Directory -Path $inheritedControlGrandparent | Out-Null
    $inheritedControlAcl = Get-Acl -LiteralPath $inheritedControlGrandparent
    $inheritedControlAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        (New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),
        [Security.AccessControl.FileSystemRights]::ChangePermissions,
        [Security.AccessControl.InheritanceFlags]::ContainerInherit,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )))
    Set-Acl -LiteralPath $inheritedControlGrandparent -AclObject $inheritedControlAcl
    New-Item -ItemType Directory -Path $inheritedControlParent | Out-Null
    $inheritedControlRules = @(Get-Acl -LiteralPath $inheritedControlParent | ForEach-Object {
        $_.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    })
    Assert-True (@($inheritedControlRules | Where-Object {
        $_.IsInherited -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ChangePermissions) -ne 0
    }).Count -gt 0) 'parent-control fixture must exercise an inherited effective ACE'
    Assert-Reason (Invoke-Helper -Command 'prepare-install-root' -Input @{ root = (Join-Path $inheritedControlParent 'cozygateway') } -Fixture @{}) 'unsafe_install_root'

    foreach ($boundaryChild in @('bin', 'runtime', 'bin\cozygateway-windows-helper.ps1')) {
        $reparseRoot = Join-Path $script:Temp ("reparse boundary " + ($boundaryChild -replace '[\\.]', '-'))
        $reparseTarget = Join-Path $script:Temp ("reparse target " + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $reparseRoot, $reparseTarget | Out-Null
        $childPath = Join-Path $reparseRoot $boundaryChild
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $childPath) | Out-Null
        [void](New-TestJunction $childPath $reparseTarget)
        Assert-Reason (Invoke-Helper -Command 'prepare-install-root' -Input @{ root = $reparseRoot } -Fixture @{}) 'path_reparse_point'
    }

    $volumeRoot = [IO.Path]::GetPathRoot($script:Temp)
    . $script:Helper
    $script:Fixture = [pscustomobject]@{ programFiles = $volumeRoot }
    Assert-True ((Get-ProgramFilesRoot) -eq $volumeRoot) 'Program Files canonicalization must preserve a volume-root separator'
    Assert-True ((Normalize-FullyQualifiedPath '\\server\share\') -eq '\\server\share\') 'canonicalization must preserve a UNC share-root separator'
    $volumeEvents = Join-Path $script:Temp 'volume-boundary-events.jsonl'
    $volumeFixture = @{ skipAcl = $true; eventLog = $volumeEvents }
    $rootBoundary = Invoke-Helper -Command 'protect-path' -Input @{ root = $volumeRoot; path = $volumeRoot } -Fixture $volumeFixture
    Assert-True ($rootBoundary.Json.ok) "volume-root protection boundary failed: $($rootBoundary.Raw)"
    $volumeEvent = Get-Content -LiteralPath $volumeEvents -Raw | ConvertFrom-Json
    Assert-True ($volumeEvent.arguments[0] -eq $volumeRoot) 'canonical containment must preserve the volume-root separator'
    $insideBoundary = Invoke-Helper -Command 'protect-path' -Input @{ root = $volumeRoot; path = $outside } -Fixture $volumeFixture
    Assert-True ($insideBoundary.Json.ok) 'a disposable path inside a volume-root boundary must remain contained'

    $inventory = Invoke-Helper -Command 'adapter-inventory' -Input @{} -Fixture @{ adapters = @(
        @{ id = '{A}'; displayName = 'Ethernet localized'; ndisMedium = 0; physicalMedium = 14; hardwareInterface = $true; operationalStatus = 1; adminStatus = 1; ipv4Addresses = @('192.168.1.20') },
        @{ id = '{B}'; displayName = 'Whatever'; ndisMedium = 16; physicalMedium = 9; hardwareInterface = $true; operationalStatus = 2; adminStatus = 1; ipv4Addresses = @() },
        @{ id = '{C}'; displayName = 'VPN'; ndisMedium = 0; physicalMedium = 0; hardwareInterface = $false; operationalStatus = 1; adminStatus = 1; ipv4Addresses = @('10.0.0.1') }
    ) }
    Assert-True ($inventory.Json.result.schemaVersion -eq 1) 'inventory schema must be fixed'
    Assert-True ($inventory.Json.result.adapters[0].kind -eq 'ethernet' -and $inventory.Json.result.adapters[0].status -eq 'up') 'numeric Ethernet mapping failed'
    Assert-True ($inventory.Json.result.adapters[1].kind -eq 'wifi' -and $inventory.Json.result.adapters[1].status -eq 'down') 'numeric Wi-Fi mapping failed'
    Assert-True ($inventory.Json.result.adapters[2].kind -eq 'other') 'software adapters must stay other'

    $safety = Invoke-Helper -Command 'inspect-network-safety' -Input @{ adapterId = '{A}' } -Fixture @{
        networkSafety = @{ networkCategory = 'Public'; firewallEnabled = $true; defaultInboundAction = 'Block' }
    }
    Assert-True $safety.Json.ok "network-safety inspection failed: $($safety.Raw)"
    Assert-True ($safety.Json.result.networkCategory -eq 'public') 'network category must be normalized'
    $domainSafety = Invoke-Helper -Command 'inspect-network-safety' -Input @{ adapterId = '{A}' } -Fixture @{
        networkSafety = @{ networkCategory = 'DomainAuthenticated'; firewallEnabled = $true; defaultInboundAction = 'NotConfigured' }
    }
    Assert-True ($domainSafety.Json.result.networkCategory -eq 'domain') 'DomainAuthenticated must normalize to the Domain firewall profile'
    Assert-True ($domainSafety.Json.result.defaultInboundAction -eq 'not_configured') 'firewall action must be normalized'
    Assert-True ($safety.Json.result.firewallEnabled -eq $true -and $safety.Json.result.defaultInboundAction -eq 'block') 'active firewall posture must be normalized'
    Assert-Reason (Invoke-Helper -Command 'inspect-network-safety' -Input @{ adapterId = '' } -Fixture @{}) 'invalid_request'

    $dashboardRequest = @{
        port = 9119
        hermesRoot = (Join-Path $script:Temp 'Hermes Root')
        hermesPath = (Join-Path $script:Temp 'Hermes Root\bin\hermes.cmd')
        launcherPath = (Join-Path $script:Temp 'Hermes Root\bin\hermes.exe')
    }
    $dashboardFree = Invoke-Helper -Command 'inspect-dashboard-port' -Input $dashboardRequest -Fixture @{
        dashboardPort = @{ status = 'free' }
    }
    Assert-True ($dashboardFree.Json.ok -and $dashboardFree.Json.result.available -and -not $dashboardFree.Json.result.owned) 'free Dashboard port must be reported without an owner'
    $dashboardOwned = Invoke-Helper -Command 'inspect-dashboard-port' -Input $dashboardRequest -Fixture @{
        dashboardPort = @{ status = 'owned'; processId = 4242; processName = 'python.exe' }
    }
    Assert-True (-not $dashboardOwned.Json.result.available -and $dashboardOwned.Json.result.owned -and $dashboardOwned.Json.result.processId -eq 4242) 'exact Hermes Dashboard owner must be reusable'
    $dashboardUnrelated = Invoke-Helper -Command 'inspect-dashboard-port' -Input $dashboardRequest -Fixture @{
        dashboardPort = @{ status = 'unrelated'; processId = 5252; processName = 'python.exe' }
    }
    Assert-True (-not $dashboardUnrelated.Json.result.available -and -not $dashboardUnrelated.Json.result.owned -and $dashboardUnrelated.Json.result.processName -eq 'python.exe') 'unrelated Dashboard listener metadata must remain actionable'
    $dashboardFreeWithoutHermes = Invoke-Helper -Command 'inspect-dashboard-port' -Input @{ port = 9119 } -Fixture @{
        dashboardPort = @{ status = 'free' }
    }
    Assert-True ($dashboardFreeWithoutHermes.Json.ok -and $dashboardFreeWithoutHermes.Json.result.available) 'initial free-port inspection must not require resolving Hermes identity'
    $dashboardOccupiedWithoutHermes = Invoke-Helper -Command 'inspect-dashboard-port' -Input @{ port = 9119 } -Fixture @{
        dashboardPort = @{ status = 'unrelated'; processId = [long]5252; processName = 'python.exe' }
    }
    Assert-True (-not $dashboardOccupiedWithoutHermes.Json.result.available -and -not $dashboardOccupiedWithoutHermes.Json.result.owned -and [long]$dashboardOccupiedWithoutHermes.Json.result.processId -eq 5252) 'initial occupied-port inspection must return engine-neutral PID metadata without Hermes identity'
    $invalidDashboardRequest = @{} + $dashboardRequest
    $invalidDashboardRequest.port = 0
    Assert-Reason (Invoke-Helper -Command 'inspect-dashboard-port' -Input $invalidDashboardRequest -Fixture @{}) 'invalid_request'

    Assert-Reason (Invoke-Helper -Command 'adapter-inventory' -Input @{ unexpected = $true } -Fixture @{ adapters = @() }) 'invalid_request'
    Assert-Reason (Invoke-Helper -Command 'set-preference' -RawRequest '{"preference":"unattended","preference":"shields-up","enabled":true}' -Fixture $prefFixture) 'invalid_request'
    Assert-Reason (Invoke-Helper -Command 'set-preference' -RawRequest '{"preference":"unattended","Preference":"shields-up","enabled":true}' -Fixture $prefFixture) 'invalid_request'
    Assert-Reason (Invoke-Helper -Command 'set-preference' -RawRequest '{"preference":"unattended","\u0070reference":"shields-up","enabled":true}' -Fixture $prefFixture) 'invalid_request'
    Assert-Reason (Invoke-Helper -Command 'open-browser' -RawRequest ('{"purpose":"login","url":"' + ('a' * 65536) + '"}') -Fixture $browserFixture) 'request_too_large'
    Assert-Reason (Invoke-Helper -Command 'made-up-command' -Input @{} -Fixture @{}) 'invalid_request'
    $hugeCommand = Invoke-Helper -Command 'fixture-command' -Input @{} -Fixture @{ testCommand = ('x' * 70000) }
    Assert-Reason $hugeCommand 'invalid_request'
    Assert-True ($hugeCommand.Json.command -eq 'invalid') 'invalid commands must use a fixed bounded envelope sentinel'
    $multibyteCommand = Invoke-Helper -Command 'fixture-command' -Input @{} -Fixture @{ testCommand = (([string][char]0x20ac) * 25000) }
    Assert-Reason $multibyteCommand 'invalid_request'
    Assert-True ($multibyteCommand.Json.command -eq 'invalid') 'multibyte invalid commands must use the same bounded sentinel'
    Write-Host 'windows helper tests passed'
} finally {
    foreach ($externalRoot in $script:ExternalRoots) {
        $parent = Split-Path -Parent $externalRoot
        $leaf = Split-Path -Leaf $externalRoot
        if ($parent -in @($env:LOCALAPPDATA, $env:OneDrive) -and $leaf -match '^cozygateway-helper-path-test-[0-9a-f]{32}$' -and (Test-Path -LiteralPath $externalRoot)) {
            Remove-Item -LiteralPath $externalRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    if ($script:TempVerified) {
        $cleanupPath = [IO.Path]::GetFullPath($script:Temp)
        if ($cleanupPath.StartsWith($script:TempBase + '\', [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $cleanupPath) -match '^cozygateway-windows-helper-[0-9a-f]{32}$') {
            for ($index = $script:Junctions.Count - 1; $index -ge 0; $index--) {
                $junction = $script:Junctions[$index]
                if ($junction.StartsWith($cleanupPath + '\', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $junction)) {
                    [IO.Directory]::Delete($junction)
                }
            }
            Remove-Item -LiteralPath $cleanupPath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

$ErrorActionPreference = 'Stop'

function Assert-True {
    param([bool] $Condition, [string] $Message)
    if (-not $Condition) { throw "ASSERT: $Message" }
}

function Write-Utf8NoBom {
    param([string] $Path, [string] $Content)
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Add-BroadInheritedReadAcl {
    param([string] $Path)
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $users = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::BuiltinUsersSid, $null)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $users,
        [Security.AccessControl.FileSystemRights]::ReadAndExecute,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )
    $acl = Get-Acl -LiteralPath $Path
    [void]$acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Assert-NoBroadReadAcl {
    param([string] $Path)
    $users = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::BuiltinUsersSid, $null)
    $acl = Get-Acl -LiteralPath $Path
    $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    Assert-True (-not ($rules | Where-Object { $_.IdentityReference -eq $users -and $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow })) "$Path must not grant the built-in Users group access"
}

function New-ReleaseFixtures {
    param([string] $Directory)
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    $assets = @{
        'cozygateway.mjs' = "console.log('fixture');`n"
        'cozygateway-hermes-attach-plugin.tar.gz' = 'plugin-fixture'
        'cozygateway-installer.sh' = "#!/usr/bin/env bash`nexit 0`n"
    }
    foreach ($entry in $assets.GetEnumerator()) {
        $path = Join-Path $Directory $entry.Key
        Write-Utf8NoBom $path $entry.Value
        $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-Utf8NoBom "$path.sha256" "$hash  $($entry.Key)`n"
    }
}

function New-FakeHermes {
    param([string] $BinDirectory, [string] $ConfigPath, [string] $EventLog)
    New-Item -ItemType Directory -Force -Path $BinDirectory | Out-Null
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ConfigPath) | Out-Null
    Write-Utf8NoBom $ConfigPath "{}`n"
    $body = @"
@echo off
echo hermes:%*>>"$EventLog"
if "%1"=="model" (
  exit /b 0
)
if "%1"=="status" (
  if "%COZYGATEWAY_TEST_MODEL_INCOMPLETE%"=="1" (
    echo   Model:        ^(not set^)
    echo   Provider:     Auto
    exit /b 0
  )
  echo   Model:        fixture-model
  echo   Provider:     fixture-provider
  exit /b 0
)
if "%1"=="-p" if "%3"=="config" if "%4"=="path" (
  echo $ConfigPath
  exit /b 0
)
exit /b 0
"@
    Write-Utf8NoBom (Join-Path $BinDirectory 'hermes.cmd') $body
}

function New-FakeBash {
    param([string] $Path, [string] $EventLog)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    Write-Utf8NoBom $Path "@echo off`necho bash:%*>>`"$EventLog`"`necho bash-hermes:%COZYGATEWAY_HERMES_BIN%>>`"$EventLog`"`nif not `"%COZYGATEWAY_TEST_SECRET_PATH%`"==`"`" (`n  for %%I in (`"%COZYGATEWAY_TEST_SECRET_PATH%`") do if not exist `"%%~dpI`" mkdir `"%%~dpI`"`n  >`"%COZYGATEWAY_TEST_SECRET_PATH%`" echo DASHBOARD_SESSION_TOKEN=test-token`n)`nexit /b 0`n"
}

function Invoke-Bootstrap {
    param(
        [string] $Installer,
        [hashtable] $Environment,
        [string[]] $Arguments = @()
    )
    $old = @{}
    foreach ($key in $Environment.Keys) {
        $old[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], 'Process')
    }
    try {
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Installer @Arguments 2>&1
        return @{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
    } finally {
        $ErrorActionPreference = $previousPreference
        foreach ($key in $Environment.Keys) {
            [Environment]::SetEnvironmentVariable($key, $old[$key], 'Process')
        }
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$installer = Join-Path $repoRoot 'scripts\install.ps1'
$temp = Join-Path ([IO.Path]::GetTempPath()) ("cozygateway-windows-bootstrap-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

try {
    Assert-True (Test-Path -LiteralPath $installer) 'scripts/install.ps1 must exist'
    $fixtures = Join-Path $temp 'release assets'
    $eventLog = Join-Path $temp 'events.log'
    $fakeBin = Join-Path $temp 'fake bin'
    $configPath = Join-Path $temp 'Hermes Home\config.yaml'
    $fakeBash = Join-Path $temp 'Git With Spaces\bash.cmd'
    $pathLog = Join-Path $temp 'user-path.txt'
    New-ReleaseFixtures $fixtures
    New-FakeHermes $fakeBin $configPath $eventLog
    New-FakeBash $fakeBash $eventLog

    $result = Invoke-Bootstrap $installer @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Cozy Gateway')
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
        'COZYGATEWAY_TEST_USER_PATH' = 'C:\Existing Tools'
        'COZYGATEWAY_TEST_USER_PATH_LOG' = $pathLog
    }
    Assert-True ($result.ExitCode -eq 0) "existing-Hermes bootstrap failed: $($result.Output)"
    $events = Get-Content -LiteralPath $eventLog
    $modelIndex = [Array]::IndexOf($events, 'hermes:model')
    $statusIndex = [Array]::IndexOf($events, 'hermes:status')
    $bashIndex = ($events | Select-String '^bash:' | Select-Object -First 1).LineNumber - 1
    Assert-True ($modelIndex -eq -1) 'bootstrap must skip hermes model when a provider and model are already configured'
    Assert-True ($statusIndex -ge 0) 'bootstrap must inspect the existing Hermes provider and model'
    Assert-True ($bashIndex -gt $statusIndex) 'Hermes model status must be confirmed before the CozyGateway handoff'
    Assert-True ($result.Output -match 'already configured') 'configured Hermes should report that model selection was skipped'
    Assert-True (($events -join "`n") -match '--service-platform Windows') 'handoff must select the Windows service platform'
    Assert-True (($events -join "`n") -match 'Cozy Gateway') 'paths containing spaces must survive the handoff'
    Assert-True (($events -join "`n") -match [regex]::Escape("bash-hermes:$(Join-Path $fakeBin 'hermes.cmd')")) 'handoff must expose the resolved Hermes executable to the shared installer'
    $registeredPath = Get-Content -LiteralPath $pathLog -Raw
    Assert-True ($registeredPath -match [regex]::Escape((Join-Path $temp 'Cozy Gateway\bin'))) 'bootstrap must add the native CozyGateway command directory to the user PATH'
    Assert-True (($registeredPath -split ';' | Where-Object { $_ -eq (Join-Path $temp 'Cozy Gateway\bin') }).Count -eq 1) 'bootstrap must register the command directory once'

    $broadParent = Join-Path $temp 'broad acl parent'
    $protectedHome = Join-Path $broadParent 'Protected Cozy Gateway'
    $protectedSecret = Join-Path $protectedHome 'local\dashboard.env'
    $protectedPathLog = Join-Path $temp 'protected-user-path.txt'
    Add-BroadInheritedReadAcl $broadParent
    $protected = Invoke-Bootstrap $installer @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_HOME' = $protectedHome
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
        'COZYGATEWAY_TEST_SECRET_PATH' = $protectedSecret
        'COZYGATEWAY_TEST_USER_PATH' = 'C:\Existing Tools'
        'COZYGATEWAY_TEST_USER_PATH_LOG' = $protectedPathLog
    }
    Assert-True ($protected.ExitCode -eq 0) "protected bootstrap failed: $($protected.Output)"
    Assert-True ((Get-Acl -LiteralPath $protectedHome).AreAccessRulesProtected) 'managed install root must disable inherited access rules before the Bash handoff'
    Assert-NoBroadReadAcl $protectedHome
    Assert-NoBroadReadAcl $protectedSecret

    $uninstallPathLog = Join-Path $temp 'uninstall-user-path.txt'
    $managedBin = Join-Path $temp 'Cozy Gateway\bin'
    $mustNotRunHermesInstaller = Join-Path $temp 'must-not-run-hermes-installer.ps1'
    Write-Utf8NoBom $mustNotRunHermesInstaller "throw 'uninstall must not install Hermes'`n"
    Remove-Item -LiteralPath $eventLog -Force
    $uninstall = Invoke-Bootstrap $installer @{
        'PATH' = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
        'LOCALAPPDATA' = (Join-Path $temp 'uninstall without prerequisites')
        'COZYGATEWAY_INSTALL_ASSET_BASE' = (Join-Path $temp 'missing release assets')
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Cozy Gateway')
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_HERMES_INSTALL_URL' = $mustNotRunHermesInstaller
        'COZYGATEWAY_TEST_USER_PATH' = "C:\Existing Tools;$managedBin"
        'COZYGATEWAY_TEST_USER_PATH_LOG' = $uninstallPathLog
    } @('--uninstall')
    Assert-True ($uninstall.ExitCode -eq 0) "bootstrap uninstall failed: $($uninstall.Output)"
    $uninstalledPath = Get-Content -LiteralPath $uninstallPathLog -Raw
    Assert-True (-not ($uninstalledPath -match [regex]::Escape($managedBin))) 'uninstall must remove the managed command directory from the user PATH'
    Assert-True (-not ((Get-Content -LiteralPath $eventLog -Raw) -match 'hermes:model')) 'uninstall must not open Hermes model selection'

    $dryUninstallPathLog = Join-Path $temp 'dry-uninstall-user-path.txt'
    Remove-Item -LiteralPath $eventLog -Force
    $dryUninstall = Invoke-Bootstrap $installer @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Cozy Gateway')
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_INSTALL_DRYRUN' = '1'
        'COZYGATEWAY_TEST_USER_PATH' = "C:\Existing Tools;$managedBin"
        'COZYGATEWAY_TEST_USER_PATH_LOG' = $dryUninstallPathLog
    } @('--uninstall')
    Assert-True ($dryUninstall.ExitCode -eq 0) "bootstrap uninstall dry run failed: $($dryUninstall.Output)"
    Assert-True (-not (Test-Path -LiteralPath $dryUninstallPathLog)) 'uninstall dry run must not mutate the user PATH'
    Assert-True ((Get-Content -LiteralPath $eventLog -Raw) -match '--uninstall.*--dry-run|--dry-run.*--uninstall') 'bootstrap must forward dry run to uninstall'

    $dryRunPathLog = Join-Path $temp 'dry-run-user-path.txt'
    $dryRunHome = Join-Path $temp 'Dry Run Gateway'
    $dryRun = Invoke-Bootstrap $installer @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_HOME' = $dryRunHome
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
        'COZYGATEWAY_INSTALL_DRYRUN' = '1'
        'COZYGATEWAY_TEST_USER_PATH' = 'C:\Existing Tools'
        'COZYGATEWAY_TEST_USER_PATH_LOG' = $dryRunPathLog
    }
    Assert-True ($dryRun.ExitCode -eq 0) "bootstrap dry run failed: $($dryRun.Output)"
    Assert-True (-not (Test-Path -LiteralPath $dryRunPathLog)) 'dry run must not mutate the user PATH'
    Assert-True (-not (Test-Path -LiteralPath $dryRunHome)) 'dry run must not create or replace managed install files'

    $missingRoot = Join-Path $temp 'missing hermes case'
    $missingHermes = Join-Path $missingRoot 'hermes\bin\hermes.cmd'
    $missingConfig = Join-Path $missingRoot 'hermes\config.yaml'
    $preparedBin = Join-Path $temp 'prepared hermes'
    New-FakeHermes $preparedBin $missingConfig $eventLog
    $officialInstaller = Join-Path $temp 'official-hermes-install.ps1'
    $preparedHermes = Join-Path $preparedBin 'hermes.cmd'
    Write-Utf8NoBom $officialInstaller @"
New-Item -ItemType Directory -Force -Path '$(Split-Path -Parent $missingHermes)' | Out-Null
Copy-Item -LiteralPath '$preparedHermes' -Destination '$missingHermes' -Force
"@
    $missing = Invoke-Bootstrap $installer @{
        'PATH' = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
        'LOCALAPPDATA' = $missingRoot
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Fresh Cozy Gateway')
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = $missingHermes
        'COZYGATEWAY_HERMES_INSTALL_URL' = $officialInstaller
    }
    Assert-True ($missing.ExitCode -eq 0) "missing-Hermes bootstrap failed: $($missing.Output)"
    Assert-True ($missing.Output -match 'Hermes Agent is not installed') 'missing Hermes must invoke the official installer path'
    Assert-True ((Get-Content -LiteralPath $eventLog -Raw) -match [regex]::Escape("bash-hermes:$missingHermes")) 'fresh-install handoff must expose Hermes when it exists only under LOCALAPPDATA'

    Remove-Item -LiteralPath $eventLog -Force
    $incomplete = Invoke-Bootstrap $installer @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Incomplete Model')
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
        'COZYGATEWAY_TEST_MODEL_INCOMPLETE' = '1'
    }
    Assert-True ($incomplete.ExitCode -ne 0) 'missing provider evidence must fail before CozyGateway handoff'
    Assert-True ($incomplete.Output -match 'active provider and model') 'model/provider failure must be actionable'
    $incompleteEvents = Get-Content -LiteralPath $eventLog
    Assert-True (($incompleteEvents -join "`n") -match '(?m)^hermes:model$') 'incomplete Hermes setup must open model selection'
    Assert-True (-not (($incompleteEvents -join "`n") -match '^bash:')) 'incomplete Hermes model selection must not invoke Bash'

    Write-Utf8NoBom (Join-Path $fixtures 'cozygateway.mjs.sha256') (('0' * 64) + "  cozygateway.mjs`n")
    $bad = Invoke-Bootstrap $installer @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Bad Hash')
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
    }
    Assert-True ($bad.ExitCode -ne 0) 'checksum mismatch must fail'
    Assert-True ($bad.Output -match 'checksum mismatch') 'checksum mismatch must be actionable'

    Write-Host 'windows bootstrap tests passed'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

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

    $className = 'FakeHermes' + [guid]::NewGuid().ToString('N')
    $configLiteral = $ConfigPath.Replace('"', '""')
    $eventLiteral = $EventLog.Replace('"', '""')
    $source = @"
using System;
using System.IO;
public static class $className {
    public static int Main(string[] args) {
        File.AppendAllText(@"$eventLiteral", "hermes:" + string.Join(" ", args) + Environment.NewLine);
        if (args.Length > 0 && args[0] == "status") {
            if (Environment.GetEnvironmentVariable("COZYGATEWAY_TEST_MODEL_INCOMPLETE") == "1") {
                Console.WriteLine("  Model:        (not set)");
                Console.WriteLine("  Provider:     Auto");
            } else {
                Console.WriteLine("  Model:        fixture-model");
                Console.WriteLine("  Provider:     fixture-provider");
            }
        } else if (args.Length > 3 && args[0] == "-p" && args[2] == "config" && args[3] == "path") {
            Console.WriteLine(@"$configLiteral");
        }
        return 0;
    }
}
"@
    Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly (Join-Path $BinDirectory 'hermes.exe') -OutputType ConsoleApplication
}

function New-FakeBash {
    param([string] $Path, [string] $EventLog)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    Write-Utf8NoBom $Path "@echo off`necho bash:%*>>`"$EventLog`"`necho bash-hermes:%COZYGATEWAY_HERMES_BIN%>>`"$EventLog`"`nif not `"%COZYGATEWAY_TEST_SECRET_PATH%`"==`"`" (`n  for %%I in (`"%COZYGATEWAY_TEST_SECRET_PATH%`") do if not exist `"%%~dpI`" mkdir `"%%~dpI`"`n  >`"%COZYGATEWAY_TEST_SECRET_PATH%`" echo DASHBOARD_SESSION_TOKEN=test-token`n)`nif `"%COZYGATEWAY_TEST_BASH_FAIL%`"==`"1`" exit /b 23`nexit /b 0`n"
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

function ConvertTo-BashSingleQuotedLiteral {
    param([string] $Value)
    $embeddedApostrophe = "'" + '"' + "'" + '"' + "'"
    return "'" + $Value.Replace("'", $embeddedApostrophe) + "'"
}

function New-FakePowerShell {
    param([string] $Path, [string] $EventLog)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    $className = 'FakePowerShell' + [guid]::NewGuid().ToString('N')
    $eventLiteral = $EventLog.Replace('"', '""')
    $source = @"
using System;
using System.IO;
using System.Text;
public static class $className {
    public static int Main(string[] args) {
        File.AppendAllText(@"$eventLiteral", Convert.ToBase64String(Encoding.UTF8.GetBytes(string.Join("\0", args))) + Environment.NewLine);
        string elevationHelper = Environment.GetEnvironmentVariable("COZYGATEWAY_TEST_ELEVATION_HELPER");
        bool elevated = Array.IndexOf(args, elevationHelper) >= 0;
        string code = Environment.GetEnvironmentVariable(elevated ? "COZYGATEWAY_TEST_ELEVATED_CODE" : "COZYGATEWAY_TEST_NORMAL_CODE");
        return Int32.Parse(code);
    }
}
"@
    Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $Path -OutputType ConsoleApplication
}

function Read-FakePowerShellCalls {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    return @(Get-Content -LiteralPath $Path | ForEach-Object {
        ,([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)).Split([char]0))
    })
}

function Invoke-DashboardStopHarness {
    param(
        [string] $FunctionText,
        [string] $Bash,
        [string] $FakePowerShellDirectory,
        [string] $CallLog,
        [string] $ScriptPath,
        [hashtable] $Paths,
        [int] $NormalCode,
        [int] $ElevatedCode
    )
    $script = @"
#!/usr/bin/env bash
set -euo pipefail
say() { printf '%s\n' "`$*"; }
die() { printf 'FAIL  %s\n' "`$*" >&2; exit 1; }
to_windows_path() { printf '%s' "`$1"; }
HERMES_ROOT=$(ConvertTo-BashSingleQuotedLiteral $Paths.Root)
HERMES_RESOLVED=$(ConvertTo-BashSingleQuotedLiteral $Paths.Hermes)
DASHBOARD_OWNER_PS1=$(ConvertTo-BashSingleQuotedLiteral $Paths.Helper)
DASHBOARD_ELEVATION_PS1=$(ConvertTo-BashSingleQuotedLiteral $Paths.ElevationHelper)
DASHBOARD_PORT=9119
$FunctionText
stop_stubborn_windows_dashboard
printf 'continued\n'
"@
    Write-Utf8NoBom $ScriptPath $script
    Remove-Item -LiteralPath $CallLog -Force -ErrorAction SilentlyContinue
    $keys = @('PATH', 'COZYGATEWAY_TEST_NORMAL_CODE', 'COZYGATEWAY_TEST_ELEVATED_CODE', 'COZYGATEWAY_TEST_ELEVATION_HELPER', 'DASHBOARD_SESSION_TOKEN', 'PROVIDER_API_KEY')
    $old = @{}
    foreach ($key in $keys) { $old[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
    try {
        $env:PATH = "$FakePowerShellDirectory;$env:PATH"
        $env:COZYGATEWAY_TEST_NORMAL_CODE = [string]$NormalCode
        $env:COZYGATEWAY_TEST_ELEVATED_CODE = [string]$ElevatedCode
        $env:COZYGATEWAY_TEST_ELEVATION_HELPER = $Paths.ElevationHelper
        $env:DASHBOARD_SESSION_TOKEN = 'task-2-secret-token'
        $env:PROVIDER_API_KEY = 'task-2-provider-secret'
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $output = & $Bash $ScriptPath 2>&1
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousPreference
        return @{ ExitCode = $exitCode; Output = ($output -join "`n"); Calls = @(Read-FakePowerShellCalls $CallLog) }
    } finally {
        $ErrorActionPreference = $previousPreference
        foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $old[$key], 'Process') }
    }
}

function Invoke-ElevationWrapperHarness {
    param(
        [string] $Wrapper,
        [string] $Harness,
        [string] $CapturePath,
        [string] $ChildCapturePath,
        [hashtable] $Paths,
        [int] $ChildCode,
        [switch] $Cancel
    )
    $harnessBody = @'
param([string]$Wrapper, [string]$Root, [string]$Hermes, [string]$Launcher, [int]$Port, [string]$Helper)
function Start-Process {
    param([string]$FilePath, [string]$Verb, [switch]$Wait, [switch]$PassThru, [string[]]$ArgumentList)
    [pscustomobject]@{
        FilePath = $FilePath
        Verb = $Verb
        Wait = $Wait.IsPresent
        PassThru = $PassThru.IsPresent
        ArgumentList = @($ArgumentList)
    } | Export-Clixml -LiteralPath $env:COZYGATEWAY_TEST_START_CAPTURE
    if ($env:COZYGATEWAY_TEST_CANCEL -eq '1') { throw 'The operation was canceled by the user.' }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $FilePath
    $info.Arguments = $ArgumentList -join ' '
    $info.UseShellExecute = $false
    $process = [Diagnostics.Process]::Start($info)
    $process.WaitForExit()
    return [pscustomobject]@{ ExitCode = $process.ExitCode }
}
& $Wrapper $Root $Hermes $Launcher $Port $Helper
exit $LASTEXITCODE
'@
    Write-Utf8NoBom $Harness $harnessBody
    Remove-Item -LiteralPath $CapturePath, $ChildCapturePath -Force -ErrorAction SilentlyContinue
    $keys = @('COZYGATEWAY_TEST_START_CAPTURE', 'COZYGATEWAY_TEST_CHILD_CAPTURE', 'COZYGATEWAY_TEST_CHILD_CODE', 'COZYGATEWAY_TEST_CANCEL', 'DASHBOARD_SESSION_TOKEN', 'PROVIDER_API_KEY')
    $old = @{}
    foreach ($key in $keys) { $old[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
    try {
        $env:COZYGATEWAY_TEST_START_CAPTURE = $CapturePath
        $env:COZYGATEWAY_TEST_CHILD_CAPTURE = $ChildCapturePath
        $env:COZYGATEWAY_TEST_CHILD_CODE = [string]$ChildCode
        $env:COZYGATEWAY_TEST_CANCEL = if ($Cancel) { '1' } else { '0' }
        $env:DASHBOARD_SESSION_TOKEN = 'task-2-secret-token'
        $env:PROVIDER_API_KEY = 'task-2-provider-secret'
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Harness $Wrapper $Paths.Root $Paths.Hermes $Paths.Launcher 9119 $Paths.Helper 2>&1
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousPreference
        return @{ ExitCode = $exitCode; Output = ($output -join "`n") }
    } finally {
        $ErrorActionPreference = $previousPreference
        foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $old[$key], 'Process') }
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
    Assert-True (($events -join "`n") -match [regex]::Escape("bash-hermes:$(Join-Path $fakeBin 'hermes.exe')")) 'handoff must expose a native Hermes executable to the shared installer'
    $registeredPath = Get-Content -LiteralPath $pathLog -Raw
    Assert-True ($registeredPath -match [regex]::Escape((Join-Path $temp 'Cozy Gateway\bin'))) 'bootstrap must add the native CozyGateway command directory to the user PATH'
    Assert-True (($registeredPath -split ';' | Where-Object { $_ -eq (Join-Path $temp 'Cozy Gateway\bin') }).Count -eq 1) 'bootstrap must register the command directory once'

    $restoreWrapper = Join-Path $temp 'verify-hermes-env-restore.ps1'
    Write-Utf8NoBom $restoreWrapper @"
`$env:COZYGATEWAY_HERMES_BIN = 'preexisting-hermes-value'
try {
    & ([scriptblock]::Create([IO.File]::ReadAllText('$installer')))
} catch {}
if (`$env:COZYGATEWAY_HERMES_BIN -cne 'preexisting-hermes-value') { exit 31 }
"@
    $restore = Invoke-Bootstrap $restoreWrapper @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Failed Handoff Gateway')
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
        'COZYGATEWAY_TEST_BASH_FAIL' = '1'
    }
    Assert-True ($restore.ExitCode -eq 0) "failed Bash handoff must restore the caller's COZYGATEWAY_HERMES_BIN: $($restore.Output)"

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
    $protectedRerun = Invoke-Bootstrap $installer @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_HOME' = $protectedHome
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
        'COZYGATEWAY_TEST_SECRET_PATH' = $protectedSecret
        'COZYGATEWAY_TEST_USER_PATH' = 'C:\Existing Tools'
        'COZYGATEWAY_TEST_USER_PATH_LOG' = $protectedPathLog
    }
    Assert-True ($protectedRerun.ExitCode -eq 0) "protected install home must support an unprivileged rerun: $($protectedRerun.Output)"

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
    $missingNativeHermes = Join-Path $missingRoot 'hermes\bin\hermes.exe'
    $missingConfig = Join-Path $missingRoot 'hermes\config.yaml'
    $preparedBin = Join-Path $temp 'prepared hermes'
    New-FakeHermes $preparedBin $missingConfig $eventLog
    $officialInstaller = Join-Path $temp 'official-hermes-install.ps1'
    $preparedHermes = Join-Path $preparedBin 'hermes.cmd'
    $preparedNativeHermes = Join-Path $preparedBin 'hermes.exe'
    Write-Utf8NoBom $officialInstaller @"
New-Item -ItemType Directory -Force -Path '$(Split-Path -Parent $missingHermes)' | Out-Null
Copy-Item -LiteralPath '$preparedHermes' -Destination '$missingHermes' -Force
Copy-Item -LiteralPath '$preparedNativeHermes' -Destination '$missingNativeHermes' -Force
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
    Assert-True ((Get-Content -LiteralPath $eventLog -Raw) -match [regex]::Escape("bash-hermes:$missingNativeHermes")) 'fresh-install handoff must expose native Hermes when it exists only under LOCALAPPDATA'

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

    $agentInstallerPath = Join-Path $repoRoot 'scripts\agent-install.sh'
    $agentInstaller = Get-Content -LiteralPath $agentInstallerPath -Raw
    $stopFunctionMatch = [regex]::Match($agentInstaller, '(?ms)^stop_stubborn_windows_dashboard\(\) \{.*?^\}')
    Assert-True $stopFunctionMatch.Success 'shared installer must define stop_stubborn_windows_dashboard'
    $gitCommand = Get-Command git.exe -ErrorAction Stop
    $gitRoot = Split-Path -Parent (Split-Path -Parent $gitCommand.Source)
    $bashPath = Join-Path $gitRoot 'bin\bash.exe'
    Assert-True (Test-Path -LiteralPath $bashPath) 'Git for Windows bash.exe must be available for the shared-installer harness'
    $fakePowerShellDirectory = Join-Path $temp 'fake PowerShell'
    $fakePowerShell = Join-Path $fakePowerShellDirectory 'powershell.exe'
    $powerShellCallLog = Join-Path $temp 'powershell-calls.log'
    New-FakePowerShell $fakePowerShell $powerShellCallLog
    $stopHarnessPath = Join-Path $temp 'dashboard stop harness.sh'
    $dashboardPaths = @{
        Root = "C:\Users\O'Brien\Hermes Root"
        Hermes = "C:\Users\O'Brien\Hermes Root\bin\hermes agent.exe"
        Helper = "C:\Users\O'Brien\Cozy Gateway\local\dashboard owner.ps1"
        Launcher = "C:\Users\O'Brien\Hermes Root\bin\hermes.exe"
        ElevationHelper = "C:\Users\O'Brien\Cozy Gateway\local\dashboard owner elevate.ps1"
    }

    $normal43 = Invoke-DashboardStopHarness $stopFunctionMatch.Value $bashPath $fakePowerShellDirectory $powerShellCallLog $stopHarnessPath $dashboardPaths 43 0
    Assert-True ($normal43.ExitCode -eq 0) "normal 43 followed by elevated 0 must continue: $($normal43.Output)"
    Assert-True ($normal43.Output -match 'continued') 'successful elevated recovery must return to the non-elevated installer'
    Assert-True (([regex]::Matches($normal43.Output, '(?m)^INFO  ')).Count -eq 1) 'normal 43 must print exactly one elevation informational line'
    Assert-True ($normal43.Calls.Count -eq 2) 'normal 43 must invoke one normal helper and exactly one elevation wrapper'
    Assert-True ($normal43.Calls[0] -contains $dashboardPaths.Helper) 'normal helper invocation must use the ownership helper path'
    Assert-True ($normal43.Calls[1] -contains $dashboardPaths.ElevationHelper) 'normal 43 must invoke the generated elevation wrapper exactly once'

    $normal0 = Invoke-DashboardStopHarness $stopFunctionMatch.Value $bashPath $fakePowerShellDirectory $powerShellCallLog $stopHarnessPath $dashboardPaths 0 99
    Assert-True ($normal0.ExitCode -eq 0 -and $normal0.Calls.Count -eq 1) 'normal 0 must continue without elevation'
    $normal42 = Invoke-DashboardStopHarness $stopFunctionMatch.Value $bashPath $fakePowerShellDirectory $powerShellCallLog $stopHarnessPath $dashboardPaths 42 0
    Assert-True ($normal42.ExitCode -ne 0 -and $normal42.Calls.Count -eq 1) 'normal 42 must fail without elevation'
    Assert-True ($normal42.Output -match 'cannot safely stop') 'normal 42 must preserve the ownership-safety failure'
    foreach ($normalFailureCode in @(45, 99)) {
        $normalFailure = Invoke-DashboardStopHarness $stopFunctionMatch.Value $bashPath $fakePowerShellDirectory $powerShellCallLog $stopHarnessPath $dashboardPaths $normalFailureCode 0
        Assert-True ($normalFailure.ExitCode -ne 0 -and $normalFailure.Calls.Count -eq 1) "normal $normalFailureCode must fail without elevation"
        Assert-True ($normalFailure.Output -match 'verified Dashboard') "normal $normalFailureCode must report a verified-owner recovery failure"
    }
    foreach ($elevatedFailureCode in @(42, 43, 45, 99)) {
        $elevatedFailure = Invoke-DashboardStopHarness $stopFunctionMatch.Value $bashPath $fakePowerShellDirectory $powerShellCallLog $stopHarnessPath $dashboardPaths 43 $elevatedFailureCode
        Assert-True ($elevatedFailure.ExitCode -ne 0 -and $elevatedFailure.Calls.Count -eq 2) "elevated $elevatedFailureCode must fail after exactly one elevation attempt"
        Assert-True (-not ($elevatedFailure.Output -match 'continued')) "elevated $elevatedFailureCode must not continue"
    }
    $launchFailure = Invoke-DashboardStopHarness $stopFunctionMatch.Value $bashPath $fakePowerShellDirectory $powerShellCallLog $stopHarnessPath $dashboardPaths 43 46
    Assert-True ($launchFailure.ExitCode -ne 0 -and $launchFailure.Calls.Count -eq 2) 'UAC cancellation or launch failure must stop after one elevation attempt'
    Assert-True ($launchFailure.Output -match 'scoped Dashboard recovery helper') 'UAC cancellation or launch failure must identify the scoped helper'
    Assert-True ($launchFailure.Output -match 'close .* Dashboard manually' -and $launchFailure.Output -match 'rerun') 'UAC cancellation or launch failure must explain manual close and rerun recovery'
    $allShellEvidence = @($normal43, $normal0, $normal42, $launchFailure) | ForEach-Object { $_.Output; $_.Calls | ForEach-Object { $_ -join "`n" } }
    Assert-True (-not (($allShellEvidence -join "`n") -match 'task-2-secret-token|task-2-provider-secret')) 'shell elevation arguments and logs must not expose token or provider secrets'

    $elevationMatch = [regex]::Match($agentInstaller, "(?ms)<<'POWERSHELL_ELEVATION'\r?\n(?<Body>.*?)\r?\nPOWERSHELL_ELEVATION")
    Assert-True $elevationMatch.Success 'shared installer must generate a PowerShell elevation wrapper'
    $elevationWrapper = Join-Path $temp 'dashboard owner elevate.ps1'
    Write-Utf8NoBom $elevationWrapper $elevationMatch.Groups['Body'].Value
    $elevatedChild = Join-Path $temp "O'Brien Cozy Gateway\dashboard owner.ps1"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $elevatedChild) | Out-Null
    Write-Utf8NoBom $elevatedChild @'
param(
    [Parameter(Position = 0)][string]$ExpectedRoot,
    [Parameter(Position = 1)][string]$ExpectedHermes,
    [Parameter(Position = 2)][string]$ExpectedLauncher,
    [Parameter(Position = 3)][int]$ExpectedPort,
    [switch]$ElevatedChild
)
[pscustomobject]@{
    ExpectedRoot = $ExpectedRoot
    ExpectedHermes = $ExpectedHermes
    ExpectedLauncher = $ExpectedLauncher
    ExpectedPort = $ExpectedPort
    ElevatedChild = $ElevatedChild.IsPresent
    ExtraArguments = @($args)
} | Export-Clixml -LiteralPath $env:COZYGATEWAY_TEST_CHILD_CAPTURE
exit ([int]$env:COZYGATEWAY_TEST_CHILD_CODE)
'@
    $wrapperPaths = @{
        Root = $dashboardPaths.Root
        Hermes = $dashboardPaths.Hermes
        Launcher = $dashboardPaths.Launcher
        Helper = $elevatedChild
    }
    $startCapture = Join-Path $temp 'start-process.xml'
    $childCapture = Join-Path $temp 'elevated-child.xml'
    $wrapperHarness = Join-Path $temp 'elevation wrapper harness.ps1'
    $wrapperResult = Invoke-ElevationWrapperHarness $elevationWrapper $wrapperHarness $startCapture $childCapture $wrapperPaths 0
    Assert-True ($wrapperResult.ExitCode -eq 0) "elevation wrapper must return elevated child 0: $($wrapperResult.Output)"
    $startInvocation = Import-Clixml -LiteralPath $startCapture
    Assert-True ($startInvocation.FilePath -eq 'powershell.exe') 'elevation wrapper must launch powershell.exe'
    Assert-True ($startInvocation.Verb -eq 'RunAs' -and $startInvocation.Wait -and $startInvocation.PassThru) 'elevation wrapper must use -Verb RunAs -Wait -PassThru'
    $childInvocation = Import-Clixml -LiteralPath $childCapture
    Assert-True ($childInvocation.ExpectedRoot -ceq $wrapperPaths.Root) 'PS5.1 parsing must preserve expected root as one argument'
    Assert-True ($childInvocation.ExpectedHermes -ceq $wrapperPaths.Hermes) 'PS5.1 parsing must preserve Hermes executable as one argument'
    Assert-True ($childInvocation.ExpectedLauncher -ceq $wrapperPaths.Launcher) 'PS5.1 parsing must preserve launcher path as one argument'
    Assert-True ($childInvocation.ExpectedPort -eq 9119) 'PS5.1 parsing must preserve Dashboard port as one argument'
    Assert-True $childInvocation.ElevatedChild 'elevated helper must receive the elevated-child marker'
    Assert-True ($childInvocation.ExtraArguments.Count -eq 0) 'elevated helper must receive no merged or extra arguments'
    $startArguments = $startInvocation.ArgumentList -join "`n"
    Assert-True ($startArguments -match '(?m)^-NoProfile$' -and $startArguments -match '(?m)^-NonInteractive$' -and $startArguments -match '(?m)^-ExecutionPolicy$' -and $startArguments -match '(?m)^Bypass$' -and $startArguments -match '(?m)^-File$') 'elevation wrapper must carry the required PowerShell argument array'
    $wrapperEvidence = $wrapperResult.Output + "`n" + (Get-Content -LiteralPath $startCapture -Raw) + "`n" + (Get-Content -LiteralPath $childCapture -Raw)
    Assert-True (-not ($wrapperEvidence -match 'task-2-secret-token|task-2-provider-secret')) 'elevation wrapper arguments and logs must not expose token or provider secrets'

    foreach ($childCode in @(42, 43, 45, 99)) {
        $childFailure = Invoke-ElevationWrapperHarness $elevationWrapper $wrapperHarness $startCapture $childCapture $wrapperPaths $childCode
        Assert-True ($childFailure.ExitCode -eq $childCode) "elevation wrapper must preserve elevated child exit code $childCode"
    }

    $cancelResult = Invoke-ElevationWrapperHarness $elevationWrapper $wrapperHarness $startCapture $childCapture $wrapperPaths 0 -Cancel
    Assert-True ($cancelResult.ExitCode -eq 46) "UAC cancellation or Start-Process failure must return the launch-failure code (actual $($cancelResult.ExitCode)): $($cancelResult.Output)"
    Assert-True (-not (Test-Path -LiteralPath $childCapture)) 'UAC cancellation must not run the elevated child'

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

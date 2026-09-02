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
        'install.ps1' = "param([switch]`$Repair)`nexit 0`n"
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
if "%1"=="--version" (
  if not "%COZYGATEWAY_TEST_HERMES_UPDATED_FILE%"=="" if exist "%COZYGATEWAY_TEST_HERMES_UPDATED_FILE%" (
    if "%COZYGATEWAY_TEST_HERMES_UPDATE_RESULT%"=="" (echo Hermes Agent v0.21.0) else (echo Hermes Agent v%COZYGATEWAY_TEST_HERMES_UPDATE_RESULT%)
    exit /b 0
  )
  if "%COZYGATEWAY_TEST_HERMES_VERSION%"=="" (echo Hermes Agent v0.21.0) else (echo Hermes Agent v%COZYGATEWAY_TEST_HERMES_VERSION%)
  exit /b 0
)
if "%1"=="update" (
  if "%COZYGATEWAY_TEST_HERMES_UPDATE_FAIL%"=="1" exit /b 17
  if not "%COZYGATEWAY_TEST_HERMES_UPDATED_FILE%"=="" type nul >"%COZYGATEWAY_TEST_HERMES_UPDATED_FILE%"
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
        if (args.Length > 0 && args[0] == "--version") {
            string version = Environment.GetEnvironmentVariable("COZYGATEWAY_TEST_HERMES_VERSION");
            string updatedFile = Environment.GetEnvironmentVariable("COZYGATEWAY_TEST_HERMES_UPDATED_FILE");
            string updateResult = Environment.GetEnvironmentVariable("COZYGATEWAY_TEST_HERMES_UPDATE_RESULT");
            string updatedVersion = String.IsNullOrWhiteSpace(updateResult) ? "0.21.0" : updateResult;
            Console.WriteLine("Hermes Agent v" + (!String.IsNullOrWhiteSpace(updatedFile) && File.Exists(updatedFile) ? updatedVersion : (String.IsNullOrWhiteSpace(version) ? "0.21.0" : version)));
        } else if (args.Length > 0 && args[0] == "update") {
            if (Environment.GetEnvironmentVariable("COZYGATEWAY_TEST_HERMES_UPDATE_FAIL") == "1") return 17;
            string updatedFile = Environment.GetEnvironmentVariable("COZYGATEWAY_TEST_HERMES_UPDATED_FILE");
            if (!String.IsNullOrWhiteSpace(updatedFile)) File.WriteAllText(updatedFile, "updated");
        } else if (args.Length > 0 && args[0] == "status") {
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
    Write-Utf8NoBom $Path "@echo off`necho bash:%*>>`"$EventLog`"`necho bash-hermes:%COZYGATEWAY_HERMES_BIN%>>`"$EventLog`"`necho bash-powershell:%COZYGATEWAY_POWERSHELL%>>`"$EventLog`"`nif not `"%COZYGATEWAY_TEST_SECRET_PATH%`"==`"`" (`n  for %%I in (`"%COZYGATEWAY_TEST_SECRET_PATH%`") do if not exist `"%%~dpI`" mkdir `"%%~dpI`"`n  >`"%COZYGATEWAY_TEST_SECRET_PATH%`" echo DASHBOARD_SESSION_TOKEN=test-token`n)`nif `"%COZYGATEWAY_TEST_BASH_FAIL%`"==`"1`" exit /b 23`nexit /b 0`n"
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

function ConvertTo-PowerShellSingleQuotedLiteral {
    param([string] $Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function New-FakeUserNetTCPIPModule {
    param([string] $MarkerPath)
    $documents = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
    Assert-True (-not [string]::IsNullOrWhiteSpace($documents)) 'Windows must expose the current user Documents directory for the PSModulePath regression test'
    $windowsPowerShellRoot = Join-Path $documents 'WindowsPowerShell'
    $modulesRoot = Join-Path $windowsPowerShellRoot 'Modules'
    $moduleRoot = Join-Path $modulesRoot 'NetTCPIP'
    Assert-True (-not (Test-Path -LiteralPath $moduleRoot)) "PSModulePath regression test refuses to replace an existing user NetTCPIP module at $moduleRoot"
    $module = [pscustomobject]@{
        ModuleRoot = $moduleRoot
        ModulesRoot = $modulesRoot
        WindowsPowerShellRoot = $windowsPowerShellRoot
        OwnsModuleRoot = $false
        CreatedModulesRoot = $false
        CreatedWindowsPowerShellRoot = $false
    }
    try {
        if (-not (Test-Path -LiteralPath $windowsPowerShellRoot)) {
            try {
                New-Item -ItemType Directory -Path $windowsPowerShellRoot -ErrorAction Stop | Out-Null
                $module.CreatedWindowsPowerShellRoot = $true
            } catch {
                if (-not (Test-Path -LiteralPath $windowsPowerShellRoot -PathType Container)) { throw }
            }
        }
        if (-not (Test-Path -LiteralPath $modulesRoot)) {
            try {
                New-Item -ItemType Directory -Path $modulesRoot -ErrorAction Stop | Out-Null
                $module.CreatedModulesRoot = $true
            } catch {
                if (-not (Test-Path -LiteralPath $modulesRoot -PathType Container)) { throw }
            }
        }
        New-Item -ItemType Directory -Path $moduleRoot -ErrorAction Stop | Out-Null
        $module.OwnsModuleRoot = $true
        $markerLiteral = ConvertTo-PowerShellSingleQuotedLiteral $MarkerPath
        $body = @"
[IO.File]::AppendAllText($markerLiteral, "fake-user-NetTCPIP-executed``r``n")
function Get-NetTCPConnection {
    [CmdletBinding()]
    param([string]`$State)
    return @()
}
Export-ModuleMember -Function Get-NetTCPConnection
"@
        Write-Utf8NoBom (Join-Path $moduleRoot 'NetTCPIP.psm1') $body
        return $module
    } catch {
        Remove-FakeUserNetTCPIPModule $module
        throw
    }
}

function Remove-FakeUserNetTCPIPModule {
    param($Module)
    if ($null -eq $Module) { return }
    if ($Module.OwnsModuleRoot -and (Test-Path -LiteralPath $Module.ModuleRoot)) {
        Remove-Item -LiteralPath $Module.ModuleRoot -Recurse -Force -ErrorAction Stop
    }
    if ($Module.OwnsModuleRoot -and (Test-Path -LiteralPath $Module.ModuleRoot)) { throw "failed to remove temporary user NetTCPIP module: $($Module.ModuleRoot)" }
    if ($Module.CreatedModulesRoot -and (Test-Path -LiteralPath $Module.ModulesRoot) -and @((Get-ChildItem -LiteralPath $Module.ModulesRoot -Force)).Count -eq 0) {
        Remove-Item -LiteralPath $Module.ModulesRoot -Force -ErrorAction Stop
    }
    if ($Module.CreatedWindowsPowerShellRoot -and (Test-Path -LiteralPath $Module.WindowsPowerShellRoot) -and @((Get-ChildItem -LiteralPath $Module.WindowsPowerShellRoot -Force)).Count -eq 0) {
        Remove-Item -LiteralPath $Module.WindowsPowerShellRoot -Force -ErrorAction Stop
    }
}

function Invoke-OwnerHelperScript {
    param([string] $ScriptPath, [int] $Port)
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath 'C:\Expected Hermes Root' 'C:\Expected Hermes Root\bin\hermes.exe' 'C:\Expected Hermes Root\bin\hermes.exe' $Port 2>&1
        return @{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
    } finally {
        $ErrorActionPreference = $previousPreference
    }
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

function Read-ElevationChildCapture {
    param([string] $Path)
    $values = @{}
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        $separatorIndex = $line.IndexOf('=')
        $name = $line.Substring(0, $separatorIndex)
        $encodedValue = $line.Substring($separatorIndex + 1)
        if ($encodedValue -eq '<null>') {
            $values[$name] = $null
        } else {
            try { $values[$name] = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedValue)) }
            catch { throw "invalid child capture value for $name`: $encodedValue" }
        }
    }
    $extraArguments = @()
    if ([int]$values.ExtraArgumentCount -gt 0) { $extraArguments = @(1..([int]$values.ExtraArgumentCount)) }
    return [pscustomobject]@{
        ExpectedRoot = $values.ExpectedRoot
        ExpectedHermes = $values.ExpectedHermes
        ExpectedLauncher = $values.ExpectedLauncher
        ExpectedPort = [int]$values.ExpectedPort
        ElevatedChild = $values.ElevatedChild -eq 'True'
        ExtraArguments = $extraArguments
        DashboardSessionToken = $values.DashboardSessionToken
        ProviderApiKey = $values.ProviderApiKey
        ArbitrarySecret = $values.ArbitrarySecret
        PathValue = $values.PathValue
        PSHomeValue = $values.PSHomeValue
        PSModulePathValue = $values.PSModulePathValue
        SystemRootValue = $values.SystemRootValue
        WindirValue = $values.WindirValue
        ComSpecValue = $values.ComSpecValue
        TempValue = $values.TempValue
        TmpValue = $values.TmpValue
        BoundarySentinel = $values.BoundarySentinel
        NetTCPIPModulePath = $values.NetTCPIPModulePath
        CimCmdletsModuleBase = $values.CimCmdletsModuleBase
        CimCmdletsAssemblyLocation = $values.CimCmdletsAssemblyLocation
    }
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
DASHBOARD_RUNAS_PS1=$(ConvertTo-BashSingleQuotedLiteral $Paths.RunAsHelper)
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
    $startCaptureLiteral = ConvertTo-PowerShellSingleQuotedLiteral $CapturePath
    $resultPath = $Harness + '.result.xml'
    $resultPathLiteral = ConvertTo-PowerShellSingleQuotedLiteral $resultPath
    $cancelLiteral = if ($Cancel) { '$true' } else { '$false' }
    $childCaptureLiteral = ConvertTo-PowerShellSingleQuotedLiteral $ChildCapturePath
    $poisonPrefix = Join-Path (Split-Path -Parent $Harness) 'poisoned-installer-environment'
    $poisonPrefixLiteral = ConvertTo-PowerShellSingleQuotedLiteral $poisonPrefix
    $childBody = @'
$ExpectedRoot = [string]$args[0]
$ExpectedHermes = [string]$args[1]
$ExpectedLauncher = [string]$args[2]
$ExpectedPort = [int]$args[3]
$ElevatedChild = [string]$args[4] -ceq '-ElevatedChild'
$extraArgumentCount = [Math]::Max(0, $args.Count - 5)
$null = Get-NetTCPConnection -State Listen -ErrorAction Stop
$null = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID) -ErrorAction Stop
$netTCPIPCommand = Get-Command Get-NetTCPConnection -CommandType Function,Cmdlet -ErrorAction Stop
$cimCmdletsCommand = Get-Command Get-CimInstance -CommandType Function,Cmdlet -ErrorAction Stop
function ConvertTo-CaptureValue {
    param($Value)
    if ($null -eq $Value) { return '<null>' }
    return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))
}
$captureLines = @(
    ('ExpectedRoot=' + (ConvertTo-CaptureValue $ExpectedRoot))
    ('ExpectedHermes=' + (ConvertTo-CaptureValue $ExpectedHermes))
    ('ExpectedLauncher=' + (ConvertTo-CaptureValue $ExpectedLauncher))
    ('ExpectedPort=' + (ConvertTo-CaptureValue ([string]$ExpectedPort)))
    ('ElevatedChild=' + (ConvertTo-CaptureValue ([string]$ElevatedChild)))
    ('ExtraArgumentCount=' + (ConvertTo-CaptureValue ([string]$extraArgumentCount)))
    ('DashboardSessionToken=' + (ConvertTo-CaptureValue ([Environment]::GetEnvironmentVariable('DASHBOARD_SESSION_TOKEN', 'Process'))))
    ('ProviderApiKey=' + (ConvertTo-CaptureValue ([Environment]::GetEnvironmentVariable('PROVIDER_API_KEY', 'Process'))))
    ('ArbitrarySecret=' + (ConvertTo-CaptureValue ([Environment]::GetEnvironmentVariable('TASK2_REVIEW_ARBITRARY_SECRET', 'Process'))))
    ('PathValue=' + (ConvertTo-CaptureValue ([Environment]::GetEnvironmentVariable('PATH', 'Process'))))
    ('PSHomeValue=' + (ConvertTo-CaptureValue ([Environment]::GetEnvironmentVariable('PSHOME', 'Process'))))
    ('PSModulePathValue=' + (ConvertTo-CaptureValue ([Environment]::GetEnvironmentVariable('PSModulePath', 'Process'))))
    ('SystemRootValue=' + (ConvertTo-CaptureValue ([Environment]::GetEnvironmentVariable('SystemRoot', 'Process'))))
    ('WindirValue=' + (ConvertTo-CaptureValue ([Environment]::GetEnvironmentVariable('WINDIR', 'Process'))))
    ('ComSpecValue=' + (ConvertTo-CaptureValue ([Environment]::GetEnvironmentVariable('COMSPEC', 'Process'))))
    ('TempValue=' + (ConvertTo-CaptureValue ([Environment]::GetEnvironmentVariable('TEMP', 'Process'))))
    ('TmpValue=' + (ConvertTo-CaptureValue ([Environment]::GetEnvironmentVariable('TMP', 'Process'))))
    ('BoundarySentinel=' + (ConvertTo-CaptureValue ([Environment]::GetEnvironmentVariable('COZYGATEWAY_UAC_BOUNDARY_SENTINEL', 'Process'))))
    ('NetTCPIPModulePath=' + (ConvertTo-CaptureValue $netTCPIPCommand.Module.Path))
    ('CimCmdletsModuleBase=' + (ConvertTo-CaptureValue $cimCmdletsCommand.Module.ModuleBase))
    ('CimCmdletsAssemblyLocation=' + (ConvertTo-CaptureValue $cimCmdletsCommand.ImplementingType.Assembly.Location))
)
[IO.File]::WriteAllLines(__CHILD_CAPTURE__, [string[]]$captureLines, [Text.UTF8Encoding]::new($false))
exit __CHILD_CODE__
'@
    $childBody = $childBody.Replace('__CHILD_CAPTURE__', $childCaptureLiteral).Replace('__CHILD_CODE__', [string]$ChildCode)
    Write-Utf8NoBom $Paths.Helper $childBody
    $harnessBody = @'
param([string]$Wrapper, [string]$Root, [string]$Hermes, [string]$Launcher, [int]$Port, [string]$Helper)
function Get-ProcessEnvironment {
    $snapshot = @{}
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
        $snapshot[[string]$entry.Key] = [string]$entry.Value
    }
    return $snapshot
}
function Start-Process {
    param([string]$FilePath, [string]$WorkingDirectory, [string]$Verb, [switch]$Wait, [switch]$PassThru, [switch]$UseNewEnvironment, [string[]]$ArgumentList)
    $script:StartCount++
    [pscustomobject]@{
        Count = $script:StartCount
        FilePath = $FilePath
        WorkingDirectory = $WorkingDirectory
        Verb = $Verb
        Wait = $Wait.IsPresent
        PassThru = $PassThru.IsPresent
        UseNewEnvironment = $UseNewEnvironment.IsPresent
        ArgumentList = @($ArgumentList)
        Environment = Get-ProcessEnvironment
    } | Export-Clixml -LiteralPath __START_CAPTURE__
    if (__CANCEL__) { throw 'The operation was canceled by the user.' }
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $FilePath
    $info.WorkingDirectory = $WorkingDirectory
    $info.Arguments = $ArgumentList -join ' '
    $info.UseShellExecute = $false
    $process = [Diagnostics.Process]::Start($info)
    $process.WaitForExit()
    return [pscustomobject]@{ ExitCode = $process.ExitCode }
}
$script:StartCount = 0
[pscustomobject]@{ Warm = $true } | Export-Clixml -LiteralPath __START_CAPTURE__
Remove-Item -LiteralPath __START_CAPTURE__ -Force
$poisonPrefix = __POISON_PREFIX__
$env:PATH = Join-Path $poisonPrefix 'PATH'
$env:PSHOME = Join-Path $poisonPrefix 'PSHOME'
$env:PSModulePath = Join-Path $poisonPrefix 'PSModulePath'
$env:SystemRoot = Join-Path $poisonPrefix 'SystemRoot'
$env:WINDIR = Join-Path $poisonPrefix 'WINDIR'
$env:COMSPEC = Join-Path $poisonPrefix 'COMSPEC\cmd.exe'
$env:TEMP = Join-Path $poisonPrefix 'TEMP'
$env:TMP = Join-Path $poisonPrefix 'TMP'
$env:COZYGATEWAY_UAC_BOUNDARY_SENTINEL = Join-Path $poisonPrefix 'sentinel'
$before = Get-ProcessEnvironment
& $Wrapper $Root $Hermes $Launcher $Port $Helper
$wrapperExitCode = $LASTEXITCODE
$after = Get-ProcessEnvironment
$restored = $before.Count -eq $after.Count
foreach ($key in $before.Keys) {
    if (-not $after.ContainsKey($key) -or $after[$key] -cne $before[$key]) { $restored = $false }
}
[pscustomobject]@{
    WrapperExitCode = $wrapperExitCode
    EnvironmentRestored = $restored
    StartCount = $script:StartCount
    Before = $before
    After = $after
} | Export-Clixml -LiteralPath __RESULT_PATH__
exit 0
'@
    $harnessBody = $harnessBody.Replace('__START_CAPTURE__', $startCaptureLiteral).Replace('__CANCEL__', $cancelLiteral).Replace('__RESULT_PATH__', $resultPathLiteral).Replace('__POISON_PREFIX__', $poisonPrefixLiteral)
    Write-Utf8NoBom $Harness $harnessBody
    Remove-Item -LiteralPath $CapturePath, $ChildCapturePath, $resultPath -Force -ErrorAction SilentlyContinue
    $keys = @('DASHBOARD_SESSION_TOKEN', 'PROVIDER_API_KEY', 'TASK2_REVIEW_ARBITRARY_SECRET')
    $old = @{}
    foreach ($key in $keys) { $old[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
    try {
        $env:DASHBOARD_SESSION_TOKEN = 'task-2-secret-token'
        $env:PROVIDER_API_KEY = 'task-2-provider-secret'
        $env:TASK2_REVIEW_ARBITRARY_SECRET = 'task-2-arbitrary-secret'
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Harness $Wrapper $Paths.Root $Paths.Hermes $Paths.Launcher 9119 $Paths.Helper 2>&1
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousPreference
        Assert-True ($exitCode -eq 0) "elevation harness process failed with $exitCode`: $($output -join "`n")"
        $result = Import-Clixml -LiteralPath $resultPath
        return @{ ExitCode = $result.WrapperExitCode; Output = ($output -join "`n"); EnvironmentRestored = $result.EnvironmentRestored; StartCount = $result.StartCount; Before = $result.Before; After = $result.After }
    } finally {
        $ErrorActionPreference = $previousPreference
        foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $old[$key], 'Process') }
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$installer = if ($env:COZYGATEWAY_TEST_INSTALLER_UNDER_TEST) { $env:COZYGATEWAY_TEST_INSTALLER_UNDER_TEST } else { Join-Path $repoRoot 'scripts\install.ps1' }
$temp = Join-Path ([IO.Path]::GetTempPath()) ("cozygateway-windows-bootstrap-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
$fakeUserNetTCPIP = $null

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

    Remove-Item -LiteralPath $eventLog -Force -ErrorAction SilentlyContinue
    $incompatibleUpdated = Join-Path $temp 'incompatible-hermes-updated.txt'
    $incompatible = Invoke-Bootstrap $installer @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Incompatible Hermes Gateway')
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
        'COZYGATEWAY_TEST_HERMES_VERSION' = '0.20.5'
        'COZYGATEWAY_TEST_HERMES_UPDATED_FILE' = $incompatibleUpdated
    }
    Assert-True ($incompatible.ExitCode -eq 0) "Hermes v0.20.5 must update before the CozyGateway handoff: $($incompatible.Output)"
    Assert-True ($incompatible.Output -match 'updated Hermes from v0\.20\.5 to v0\.21\.0') 'incompatible Hermes update must name the old and verified new versions'
    $incompatibleEvents = Get-Content -LiteralPath $eventLog
    $trustedBootstrapPowerShell = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    Assert-True ($incompatibleEvents -contains "bash-powershell:$trustedBootstrapPowerShell") 'verified bootstrap must hand the shared installer an absolute native PowerShell path'
    $incompatibleUpdateIndex = [Array]::IndexOf($incompatibleEvents, 'hermes:update --yes')
    $incompatibleBashIndex = ($incompatibleEvents | Select-String '^bash:' | Select-Object -First 1).LineNumber - 1
    Assert-True ($incompatibleUpdateIndex -ge 0 -and $incompatibleBashIndex -gt $incompatibleUpdateIndex) 'Hermes update must complete before the CozyGateway Bash handoff'
    Remove-Item -LiteralPath $eventLog -Force -ErrorAction SilentlyContinue

    $prereleaseUpdated = Join-Path $temp 'prerelease-hermes-updated.txt'
    $prerelease = Invoke-Bootstrap $installer @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Prerelease Hermes Gateway')
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
        'COZYGATEWAY_TEST_HERMES_VERSION' = '0.21.0-beta.1'
        'COZYGATEWAY_TEST_HERMES_UPDATED_FILE' = $prereleaseUpdated
    }
    Assert-True ($prerelease.ExitCode -eq 0) "Hermes prerelease must update to stable before the CozyGateway handoff: $($prerelease.Output)"
    Assert-True ($prerelease.Output -match 'updated Hermes from v0\.21\.0-beta\.1 to v0\.21\.0') 'prerelease Hermes update must name the prerelease and verified stable version'
    $prereleaseEvents = Get-Content -LiteralPath $eventLog
    $prereleaseUpdateIndex = [Array]::IndexOf($prereleaseEvents, 'hermes:update --yes')
    $prereleaseBashIndex = ($prereleaseEvents | Select-String '^bash:' | Select-Object -First 1).LineNumber - 1
    Assert-True ($prereleaseUpdateIndex -ge 0 -and $prereleaseBashIndex -gt $prereleaseUpdateIndex) 'Hermes prerelease update must complete before the CozyGateway Bash handoff'
    Remove-Item -LiteralPath $eventLog -Force -ErrorAction SilentlyContinue

    $updateFailure = Invoke-Bootstrap $installer @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Failed Hermes Update Gateway')
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
        'COZYGATEWAY_TEST_HERMES_VERSION' = '0.20.5'
        'COZYGATEWAY_TEST_HERMES_UPDATE_FAIL' = '1'
        'COZYGATEWAY_TEST_HERMES_UPDATED_FILE' = (Join-Path $temp 'failed-hermes-update.txt')
    }
    Assert-True ($updateFailure.ExitCode -ne 0) 'a failed Hermes update must fail the installer'
    Assert-True ($updateFailure.Output -match 'Hermes update failed') 'a failed Hermes update must report an actionable error'
    $updateFailureEvents = Get-Content -LiteralPath $eventLog
    Assert-True ([Array]::IndexOf($updateFailureEvents, 'hermes:update --yes') -ge 0) 'the incompatible Hermes path must attempt update --yes'
    Assert-True (-not (($updateFailureEvents -join "`n") -match '(?m)^bash:')) 'a failed Hermes update must stop before the CozyGateway Bash handoff'
    Remove-Item -LiteralPath $eventLog -Force -ErrorAction SilentlyContinue

    foreach ($incompatibleResult in @('0.20.5', '0.21.1-beta.1')) {
        $resultMarker = Join-Path $temp ("hermes-update-result-" + $incompatibleResult.Replace('.', '-') + '.txt')
        $stillIncompatible = Invoke-Bootstrap $installer @{
            'PATH' = "$fakeBin;$env:PATH"
            'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
            'COZYGATEWAY_HOME' = (Join-Path $temp ("Still Incompatible Hermes " + $incompatibleResult))
            'COZYGATEWAY_GIT_BASH' = $fakeBash
            'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
            'COZYGATEWAY_TEST_HERMES_VERSION' = '0.20.5'
            'COZYGATEWAY_TEST_HERMES_UPDATE_RESULT' = $incompatibleResult
            'COZYGATEWAY_TEST_HERMES_UPDATED_FILE' = $resultMarker
        }
        Assert-True ($stillIncompatible.ExitCode -ne 0) "Hermes update result v$incompatibleResult must remain fail-closed"
        Assert-True ($stillIncompatible.Output -match 'did not install a compatible stable version' -and $stillIncompatible.Output -match [regex]::Escape("found v$incompatibleResult")) "incompatible update result v$incompatibleResult must be reported exactly"
        $stillIncompatibleEvents = Get-Content -LiteralPath $eventLog
        Assert-True ([Array]::IndexOf($stillIncompatibleEvents, 'hermes:update --yes') -ge 0) "Hermes update result v$incompatibleResult must include an update attempt"
        Assert-True (-not (($stillIncompatibleEvents -join "`n") -match '(?m)^bash:')) "Hermes update result v$incompatibleResult must stop before the CozyGateway Bash handoff"
        Remove-Item -LiteralPath $eventLog -Force -ErrorAction SilentlyContinue
    }

    $newerStable = Invoke-Bootstrap $installer @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Newer Stable Hermes Gateway')
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
        'COZYGATEWAY_TEST_HERMES_VERSION' = '0.22.0'
    }
    Assert-True ($newerStable.ExitCode -eq 0) "newer stable Hermes must proceed without update: $($newerStable.Output)"
    $newerStableEvents = Get-Content -LiteralPath $eventLog
    Assert-True ([Array]::IndexOf($newerStableEvents, 'hermes:update --yes') -eq -1) 'newer stable Hermes must not invoke update'
    Assert-True (($newerStableEvents -join "`n") -match '(?m)^bash:') 'newer stable Hermes must proceed to the CozyGateway Bash handoff'
    Remove-Item -LiteralPath $eventLog -Force -ErrorAction SilentlyContinue

    $repairMetadataHome = Join-Path $temp 'missing repair metadata'
    $repairBootstrap = Join-Path $repairMetadataHome 'bin\cozygateway-bootstrap.ps1'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $repairBootstrap) | Out-Null
    Copy-Item -LiteralPath $installer -Destination $repairBootstrap
    $repairHash = (Get-FileHash -LiteralPath $repairBootstrap -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Utf8NoBom "$repairBootstrap.sha256" "$repairHash  install.ps1`n"
    $missingRepairMetadata = Invoke-Bootstrap $installer @{
        'COZYGATEWAY_HOME' = $repairMetadataHome
    } @('-Repair')
    Assert-True ($missingRepairMetadata.ExitCode -ne 0) 'repair with missing metadata must fail closed'
    Assert-True ($missingRepairMetadata.Output -match 'repair metadata is unavailable. Reinstall with: irm https://cozylabs.ai/install.ps1 \| iex') 'repair metadata failures must print canonical reinstall guidance'

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
    $persistedBootstrap = Join-Path $temp 'Cozy Gateway\bin\cozygateway-bootstrap.ps1'
    Assert-True (Test-Path -LiteralPath $persistedBootstrap) 'Windows bootstrap must persist its verified repair bootstrap'
    Assert-True (Test-Path -LiteralPath "$persistedBootstrap.sha256") 'Windows bootstrap must persist the repair bootstrap checksum'
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $temp 'Cozy Gateway') -Filter '.bootstrap-*' -Force).Count -eq 0) 'successful bootstrap must remove its staging directory'

    $bundleBeforeLateFailure = [IO.File]::ReadAllBytes((Join-Path $temp 'Cozy Gateway\bin\cozygateway.mjs'))
    $pluginBeforeLateFailure = [IO.File]::ReadAllBytes((Join-Path $temp 'Cozy Gateway\bin\cozygateway-hermes-attach-plugin.tar.gz'))
    $originalInstallPs1 = [IO.File]::ReadAllText((Join-Path $fixtures 'install.ps1'))
    Write-Utf8NoBom (Join-Path $fixtures 'install.ps1') "tampered bootstrap`n"
    Remove-Item -LiteralPath $eventLog -Force -ErrorAction SilentlyContinue
    $lateAssetFailure = Invoke-Bootstrap $installer @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Cozy Gateway')
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
    }
    Assert-True ($lateAssetFailure.ExitCode -ne 0 -and $lateAssetFailure.Output -match 'install.ps1 checksum mismatch') 'a late bootstrap checksum mismatch must fail before promotion'
    Assert-True ([Linq.Enumerable]::SequenceEqual($bundleBeforeLateFailure, [IO.File]::ReadAllBytes((Join-Path $temp 'Cozy Gateway\bin\cozygateway.mjs'))) ) 'late checksum failure must not replace the installed bundle'
    Assert-True ([Linq.Enumerable]::SequenceEqual($pluginBeforeLateFailure, [IO.File]::ReadAllBytes((Join-Path $temp 'Cozy Gateway\bin\cozygateway-hermes-attach-plugin.tar.gz'))) ) 'late checksum failure must not replace the installed plugin'
    Assert-True (-not ((Get-Content -LiteralPath $eventLog -Raw -ErrorAction SilentlyContinue) -match '(?m)^bash:')) 'late checksum failure must not invoke the installer payload'
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $temp 'Cozy Gateway') -Filter '.bootstrap-*' -Force).Count -eq 0) 'failed bootstrap must remove its staging directory'
    Write-Utf8NoBom (Join-Path $fixtures 'install.ps1') $originalInstallPs1

    $restoreWrapper = Join-Path $temp 'verify-hermes-env-restore.ps1'
    Write-Utf8NoBom $restoreWrapper @"
`$env:COZYGATEWAY_HERMES_BIN = 'preexisting-hermes-value'
`$env:COZYGATEWAY_POWERSHELL = 'preexisting-powershell-value'
try {
    & ([scriptblock]::Create([IO.File]::ReadAllText('$installer')))
} catch {}
if (`$env:COZYGATEWAY_HERMES_BIN -cne 'preexisting-hermes-value') { exit 31 }
if (`$env:COZYGATEWAY_POWERSHELL -cne 'preexisting-powershell-value') { exit 32 }
"@
    $restore = Invoke-Bootstrap $restoreWrapper @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Failed Handoff Gateway')
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
        'COZYGATEWAY_TEST_BASH_FAIL' = '1'
    }
    Assert-True ($restore.ExitCode -eq 0) "failed Bash handoff must restore installer-owned process environment: $($restore.Output)"

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
    Assert-True ($agentInstaller.Contains('Get-FileHash -LiteralPath \$p -Algorithm SHA256')) 'generated Windows repair command must independently checksum its bootstrap'
    $cliWriterMatch = [regex]::Match($agentInstaller, '(?ms)^write_cli_wrapper\(\) \{.*?^\}')
    Assert-True $cliWriterMatch.Success 'shared installer must define write_cli_wrapper'
    $wrapperWriterMatch = [regex]::Match($agentInstaller, '(?ms)^write_wrapper\(\) \{.*?^\}\r?\n(?=vbs_quote\(\))')
    Assert-True $wrapperWriterMatch.Success 'shared installer must define the gateway supervisor writer'
    $gatewayStopFunctionMatch = [regex]::Match($agentInstaller, '(?ms)^stop_owned_windows_gateway\(\) \{.*?^\}')
    Assert-True $gatewayStopFunctionMatch.Success 'shared installer must define the Windows gateway stop helper'
    $elevationWriterMatch = [regex]::Match($agentInstaller, '(?ms)^write_dashboard_elevation_helper\(\) \{.*?^\}')
    Assert-True $elevationWriterMatch.Success 'shared installer must define write_dashboard_elevation_helper'
    $stopFunctionMatch = [regex]::Match($agentInstaller, '(?ms)^stop_stubborn_windows_dashboard\(\) \{.*?^\}')
    Assert-True $stopFunctionMatch.Success 'shared installer must define stop_stubborn_windows_dashboard'
    $gitCommand = Get-Command git.exe -ErrorAction Stop
    $gitRoot = Split-Path -Parent (Split-Path -Parent $gitCommand.Source)
    $bashPath = Join-Path $gitRoot 'bin\bash.exe'
    Assert-True (Test-Path -LiteralPath $bashPath) 'Git for Windows bash.exe must be available for the shared-installer harness'
    $repairHome = Join-Path $temp 'Custom Cozy Gateway Home'
    $repairBootstrap = Join-Path $repairHome 'bin\cozygateway-bootstrap.ps1'
    $repairMarker = Join-Path $temp 'repair-home-marker.txt'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $repairBootstrap) | Out-Null
    Write-Utf8NoBom $repairBootstrap "[IO.File]::AppendAllText('$repairMarker', [string]`$env:COZYGATEWAY_HOME + [Environment]::NewLine)`n"
    $repairHash = (Get-FileHash -LiteralPath $repairBootstrap -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Utf8NoBom "$repairBootstrap.sha256" "$repairHash  install.ps1`n"
    $repairCmd = Join-Path $repairHome 'bin\cozygateway.cmd'
    $trustedRepairPowerShell = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    $cliWriterHarness = Join-Path $temp 'generate-cli-wrapper.sh'
    $cliWriterScript = @"
#!/usr/bin/env bash
set -euo pipefail
GATEWAY_DIR="`$(cygpath -u "`$1")"
WINDOWS_POWERSHELL="`$2"
DRY_RUN=0
NODE_RESOLVED="`$GATEWAY_DIR/runtime/node/node.exe"
BUNDLE_PATH="`$GATEWAY_DIR/bin/cozygateway.mjs"
LOCAL_DIR="`$GATEWAY_DIR/local"
STATE_FILE="`$LOCAL_DIR/install-state"
CLI_WRAPPER="`$GATEWAY_DIR/bin/cozygateway"
CLI_WINDOWS="`$GATEWAY_DIR/bin/cozygateway.cmd"
POSIX_BOOTSTRAP="`$GATEWAY_DIR/bin/cozygateway-bootstrap.sh"
WINDOWS_BOOTSTRAP="`$GATEWAY_DIR/bin/cozygateway-bootstrap.ps1"
say() { printf '%s\n' "`$*"; }
is_windows() { return 0; }
to_windows_path() { cygpath -w "`$1"; }
$($cliWriterMatch.Value)
write_cli_wrapper
"@
    Write-Utf8NoBom $cliWriterHarness $cliWriterScript
    $cliWriterOutput = (& $bashPath $cliWriterHarness $repairHome $trustedRepairPowerShell 2>&1 | Out-String)
    Assert-True ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $repairCmd)) "actual installer must generate the Windows command shim: $cliWriterOutput"
    $generatedRepairCmd = Get-Content -LiteralPath $repairCmd -Raw
    Assert-True ($generatedRepairCmd -match [regex]::Escape('"' + $trustedRepairPowerShell + '"')) 'generated repair shim must pin the trusted native PowerShell executable'
    $repairRun = (& cmd.exe /c $repairCmd repair 2>&1 | Out-String)
    Assert-True ($LASTEXITCODE -eq 0 -and @((Get-Content -LiteralPath $repairMarker)).Count -eq 1 -and (Get-Content -LiteralPath $repairMarker -Raw).Trim() -eq $repairHome) 'generated repair shim must pass the custom installed home to its bootstrap'
    $extraRepair = (& cmd.exe /c $repairCmd repair unexpected 2>&1 | Out-String)
    Assert-True ($LASTEXITCODE -ne 0 -and $extraRepair -match 'does not accept extra arguments' -and @((Get-Content -LiteralPath $repairMarker)).Count -eq 1) 'generated repair shim must reject extra arguments before bootstrap execution'
    $hijackDirectory = Join-Path $temp 'repair current directory hijack'
    $hijackPowerShell = Join-Path $hijackDirectory 'powershell.exe'
    $hijackLog = Join-Path $temp 'repair-hijack.log'
    New-FakePowerShell $hijackPowerShell $hijackLog
    $env:COZYGATEWAY_TEST_NORMAL_CODE = '0'
    Push-Location $hijackDirectory
    try {
        $repairFromHostileDirectory = (& cmd.exe /c $repairCmd repair 2>&1 | Out-String)
        $repairFromHostileExit = $LASTEXITCODE
    } finally {
        Pop-Location
        Remove-Item Env:COZYGATEWAY_TEST_NORMAL_CODE -ErrorAction SilentlyContinue
    }
    Assert-True ($repairFromHostileExit -eq 0 -and -not (Test-Path -LiteralPath $hijackLog) -and @((Get-Content -LiteralPath $repairMarker)).Count -eq 2) 'generated repair shim must ignore a current-directory powershell.exe'
    Add-Content -LiteralPath $repairBootstrap -Value '# tampered'
    $tamperedRepair = (& cmd.exe /c $repairCmd repair 2>&1 | Out-String)
    Assert-True ($LASTEXITCODE -ne 0 -and $tamperedRepair -match 'repair bootstrap checksum mismatch' -and @((Get-Content -LiteralPath $repairMarker)).Count -eq 2) 'generated repair shim must reject a tampered bootstrap before execution'

    # The managed process is a Node supervisor, not the `serve` child. Killing
    # only the child appears to free the port, then the supervisor restarts it
    # one second later and wins the replacement race. Exercise the real stop
    # helper against that exact command-line contract, then wait past restart.
    $supervisorRoot = Join-Path $temp 'gateway supervisor replacement race'
    $supervisorLocal = Join-Path $supervisorRoot 'local'
    New-Item -ItemType Directory -Force -Path $supervisorLocal | Out-Null
    $supervisorConfig = Join-Path $supervisorLocal 'cozygateway.config.json'
    $supervisorGatewayEnv = Join-Path $supervisorLocal 'gateway.env'
    $supervisorDashboardEnv = Join-Path $supervisorLocal 'dashboard.env'
    $supervisorBundle = Join-Path $supervisorRoot 'bin\cozygateway.mjs'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $supervisorBundle) | Out-Null
    $portReservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $portReservation.Start()
    $supervisorPort = ([Net.IPEndPoint]$portReservation.LocalEndpoint).Port
    $portReservation.Stop()
    Write-Utf8NoBom $supervisorConfig "{`"port`":$supervisorPort}`n"
    Write-Utf8NoBom $supervisorGatewayEnv "TOKEN=fixture`n"
    Write-Utf8NoBom $supervisorDashboardEnv "DASHBOARD_SESSION_TOKEN=fixture`n"
    Write-Utf8NoBom $supervisorBundle @'
import { readFileSync } from 'node:fs';
import net from 'node:net';
if (process.argv.includes('--foreign')) {
  setInterval(() => {}, 1000);
} else {
const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8'));
const server = net.createServer();
server.listen(config.port, '127.0.0.1');
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
}
'@
    $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
    $nodePosix = (& cygpath.exe -u $nodeExecutable).Trim()
    $toPosix = { param([string] $Path) (& cygpath.exe -u $Path).Trim() }
    $gatewayEnvPosix = & $toPosix $supervisorGatewayEnv
    $dashboardEnvPosix = & $toPosix $supervisorDashboardEnv
    $bundlePosix = & $toPosix $supervisorBundle
    $configPosix = & $toPosix $supervisorConfig
    $hermesRootPosix = & $toPosix (Join-Path $supervisorRoot 'hermes')
    $hermesPosix = & $toPosix (Join-Path $supervisorRoot 'hermes\bin\hermes-agent.exe')
    $launcherPosix = & $toPosix (Join-Path $supervisorRoot 'hermes\bin\hermes.exe')
    $ownerHelperPosix = & $toPosix (Join-Path $supervisorLocal 'dashboard-owner.ps1')
    $dashboardReservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $dashboardReservation.Start()
    $supervisorDashboardPort = ([Net.IPEndPoint]$dashboardReservation.LocalEndpoint).Port
    $dashboardReservation.Stop()
    $dashboardSource = Join-Path $supervisorRoot 'dashboard.mjs'
    Write-Utf8NoBom $dashboardSource @'
import http from 'node:http';
const server = http.createServer((request, response) => {
  response.writeHead((request.url === '/api/health' || request.url === '/api/config') ? 200 : 404);
  response.end('{}');
});
server.listen(Number(process.argv[2]), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
'@
    $dashboard = Start-Process -FilePath $nodeExecutable -ArgumentList @($dashboardSource, $supervisorDashboardPort) -PassThru
    $dashboardReady = $false
    for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
        $dashboardProbe = [Net.Sockets.TcpClient]::new()
        try {
            $dashboardProbe.Connect('127.0.0.1', $supervisorDashboardPort)
            $dashboardReady = $true
            break
        } catch {
            Start-Sleep -Milliseconds 100
        } finally {
            $dashboardProbe.Dispose()
        }
    }
    Assert-True $dashboardReady 'fixture Dashboard must be ready before generating the gateway supervisor'
    $wrapperGenerator = Join-Path $temp 'generate-gateway-supervisor.sh'
    $generatedWrapper = Join-Path $supervisorLocal 'run-gateway.sh'
    $wrapperGeneratorScript = @"
#!/usr/bin/env bash
set -euo pipefail
GATEWAY_DIR="`$1"
LOCAL_DIR="`$2"
WRAPPER="`$3"
GATEWAY_ENV="`$4"
DASHBOARD_ENV="`$5"
HERMES_ROOT="`$6"
HERMES_RESOLVED="`$7"
DASHBOARD_OWNER_PS1="`$8"
DASHBOARD_PORT="`$9"
NODE_RESOLVED="`${10}"
BUNDLE_PATH="`${11}"
DRY_RUN=0
say() { printf '%s\n' "`$*"; }
is_windows() { return 0; }
to_windows_path() { cygpath -w "`$1"; }
$($wrapperWriterMatch.Value)
write_wrapper
"@
    Write-Utf8NoBom $wrapperGenerator $wrapperGeneratorScript
    $wrapperOutput = (& $bashPath $wrapperGenerator $supervisorRoot $supervisorLocal $generatedWrapper $gatewayEnvPosix $dashboardEnvPosix $hermesRootPosix $hermesPosix $ownerHelperPosix $supervisorDashboardPort $nodePosix $bundlePosix 2>&1 | Out-String)
    Assert-True ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $generatedWrapper)) "production writer must generate the supervisor: $wrapperOutput"
    $wrapperArgument = '"' + $generatedWrapper + '"'
    $supervisor = Start-Process -FilePath $bashPath -ArgumentList $wrapperArgument -PassThru
    $staleSupervisor = Start-Process -FilePath $bashPath -ArgumentList $wrapperArgument -PassThru
    $foreignChild = Start-Process -FilePath $nodeExecutable -ArgumentList @($supervisorBundle, 'serve', '--config', $supervisorConfig, '--foreign') -PassThru
    $uninstallSupervisor = $null
    try {
        $listening = $false
        for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
            $probe = [Net.Sockets.TcpClient]::new()
            try {
                $probe.Connect('127.0.0.1', $supervisorPort)
                $listening = $true
                break
            } catch {
                Start-Sleep -Milliseconds 100
            } finally {
                $probe.Dispose()
            }
        }
        Assert-True $listening 'fixture supervisor must start its managed gateway child'
        $gatewayStopHarness = Join-Path $temp 'gateway supervisor stop harness.sh'
        $gatewayStopScript = @"
#!/usr/bin/env bash
set -euo pipefail
PORT="`$1"
CONFIG_JSON="`$2"
GATEWAY_ENV="`$3"
DASHBOARD_ENV="`$4"
NODE_RESOLVED="`$5"
BUNDLE_PATH="`$6"
HERMES_ROOT="`$7"
HERMES_RESOLVED="`$8"
DASHBOARD_OWNER_PS1="`$9"
to_windows_path() { cygpath -w "`$1"; }
gateway_ready() { return 1; }
die() { printf 'FAIL  %s\n' "`$*" >&2; exit 1; }
$($gatewayStopFunctionMatch.Value)
stop_owned_windows_gateway
"@
        Write-Utf8NoBom $gatewayStopHarness $gatewayStopScript
        $stopOutput = (& $bashPath $gatewayStopHarness $supervisorPort $configPosix $gatewayEnvPosix $dashboardEnvPosix $nodePosix $bundlePosix $hermesRootPosix $hermesPosix $ownerHelperPosix 2>&1 | Out-String)
        Assert-True ($LASTEXITCODE -eq 0) "owned gateway stop helper failed: $stopOutput"
        Start-Sleep -Milliseconds 1500
        $foreignChild.Refresh()
        Assert-True (-not $foreignChild.HasExited) 'a same-bundle/config process with an extra argument must remain untouched'
        $reacquired = $false
        $replacement = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $supervisorPort)
        try {
            $replacement.Start()
            $reacquired = $true
        } catch {
            $reacquired = $false
        } finally {
            if ($reacquired) { $replacement.Stop() }
        }
        Assert-True $reacquired 'in-place update must stop the owned supervisor so it cannot reclaim the gateway port'
        $uninstallSupervisor = Start-Process -FilePath $bashPath -ArgumentList $wrapperArgument -PassThru
        Start-Sleep -Milliseconds 250
        $uninstallStopHarness = Join-Path $temp 'gateway uninstall stop harness.sh'
        $uninstallStopScript = @"
#!/usr/bin/env bash
set -euo pipefail
PORT="`$1"
CONFIG_JSON="`$2"
GATEWAY_ENV="`$3"
DASHBOARD_ENV="`$4"
HERMES_ROOT="`$5"
HERMES_RESOLVED="`$6"
DASHBOARD_OWNER_PS1="`$7"
WRAPPER="`$8"
DASHBOARD_PORT="`$9"
unset NODE_RESOLVED BUNDLE_PATH
to_windows_path() { cygpath -w "`$1"; }
gateway_ready() { return 1; }
die() { printf 'FAIL  %s\n' "`$*" >&2; exit 1; }
$($gatewayStopFunctionMatch.Value)
stop_owned_windows_gateway 0
"@
        Write-Utf8NoBom $uninstallStopHarness $uninstallStopScript
        $uninstallOutput = (& $bashPath $uninstallStopHarness $supervisorPort $configPosix $gatewayEnvPosix $dashboardEnvPosix $hermesRootPosix $hermesPosix $ownerHelperPosix $generatedWrapper $supervisorDashboardPort 2>&1 | Out-String)
        Assert-True ($LASTEXITCODE -eq 0) "uninstall-owned gateway stop helper failed: $uninstallOutput"
        Start-Sleep -Milliseconds 1500
        $uninstallReacquired = $false
        $uninstallReplacement = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $supervisorPort)
        try {
            $uninstallReplacement.Start()
            $uninstallReacquired = $true
        } catch {
            $uninstallReacquired = $false
        } finally {
            if ($uninstallReacquired) { $uninstallReplacement.Stop() }
        }
        Assert-True $uninstallReacquired 'uninstall must stop a running generated supervisor even before Node and bundle are resolved'
    } finally {
        & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $supervisor.Id /T /F 2>$null | Out-Null
        & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $staleSupervisor.Id /T /F 2>$null | Out-Null
        if ($null -ne $uninstallSupervisor) { & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $uninstallSupervisor.Id /T /F 2>$null | Out-Null }
        & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $foreignChild.Id /T /F 2>$null | Out-Null
        & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $dashboard.Id /T /F 2>$null | Out-Null
    }

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
        RunAsHelper = "C:\Users\O'Brien\Cozy Gateway\local\dashboard owner runas.ps1"
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
    $ownerMatch = [regex]::Match($agentInstaller, "(?ms)<<'POWERSHELL_OWNER'\r?\n(?<Body>.*?)\r?\nPOWERSHELL_OWNER")
    Assert-True $ownerMatch.Success 'shared installer must generate a PowerShell Dashboard owner helper'
    $runAsMatch = [regex]::Match($agentInstaller, "(?ms)<<'POWERSHELL_RUNAS'\r?\n(?<Body>.*?)\r?\nPOWERSHELL_RUNAS")
    Assert-True (-not $runAsMatch.Success) 'shared installer must not generate a second PowerShell elevation stage'
    $elevationWrapper = Join-Path $temp 'dashboard owner elevate.ps1'
    Write-Utf8NoBom $elevationWrapper $elevationMatch.Groups['Body'].Value
    $elevatedChild = Join-Path $temp "O'Brien Cozy Gateway\dashboard owner.ps1"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $elevatedChild) | Out-Null
    $wrapperPaths = @{
        Root = $dashboardPaths.Root
        Hermes = $dashboardPaths.Hermes
        Launcher = $dashboardPaths.Launcher
        Helper = $elevatedChild
    }
    $startCapture = Join-Path $temp 'start-process.xml'
    $childCapture = Join-Path $temp 'elevated-child.xml'
    $wrapperHarness = Join-Path $temp 'elevation wrapper harness.ps1'
    $elevationBody = $elevationMatch.Groups['Body'].Value
    Assert-True (-not ($elevationBody -match 'UseNewEnvironment')) 'elevation wrapper must not use -UseNewEnvironment'
    Assert-True ($elevationBody -match 'GetEnvironmentVariables\("Process"\)') 'elevation wrapper must snapshot and enumerate every Process-scope environment entry'
    Assert-True ($elevationBody -match 'Set-CozyProcessEnvironmentVariable \(\[string\]\$name\) \$null') 'elevation wrapper must clear every enumerated Process-scope entry rather than use a secret-name denylist'
    Assert-True (-not ($elevationBody -match 'DASHBOARD_SESSION_TOKEN|PROVIDER_API_KEY|TASK2_REVIEW_ARBITRARY_SECRET')) 'production sanitization must not depend on known secret names'
    Assert-True (-not ($elevationBody -match 'GetEnvironmentVariables\("(?:User|Machine)"\)')) 'elevation wrapper must not source User or Machine environment blocks'
    Assert-True ($elevationBody -match 'GetSystemDirectoryW' -and $elevationBody -match 'GetWindowsDirectoryW' -and $elevationBody -match 'kernel32\.dll') 'elevation wrapper must resolve native Windows directories through kernel32 KnownDLL'
    Assert-True ($elevationBody -match 'SetLastError' -and $elevationBody -match '\[Runtime\.InteropServices\.Marshal\]::GetLastWin32Error\(\)') 'elevation wrapper must preserve and check errors from each native call'
    Assert-True ($elevationWriterMatch.Value -match 'is_windows \|\| return 0') 'elevation helper files must be generated only on Windows'
    Assert-True ($agentInstaller -match 'is_windows && write_dashboard_elevation_helper') 'non-Windows install flow must not invoke elevation-helper generation'

    $fakeModuleMarker = Join-Path $temp 'fake-user-module-executed.txt'
    $ownerProbeCapture = Join-Path $temp 'owner-module-probe.xml'
    $ownerProbeCaptureLiteral = ConvertTo-PowerShellSingleQuotedLiteral $ownerProbeCapture
    $ownerProbe = @"
`$netTCPIPCommand = Get-Command Get-NetTCPConnection -CommandType Function,Cmdlet -ErrorAction Stop
`$cimCmdletsCommand = Get-Command Get-CimInstance -CommandType Function,Cmdlet -ErrorAction Stop
[pscustomobject]@{
  PSModulePath = `$env:PSModulePath
  AutoLoading = [string]`$PSModuleAutoLoadingPreference
  NetTCPIPModulePath = `$netTCPIPCommand.Module.Path
  CimCmdletsModuleBase = `$cimCmdletsCommand.Module.ModuleBase
  CimCmdletsAssemblyLocation = `$cimCmdletsCommand.ImplementingType.Assembly.Location
} | Export-Clixml -LiteralPath $ownerProbeCaptureLiteral
"@
    $taskkillNeedle = '$taskkillExecutable = Resolve-CozySystemExecutable "taskkill.exe"'
    $instrumentedOwnerBody = $ownerMatch.Groups['Body'].Value.Replace($taskkillNeedle, $ownerProbe + "`r`n" + $taskkillNeedle)
    Assert-True ($instrumentedOwnerBody -cne $ownerMatch.Groups['Body'].Value) 'owner helper test must instrument the production module initialization boundary'
    $instrumentedOwner = Join-Path $temp 'instrumented dashboard owner.ps1'
    Write-Utf8NoBom $instrumentedOwner $instrumentedOwnerBody
    $failedImportOwner = Join-Path $temp 'failed-import dashboard owner.ps1'
    $failedImportBody = $ownerMatch.Groups['Body'].Value.Replace('Import-Module -Name $trustedNetTCPIPManifest -Force -ErrorAction Stop', 'throw "forced trusted module import failure"')
    Assert-True ($failedImportBody -cne $ownerMatch.Groups['Body'].Value) 'owner helper failure test must replace the production trusted module import'
    Write-Utf8NoBom $failedImportOwner $failedImportBody
    $portReservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $portReservation.Start()
    $ownerProbePort = ([Net.IPEndPoint]$portReservation.LocalEndpoint).Port
    $portReservation.Stop()
    $fakeUserNetTCPIP = New-FakeUserNetTCPIPModule $fakeModuleMarker
    try {
        $wrapperResult = Invoke-ElevationWrapperHarness $elevationWrapper $wrapperHarness $startCapture $childCapture $wrapperPaths 0
        $ownerProbeResult = Invoke-OwnerHelperScript $instrumentedOwner $ownerProbePort
        $failedImportResult = Invoke-OwnerHelperScript $failedImportOwner $ownerProbePort
    } finally {
        Remove-FakeUserNetTCPIPModule $fakeUserNetTCPIP
        $fakeUserNetTCPIP = $null
    }
    Assert-True ($wrapperResult.ExitCode -eq 0) "elevation wrapper must return elevated child 0: $($wrapperResult.Output)"
    $fakeModuleEvidence = if (Test-Path -LiteralPath $fakeModuleMarker) { Get-Content -LiteralPath $fakeModuleMarker -Raw } else { '<none>' }
    Assert-True (-not (Test-Path -LiteralPath $fakeModuleMarker)) "fake user-scope NetTCPIP module must never execute in the elevated PS5.1 child; marker: $fakeModuleEvidence"
    Assert-True ($ownerProbeResult.ExitCode -eq 0) "instrumented production owner helper must succeed on an absent listener: $($ownerProbeResult.Output)"
    Assert-True ($failedImportResult.ExitCode -eq 43) "trusted module setup failure must remain an indeterminate pre-inspection result (actual $($failedImportResult.ExitCode)): $($failedImportResult.Output)"
    $ownerProbeResult = Import-Clixml -LiteralPath $ownerProbeCapture
    $environmentDifference = @(@($wrapperResult.Before.Keys) + @($wrapperResult.After.Keys) | Sort-Object -Unique | Where-Object {
        -not $wrapperResult.Before.ContainsKey($_) -or -not $wrapperResult.After.ContainsKey($_) -or $wrapperResult.Before[$_] -cne $wrapperResult.After[$_]
    })
    Assert-True $wrapperResult.EnvironmentRestored "elevation wrapper must exactly restore its parent Process environment after success; differences: $($environmentDifference -join ', ')"
    $startInvocation = Import-Clixml -LiteralPath $startCapture
    Assert-True ($startInvocation.Count -eq 1) 'elevation wrapper must make exactly one Start-Process call'
    $trustedSystemDirectory = [Environment]::SystemDirectory
    $trustedWindowsDirectory = [IO.Directory]::GetParent($trustedSystemDirectory).FullName
    $expectedPowerShell = [IO.Path]::Combine($trustedSystemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    Assert-True ($startInvocation.FilePath -ceq $expectedPowerShell) 'elevation wrapper must launch absolute Windows PowerShell from the native system directory'
    Assert-True ($startInvocation.WorkingDirectory -ceq $trustedSystemDirectory) 'elevation wrapper must launch from the native system directory'
    Assert-True (-not ($elevationBody -match '\$PSHOME')) 'elevation wrapper must not select an executable through PSHOME'
    Assert-True ($startInvocation.Verb -eq 'RunAs' -and $startInvocation.Wait -and $startInvocation.PassThru -and -not $startInvocation.UseNewEnvironment) 'elevation wrapper must use one -Verb RunAs -Wait -PassThru call without -UseNewEnvironment'
    $startEnvironmentNames = @($startInvocation.Environment.Keys | ForEach-Object { [string]$_ })
    Assert-True (($startEnvironmentNames | Where-Object { $_ -notin @('SystemRoot', 'WINDIR', 'PSModulePath') }).Count -eq 0 -and $startEnvironmentNames.Count -eq 3) 'RunAs environment must contain only OS-derived SystemRoot, WINDIR, and PSModulePath'
    Assert-True ($startInvocation.Environment.SystemRoot -ceq $trustedWindowsDirectory -and $startInvocation.Environment.WINDIR -ceq $trustedWindowsDirectory) 'RunAs environment must derive SystemRoot and WINDIR from the native Windows directory'
    $trustedModuleRoot = [IO.Path]::Combine($trustedSystemDirectory, 'WindowsPowerShell', 'v1.0', 'Modules')
    Assert-True ($startInvocation.Environment.PSModulePath.Equals($trustedModuleRoot, [StringComparison]::OrdinalIgnoreCase)) 'RunAs PSModulePath must contain only the native system Windows PowerShell module root'
    $childInvocation = Read-ElevationChildCapture $childCapture
    Assert-True ($childInvocation.ExpectedRoot -ceq $wrapperPaths.Root) 'PS5.1 parsing must preserve expected root as one argument'
    Assert-True ($childInvocation.ExpectedHermes -ceq $wrapperPaths.Hermes) 'PS5.1 parsing must preserve Hermes executable as one argument'
    Assert-True ($childInvocation.ExpectedLauncher -ceq $wrapperPaths.Launcher) 'PS5.1 parsing must preserve launcher path as one argument'
    Assert-True ($childInvocation.ExpectedPort -eq 9119) 'PS5.1 parsing must preserve Dashboard port as one argument'
    Assert-True $childInvocation.ElevatedChild 'elevated helper must receive the elevated-child marker'
    Assert-True ($childInvocation.ExtraArguments.Count -eq 0) 'elevated helper must receive no merged or extra arguments'
    Assert-True ([string]::IsNullOrWhiteSpace($childInvocation.DashboardSessionToken)) 'actual PowerShell child must not inherit the Dashboard session token'
    Assert-True ([string]::IsNullOrWhiteSpace($childInvocation.ProviderApiKey)) 'actual PowerShell child must not inherit provider credentials'
    Assert-True ([string]::IsNullOrWhiteSpace($childInvocation.ArbitrarySecret)) 'actual PowerShell child must not inherit an unrelated Process-scope sentinel'
    Assert-True ([string]::IsNullOrWhiteSpace($childInvocation.PathValue)) 'actual PowerShell 5.1 child must not inherit PATH'
    Assert-True ([string]::IsNullOrWhiteSpace($childInvocation.PSHomeValue)) 'actual PowerShell 5.1 child must not inherit PSHOME'
    Assert-True ([string]::IsNullOrWhiteSpace($childInvocation.ComSpecValue)) 'actual PowerShell 5.1 child must not inherit COMSPEC'
    Assert-True ([string]::IsNullOrWhiteSpace($childInvocation.TempValue)) 'actual PowerShell 5.1 child must not inherit TEMP'
    Assert-True ([string]::IsNullOrWhiteSpace($childInvocation.TmpValue)) 'actual PowerShell 5.1 child must not inherit TMP'
    Assert-True ([string]::IsNullOrWhiteSpace($childInvocation.BoundarySentinel)) 'actual PowerShell 5.1 child must not inherit the UAC-boundary sentinel'
    $poisonedPathPrefix = Join-Path $temp 'poisoned-installer-environment'
    $trustedAllUsersModuleRoot = [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles), 'WindowsPowerShell', 'Modules')
    $effectiveModuleRoots = @($childInvocation.PSModulePathValue -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $unexpectedModuleRoots = @($effectiveModuleRoots | Where-Object { -not $_.Equals($trustedModuleRoot, [StringComparison]::OrdinalIgnoreCase) -and -not $_.Equals($trustedAllUsersModuleRoot, [StringComparison]::OrdinalIgnoreCase) })
    Assert-True (($effectiveModuleRoots | Where-Object { $_.Equals($trustedModuleRoot, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0 -and $unexpectedModuleRoots.Count -eq 0) "actual PowerShell 5.1 child must expose only protected system/all-users module roots (actual: $($childInvocation.PSModulePathValue))"
    Assert-True ($childInvocation.SystemRootValue -ceq $trustedWindowsDirectory -and $childInvocation.WindirValue -ceq $trustedWindowsDirectory) 'actual PowerShell 5.1 child must receive only native-derived Windows roots'
    $trustedNetTCPIPManifest = [IO.Path]::Combine($trustedModuleRoot, 'NetTCPIP', 'NetTCPIP.psd1')
    $trustedCimCmdletsBase = [IO.Path]::Combine($trustedModuleRoot, 'CimCmdlets')
    $trustedCimCmdletsGacRoot = [IO.Path]::Combine($trustedWindowsDirectory, 'Microsoft.Net', 'assembly', 'GAC_MSIL', 'Microsoft.Management.Infrastructure.CimCmdlets') + [IO.Path]::DirectorySeparatorChar
    Assert-True ($childInvocation.NetTCPIPModulePath.Equals($trustedNetTCPIPManifest, [StringComparison]::OrdinalIgnoreCase)) 'Get-NetTCPConnection must resolve from the trusted inbox NetTCPIP manifest'
    Assert-True ($childInvocation.CimCmdletsModuleBase.Equals($trustedCimCmdletsBase, [StringComparison]::OrdinalIgnoreCase)) 'Get-CimInstance must resolve from the trusted inbox CimCmdlets module base'
    Assert-True ($childInvocation.CimCmdletsAssemblyLocation.StartsWith($trustedCimCmdletsGacRoot, [StringComparison]::OrdinalIgnoreCase)) 'Get-CimInstance must execute from the OS GAC CimCmdlets assembly'
    Assert-True ($ownerProbeResult.PSModulePath.Equals($trustedModuleRoot, [StringComparison]::OrdinalIgnoreCase)) 'production owner helper must reset PSModulePath to the native system module root'
    Assert-True ($ownerProbeResult.AutoLoading -ceq 'None') 'production owner helper must disable module autoload after trusted imports'
    Assert-True ($ownerProbeResult.NetTCPIPModulePath.Equals($trustedNetTCPIPManifest, [StringComparison]::OrdinalIgnoreCase)) 'production owner helper must import Get-NetTCPConnection from the trusted inbox manifest'
    Assert-True ($ownerProbeResult.CimCmdletsModuleBase.Equals($trustedCimCmdletsBase, [StringComparison]::OrdinalIgnoreCase)) 'production owner helper must import Get-CimInstance from the trusted inbox module base'
    Assert-True ($ownerProbeResult.CimCmdletsAssemblyLocation.StartsWith($trustedCimCmdletsGacRoot, [StringComparison]::OrdinalIgnoreCase)) 'production owner helper must execute Get-CimInstance from the OS GAC assembly'
    $startArguments = $startInvocation.ArgumentList -join "`n"
    Assert-True ($startArguments -match '(?m)^-NoProfile$' -and $startArguments -match '(?m)^-NonInteractive$' -and $startArguments -match '(?m)^-ExecutionPolicy$' -and $startArguments -match '(?m)^Bypass$' -and $startArguments -match '(?m)^-File$') 'elevation wrapper must carry the required PowerShell argument array'
    $wrapperEvidence = $wrapperResult.Output + "`n" + (Get-Content -LiteralPath $startCapture -Raw)
    Assert-True (-not ($wrapperEvidence -match 'task-2-secret-token|task-2-provider-secret|task-2-arbitrary-secret|poisoned-installer-environment')) 'elevation wrapper FilePath, arguments, and logs must not expose Process-scope or poisoned path values'

    foreach ($childCode in @(42, 43, 45, 99)) {
        $childFailure = Invoke-ElevationWrapperHarness $elevationWrapper $wrapperHarness $startCapture $childCapture $wrapperPaths $childCode
        Assert-True ($childFailure.ExitCode -eq $childCode) "elevation wrapper must preserve elevated child exit code $childCode"
        $childFailureStart = Import-Clixml -LiteralPath $startCapture
        Assert-True ($childFailure.EnvironmentRestored -and $childFailureStart.Count -eq 1) "elevation wrapper must restore the exact environment after elevated child code $childCode"
    }

    $cancelResult = Invoke-ElevationWrapperHarness $elevationWrapper $wrapperHarness $startCapture $childCapture $wrapperPaths 0 -Cancel
    Assert-True ($cancelResult.ExitCode -eq 46) "UAC cancellation or Start-Process failure must return the launch-failure code (actual $($cancelResult.ExitCode)): $($cancelResult.Output)"
    Assert-True (-not (Test-Path -LiteralPath $childCapture)) 'UAC cancellation must not run the elevated child'
    $cancelStart = Import-Clixml -LiteralPath $startCapture
    Assert-True ($cancelResult.EnvironmentRestored -and $cancelStart.Count -eq 1) 'elevation wrapper must exactly restore its parent Process environment after launch exception'

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
    Remove-FakeUserNetTCPIPModule $fakeUserNetTCPIP
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

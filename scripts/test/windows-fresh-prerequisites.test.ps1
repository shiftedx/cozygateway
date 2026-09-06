$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\install.ps1'))
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($function in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    Invoke-Expression $function.Extent.Text
}
function Assert-Equal($Actual, $Expected, [string]$Message) { if ($Actual -ne $Expected) { throw "${Message}: got $Actual" } }
function Assert-Throws([scriptblock]$Action, [string]$Message) {
    $failed = $false
    try { & $Action } catch { $failed = $true }
    if (-not $failed) { throw $Message }
}
$script:upgraded = $false
function Get-HermesVersion {
    return @{ Text = $(if ($script:upgraded) { '0.21.0' } else { '0.20.0' }); Core = $(if ($script:upgraded) { [version]'0.21.0' } else { [version]'0.20.0' }); IsPrerelease = $false }
}
function Fixture-HermesUpgrade { $script:upgraded = $true; $global:LASTEXITCODE = 0; 'fixture upstream update progress' }
$upgradeOutput = @(Ensure-CompatibleHermes 'Fixture-HermesUpgrade')
Assert-Equal $upgradeOutput.Count 0 'upgrade progress must not contaminate the resolved Hermes executable path'
Assert-Equal $script:upgraded $true 'old Hermes must actually be upgraded'
$savedLocal = $env:LOCALAPPDATA
try {
    $env:LOCALAPPDATA = 'C:\Fixture Alias'
    function Get-CozyLocalAppData { return 'C:\Fixture Physical Local' }
    Assert-Equal (Resolve-InstallHome '') 'C:\Fixture Physical Local\cozygateway' 'default gateway must use the OS physical directory'
    Assert-Equal (Resolve-InstallHome 'C:\Explicit Gateway') 'C:\Explicit Gateway' 'explicit gateway home must remain explicit'
    Assert-Throws { Resolve-InstallHome 'C:\Fixture Physical Local' } 'physical LocalAppData root must not be an install home'
    Write-Output 'PASS physical default and explicit gateway homes'
} finally { $env:LOCALAPPDATA = $savedLocal }

$savedEndpoint = $env:COZYGATEWAY_HERMES_MODEL_ENDPOINT
$savedModel = $env:COZYGATEWAY_HERMES_MODEL_ID
try {
    function Fixture-TemplateStatus {
        Assert-Equal ($args -join ' ') '-p default status' 'model inspection must target the default profile'
        $global:LASTEXITCODE = 0
        "Model: template-model`nProvider: Auto"
    }
    Assert-Equal (Get-HermesModelState 'Fixture-TemplateStatus').Configured $false 'a template model with unresolved Auto provider is not configured'
    $env:COZYGATEWAY_HERMES_MODEL_ENDPOINT = 'http://192.0.2.120:8000/v1'
    $env:COZYGATEWAY_HERMES_MODEL_ID = 'fixture-model'
    $script:modelCalls = [Collections.Generic.List[string]]::new()
    function Get-HermesModelState { return @{ Configured = ($script:modelCalls.Count -eq 3) } }
    function Fixture-Hermes {
        $script:modelCalls.Add(($args -join ' '))
        $global:LASTEXITCODE = 0
    }
    Confirm-HermesModel 'Fixture-Hermes'
    Assert-Equal ($script:modelCalls -join '|') '-p default config set model.provider custom|-p default config set model.base_url http://192.0.2.120:8000/v1|-p default config set model.default fixture-model' 'explicit fresh model must configure without a wizard'
    Confirm-HermesModel 'Fixture-Hermes'
    Assert-Equal $script:modelCalls.Count 3 'configured model must remain untouched'
    function Get-HermesModelState { return @{ Configured = $true } }
    Confirm-HermesModel 'Fixture-Hermes' -FreshInstall $true
    Assert-Equal $script:modelCalls.Count 6 'fresh explicit model must override an ambient auto-detected provider'
    Confirm-HermesModel 'Fixture-Hermes'
    Assert-Equal $script:modelCalls.Count 6 'subsequent confirmation must preserve the newly configured model'
    $env:COZYGATEWAY_HERMES_MODEL_ID = ''
    Assert-Throws { Get-HermesModelRequest } 'partial unattended model configuration must fail'
    Write-Output 'PASS noninteractive fresh Hermes model and existing-model preservation'
} finally {
    $env:COZYGATEWAY_HERMES_MODEL_ENDPOINT = $savedEndpoint
    $env:COZYGATEWAY_HERMES_MODEL_ID = $savedModel
}

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('cozy-fresh-prerequisites-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
try {
    Add-Type -AssemblyName System.IO.Compression
    $zipPath = Join-Path $fixtureRoot 'long-path.zip'
    $destination = Join-Path $fixtureRoot 'extract'
    $first = 'a' * 110; $second = 'b' * 110
    $entryName = "$first/$second/index.html"
    $file = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew)
    $zip = [IO.Compression.ZipArchive]::new($file, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $entry = $zip.CreateEntry($entryName)
        $writer = [IO.StreamWriter]::new($entry.Open())
        try { $writer.Write('fixture dashboard') } finally { $writer.Dispose() }
    } finally { $zip.Dispose(); $file.Dispose() }
    $longFile = Join-Path $destination ($entryName.Replace('/', '\'))
    if ($longFile.Length -le 260) { throw 'archive regression must exceed MAX_PATH' }
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class LongArchiveFixture {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetFileAttributesW(string path);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool DeleteFileW(string path);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool RemoveDirectoryW(string path);
}
'@
    try {
        Expand-HermesArchive $zipPath $destination
        if ([LongArchiveFixture]::GetFileAttributesW('\\?\' + $longFile) -eq [uint32]::MaxValue) { throw 'native archive extraction did not preserve a path longer than 260 characters' }
        Write-Output 'PASS real ZIP extraction beyond Windows PowerShell MAX_PATH'
    } finally {
        [void][LongArchiveFixture]::DeleteFileW('\\?\' + $longFile)
        [void][LongArchiveFixture]::RemoveDirectoryW('\\?\' + (Split-Path -Parent $longFile))
        [void][LongArchiveFixture]::RemoveDirectoryW('\\?\' + (Join-Path $destination $first))
    }
    $oldLocal = $env:LOCALAPPDATA
    try {
        $env:LOCALAPPDATA = Join-Path $fixtureRoot 'alias'
        $script:physicalLocal = Join-Path $fixtureRoot 'physical'
        function Get-CozyLocalAppData { return $script:physicalLocal }
        $standaloneGateway = Join-Path $env:LOCALAPPDATA 'cozygateway'
        New-Item -ItemType Directory -Force -Path $standaloneGateway | Out-Null
        Assert-Equal (Resolve-InstallHome '') $standaloneGateway 'existing unpackaged gateway home must remain selected when its packaged counterpart is missing'
        $hermesHome = Join-Path $script:physicalLocal 'hermes'
        $standalone = Join-Path $env:LOCALAPPDATA 'hermes'
        New-Item -ItemType Directory -Path (Join-Path $standalone 'bin') -Force | Out-Null
        $standaloneCommand = Join-Path $standalone 'bin\hermes.exe'
        [IO.File]::WriteAllText($standaloneCommand, 'standalone fixture')
        Assert-Equal (Resolve-PhysicalHermesPath $standalone) $standalone 'existing unpackaged home must survive a missing packaged counterpart'
        Assert-Equal (Resolve-NativeHermesPath $standaloneCommand) $standaloneCommand 'existing unpackaged command must remain discoverable'
        $bin = Join-Path $hermesHome 'bin'
        $scripts = Join-Path $hermesHome 'hermes-agent\venv\Scripts'
        New-Item -ItemType Directory -Force -Path $bin,$scripts | Out-Null
        $command = Join-Path $bin 'hermes.exe'
        $acp = Join-Path $bin 'hermes-acp.exe'
        $python = Join-Path $scripts 'python.exe'
        $script:expectedPython = $python
        $aliasPython = Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent\venv\Scripts\python.exe'
        Assert-Equal (Resolve-PhysicalHermesPath (Join-Path $env:LOCALAPPDATA 'hermes')) $hermesHome 'default Hermes alias must resolve to physical home'
        Assert-Equal (Resolve-PhysicalHermesPath $hermesHome) $hermesHome 'physical Hermes path must not be redirected twice'
        Assert-Equal (Resolve-PhysicalHermesPath (Join-Path $fixtureRoot 'custom-home')) (Join-Path $fixtureRoot 'custom-home') 'explicit custom home must remain unchanged'
        [IO.File]::WriteAllText($command, "fixture`n$aliasPython`n")
        [IO.File]::WriteAllText($acp, "fixture`n$aliasPython`n")
        [IO.File]::WriteAllText($python, 'fixture')
        [IO.File]::WriteAllText((Join-Path $bin 'uv.exe'), 'fixture')
        $script:repairCalls = 0
        function Repair-HermesLauncherInterpreter($Uv, $Python, $Repository) {
            $script:repairCalls++
            Assert-Equal $Uv (Join-Path $bin 'uv.exe') 'repair must use the managed uv'
            Assert-Equal $Python $script:expectedPython 'repair must use the physical interpreter'
            [IO.File]::WriteAllText((Join-Path $Repository 'venv\Scripts\hermes.exe'), "fixture`n$Python`n")
            [IO.File]::WriteAllText((Join-Path $Repository 'venv\Scripts\hermes-acp.exe'), "fixture`n$Python`n")
        }
        Ensure-HermesLauncherInterpreter $command
        Assert-Equal (Get-HermesLauncherInterpreter $command) $python 'repaired launcher must embed physical interpreter'
        Assert-Equal (Get-HermesLauncherInterpreter $acp) $python 'the recognized ACP launcher must also use the physical interpreter'
        Ensure-HermesLauncherInterpreter $command
        Assert-Equal $script:repairCalls 1 'already physical launcher must not be reinstalled'
        [IO.File]::WriteAllText($command, "fixture`nC:\Unrelated Python\python.exe`n")
        Ensure-HermesLauncherInterpreter $command
        Assert-Equal $script:repairCalls 1 'unrelated launcher format must not be rewritten'
        [IO.File]::WriteAllText($command, "fixture`n$aliasPython`n")
        function Repair-HermesLauncherInterpreter { throw 'fixture uv failure' }
        Assert-Throws { Ensure-HermesLauncherInterpreter $command } 'reinstall failure must propagate'
        Assert-Equal (Get-HermesLauncherInterpreter $command) $aliasPython 'failed repair must retain previous command'
        # A running executable cannot be overwritten on Windows. Verify the
        # staged rename path against a real, hidden, disposable native process.
        Remove-Item -LiteralPath $command -Force
        $className = 'HeldLauncher' + [guid]::NewGuid().ToString('N')
        Add-Type -TypeDefinition "public static class $className { public static void Main() { System.Console.WriteLine(`"ready`"); System.Threading.Thread.Sleep(30000); } }" -OutputAssembly $command -OutputType ConsoleApplication
        [IO.File]::AppendAllText($command, "`n$aliasPython`n")
        $start = New-Object Diagnostics.ProcessStartInfo
        $start.FileName = $command; $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.RedirectStandardOutput = $true
        $held = [Diagnostics.Process]::Start($start)
        try {
            $ready = $held.StandardOutput.ReadLineAsync()
            if (-not $ready.Wait(5000) -or $ready.Result -ne 'ready') { throw 'hidden launcher fixture did not start' }
            function Repair-HermesLauncherInterpreter($Uv, $Python, $Repository) {
                [IO.File]::WriteAllText((Join-Path $Repository 'venv\Scripts\hermes.exe'), "fixture`n$Python`n")
            }
            Ensure-HermesLauncherInterpreter $command
            Assert-Equal (Get-HermesLauncherInterpreter $command) $python 'a running launcher must be replaced without terminating its process'
            Assert-Equal $held.HasExited $false 'repair must preserve the existing process'
        } finally { if (-not $held.HasExited) { $held.Kill(); $held.WaitForExit() }; $held.Dispose() }
        Write-Output 'PASS physical trampoline repair, idempotence, unrelated launcher preservation and failure retention'
    } finally { $env:LOCALAPPDATA = $oldLocal }
    $official = Join-Path $fixtureRoot 'official.ps1'
    [IO.File]::WriteAllText($official, @'
param($HermesHome, $InstallDir, $Tag, $Branch, [switch]$NonInteractive, [switch]$SkipSetup)
$global:officialFixture = @{
    Home=$HermesHome; InstallDir=$InstallDir; Tag=$Tag; Branch=$Branch
    NonInteractive=[bool]$NonInteractive; SkipSetup=[bool]$SkipSetup
    GitConfigPath=$env:GIT_CONFIG_GLOBAL; GitConfig=[IO.File]::ReadAllText($env:GIT_CONFIG_GLOBAL)
}
'@)
    $beforeGit = $env:GIT_CONFIG_GLOBAL
    Invoke-OfficialHermesInstaller $official 'v2026.8.31' (Join-Path $fixtureRoot 'Hermes') $true
    Assert-Equal $global:officialFixture.Tag 'v2026.8.31' 'official installer tag must be pinned'
    Assert-Equal $global:officialFixture.Branch 'v2026.8.31' 'clone must use the fetched release'
    Assert-Equal $global:officialFixture.Home (Join-Path $fixtureRoot 'Hermes') 'explicit Hermes home must reach upstream'
    Assert-Equal $global:officialFixture.InstallDir (Join-Path $fixtureRoot 'Hermes\hermes-agent') 'source must live under explicit Hermes home'
    Assert-Equal $global:officialFixture.NonInteractive $true 'explicit model setup must not launch upstream wizard'
    Assert-Equal $global:officialFixture.SkipSetup $true 'explicit model setup must skip upstream setup'
    if ($global:officialFixture.GitConfig -notmatch 'longpaths = true') { throw 'Git clone must enable longpaths' }
    Assert-Equal $env:GIT_CONFIG_GLOBAL $beforeGit 'global Git override must be restored'
    Assert-Equal (Test-Path $global:officialFixture.GitConfigPath) $false 'temporary Git config must be removed'
    [IO.File]::WriteAllText($official, 'param($HermesHome, $InstallDir) $env:GIT_CONFIG_COUNT="99"; throw "fixture installer failed"')
    $beforeCount = $env:GIT_CONFIG_COUNT
    Assert-Throws { Invoke-OfficialHermesInstaller $official '' (Join-Path $fixtureRoot 'Hermes') $false } 'installer failure must propagate'
    Assert-Equal $env:GIT_CONFIG_GLOBAL $beforeGit 'global Git override must be restored on failure'
    Assert-Equal $env:GIT_CONFIG_COUNT $beforeCount 'Git process options must be restored on failure'
    Write-Output 'PASS pinned official install parameters and process-only longpaths'
    $builder = Join-Path $fixtureRoot 'builder.ps1'
    [IO.File]::WriteAllText($builder, 'param($HermesPath) $global:dashboardBuiltFor=$HermesPath; $global:LASTEXITCODE=0')
    $oldBuilder = $env:COZYGATEWAY_TEST_DASHBOARD_BUILDER
    try {
        $env:COZYGATEWAY_TEST_DASHBOARD_BUILDER = $builder
        Ensure-HermesDashboardAssets 'fixture-hermes.exe'
        Assert-Equal $global:dashboardBuiltFor 'fixture-hermes.exe' 'Dashboard assets must be prepared before service launch'
        [IO.File]::WriteAllText($builder, 'param($HermesPath) $global:LASTEXITCODE=1')
        Assert-Throws { Ensure-HermesDashboardAssets 'fixture-hermes.exe' } 'failed Dashboard build must block service launch'
        $oldDryRun = $env:COZYGATEWAY_INSTALL_DRYRUN
        try {
            $env:COZYGATEWAY_INSTALL_DRYRUN = '1'
            Ensure-HermesDashboardAssets 'fixture-hermes.exe'
        } finally { $env:COZYGATEWAY_INSTALL_DRYRUN = $oldDryRun }
        Write-Output 'PASS Dashboard preparation, failure propagation, and dry-run isolation'
    } finally { $env:COZYGATEWAY_TEST_DASHBOARD_BUILDER = $oldBuilder }
} finally {
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\cozy-fresh-prerequisites-'
    if (-not $resolvedFixture.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'refusing fixture cleanup outside the allocated temp directory' }
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

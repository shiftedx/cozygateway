param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $InstallerArguments
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$ProgressPreference = 'SilentlyContinue'

function Write-Info { param([string] $Message) Write-Host "INFO  $Message" }
function Write-Ok { param([string] $Message) Write-Host "OK    $Message" }
function Fail { param([string] $Message) throw "FAIL  $Message" }

function Resolve-InstallHome {
    param([string] $RequestedHome)
    if ([string]::IsNullOrWhiteSpace($RequestedHome)) {
        $RequestedHome = Join-Path $env:LOCALAPPDATA 'cozygateway'
    }
    $full = [IO.Path]::GetFullPath($RequestedHome)
    $local = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')
    if ($full.TrimEnd('\') -eq $local) { Fail 'COZYGATEWAY_HOME must name a dedicated directory' }
    return $full.TrimEnd('\')
}

function Get-LatestTag {
    param([string] $Repository)
    $headers = @{ 'User-Agent' = 'cozygateway-windows-installer' }
    $release = Invoke-RestMethod -UseBasicParsing -Headers $headers -Uri "https://api.github.com/repos/$Repository/releases/latest"
    if ([string]::IsNullOrWhiteSpace([string]$release.tag_name)) { Fail "could not resolve latest release for $Repository" }
    return [string]$release.tag_name
}

function Copy-OrDownload {
    param([string] $Source, [string] $Destination)
    if (Test-Path -LiteralPath $Source) {
        Copy-Item -LiteralPath $Source -Destination $Destination -Force
    } else {
        Invoke-WebRequest -UseBasicParsing -Uri $Source -OutFile $Destination
    }
}

function Get-VerifiedAsset {
    param([string] $Name, [string] $Destination, [string] $BaseUri)
    $source = if (Test-Path -LiteralPath $BaseUri) { Join-Path $BaseUri $Name } else { "$($BaseUri.TrimEnd('/'))/$Name" }
    $newPath = "$Destination.new"
    $shaPath = "$Destination.sha256"
    Remove-Item -LiteralPath $newPath -Force -ErrorAction SilentlyContinue
    Copy-OrDownload $source $newPath
    Copy-OrDownload "$source.sha256" $shaPath
    $expected = ((Get-Content -LiteralPath $shaPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $newPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($expected) -or $expected -ne $actual) {
        Remove-Item -LiteralPath $newPath -Force -ErrorAction SilentlyContinue
        Fail "$Name checksum mismatch"
    }
    Move-Item -LiteralPath $newPath -Destination $Destination -Force
    Write-Ok "verified $Name"
}

function Refresh-HermesEnvironment {
    param([string] $HermesHome)
    $env:HERMES_HOME = $HermesHome
    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    $machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
    $env:PATH = (@((Join-Path $HermesHome 'bin'), $userPath, $machinePath, $env:PATH) | Where-Object { $_ }) -join ';'
    $userBash = [Environment]::GetEnvironmentVariable('HERMES_GIT_BASH_PATH', 'User')
    if (-not [string]::IsNullOrWhiteSpace($userBash)) { $env:HERMES_GIT_BASH_PATH = $userBash }
}

function Find-Hermes {
    if (-not [string]::IsNullOrWhiteSpace($env:COZYGATEWAY_TEST_HERMES) -and (Test-Path -LiteralPath $env:COZYGATEWAY_TEST_HERMES)) {
        return [IO.Path]::GetFullPath($env:COZYGATEWAY_TEST_HERMES)
    }
    $command = Get-Command hermes.exe, hermes.cmd, hermes -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    $candidate = Join-Path $env:LOCALAPPDATA 'hermes\bin\hermes.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    return $null
}

function Resolve-Hermes {
    param([string] $InstallerUri)
    $hermes = Find-Hermes
    if (-not $hermes) {
        if ([string]::IsNullOrWhiteSpace($InstallerUri)) {
            $tag = Get-LatestTag 'NousResearch/hermes-agent'
            $InstallerUri = "https://raw.githubusercontent.com/NousResearch/hermes-agent/$tag/scripts/install.ps1"
        }
        Write-Info 'Hermes Agent is not installed; starting the official Windows installer.'
        $hermesInstaller = Join-Path ([IO.Path]::GetTempPath()) ("hermes-install-" + [guid]::NewGuid().ToString('N') + '.ps1')
        try {
            Copy-OrDownload $InstallerUri $hermesInstaller
            $content = [IO.File]::ReadAllText($hermesInstaller).TrimStart([char]0xFEFF)
            & ([scriptblock]::Create($content))
        } finally {
            Remove-Item -LiteralPath $hermesInstaller -Force -ErrorAction SilentlyContinue
        }
        $hermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
        Refresh-HermesEnvironment $hermesHome
        $hermes = Find-Hermes
    }
    if (-not $hermes) { Fail 'Hermes installation did not produce hermes.exe; finish Hermes setup and run this command again' }
    $configPath = (& $hermes -p default config path 2>$null | Select-Object -Last 1).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($configPath) -or -not (Test-Path -LiteralPath $configPath)) {
        Fail 'Hermes default profile is not configured; finish Hermes setup and run this command again'
    }
    return $hermes
}

function Get-HermesModelState {
    param([string] $HermesPath)
    $statusOutput = (& $HermesPath status 2>&1 | Out-String)
    $statusExit = $LASTEXITCODE
    $modelMatch = [regex]::Match($statusOutput, '(?m)^\s*(?:Current model|Model):\s*(?<value>[^\r\n]+)')
    $providerMatch = [regex]::Match($statusOutput, '(?m)^\s*(?:Active provider|Provider):\s*(?<value>[^\r\n]+)')
    $model = if ($modelMatch.Success) { $modelMatch.Groups['value'].Value.Trim() } else { '' }
    $provider = if ($providerMatch.Success) { $providerMatch.Groups['value'].Value.Trim() } else { '' }
    $placeholder = '^(?i:\(?\s*(?:not set|not configured|unknown|none|null)\s*\)?)$'
    $hasModel = -not [string]::IsNullOrWhiteSpace($model) -and $model -notmatch $placeholder
    $hasProvider = -not [string]::IsNullOrWhiteSpace($provider) -and $provider -notmatch $placeholder
    return [pscustomobject]@{
        Configured = ($statusExit -eq 0 -and $hasModel -and $hasProvider)
    }
}

function Confirm-HermesModel {
    param([string] $HermesPath)
    if ($env:COZYGATEWAY_INSTALL_DRYRUN -eq '1') {
        Write-Info 'dry run: would inspect Hermes model status and open model selection only when setup is incomplete'
        return
    }
    $state = Get-HermesModelState $HermesPath
    if ($state.Configured) {
        Write-Ok 'Hermes provider and model are already configured; skipping model selection'
        return
    }
    Write-Info 'Choose or confirm the Hermes inference provider and model.'
    & $HermesPath model
    $modelExit = $LASTEXITCODE
    if ($modelExit -ne 0) {
        Fail 'Hermes model selection did not complete successfully'
    }
    $state = Get-HermesModelState $HermesPath
    if (-not $state.Configured) {
        Fail 'Hermes needs an active provider and model before CozyGateway can be installed'
    }
    Write-Ok 'Hermes provider and model are configured'
}

function Resolve-GitBash {
    param([string] $ExplicitPath)
    $candidates = New-Object System.Collections.Generic.List[string]
    $programFilesX86Bash = $null
    if (${env:ProgramFiles(x86)}) { $programFilesX86Bash = Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe' }
    foreach ($candidate in @(
        $ExplicitPath,
        $env:HERMES_GIT_BASH_PATH,
        [Environment]::GetEnvironmentVariable('HERMES_GIT_BASH_PATH', 'User'),
        (Join-Path $env:LOCALAPPDATA 'hermes\git\bin\bash.exe'),
        (Join-Path $env:LOCALAPPDATA 'hermes\git\usr\bin\bash.exe'),
        (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
        $programFilesX86Bash,
        (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')
    )) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) { $candidates.Add($candidate) }
    }
    $git = Get-Command git.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($git) {
        $gitRoot = Split-Path -Parent (Split-Path -Parent $git.Source)
        $candidates.Add((Join-Path $gitRoot 'bin\bash.exe'))
        $candidates.Add((Join-Path $gitRoot 'usr\bin\bash.exe'))
    }
    foreach ($candidate in $candidates) {
        if ((Test-Path -LiteralPath $candidate) -and ([IO.Path]::GetFullPath($candidate) -notlike "$env:WINDIR\System32\bash.exe")) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    Fail 'Git Bash was not found. Re-run the Hermes Windows installer, then paste this command again.'
}

function Invoke-CozyGatewayInstaller {
    param([string] $BashPath, [string] $InstallerPath, [string] $HermesPath, [string[]] $ForwardedArguments)
    $arguments = @($InstallerPath, '--service-platform', 'Windows', '--gateway-dir', $script:InstallHome, '--bundle', $script:BundlePath, '--plugin-archive', $script:PluginPath)
    if ($env:COZYGATEWAY_INSTALL_DRYRUN -eq '1') { $arguments += '--dry-run' }
    if ($ForwardedArguments) { $arguments += $ForwardedArguments }
    $previousHermes = [Environment]::GetEnvironmentVariable('COZYGATEWAY_HERMES_BIN', 'Process')
    try {
        $env:COZYGATEWAY_HERMES_BIN = $HermesPath
        & $BashPath @arguments
        if ($LASTEXITCODE -ne 0) { Fail "CozyGateway installer exited $LASTEXITCODE" }
    } finally {
        [Environment]::SetEnvironmentVariable('COZYGATEWAY_HERMES_BIN', $previousHermes, 'Process')
    }
}

function Protect-CozyGatewayHome {
    param([string] $Path)
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
    $administrators = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($currentUser, $system, $administrators)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $identity,
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    (Get-Item -LiteralPath $Path).SetAccessControl($acl)
}

function Set-CozyGatewayCommandPath {
    param([string] $BinPath, [bool] $Present)
    $full = [IO.Path]::GetFullPath($BinPath).TrimEnd('\')
    $testPath = [Environment]::GetEnvironmentVariable('COZYGATEWAY_TEST_USER_PATH', 'Process')
    $userPath = if ($null -ne $testPath) { $testPath } else { [Environment]::GetEnvironmentVariable('PATH', 'User') }
    $parts = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and $_.TrimEnd('\') -ine $full })
    if ($Present) { $parts = @($full) + $parts }
    $next = $parts -join ';'

    $testLog = [Environment]::GetEnvironmentVariable('COZYGATEWAY_TEST_USER_PATH_LOG', 'Process')
    if (-not [string]::IsNullOrWhiteSpace($testLog)) {
        [IO.File]::WriteAllText($testLog, $next, (New-Object Text.UTF8Encoding($false)))
    } else {
        [Environment]::SetEnvironmentVariable('PATH', $next, 'User')
    }

    $processParts = @($env:PATH -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and $_.TrimEnd('\') -ine $full })
    if ($Present) {
        $env:PATH = (@($full) + $processParts) -join ';'
    } else {
        $env:PATH = $processParts -join ';'
    }
    Write-Ok $(if ($Present) { 'the cozygateway command is available in new PowerShell and Terminal windows' } else { 'removed the cozygateway command from the user PATH' })
}

if ($PSVersionTable.PSVersion.Major -lt 5) { Fail 'Windows PowerShell 5.1 or newer is required' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$script:InstallHome = Resolve-InstallHome $env:COZYGATEWAY_HOME
$bin = Join-Path $script:InstallHome 'bin'
$installerPath = Join-Path $bin 'agent-install.sh'
$isUninstall = $InstallerArguments -contains '--uninstall'
$isDryRun = $env:COZYGATEWAY_INSTALL_DRYRUN -eq '1' -or $InstallerArguments -contains '--dry-run'

if ($isUninstall) {
    $bash = Resolve-GitBash $env:COZYGATEWAY_GIT_BASH
    if (-not (Test-Path -LiteralPath $installerPath)) { Fail "no CozyGateway installer was found at $installerPath" }
    $uninstallArguments = @($installerPath, '--service-platform', 'Windows', '--gateway-dir', $script:InstallHome) + @($InstallerArguments)
    if ($isDryRun -and -not ($uninstallArguments -contains '--dry-run')) { $uninstallArguments += '--dry-run' }
    & $bash @uninstallArguments
    if ($LASTEXITCODE -ne 0) { Fail "CozyGateway installer exited $LASTEXITCODE" }
    if (-not $isDryRun) { Set-CozyGatewayCommandPath $bin $false }
    return
}

if ($isDryRun) {
    if (Find-Hermes) {
        Write-Info 'dry run: would inspect Hermes model status and open model selection only when setup is incomplete'
    } else {
        Write-Info 'dry run: would install Hermes Agent, inspect its model status, and open model selection only when setup is incomplete'
    }
    Write-Info 'dry run: would resolve and checksum-verify the CozyGateway release assets'
    Write-Info "dry run: would install CozyGateway under $script:InstallHome without administrator rights"
    return
}

$hermes = Resolve-Hermes $env:COZYGATEWAY_HERMES_INSTALL_URL
Confirm-HermesModel $hermes
$bash = Resolve-GitBash $env:COZYGATEWAY_GIT_BASH

$repo = if ($env:COZYGATEWAY_INSTALL_REPO) { $env:COZYGATEWAY_INSTALL_REPO } else { 'shiftedx/cozygateway' }
$tag = $env:COZYGATEWAY_INSTALL_TAG
$base = $env:COZYGATEWAY_INSTALL_ASSET_BASE
if ([string]::IsNullOrWhiteSpace($base)) {
    if ([string]::IsNullOrWhiteSpace($tag)) { $tag = Get-LatestTag $repo }
    $base = "https://github.com/$repo/releases/download/$tag"
}

Protect-CozyGatewayHome $script:InstallHome
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$script:BundlePath = Join-Path $bin 'cozygateway.mjs'
$script:PluginPath = Join-Path $bin 'cozygateway-hermes-attach-plugin.tar.gz'
Get-VerifiedAsset 'cozygateway.mjs' $script:BundlePath $base
Get-VerifiedAsset 'cozygateway-hermes-attach-plugin.tar.gz' $script:PluginPath $base
Get-VerifiedAsset 'cozygateway-installer.sh' $installerPath $base
Invoke-CozyGatewayInstaller $bash $installerPath $hermes $InstallerArguments
if ($env:COZYGATEWAY_INSTALL_DRYRUN -ne '1') { Set-CozyGatewayCommandPath $bin $true }

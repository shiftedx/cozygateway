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

function Confirm-HermesModel {
    param([string] $HermesPath)
    if ($env:COZYGATEWAY_INSTALL_DRYRUN -eq '1') {
        Write-Info 'dry run: would open hermes model before CozyGateway installation'
        return
    }
    Write-Info 'Choose or confirm the Hermes inference provider and model.'
    $modelOutput = (& $HermesPath model 2>&1 | Out-String)
    $modelExit = $LASTEXITCODE
    if (-not [string]::IsNullOrWhiteSpace($modelOutput)) { Write-Host $modelOutput.TrimEnd() }
    if ($modelExit -ne 0 -or $modelOutput -notmatch '(?m)^\s*Current model:\s*\S+' -or $modelOutput -notmatch '(?m)^\s*Active provider:\s*\S+') {
        Fail 'Hermes needs an active provider and model before CozyGateway can be installed'
    }
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
    param([string] $BashPath, [string] $InstallerPath, [string[]] $ForwardedArguments)
    $arguments = @($InstallerPath, '--service-platform', 'Windows', '--gateway-dir', $script:InstallHome, '--bundle', $script:BundlePath, '--plugin-archive', $script:PluginPath)
    if ($env:COZYGATEWAY_INSTALL_DRYRUN -eq '1') { $arguments += '--dry-run' }
    if ($ForwardedArguments) { $arguments += $ForwardedArguments }
    & $BashPath @arguments
    if ($LASTEXITCODE -ne 0) { Fail "CozyGateway installer exited $LASTEXITCODE" }
}

if ($PSVersionTable.PSVersion.Major -lt 5) { Fail 'Windows PowerShell 5.1 or newer is required' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$script:InstallHome = Resolve-InstallHome $env:COZYGATEWAY_HOME
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

$bin = Join-Path $script:InstallHome 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$script:BundlePath = Join-Path $bin 'cozygateway.mjs'
$script:PluginPath = Join-Path $bin 'cozygateway-hermes-attach-plugin.tar.gz'
$installerPath = Join-Path $bin 'agent-install.sh'
Get-VerifiedAsset 'cozygateway.mjs' $script:BundlePath $base
Get-VerifiedAsset 'cozygateway-hermes-attach-plugin.tar.gz' $script:PluginPath $base
Get-VerifiedAsset 'cozygateway-installer.sh' $installerPath $base
Invoke-CozyGatewayInstaller $bash $installerPath $InstallerArguments

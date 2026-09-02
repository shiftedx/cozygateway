<#
The CozyGateway one-liner for Windows:

  irm https://cozylabs.ai/install.ps1 | iex

It installs one CozyGateway for the person running it, under their own profile and with no
administrator rights, and it asks which harness runs their bots. A machine that already has
Hermes Agent keeps it. A machine with none is offered CozyAgents first, and that path installs
the harness through its own native one-liner, pairs this computer as a runner with a code minted
here, and never asks anybody to read a code off a screen.

`irm | iex` runs in the current process, so the execution policy is not consulted and this script
never offers to change it.
#>
param(
    [switch] $Repair,
    # cozyagents or hermes. Skips the harness question, and is the one answer allowed to take a
    # Hermes bridge out of a config that already has one.
    [ValidateSet('cozyagents', 'hermes')]
    [string] $Harness,
    # The CozyAgents Windows installer, as a path or a URL. Defaults to the published one-liner.
    [string] $CozyAgentsInstaller,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $InstallerArguments
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$ProgressPreference = 'SilentlyContinue'
# PowerShell 7.4 turns a non-zero exit from a native command into a terminating error under Stop.
# Every native call here checks $LASTEXITCODE itself and answers with a sentence a person can act
# on. Windows PowerShell 5.1 has no such variable, and assigning it there is harmless.
$PSNativeCommandUseErrorActionPreference = $false

$script:CozyAgentsInstallUrlDefault = 'https://cozylabs.ai/agents.ps1'
# Stays false unless a person or a recorded install actually said CozyAgents, because that is the
# only answer allowed to replace a Hermes bridge in a config that already carries one.
$script:HarnessChosen = $false
$script:PromptAnswers = @{}
$script:PromptIndex = @{}

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

function Promote-VerifiedAsset {
    param([string] $Name, [string] $Stage, [string] $Destination)
    Move-Item -LiteralPath (Join-Path $Stage $Name) -Destination (Join-Path $Destination $Name) -Force
    Move-Item -LiteralPath (Join-Path $Stage "$Name.sha256") -Destination (Join-Path $Destination "$Name.sha256") -Force
}

function Get-PersistedRepairProfiles {
    param([string] $StatePath)
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
        Fail 'repair metadata is unavailable. Reinstall with: irm https://cozylabs.ai/install.ps1 | iex'
    }
    $line = (Get-Content -LiteralPath $StatePath | Where-Object { $_ -like 'profiles=*' } | Select-Object -Last 1)
    if ($null -eq $line) {
        Fail 'repair metadata is invalid. Reinstall with: irm https://cozylabs.ai/install.ps1 | iex'
    }
    $profiles = $line.Substring(9)
    if ([string]::IsNullOrWhiteSpace($profiles) -or $profiles -notmatch '^(?:default|[A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:,(?:default|[A-Za-z0-9][A-Za-z0-9._-]{0,63}))*$') {
        Fail 'repair metadata is invalid. Reinstall with: irm https://cozylabs.ai/install.ps1 | iex'
    }
    return $profiles
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

function Resolve-NativeHermesPath {
    param([string] $Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    $full = [IO.Path]::GetFullPath($Path)
    if ([IO.Path]::GetExtension($full) -ieq '.cmd') {
        $full = [IO.Path]::ChangeExtension($full, '.exe')
    }
    if ([IO.Path]::GetExtension($full) -ieq '.exe' -and (Test-Path -LiteralPath $full -PathType Leaf)) {
        return $full
    }
    return $null
}

function Find-Hermes {
    $resolved = Resolve-NativeHermesPath $env:COZYGATEWAY_TEST_HERMES
    if ($resolved) { return $resolved }
    $command = Get-Command hermes.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
        $resolved = Resolve-NativeHermesPath $command.Source
        if ($resolved) { return $resolved }
    }
    $resolved = Resolve-NativeHermesPath (Join-Path $env:LOCALAPPDATA 'hermes\bin\hermes.exe')
    if ($resolved) { return $resolved }
    return $null
}

function Get-HermesVersion {
    param([string] $HermesPath)
    $versionOutput = (& $HermesPath --version 2>&1 | Out-String)
    $versionExit = $LASTEXITCODE
    $match = [regex]::Match($versionOutput, '(?i)\bHermes Agent v(?<version>(?<core>\d+\.\d+\.\d+)(?<prerelease>-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b')
    if ($versionExit -ne 0 -or -not $match.Success) {
        Fail 'could not verify the installed Hermes version; Hermes v0.21.0 or newer is required. Run hermes update, then retry this installer'
    }
    return [pscustomobject]@{
        Text = $match.Groups['version'].Value
        Core = [Version]$match.Groups['core'].Value
        IsPrerelease = $match.Groups['prerelease'].Success
    }
}

function Test-CompatibleHermesVersion {
    param($Version)
    return (-not $Version.IsPrerelease -and $Version.Core -ge [Version]'0.21.0')
}

function Ensure-CompatibleHermes {
    param([string] $HermesPath)
    $before = Get-HermesVersion $HermesPath
    if (Test-CompatibleHermesVersion $before) { return }
    Write-Info "Hermes v$($before.Text) must be updated for reliable multi-profile gateway attach"
    & $HermesPath update --yes
    if ($LASTEXITCODE -ne 0) { Fail "Hermes update failed; Hermes v0.21.0 or newer is required. Resolve the update error, then retry this installer" }
    $after = Get-HermesVersion $HermesPath
    if (-not (Test-CompatibleHermesVersion $after)) {
        Fail "Hermes update did not install a compatible stable version (found v$($after.Text); v0.21.0 or newer is required)"
    }
    Write-Ok "updated Hermes from v$($before.Text) to v$($after.Text)"
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
    Ensure-CompatibleHermes $hermes
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
    param([string] $ExplicitPath, [string] $Guidance = 'Re-run the Hermes Windows installer, then paste this command again.')
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
    Fail "Git Bash was not found. $Guidance"
}

# The shared installer owns the gateway on every platform. On the CozyAgents harness it owns only
# the gateway: COZYGATEWAY_WINDOWS_HARNESS_OWNER tells it that this script asks the model and
# network questions, installs the harness, pairs the runner and prints the QR.
function Invoke-CozyGatewayInstaller {
    param(
        [string] $BashPath,
        [string] $InstallerPath,
        [string] $HermesPath,
        [string[]] $ForwardedArguments,
        [string] $HarnessName = 'hermes',
        [string[]] $HarnessArguments = @()
    )
    $arguments = @($InstallerPath, '--service-platform', 'Windows', '--gateway-dir', $script:InstallHome, '--bundle', $script:BundlePath)
    if ($HarnessName -eq 'cozyagents') {
        $arguments += @('--harness', 'cozyagents')
        if ($HarnessArguments) { $arguments += $HarnessArguments }
    } else {
        $arguments += @('--plugin-archive', $script:PluginPath)
    }
    if ($env:COZYGATEWAY_INSTALL_DRYRUN -eq '1') { $arguments += '--dry-run' }
    if ($ForwardedArguments) { $arguments += $ForwardedArguments }
    $previousHermes = [Environment]::GetEnvironmentVariable('COZYGATEWAY_HERMES_BIN', 'Process')
    $previousPowerShell = [Environment]::GetEnvironmentVariable('COZYGATEWAY_POWERSHELL', 'Process')
    $previousOwner = [Environment]::GetEnvironmentVariable('COZYGATEWAY_WINDOWS_HARNESS_OWNER', 'Process')
    $previousAgentsHome = [Environment]::GetEnvironmentVariable('COZYAGENTS_HOME', 'Process')
    $trustedPowerShell = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (-not (Test-Path -LiteralPath $trustedPowerShell -PathType Leaf)) { Fail 'native Windows PowerShell is unavailable' }
    try {
        $env:COZYGATEWAY_HERMES_BIN = $HermesPath
        $env:COZYGATEWAY_POWERSHELL = $trustedPowerShell
        if ($HarnessName -eq 'cozyagents') {
            $env:COZYGATEWAY_WINDOWS_HARNESS_OWNER = '1'
            # The shared installer records the harness home as a POSIX path it can act on later.
            # A native path handed to it here would be recorded as one, and read back as unsafe.
            [Environment]::SetEnvironmentVariable('COZYAGENTS_HOME', $null, 'Process')
        }
        & $BashPath @arguments
        if ($LASTEXITCODE -ne 0) { Fail "CozyGateway installer exited $LASTEXITCODE" }
    } finally {
        [Environment]::SetEnvironmentVariable('COZYGATEWAY_HERMES_BIN', $previousHermes, 'Process')
        [Environment]::SetEnvironmentVariable('COZYGATEWAY_POWERSHELL', $previousPowerShell, 'Process')
        [Environment]::SetEnvironmentVariable('COZYGATEWAY_WINDOWS_HARNESS_OWNER', $previousOwner, 'Process')
        [Environment]::SetEnvironmentVariable('COZYAGENTS_HOME', $previousAgentsHome, 'Process')
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

# ---------------------------------------------------------------------------
# The harness choice, and the CozyAgents half of it
# ---------------------------------------------------------------------------

# The supported one-liner is pasted into a terminal, where Read-Host is the person. An unattended
# run has no terminal at all, and every question below then takes its safe default rather than
# reading a redirected stdin that was never meant as an answer.
function Test-CanPrompt {
    if (-not [Environment]::UserInteractive) { return $false }
    try { if ([Console]::IsInputRedirected) { return $false } } catch { return $false }
    return $true
}

function Test-PromptAvailable {
    param([string] $InputVariable)
    if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($InputVariable, 'Process'))) { return $true }
    return (Test-CanPrompt)
}

# $null means there was no way to ask at all, which is not the same answer as pressing Enter.
function Get-PromptAnswer {
    param([string] $Prompt, [string] $InputVariable, [string] $Fallback)
    $scripted = [Environment]::GetEnvironmentVariable($InputVariable, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($scripted)) {
        if (-not $script:PromptAnswers.ContainsKey($InputVariable)) {
            $lines = @()
            if (Test-Path -LiteralPath $scripted -PathType Leaf) { $lines = @(Get-Content -LiteralPath $scripted) }
            $script:PromptAnswers[$InputVariable] = $lines
            $script:PromptIndex[$InputVariable] = 0
        }
        Write-Host $Prompt
        $answers = $script:PromptAnswers[$InputVariable]
        $index = $script:PromptIndex[$InputVariable]
        if ($index -ge $answers.Count) { return $Fallback }
        $script:PromptIndex[$InputVariable] = $index + 1
        $value = [string]$answers[$index]
        if ([string]::IsNullOrWhiteSpace($value)) { return $Fallback }
        return $value.Trim()
    }
    if (-not (Test-CanPrompt)) { return $null }
    try { $answer = Read-Host -Prompt $Prompt } catch { return $Fallback }
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Fallback }
    return $answer.Trim()
}

function Get-RecordedHarness {
    param([string] $StatePath)
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return '' }
    $lines = @(Get-Content -LiteralPath $StatePath)
    $harnessLine = $lines | Where-Object { $_ -like 'harness=*' } | Select-Object -Last 1
    if ($harnessLine) { return ([string]$harnessLine).Substring(8).Trim() }
    # An install written before the harness question existed records a Hermes root instead, and
    # that is just as binding.
    if ($lines | Where-Object { $_ -like 'hermes_root=*' }) { return 'hermes' }
    return ''
}

function Test-HermesBridge {
    param([string] $ConfigPath)
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return $false }
    return ((Get-Content -LiteralPath $ConfigPath -Raw) -match '"hermesEndpoints"')
}

# The harness is the thing that actually runs a bot. A machine that already has Hermes keeps it,
# with no question asked; a machine with none is offered CozyAgents first and takes it on Enter,
# on -Harness, and whenever there is no terminal to ask on.
function Select-Harness {
    param([string] $Requested, [string] $StatePath, [string] $ConfigPath)
    $harness = ''
    if ($Requested) {
        if ($Requested -eq 'cozyagents') { $script:HarnessChosen = $true }
        Write-Ok "harness: $Requested (from -Harness)"
        $harness = $Requested
    } else {
        # A machine that answered this question once is never asked again: the recorded harness is
        # the one this install owns, and changing it is an uninstall away.
        $recorded = Get-RecordedHarness $StatePath
        if ($recorded -eq 'cozyagents') {
            $script:HarnessChosen = $true
            Write-Ok 'harness: cozyagents (already installed here)'
            $harness = 'cozyagents'
        } elseif ($recorded -eq 'hermes') {
            Write-Ok 'harness: hermes (already installed here)'
            $harness = 'hermes'
        } elseif (Find-Hermes) {
            Write-Ok 'Hermes Agent is already installed; keeping it as the harness that runs your bots'
            $harness = 'hermes'
        } else {
            $harness = 'cozyagents'
            while ($true) {
                $answer = Get-PromptAnswer 'Which harness runs your bots? [1] CozyAgents (recommended) [2] Hermes Agent [1]' 'COZYGATEWAY_TEST_HARNESS_PROMPT_INPUT' '1'
                if ($null -eq $answer) { break }
                $normalized = $answer.ToLowerInvariant()
                if ($normalized -eq '1' -or $normalized -eq 'c' -or $normalized -eq 'cozyagents') { $script:HarnessChosen = $true; $harness = 'cozyagents'; break }
                if ($normalized -eq '2' -or $normalized -eq 'h' -or $normalized -eq 'hermes') { $harness = 'hermes'; break }
                Write-Host 'Please answer 1 or 2.'
            }
            if ($script:HarnessChosen -or $harness -eq 'hermes') { Write-Ok "harness: $harness" }
        }
    }
    # A Hermes bridge in a config that nobody asked to replace freezes the run: it stays a Hermes
    # install end to end, and the Hermes install records harness=hermes, so the next run cannot
    # read that kept bridge back as the explicit choice nobody made.
    if ($harness -eq 'cozyagents' -and -not $script:HarnessChosen -and (Test-HermesBridge $ConfigPath)) {
        Write-Host 'WARN  this config already has a Hermes endpoint and no one chose CozyAgents here; keeping it. Rerun with -Harness cozyagents to replace it.'
        Write-Info 'continuing as a Hermes install; nothing CozyAgents-owned is installed, paired, or configured here.'
        Write-Info 'irm | iex takes no parameters; to pass one, run: & ([scriptblock]::Create((irm https://cozylabs.ai/install.ps1))) -Harness cozyagents'
        $harness = 'hermes'
    }
    return $harness
}

# CozyAgents installs per user under the profile of whoever runs it and refuses an elevated token
# when it runs. Refusing here, before anything is installed, is what keeps an elevated paste from
# leaving a gateway under the administrator profile with no harness and no runner behind it. The
# Hermes path is untouched: it has always installed whatever token it was given.
function Test-ElevatedToken {
    # COZYAGENTS_INSTALL_ASSUME_ELEVATED is the harness installer's own knob, honoured here so one
    # variable elevates both halves of a test run. COZYGATEWAY_TEST_ASSUME_ELEVATED is this side's,
    # and 0 is the only way to say "not elevated": a CI runner holds an administrator token, which
    # would otherwise refuse every CozyAgents case in the suite.
    if ($env:COZYGATEWAY_TEST_ASSUME_ELEVATED -eq '1' -or $env:COZYAGENTS_INSTALL_ASSUME_ELEVATED -eq '1') { return $true }
    if ($env:COZYGATEWAY_TEST_ASSUME_ELEVATED -eq '0') { return $false }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Deny-Elevation {
    if (Test-ElevatedToken) { Fail 'CozyAgents installs per user under your profile and never needs administrator; rerun as yourself.' }
}

function Test-SafeModelWord {
    param([string] $Value)
    return ($Value -cmatch '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$')
}

function Test-SafeModelEndpoint {
    param([string] $Value)
    return ($Value -cmatch '^https?://[A-Za-z0-9._~:/?#@%+=-]{1,255}$')
}

# A Codex login already on this machine is the one credential a person can share with their bots
# without typing a key anywhere. Detection only: nothing is read, copied, or written.
function Find-CodexLogin {
    $auth = $env:COZYGATEWAY_CODEX_AUTH_PATH
    if ([string]::IsNullOrWhiteSpace($auth)) { $auth = Join-Path $env:USERPROFILE '.pi\agent\auth.json' }
    if (Test-Path -LiteralPath $auth -PathType Leaf) { return $auth }
    $hermesHome = $env:HERMES_HOME
    if ([string]::IsNullOrWhiteSpace($hermesHome)) { $hermesHome = Join-Path $env:LOCALAPPDATA 'hermes' }
    $hermesEnv = Join-Path $hermesHome '.env'
    if (Test-Path -LiteralPath $hermesEnv -PathType Leaf) {
        if ((Get-Content -LiteralPath $hermesEnv -Raw) -match '(?m)^\s*(OPENAI_CODEX_[A-Z0-9_]*|CODEX_[A-Z0-9_]*)=\S') { return $hermesEnv }
    }
    return $null
}

# The CozyAgents half of provider-and-model onboarding: the same pair of questions the Hermes path
# asks, answered once, and written to the runner env by Write-RunnerModelEnv.
function Confirm-CozyAgentsModel {
    param([string] $RunnerEnvPath)
    $answers = @{ Provider = ''; Endpoint = ''; Id = ''; ShareHostAuth = $false }
    $provider = $env:COZYGATEWAY_RUNNER_MODEL_PROVIDER
    $endpoint = $env:COZYGATEWAY_RUNNER_MODEL_ENDPOINT
    $id = $env:COZYGATEWAY_RUNNER_MODEL_ID
    if (-not [string]::IsNullOrWhiteSpace($provider) -and -not [string]::IsNullOrWhiteSpace($endpoint)) {
        Fail 'COZYGATEWAY_RUNNER_MODEL_PROVIDER and COZYGATEWAY_RUNNER_MODEL_ENDPOINT are mutually exclusive; a bot has one model source'
    }
    if ((-not [string]::IsNullOrWhiteSpace($provider)) -or (-not [string]::IsNullOrWhiteSpace($endpoint))) {
        if ([string]::IsNullOrWhiteSpace($id)) { Fail 'a model provider or endpoint needs COZYGATEWAY_RUNNER_MODEL_ID as well' }
        $answers.Provider = [string]$provider
        $answers.Endpoint = [string]$endpoint
        $answers.Id = [string]$id
        $source = if ($answers.Provider) { $answers.Provider } else { $answers.Endpoint }
        Write-Ok "default model for new bots: $($answers.Id) on $source"
        return $answers
    }
    if (-not [string]::IsNullOrWhiteSpace($id)) { Fail 'COZYGATEWAY_RUNNER_MODEL_ID needs COZYGATEWAY_RUNNER_MODEL_PROVIDER or COZYGATEWAY_RUNNER_MODEL_ENDPOINT' }
    if (-not (Test-PromptAvailable 'COZYGATEWAY_TEST_MODEL_PROMPT_INPUT')) {
        Write-Info "no terminal to ask about a model on; set COZYRUNNER_MODEL_PROVIDER (or COZYRUNNER_MODEL_ENDPOINT) and COZYRUNNER_MODEL_ID in $RunnerEnvPath"
        return $answers
    }
    while ($true) {
        $answer = Get-PromptAnswer 'Which provider should new bots use? A provider name (openai-codex) or a local endpoint URL (http://127.0.0.1:1234/v1) [openai-codex]' 'COZYGATEWAY_TEST_MODEL_PROMPT_INPUT' 'openai-codex'
        if ($null -eq $answer) { $answer = 'openai-codex' }
        if ($answer -like 'http://*' -or $answer -like 'https://*') {
            if (Test-SafeModelEndpoint $answer) { $answers.Endpoint = $answer; break }
            Write-Host 'That is not a usable endpoint URL.'
        } else {
            if (Test-SafeModelWord $answer) { $answers.Provider = $answer; break }
            Write-Host 'Provider names are letters, digits, and . _ : / -'
        }
    }
    while ($true) {
        $answer = Get-PromptAnswer 'Which model id should new bots use?' 'COZYGATEWAY_TEST_MODEL_PROMPT_INPUT' ''
        if ($null -ne $answer -and (Test-SafeModelWord $answer)) { $answers.Id = $answer; break }
        Write-Host 'Model ids are letters, digits, and . _ : / -'
    }
    if ($answers.Provider) {
        $codex = Find-CodexLogin
        if ($codex) {
            while ($true) {
                $answer = Get-PromptAnswer "Share the Codex login on this computer ($codex) with the bots that run here, so you never paste an API key? [y/N]" 'COZYGATEWAY_TEST_MODEL_PROMPT_INPUT' 'n'
                if ($null -eq $answer) { break }
                $normalized = $answer.ToLowerInvariant()
                if ($normalized -eq 'y' -or $normalized -eq 'yes') { $answers.ShareHostAuth = $true; break }
                if ($normalized -eq 'n' -or $normalized -eq 'no') { break }
                Write-Host 'Please answer y or n.'
            }
        }
    }
    $source = if ($answers.Provider) { $answers.Provider } else { $answers.Endpoint }
    Write-Ok "default model for new bots: $($answers.Id) on $source"
    return $answers
}

# Windows ignores the POSIX mode on a file, so a 0600 there is a lie. This resets the ACL to the
# owning user plus SYSTEM with inheritance disabled, and throws when it cannot.
function Protect-FileToOwner {
    param([string] $Path)
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($currentUser, $system)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $identity,
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    (Get-Item -LiteralPath $Path).SetAccessControl($acl)
}

function Get-RunnerEnvValue {
    param([string] $Path, [string] $Name)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $line = Get-Content -LiteralPath $Path | Where-Object { $_ -like "$Name=*" } | Select-Object -Last 1
    if (-not $line) { return '' }
    return ([string]$line).Substring($Name.Length + 1).Trim()
}

function Set-RunnerEnvValue {
    param([string] $Path, [string] $Name, [string] $Value)
    $lines = @()
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $lines = @(Get-Content -LiteralPath $Path | Where-Object { -not ($_ -like "$Name=*") })
    }
    $lines += "$Name=$Value"
    [IO.File]::WriteAllText($Path, (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
    Protect-FileToOwner $Path
}

# The answers land in the runner env CozyAgents already reads, next to the pairing token and never
# in this installer's own state. No key is ever written here.
function Write-RunnerModelEnv {
    param([string] $RunnerEnvPath, [hashtable] $Answers)
    if (-not $Answers.Provider -and -not $Answers.Endpoint) { return }
    if (-not $Answers.Id) { return }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $RunnerEnvPath) | Out-Null
    Set-RunnerEnvValue $RunnerEnvPath 'COZYRUNNER_MODEL_ID' $Answers.Id
    if ($Answers.Provider) {
        Set-RunnerEnvValue $RunnerEnvPath 'COZYRUNNER_MODEL_PROVIDER' $Answers.Provider
    } else {
        Set-RunnerEnvValue $RunnerEnvPath 'COZYRUNNER_MODEL_ENDPOINT' $Answers.Endpoint
    }
    if ($Answers.ShareHostAuth) { Set-RunnerEnvValue $RunnerEnvPath 'COZYRUNNER_SHARE_HOST_MODEL_AUTH' '1' }
    Write-Ok "wrote the default model for new bots to $RunnerEnvPath"
}

function Resolve-CozyAgentsHome {
    $candidate = $env:COZYAGENTS_HOME
    if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = Join-Path $env:USERPROFILE '.cozyagents' }
    return ([IO.Path]::GetFullPath($candidate)).TrimEnd('\')
}

function Get-CozyAgentsInstallerSource {
    param([string] $Requested)
    if (-not [string]::IsNullOrWhiteSpace($Requested)) { return $Requested }
    if (-not [string]::IsNullOrWhiteSpace($env:COZYAGENTS_INSTALL_URL)) { return $env:COZYAGENTS_INSTALL_URL }
    return $script:CozyAgentsInstallUrlDefault
}

# The CozyAgents half of the install: its own verified one-liner does the bundle, the private Node,
# the launcher and the scheduled task, and this script pairs it, because it is the one side that
# can mint a runner code without asking anybody to read one off a screen. The installer is run in
# this process the way irm | iex runs it, so no execution policy is consulted or changed.
function Install-CozyAgentsHarness {
    param([string] $AgentsHome, [string] $Source)
    Write-Info 'installing CozyAgents, the harness that runs your bots on this machine.'
    # The scriptblock runs in this script's session state, so its $script: variables are this
    # script's: its $script:Tag, $script:Repo and $script:AssetBase are the same names as $tag,
    # $repo and $base here. Nothing reads those after this point; do not start.
    $staged = Join-Path ([IO.Path]::GetTempPath()) ('cozyagents-install-' + [guid]::NewGuid().ToString('N') + '.ps1')
    $previousAgentsHome = [Environment]::GetEnvironmentVariable('COZYAGENTS_HOME', 'Process')
    try {
        Copy-OrDownload $Source $staged
        $content = [IO.File]::ReadAllText($staged).TrimStart([char]0xFEFF)
        $env:COZYAGENTS_HOME = $AgentsHome
        & ([scriptblock]::Create($content)) -NoPair -InstallHome $AgentsHome
    } finally {
        [Environment]::SetEnvironmentVariable('COZYAGENTS_HOME', $previousAgentsHome, 'Process')
        Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath (Join-Path $AgentsHome 'install.json') -PathType Leaf)) {
        Fail 'the CozyAgents install did not complete successfully'
    }
}

# node plus the bundle rather than the cozyagents.cmd launcher this install also writes: PowerShell
# runs a .cmd through cmd.exe, which parses the command line a second time, and a computer name or
# a gateway URL carrying an ampersand would then split it.
function Get-CozyAgentsCommand {
    param([string] $AgentsHome)
    $statePath = Join-Path $AgentsHome 'install.json'
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $node = [string]$state.node
    $bundle = [string]$state.bundle.path
    if ([string]::IsNullOrWhiteSpace($node) -or [string]::IsNullOrWhiteSpace($bundle)) {
        Fail 'the CozyAgents install did not record the node and bundle this computer pairs with'
    }
    return @{ Node = $node; Bundle = $bundle }
}

function Get-GatewayOrigin {
    param([string] $ConfigPath)
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { Fail "CozyGateway did not write its configuration at $ConfigPath" }
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $names = @($config.PSObject.Properties.Name)
    if ($names -contains 'publicUrl' -and -not [string]::IsNullOrWhiteSpace([string]$config.publicUrl)) { return ([string]$config.publicUrl) }
    $listenHost = [string]$config.host
    if ($listenHost -eq '0.0.0.0' -or $listenHost -eq '::') { $listenHost = '127.0.0.1' }
    elseif ($listenHost.Contains(':')) { $listenHost = "[$listenHost]" }
    return "http://$listenHost`:$([string]$config.port)"
}

# One runner pairing code, minted here through the gateway's own CLI and handed straight to the
# CozyAgents runner, so nobody types a code to pair the machine they are standing at. It is never
# printed, never logged, and never reaches an argument.
function New-RunnerPairCode {
    param([string] $Cli)
    $output = (& $Cli pair --kind runner --ttl 10 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { Fail "could not mint a runner pairing code; the gateway is installed, so retry with: $Cli pair --kind runner" }
    $match = [regex]::Match($output, '(?m)^Setup code:\s*(?<code>\S+)\s*$')
    if (-not $match.Success) { Fail 'the gateway did not return a usable runner pairing code' }
    $code = $match.Groups['code'].Value
    if ($code -cnotmatch '^[A-Za-z0-9-]{4,64}$') { Fail 'the gateway did not return a usable runner pairing code' }
    return $code
}

function Join-RunnerToGateway {
    param([string] $AgentsHome, [string] $Cli, [string] $ConfigPath)
    $runnerEnv = Join-Path $AgentsHome 'runner.env'
    # A computer that is already paired keeps the runner credential it has: a second run upgrades
    # the harness and leaves the pairing, exactly as a second run leaves device trust alone.
    if (Get-RunnerEnvValue $runnerEnv 'COZYRUNNER_TOKEN') {
        Write-Ok 'this computer is already paired to CozyGateway as a runner; keeping that pairing'
        return
    }
    $origin = Get-GatewayOrigin $ConfigPath
    $name = $env:COMPUTERNAME
    if ([string]::IsNullOrWhiteSpace($name)) { $name = [Environment]::MachineName }
    $command = Get-CozyAgentsCommand $AgentsHome
    $code = New-RunnerPairCode $Cli
    # The code travels in the environment, never in an argument: it is a credential in waiting, and
    # an argument is readable by every other process on this machine while the command runs.
    $previous = [Environment]::GetEnvironmentVariable('COZYAGENTS_PAIR_CODE', 'Process')
    try {
        $env:COZYAGENTS_PAIR_CODE = $code
        & $command.Node $command.Bundle runner pair --gateway $origin --name $name --home $AgentsHome
        if ($LASTEXITCODE -ne 0) {
            Fail "CozyAgents is installed but pairing did not complete; mint a code with `"$Cli pair --kind runner`" and run: cozyagents runner pair <code> --gateway $origin"
        }
    } finally {
        [Environment]::SetEnvironmentVariable('COZYAGENTS_PAIR_CODE', $previous, 'Process')
    }
    Write-Ok "CozyAgents is paired to $origin as `"$name`"; bots you make in CozyChat run here"
}

# The network question, asked once on a fresh install and answered by the listener the shared
# installer is then told to use. An install that already has a listener keeps it.
function Select-Listener {
    param([bool] $AlreadyConfigured, [string[]] $ForwardedArguments)
    if ($AlreadyConfigured) { return @() }
    foreach ($flag in @('--bind-host', '--public-url', '--clear-public-url')) {
        if ($ForwardedArguments -contains $flag) { return @() }
    }
    while ($true) {
        $answer = Get-PromptAnswer 'Allow CozyChat to access this Gateway over your local network? [y/N]' 'COZYGATEWAY_TEST_LAN_PROMPT_INPUT' 'n'
        if ($null -eq $answer) { break }
        $normalized = $answer.ToLowerInvariant()
        if ($normalized -eq 'y' -or $normalized -eq 'yes') { return @('--bind-host', '0.0.0.0') }
        if ($normalized -eq 'n' -or $normalized -eq 'no') { break }
        Write-Host 'Please answer y or n.'
    }
    return @('--bind-host', '127.0.0.1')
}

# First setup ends ready to scan. Updates preserve existing device trust and ask before creating
# any new credential; unattended updates take the default No, and --no-qr never prints one at all.
function Complete-Pairing {
    param([string] $Cli, [bool] $AlreadyConfigured, [bool] $NoQr)
    $mint = $false
    if ($NoQr) {
        Write-Info "no pairing QR was printed (--no-qr); run $Cli pair when you want to add a device"
    } elseif (-not $AlreadyConfigured) {
        $mint = $true
    } else {
        while ($true) {
            $answer = Get-PromptAnswer 'Create a new CozyChat pairing code? [y/N]' 'COZYGATEWAY_TEST_PAIR_PROMPT_INPUT' 'n'
            if ($null -eq $answer) { break }
            $normalized = $answer.ToLowerInvariant()
            if ($normalized -eq 'y' -or $normalized -eq 'yes') { $mint = $true; break }
            if ($normalized -eq 'n' -or $normalized -eq 'no') { break }
            Write-Host 'Please answer y or n.'
        }
        if (-not $mint) { Write-Info "no new pairing code created; run $Cli pair when you want to add a device" }
    }
    if ($mint) {
        & $Cli pair
        if ($LASTEXITCODE -ne 0) { Fail "could not create a pairing code; the gateway is installed, so retry with: $Cli pair" }
    }
    Write-Info "codes expire after 10 minutes; mint a fresh QR and code with: $Cli pair"
    Write-Info 'for a tunnel, rerun the installer with: --public-url https://gateway.example.com'
}

# The CozyAgents branch: the same gateway with no Hermes discovery, no plugin and no Dashboard,
# plus the harness, its runner pairing, and the model answers the runner reads.
function Install-WithCozyAgents {
    param(
        [string] $Bin,
        [string] $InstallerPath,
        [string] $ConfigPath,
        [string] $CliPath,
        [string] $Base,
        [bool] $AlreadyConfigured,
        [bool] $NoQr,
        [string[]] $ForwardedArguments,
        [string] $InstallerSource
    )
    Write-Ok 'harness: CozyAgents; your bots run on this computer under the CozyAgents runner'
    $agentsHome = Resolve-CozyAgentsHome
    # The gateway half is the shared installer, so a machine without Git Bash cannot finish. Say so
    # before the questions rather than after a person has answered all three.
    $bash = Resolve-GitBash $env:COZYGATEWAY_GIT_BASH 'Install Git for Windows from https://git-scm.com/download/win, then paste this command again.'
    $model = Confirm-CozyAgentsModel (Join-Path $agentsHome 'runner.env')
    $listener = Select-Listener $AlreadyConfigured $ForwardedArguments

    Protect-CozyGatewayHome $script:InstallHome
    $stage = Join-Path $script:InstallHome ('.bootstrap-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Force -Path $stage
    $script:BundlePath = Join-Path $Bin 'cozygateway.mjs'
    try {
        Get-VerifiedAsset 'cozygateway.mjs' (Join-Path $stage 'cozygateway.mjs') $Base
        Get-VerifiedAsset 'cozygateway-installer.sh' (Join-Path $stage 'agent-install.sh') $Base
        Get-VerifiedAsset 'install.ps1' (Join-Path $stage 'cozygateway-bootstrap.ps1') $Base
        New-Item -ItemType Directory -Force -Path $Bin | Out-Null
        foreach ($asset in @('cozygateway.mjs', 'agent-install.sh', 'cozygateway-bootstrap.ps1')) {
            Promote-VerifiedAsset $asset $stage $Bin
        }
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }

    Invoke-CozyGatewayInstaller $bash $InstallerPath '' $ForwardedArguments 'cozyagents' $listener
    Set-CozyGatewayCommandPath $Bin $true
    Install-CozyAgentsHarness $agentsHome $InstallerSource
    Write-RunnerModelEnv (Join-Path $agentsHome 'runner.env') $model
    Join-RunnerToGateway $agentsHome $CliPath $ConfigPath
    Complete-Pairing $CliPath $AlreadyConfigured $NoQr
}

# A CozyAgents uninstall takes back exactly what this bootstrap put there: the gateway through the
# shared installer, and the harness through the CozyAgents uninstaller, which owns its launcher,
# its PATH line, its task and its runner state.
function Uninstall-WithCozyAgents {
    param([string] $Bin, [string] $InstallerPath, [string[]] $ForwardedArguments, [bool] $IsDryRun)
    $agentsHome = Resolve-CozyAgentsHome
    $bash = Resolve-GitBash $env:COZYGATEWAY_GIT_BASH 'Install Git for Windows from https://git-scm.com/download/win, then paste this command again.'
    if (-not (Test-Path -LiteralPath $InstallerPath)) { Fail "no CozyGateway installer was found at $InstallerPath" }
    $arguments = @($InstallerPath, '--service-platform', 'Windows', '--gateway-dir', $script:InstallHome) + @($ForwardedArguments)
    if ($IsDryRun -and -not ($arguments -contains '--dry-run')) { $arguments += '--dry-run' }
    $previousOwner = [Environment]::GetEnvironmentVariable('COZYGATEWAY_WINDOWS_HARNESS_OWNER', 'Process')
    try {
        $env:COZYGATEWAY_WINDOWS_HARNESS_OWNER = '1'
        & $bash @arguments
        if ($LASTEXITCODE -ne 0) { Fail "CozyGateway installer exited $LASTEXITCODE" }
    } finally {
        [Environment]::SetEnvironmentVariable('COZYGATEWAY_WINDOWS_HARNESS_OWNER', $previousOwner, 'Process')
    }
    if ($IsDryRun) {
        Write-Info "dry run: would remove the CozyAgents harness through its own uninstaller at $agentsHome"
        return
    }
    Set-CozyGatewayCommandPath $Bin $false
    if (Test-Path -LiteralPath (Join-Path $agentsHome 'install.json') -PathType Leaf) {
        $command = Get-CozyAgentsCommand $agentsHome
        & $command.Node $command.Bundle uninstall --home $agentsHome --yes
        if ($LASTEXITCODE -ne 0) { Fail "the CozyAgents harness could not be removed; run: cozyagents uninstall --home $agentsHome" }
        Write-Ok 'removed the CozyAgents harness through its own uninstaller'
    } else {
        Write-Host "WARN  the cozyagents command is gone; leaving $agentsHome untouched"
    }
}

if ($PSVersionTable.PSVersion.Major -lt 5) { Fail 'Windows PowerShell 5.1 or newer is required' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$script:InstallHome = Resolve-InstallHome $env:COZYGATEWAY_HOME
$bin = Join-Path $script:InstallHome 'bin'
$installerPath = Join-Path $bin 'agent-install.sh'
$bootstrapPath = Join-Path $bin 'cozygateway-bootstrap.ps1'
$cliPath = Join-Path $bin 'cozygateway.cmd'
$statePath = Join-Path $script:InstallHome 'local\install-state'
$configPath = Join-Path $script:InstallHome 'local\cozygateway.config.json'
$isUninstall = $InstallerArguments -contains '--uninstall'
$isDryRun = $env:COZYGATEWAY_INSTALL_DRYRUN -eq '1' -or $InstallerArguments -contains '--dry-run'
$isNoQr = $InstallerArguments -contains '--no-qr'
$alreadyConfigured = Test-Path -LiteralPath $configPath -PathType Leaf
$cozyAgentsInstaller = Get-CozyAgentsInstallerSource $CozyAgentsInstaller

if ($Repair) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf) -or -not (Test-Path -LiteralPath "$bootstrapPath.sha256" -PathType Leaf)) {
        Fail 'repair bootstrap is unavailable. Reinstall with: irm https://cozylabs.ai/install.ps1 | iex'
    }
    $expected = ((Get-Content -LiteralPath "$bootstrapPath.sha256" -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $bootstrapPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($expected) -or $expected -ne $actual) {
        Fail 'repair bootstrap checksum mismatch. Reinstall with: irm https://cozylabs.ai/install.ps1 | iex'
    }
    if ((Get-RecordedHarness $statePath) -eq 'cozyagents') {
        $Harness = 'cozyagents'
        Write-Info 'repair refreshes verified runtime assets, then restarts CozyGateway'
    } else {
        $InstallerArguments = @('--profiles', (Get-PersistedRepairProfiles $statePath)) + @($InstallerArguments)
        Write-Info 'repair refreshes verified runtime and plugin assets, then restarts CozyGateway and Hermes attachment'
    }
}

if ($isUninstall) {
    $recorded = if ($Harness) { $Harness } else { Get-RecordedHarness $statePath }
    if ($recorded -eq 'cozyagents') {
        Uninstall-WithCozyAgents $bin $installerPath $InstallerArguments ([bool]$isDryRun)
        return
    }
    $bash = Resolve-GitBash $env:COZYGATEWAY_GIT_BASH
    if (-not (Test-Path -LiteralPath $installerPath)) { Fail "no CozyGateway installer was found at $installerPath" }
    $uninstallArguments = @($installerPath, '--service-platform', 'Windows', '--gateway-dir', $script:InstallHome) + @($InstallerArguments)
    if ($isDryRun -and -not ($uninstallArguments -contains '--dry-run')) { $uninstallArguments += '--dry-run' }
    & $bash @uninstallArguments
    if ($LASTEXITCODE -ne 0) { Fail "CozyGateway installer exited $LASTEXITCODE" }
    if (-not $isDryRun) { Set-CozyGatewayCommandPath $bin $false }
    return
}

# Step 1 of the approved order: the harness, before anything is installed.
$harness = Select-Harness $Harness $statePath $configPath
if ($harness -eq 'cozyagents') { Deny-Elevation }

if ($isDryRun) {
    if ($harness -eq 'cozyagents') {
        $agentsHome = Resolve-CozyAgentsHome
        Write-Info "dry run: would ask for the model provider or a local endpoint, and the model id, then write COZYRUNNER_MODEL_* into $(Join-Path $agentsHome 'runner.env')"
        Write-Info 'dry run: would ask whether CozyChat may reach this Gateway over your local network'
        Write-Info 'dry run: would resolve and checksum-verify the CozyGateway release assets, and no Hermes attach plugin'
        Write-Info "dry run: would install CozyGateway under $script:InstallHome without administrator rights"
        Write-Info "dry run: would install CozyAgents from $cozyAgentsInstaller with -NoPair, then pair this computer as a runner with a code minted here"
        return
    }
    if (Find-Hermes) {
        Write-Info 'dry run: would inspect Hermes model status and open model selection only when setup is incomplete'
    } else {
        Write-Info 'dry run: would install Hermes Agent, inspect its model status, and open model selection only when setup is incomplete'
    }
    Write-Info 'dry run: would resolve and checksum-verify the CozyGateway release assets'
    Write-Info "dry run: would install CozyGateway under $script:InstallHome without administrator rights"
    return
}

$repo = if ($env:COZYGATEWAY_INSTALL_REPO) { $env:COZYGATEWAY_INSTALL_REPO } else { 'shiftedx/cozygateway' }
$tag = $env:COZYGATEWAY_INSTALL_TAG
$base = $env:COZYGATEWAY_INSTALL_ASSET_BASE
if ([string]::IsNullOrWhiteSpace($base)) {
    if ([string]::IsNullOrWhiteSpace($tag)) { $tag = Get-LatestTag $repo }
    $base = "https://github.com/$repo/releases/download/$tag"
}

if ($harness -eq 'cozyagents') {
    Install-WithCozyAgents $bin $installerPath $configPath $cliPath $base ([bool]$alreadyConfigured) ([bool]$isNoQr) $InstallerArguments $cozyAgentsInstaller
    return
}

$hermes = Resolve-Hermes $env:COZYGATEWAY_HERMES_INSTALL_URL
Confirm-HermesModel $hermes
$bash = Resolve-GitBash $env:COZYGATEWAY_GIT_BASH

Protect-CozyGatewayHome $script:InstallHome
$stage = Join-Path $script:InstallHome ('.bootstrap-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Force -Path $stage
$script:BundlePath = Join-Path $bin 'cozygateway.mjs'
$script:PluginPath = Join-Path $bin 'cozygateway-hermes-attach-plugin.tar.gz'
try {
    Get-VerifiedAsset 'cozygateway.mjs' (Join-Path $stage 'cozygateway.mjs') $base
    Get-VerifiedAsset 'cozygateway-hermes-attach-plugin.tar.gz' (Join-Path $stage 'cozygateway-hermes-attach-plugin.tar.gz') $base
    Get-VerifiedAsset 'cozygateway-installer.sh' (Join-Path $stage 'agent-install.sh') $base
    Get-VerifiedAsset 'install.ps1' (Join-Path $stage 'cozygateway-bootstrap.ps1') $base
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    foreach ($asset in @('cozygateway.mjs', 'cozygateway-hermes-attach-plugin.tar.gz', 'agent-install.sh', 'cozygateway-bootstrap.ps1')) {
        Promote-VerifiedAsset $asset $stage $bin
    }
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
Invoke-CozyGatewayInstaller $bash $installerPath $hermes $InstallerArguments
if ($env:COZYGATEWAY_INSTALL_DRYRUN -ne '1') { Set-CozyGatewayCommandPath $bin $true }

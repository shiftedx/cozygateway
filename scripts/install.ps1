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
    $volumeRoot = [IO.Path]::GetPathRoot($full)
    if ($full.TrimEnd('\') -eq $volumeRoot.TrimEnd('\')) { Fail 'COZYGATEWAY_HOME must not be a drive or share root' }
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

function Test-CozyGatewayProcessOwnsConfig {
    param($ProcessRecord, [string] $ExpectedConfig)
    $command = [string]$ProcessRecord.CommandLine
    if (-not $command.Contains('cozygateway.mjs') -or -not $command.Contains(' serve ')) { return $false }
    $tokens = @([regex]::Matches($command, '[^\s"]+|"[^"]*"') | ForEach-Object { $_.Value.Trim([char]34) })
    $candidate = $null
    for ($index = 0; $index -lt $tokens.Count; $index++) {
        if ($tokens[$index] -eq '--config' -and $index + 1 -lt $tokens.Count) { $candidate = $tokens[$index + 1]; break }
        if ($tokens[$index].StartsWith('--config=')) { $candidate = $tokens[$index].Substring(9); break }
    }
    if ([string]::IsNullOrWhiteSpace($candidate)) { return $false }
    try {
        return [IO.Path]::GetFullPath($candidate).Equals([IO.Path]::GetFullPath($ExpectedConfig), [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Resolve-RequestedGatewayPort {
    param([string] $ConfigPath, [string[]] $ForwardedArguments)
    $port = 8787
    $argumentCount = if ($null -eq $ForwardedArguments) { 0 } else { $ForwardedArguments.Length }
    if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
        try {
            $saved = [IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json
            if ($null -ne $saved.port) { $port = [int]$saved.port }
        } catch { Fail 'the existing Gateway config is invalid; repair or remove it before reinstalling' }
    }
    for ($index = 0; $index -lt $argumentCount; $index++) {
        if ($ForwardedArguments[$index] -eq '--port') {
            if ($index + 1 -ge $argumentCount) { Fail '--port needs a value' }
            $candidate = 0
            if (-not [int]::TryParse($ForwardedArguments[$index + 1], [ref]$candidate)) { Fail '--port must be 1-65535' }
            $port = $candidate
            $index++
        }
    }
    if ($port -lt 1 -or $port -gt 65535) { Fail '--port must be 1-65535' }
    return $port
}

function Assert-GatewayPortAvailable {
    param([int] $Port, [string] $ConfigPath)
    try {
        [array]$connection = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($connection.Count -eq 0) { return }
        $ownerPid = [int]$connection[0].OwningProcess
        [array]$owner = @(Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($owner.Count -eq 1 -and (Test-CozyGatewayProcessOwnsConfig $owner[0] $ConfigPath)) { return }
        $processName = try { (Get-Process -Id $ownerPid -ErrorAction Stop).ProcessName } catch { 'unknown' }
        Fail "Gateway port $Port is already in use by PID $ownerPid ($processName). Stop that process, or rerun with --port and a free port. No CozyGateway state was changed."
    } catch {
        if ($_.Exception.Message -like 'FAIL  Gateway port *') { throw }
        Fail "could not inspect Gateway port $Port before installation; no CozyGateway state was changed"
    }
}

function Invoke-CozyGatewayInstaller {
    param([string] $BashPath, [string] $InstallerPath, [string[]] $ForwardedArguments)
    $arguments = @($InstallerPath, '--service-platform', 'Windows', '--gateway-dir', $script:InstallHome, '--bundle', $script:BundlePath, '--plugin-archive', $script:PluginPath)
    if ($env:COZYGATEWAY_INSTALL_DRYRUN -eq '1') { $arguments += '--dry-run' }
    if ($ForwardedArguments) { $arguments += $ForwardedArguments }
    & $BashPath @arguments
    if ($LASTEXITCODE -ne 0) { Fail "CozyGateway installer exited $LASTEXITCODE" }
}

function Invoke-OnboardingHelper {
    param([string] $Command, [hashtable] $Request, [string] $HelperPath = $script:WindowsHelperPath)
    $json = $Request | ConvertTo-Json -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $process = New-Object Diagnostics.Process
    $process.StartInfo.FileName = $powerShell
    $process.StartInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$HelperPath`" $Command"
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardInput = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $utf8 = New-Object Text.UTF8Encoding($false, $true)
    $process.StartInfo.StandardOutputEncoding = $utf8
    $process.StartInfo.StandardErrorEncoding = $utf8
    [void]$process.Start()
    $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $process.StandardInput.Close()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) {
        $process.Kill()
        Fail "Windows onboarding helper timed out for $Command"
    }
    $raw = $stdoutTask.Result.Trim()
    $stderr = $stderrTask.Result
    $exit = $process.ExitCode
    try { $response = $raw | ConvertFrom-Json } catch { Fail "Windows onboarding helper returned an invalid response for $Command" }
    if ($exit -ne 0 -or $null -eq $response -or $response.schemaVersion -ne 1 -or $response.ok -ne $true -or $response.command -cne $Command -or $response.result.applied -ne $true) {
        $reason = if ($null -ne $response -and $null -ne $response.reason) { ": $($response.reason)" } else { '' }
        if ([string]::IsNullOrWhiteSpace($reason) -and -not [string]::IsNullOrWhiteSpace($stderr)) { $reason = ": $($stderr.Trim())" }
        Fail "Windows onboarding helper could not complete $Command$reason"
    }
}

function Protect-InstallBoundary {
    foreach ($path in @(
        $script:WindowsHelperPath,
        (Join-Path $script:InstallHome 'bin\agent-install.sh'),
        (Join-Path $script:InstallHome 'bin\cozygateway.mjs'),
        (Join-Path $script:InstallHome 'runtime'),
        (Join-Path $script:InstallHome 'runtime\node'),
        (Join-Path $script:InstallHome 'runtime\node\node.exe')
    )) {
        if (-not [string]::IsNullOrWhiteSpace($path) -and (Test-Path -LiteralPath $path)) {
            try { Invoke-OnboardingHelper 'protect-path' @{ root = $script:InstallHome; path = $path } }
            catch { Fail "could not protect installer trust-boundary path $path ($($_.Exception.Message))" }
        }
    }
}

function Initialize-OnboardingBootstrap {
    param([bool] $FreshInstall)
    if ($FreshInstall) { Invoke-OnboardingHelper 'initialize-pending' @{ root = $script:InstallHome } }
    $local = Join-Path $script:InstallHome 'local'
    if (-not (Test-Path -LiteralPath $local -PathType Container)) { New-Item -ItemType Directory -Force -Path $local | Out-Null }
    $tokenPath = Join-Path $local 'operator-control.token'
    if (Test-Path -LiteralPath $tokenPath) {
        $token = [IO.File]::ReadAllText($tokenPath)
        if ($token -cnotmatch '^[A-Za-z0-9_-]{43}$') { Fail 'the local onboarding control token is invalid; restore it or remove it and rerun setup' }
    } else {
        $bytes = New-Object byte[] 32
        $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
        $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
        [IO.File]::WriteAllText($tokenPath, $token, (New-Object Text.UTF8Encoding($false)))
    }
    Invoke-OnboardingHelper 'protect-path' @{ root = $script:InstallHome; path = $tokenPath }
    $env:COZYGATEWAY_ONBOARDING_CONTROL_TOKEN_FILE = $tokenPath
    return $tokenPath
}

function Protect-CozyGatewayLocalState {
    $local = Join-Path $script:InstallHome 'local'
    $paths = @(
        $local,
        (Join-Path $local 'cozygateway.config.json'),
        (Join-Path $local 'cozygateway.sqlite'),
        (Join-Path $local 'cozygateway.sqlite-wal'),
        (Join-Path $local 'cozygateway.sqlite-shm'),
        (Join-Path $local 'gateway.env'),
        (Join-Path $local 'dashboard.env'),
        (Join-Path $local 'profiles.json'),
        (Join-Path $local 'install-state'),
        (Join-Path $local 'network-onboarding.json'),
        (Join-Path $local 'operator-control.token')
    )
    foreach ($path in $paths) {
        if (Test-Path -LiteralPath $path) { Invoke-OnboardingHelper 'protect-path' @{ root = $script:InstallHome; path = $path } }
    }
}

function Invoke-PhoneAccessSetup {
    $command = Join-Path $script:InstallHome 'bin\cozygateway.cmd'
    $config = Join-Path $script:InstallHome 'local\cozygateway.config.json'
    $interactive = ($env:COZYGATEWAY_TEST_INTERACTIVE -eq '1') -or (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected)
    if (-not $interactive) {
        Write-Info "Resume phone access setup with: `"$command`" setup --config `"$config`""
        return
    }
    if (-not (Test-Path -LiteralPath $command)) { Fail 'the CozyGateway command was not installed; rerun this installer' }
    & $command setup --config $config
    if ($LASTEXITCODE -ne 0) { Fail 'phone access setup paused or failed; rerun the displayed resume command' }
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

function Get-OwnedNetworkAuthorityStatus {
    param([string] $InstallHome)
    $bundle = Join-Path $InstallHome 'bin\cozygateway.mjs'
    $config = Join-Path $InstallHome 'local\cozygateway.config.json'
    $node = Join-Path $InstallHome 'runtime\node\node.exe'
    $local = Join-Path $InstallHome 'local'
    $defaultDatabase = Join-Path $local 'cozygateway.sqlite'
    $configuredDatabase = $null
    $configReadable = $false
    if (Test-Path -LiteralPath $config -PathType Leaf) {
        try {
            $parsed = [IO.File]::ReadAllText($config) | ConvertFrom-Json
            if ($parsed.dbPath -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$parsed.dbPath)) { throw 'missing database path' }
            if ([string]$parsed.dbPath -ne ':memory:') {
                $configuredDatabase = if ([IO.Path]::IsPathRooted([string]$parsed.dbPath)) {
                    [IO.Path]::GetFullPath([string]$parsed.dbPath)
                } else {
                    [IO.Path]::GetFullPath((Join-Path $local ([string]$parsed.dbPath)))
                }
            }
            $configReadable = $true
        } catch { $configReadable = $false }
    }

    $artifactPaths = New-Object System.Collections.Generic.List[string]
    $databaseCandidates = @($defaultDatabase)
    if ($null -ne $configuredDatabase) { $databaseCandidates += $configuredDatabase }
    foreach ($database in $databaseCandidates) {
        foreach ($candidate in @($database, "$database-wal", "$database-shm")) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $artifactPaths.Add([IO.Path]::GetFullPath($candidate))
            }
        }
    }
    if (Test-Path -LiteralPath $local -PathType Container) {
        foreach ($item in @(Get-ChildItem -LiteralPath $local -File -ErrorAction SilentlyContinue)) {
            if ($item.Name -match '\.sqlite(?:-wal|-shm)?$') { $artifactPaths.Add($item.FullName) }
        }
    }
    [array]$artifacts = @($artifactPaths | Sort-Object -Unique)
    if ($artifacts.Count -eq 0) { return 'absent' }
    if (-not $configReadable -or $null -eq $configuredDatabase) { return 'present_unavailable' }

    $allowedArtifacts = @(
        [IO.Path]::GetFullPath($configuredDatabase),
        [IO.Path]::GetFullPath("$configuredDatabase-wal"),
        [IO.Path]::GetFullPath("$configuredDatabase-shm")
    )
    foreach ($artifact in $artifacts) {
        if (-not @($allowedArtifacts | Where-Object { $_.Equals($artifact, [StringComparison]::OrdinalIgnoreCase) }).Count) {
            return 'present_unavailable'
        }
    }
    if (-not (Test-Path -LiteralPath $configuredDatabase -PathType Leaf) -or
        (Get-Item -LiteralPath $configuredDatabase).Length -le 0 -or
        -not (Test-Path -LiteralPath $bundle -PathType Leaf) -or
        -not (Test-Path -LiteralPath $node -PathType Leaf)) { return 'present_unavailable' }
    return 'ready'
}

function Invoke-OwnedNetworkCleanup {
    param([string] $InstallHome, [bool] $DryRun)
    $node = Join-Path $InstallHome 'runtime\node\node.exe'
    $bundle = Join-Path $InstallHome 'bin\cozygateway.mjs'
    $config = Join-Path $InstallHome 'local\cozygateway.config.json'
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
        Fail 'owned network cleanup cannot run because the installed Node.js runtime is missing; repair the install and retry uninstall'
    }
    if ($DryRun) {
        Write-Info "dry run: would reconcile only installer-owned network state with $node before persistence or file teardown"
        return
    }
    $testLog = [Environment]::GetEnvironmentVariable('COZYGATEWAY_TEST_NETWORK_CLEANUP_LOG', 'Process')
    if (-not [string]::IsNullOrWhiteSpace($testLog)) {
        Add-Content -LiteralPath $testLog -Value "network-cleanup:$node $bundle cleanup-owned-network --config $config"
        return
    }
    try {
        & $node $bundle cleanup-owned-network --config $config
        if ($LASTEXITCODE -ne 0) { Fail 'owned network cleanup failed; uninstall stopped before changing persistence or files' }
    } catch {
        if ($_.Exception.Message -like 'FAIL  owned network cleanup failed*') { throw }
        Fail 'owned network cleanup failed; uninstall stopped before changing persistence or files'
    }
}

function Get-WindowsProcessRecords {
    $fixturePath = [Environment]::GetEnvironmentVariable('COZYGATEWAY_TEST_WINDOWS_PROCESS_FIXTURE', 'Process')
    if (-not [string]::IsNullOrWhiteSpace($fixturePath)) {
        $parsed = [IO.File]::ReadAllText($fixturePath) | ConvertFrom-Json
        foreach ($record in $parsed) { Write-Output $record }
        return
    }
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
}

function Invoke-NativeWindowsTeardown {
    param([string] $InstallHome, [bool] $DryRun)
    $config = Join-Path $InstallHome 'local\cozygateway.config.json'
    $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\CozyGateway.vbs'
    $testLog = [Environment]::GetEnvironmentVariable('COZYGATEWAY_TEST_NATIVE_UNINSTALL_LOG', 'Process')
    if ($DryRun) {
        Write-Info "dry run: would delete the exact CozyGateway Task and Startup entry, stop only the process owned by $config, and remove the managed PATH entry"
        return
    }
    if (-not [string]::IsNullOrWhiteSpace($testLog)) {
        Add-Content -LiteralPath $testLog -Value 'task-delete:CozyGateway'
    } else {
        $schtasks = Join-Path $env:WINDIR 'System32\schtasks.exe'
        if (Test-Path -LiteralPath $schtasks -PathType Leaf) { & $schtasks /Delete /F /TN CozyGateway 2>$null | Out-Null }
    }
    Remove-Item -LiteralPath $startup -Force -ErrorAction SilentlyContinue
    [array]$processes = @(Get-WindowsProcessRecords)
    foreach ($process in $processes) {
        if (-not (Test-CozyGatewayProcessOwnsConfig $process $config)) { continue }
        $pidToStop = [int]$process.ProcessId
        if (-not [string]::IsNullOrWhiteSpace($testLog)) {
            Add-Content -LiteralPath $testLog -Value "process-stop:$pidToStop"
        } else {
            Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue
        }
    }
    Set-CozyGatewayCommandPath (Join-Path $InstallHome 'bin') $false
}

function Remove-DamagedInstallRoot {
    param([string] $InstallHome)
    if (-not (Test-Path -LiteralPath $InstallHome)) { return }
    if (([IO.File]::GetAttributes($InstallHome) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail 'refusing to recursively remove a reparse-point install root'
    }
    Remove-Item -LiteralPath $InstallHome -Recurse -Force
}

if ($PSVersionTable.PSVersion.Major -lt 5) { Fail 'Windows PowerShell 5.1 or newer is required' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$script:InstallHome = Resolve-InstallHome $env:COZYGATEWAY_HOME
$bin = Join-Path $script:InstallHome 'bin'
$installerPath = Join-Path $bin 'agent-install.sh'
$configPath = Join-Path $script:InstallHome 'local\cozygateway.config.json'
$isFreshInstall = -not (Test-Path -LiteralPath $configPath)
$isUninstall = $InstallerArguments -contains '--uninstall'
$isDryRun = $env:COZYGATEWAY_INSTALL_DRYRUN -eq '1' -or $InstallerArguments -contains '--dry-run'

if ($isUninstall) {
    $authorityStatus = Get-OwnedNetworkAuthorityStatus $script:InstallHome
    if ($authorityStatus -eq 'present_unavailable') {
        Fail 'a plausible owned-network SQLite database remains, but cleanup cannot run. The entire install was preserved. Restore or repair the installed bundle, config, and Node.js runtime, then retry uninstall.'
    }
    $authorityReady = $authorityStatus -eq 'ready'
    if ($authorityReady) { Invoke-OwnedNetworkCleanup $script:InstallHome $isDryRun }
    Invoke-NativeWindowsTeardown $script:InstallHome $isDryRun
    if (-not $authorityReady) {
        Write-Info 'owned network authority is missing or corrupt and cannot be reconstructed; removing only recoverable local install state'
        if (-not $isDryRun) { Remove-DamagedInstallRoot $script:InstallHome }
        return
    }
    $bash = Resolve-GitBash $env:COZYGATEWAY_GIT_BASH
    if (-not (Test-Path -LiteralPath $installerPath)) { Fail "no CozyGateway installer was found at $installerPath; network state is reconciled but Hermes cleanup still requires a repaired installer" }
    $uninstallArguments = @($installerPath, '--service-platform', 'Windows', '--gateway-dir', $script:InstallHome) + @($InstallerArguments)
    if ($isDryRun -and -not ($uninstallArguments -contains '--dry-run')) { $uninstallArguments += '--dry-run' }
    & $bash @uninstallArguments
    if ($LASTEXITCODE -ne 0) { Fail "CozyGateway installer exited $LASTEXITCODE" }
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
    Write-Info 'dry run: would initialize private resumable phone access state and return to this PowerShell for setup'
    return
}

$requestedPort = Resolve-RequestedGatewayPort $configPath $InstallerArguments
Assert-GatewayPortAvailable $requestedPort $configPath

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

$script:BundlePath = Join-Path $bin 'cozygateway.mjs'
$script:PluginPath = Join-Path $bin 'cozygateway-hermes-attach-plugin.tar.gz'
$script:WindowsHelperPath = Join-Path $bin 'cozygateway-windows-helper.ps1'
[string]$verifiedHelper = Join-Path ([IO.Path]::GetTempPath()) ("cozygateway-windows-helper-" + [guid]::NewGuid().ToString('N') + '.ps1')
try {
    Get-VerifiedAsset 'cozygateway-windows-helper.ps1' $verifiedHelper $base
    Invoke-OnboardingHelper 'prepare-install-root' @{ root = $script:InstallHome } $verifiedHelper
    if (-not (Test-Path -LiteralPath $bin -PathType Container)) { Fail "verified helper did not create the protected install bin at $bin" }
    Move-Item -LiteralPath $verifiedHelper -Destination $script:WindowsHelperPath -Force
    Protect-InstallBoundary
    Get-VerifiedAsset 'cozygateway.mjs' $script:BundlePath $base
    Get-VerifiedAsset 'cozygateway-hermes-attach-plugin.tar.gz' $script:PluginPath $base
    Get-VerifiedAsset 'cozygateway-installer.sh' $installerPath $base
    Protect-InstallBoundary
} finally {
    Remove-Item -LiteralPath $verifiedHelper, "$verifiedHelper.new", "$verifiedHelper.sha256" -Force -ErrorAction SilentlyContinue
}
[void](Initialize-OnboardingBootstrap $isFreshInstall)
Invoke-CozyGatewayInstaller $bash $installerPath $InstallerArguments
Protect-InstallBoundary
Protect-CozyGatewayLocalState
if ($env:COZYGATEWAY_INSTALL_DRYRUN -ne '1') { Set-CozyGatewayCommandPath $bin $true }
Invoke-PhoneAccessSetup

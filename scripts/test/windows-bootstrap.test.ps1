$ErrorActionPreference = 'Stop'

function Assert-True {
    param([bool] $Condition, [string] $Message)
    if (-not $Condition) { throw "ASSERT: $Message" }
}

function Write-Utf8NoBom {
    param([string] $Path, [string] $Content)
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Assert-PrivateDacl {
    param([string] $Path)
    $acl = Get-Acl -LiteralPath $Path
    Assert-True $acl.AreAccessRulesProtected "protected path must disable inheritance: $Path"
    $rules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
    $expected = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18') | Sort-Object
    $actual = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object)
    Assert-True (($actual -join ',') -eq ($expected -join ',')) "protected path has unexpected identities: $Path ($($actual -join ','))"
}

function New-ReleaseFixtures {
    param([string] $Directory, [string] $HelperSource)
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    $assets = @{
        'cozygateway.mjs' = "console.log('fixture');`n"
        'cozygateway-hermes-attach-plugin.tar.gz' = 'plugin-fixture'
        'cozygateway-installer.sh' = "#!/usr/bin/env bash`nexit 0`n"
        'cozygateway-windows-helper.ps1' = if ([string]::IsNullOrWhiteSpace($HelperSource)) { @'
param([string]$Command)
$ErrorActionPreference = 'Stop'
$stream = [Console]::OpenStandardInput()
$memory = New-Object IO.MemoryStream
$stream.CopyTo($memory)
$inputText = [Text.Encoding]::UTF8.GetString($memory.ToArray()).TrimStart([char]0xFEFF)
$request = ($inputText | ConvertFrom-Json)
if ($env:COZYGATEWAY_TEST_HELPER_EVENT_LOG) { Add-Content -LiteralPath $env:COZYGATEWAY_TEST_HELPER_EVENT_LOG -Value "helper:$Command" }
if ($Command -eq 'prepare-install-root') {
  [void][IO.Directory]::CreateDirectory((Join-Path ([string]$request.root) 'bin'))
  if (-not (Test-Path -LiteralPath (Join-Path ([string]$request.root) 'bin') -PathType Container)) { throw "fixture failed to create $($request.root)\bin" }
}
if ($Command -eq 'initialize-pending') {
  $local = Join-Path ([string]$request.root) 'local'
  New-Item -ItemType Directory -Force -Path $local | Out-Null
  $state = Join-Path $local 'network-onboarding.json'
  if (-not (Test-Path -LiteralPath $state)) { [IO.File]::WriteAllText($state, '{"version":1,"stage":"pending_choice","updatedAt":1}') }
}
$result = if ($Command -eq 'inspect-dashboard-port') { @{ available=$true; owned=$false } } else { @{ applied=$true } }
[Console]::Out.Write((@{ schemaVersion=1; ok=$true; command=$Command; result=$result } | ConvertTo-Json -Compress))
'@
        } else { [IO.File]::ReadAllText($HelperSource) }
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
    Write-Utf8NoBom $Path "@echo off`necho bash:%*>>`"$EventLog`"`necho onboarding-token:%COZYGATEWAY_ONBOARDING_CONTROL_TOKEN_FILE%>>`"$EventLog`"`nfor %%A in (%*) do if `"%%~A`"==`"--uninstall`" exit /b 0`nif not exist `"%COZYGATEWAY_HOME%\local`" mkdir `"%COZYGATEWAY_HOME%\local`"`nif not exist `"%COZYGATEWAY_HOME%\runtime\node`" mkdir `"%COZYGATEWAY_HOME%\runtime\node`"`necho {`"name`":`"cozygateway`",`"host`":`"127.0.0.1`",`"port`":8787,`"dbPath`":`"%COZYGATEWAY_HOME:\=\\%\\local\\cozygateway.sqlite`"}>`"%COZYGATEWAY_HOME%\local\cozygateway.config.json`"`necho fixture>`"%COZYGATEWAY_HOME%\local\cozygateway.sqlite`"`necho fixture>`"%COZYGATEWAY_HOME%\local\gateway.env`"`necho runtime>`"%COZYGATEWAY_HOME%\runtime\node\node.exe`"`nexit /b 0`n"
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
        $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $output = & $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $Installer @Arguments 2>&1
        return @{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
    } finally {
        $ErrorActionPreference = $previousPreference
        foreach ($key in $Environment.Keys) {
            [Environment]::SetEnvironmentVariable($key, $old[$key], 'Process')
        }
    }
}

function Assert-AuthorityPreservingUninstallRefusal {
    param(
        [string] $Installer,
        [string] $Temp,
        [string] $Name,
        [ValidateSet('missing-bundle','missing-config','unreadable-config','sidecar-only')] [string] $Damage
    )
    $installFixtureHome = Join-Path $Temp ("authority refusal " + $Name)
    $local = Join-Path $installFixtureHome 'local'
    $bin = Join-Path $installFixtureHome 'bin'
    $runtime = Join-Path $installFixtureHome 'runtime\node'
    $config = Join-Path $local 'cozygateway.config.json'
    $database = Join-Path $local 'cozygateway.sqlite'
    New-Item -ItemType Directory -Force -Path $local, $bin, $runtime | Out-Null
    if ($Damage -ne 'missing-bundle') { Write-Utf8NoBom (Join-Path $bin 'cozygateway.mjs') 'bundle fixture' }
    Write-Utf8NoBom (Join-Path $runtime 'node.exe') 'node fixture'
    $authorityArtifact = if ($Damage -eq 'sidecar-only') { "$database-wal" } else { $database }
    Write-Utf8NoBom $authorityArtifact 'plausible ownership database'
    if ($Damage -eq 'unreadable-config') {
        Write-Utf8NoBom $config '{not-readable-as-config'
    } elseif ($Damage -notin @('missing-config','sidecar-only')) {
        Write-Utf8NoBom $config (@{ name='cozygateway'; host='127.0.0.1'; port=8787; dbPath=$database } | ConvertTo-Json -Compress)
    }

    $appData = Join-Path $Temp ("authority refusal appdata " + $Name)
    $startup = Join-Path $appData 'Microsoft\Windows\Start Menu\Programs\Startup\CozyGateway.vbs'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $startup) | Out-Null
    Write-Utf8NoBom $startup 'owned startup fixture'
    $processFixture = Join-Path $Temp ("authority refusal processes " + $Name + '.json')
    Write-Utf8NoBom $processFixture (@(
        @{ ProcessId = 5101; Name = 'node.exe'; CommandLine = "node cozygateway.mjs serve --config `"$config`"" }
    ) | ConvertTo-Json -Compress)
    $nativeLog = Join-Path $Temp ("authority refusal native " + $Name + '.log')
    $pathLog = Join-Path $Temp ("authority refusal path " + $Name + '.log')

    $result = Invoke-Bootstrap $Installer @{
        'PATH' = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
        'APPDATA' = $appData
        'LOCALAPPDATA' = (Join-Path $Temp ("authority refusal localappdata " + $Name))
        'COZYGATEWAY_HOME' = $installFixtureHome
        'COZYGATEWAY_GIT_BASH' = (Join-Path $Temp 'missing-git-bash.exe')
        'COZYGATEWAY_TEST_USER_PATH' = "C:\Existing Tools;$(Join-Path $installFixtureHome 'bin')"
        'COZYGATEWAY_TEST_USER_PATH_LOG' = $pathLog
        'COZYGATEWAY_TEST_NATIVE_UNINSTALL_LOG' = $nativeLog
        'COZYGATEWAY_TEST_WINDOWS_PROCESS_FIXTURE' = $processFixture
    } @('--uninstall')

    Assert-True ($result.ExitCode -ne 0) "$Name must fail closed while plausible SQLite authority remains"
    Assert-True ($result.Output -match 'ownership.*database.*preserved|repair.*retry') "$Name must print actionable authority recovery guidance: $($result.Output)"
    Assert-True (Test-Path -LiteralPath $installFixtureHome) "$Name must preserve the entire install root"
    Assert-True (Test-Path -LiteralPath $authorityArtifact) "$Name must preserve the plausible ownership database or sidecar"
    if ($Damage -eq 'missing-bundle') {
        Assert-True (Test-Path -LiteralPath $startup) "$Name must preserve persistence before known authority cleanup can run"
        Assert-True (-not (Test-Path -LiteralPath $nativeLog)) "$Name must not delete Task or stop the managed process"
        Assert-True (-not (Test-Path -LiteralPath $pathLog)) "$Name must not change PATH"
    } else {
        Assert-True (-not (Test-Path -LiteralPath $startup)) "$Name must deactivate the exact Startup entry while retaining recovery files"
        Assert-True (Test-Path -LiteralPath $nativeLog) "$Name must deactivate Task/process persistence for legacy ambiguity"
        Assert-True (Test-Path -LiteralPath $pathLog) "$Name must deactivate the managed command PATH entry"
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$installer = Join-Path $repoRoot 'scripts\install.ps1'
$bundle = Join-Path $repoRoot 'dist-bundle\cozygateway.mjs'
$temp = Join-Path ([IO.Path]::GetTempPath()) ("cozygateway-windows-bootstrap-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

try {
    Assert-True (Test-Path -LiteralPath $installer) 'scripts/install.ps1 must exist'
    & cmd.exe /d /s /c "pnpm.cmd build >nul 2>&1"
    Assert-True ($LASTEXITCODE -eq 0) 'workspace build must succeed before the bundled cleanup integration'
    & cmd.exe /d /s /c "pnpm.cmd bundle >nul 2>&1"
    Assert-True ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $bundle -PathType Leaf)) 'release bundle must build for the bundled cleanup integration'
    $fixtures = Join-Path $temp 'release assets'
    $eventLog = Join-Path $temp 'events.log'
    $fakeBin = Join-Path $temp 'fake bin'
    $configPath = Join-Path $temp 'Hermes Home\config.yaml'
    $fakeBash = Join-Path $temp 'Git With Spaces\bash.cmd'
    $pathLog = Join-Path $temp 'user-path.txt'
    New-ReleaseFixtures $fixtures
    New-FakeHermes $fakeBin $configPath $eventLog
    New-FakeBash $fakeBash $eventLog

    $occupiedHome = Join-Path $temp 'Occupied Port Gateway'
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        $occupiedPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
        $occupied = Invoke-Bootstrap $installer @{
            'PATH' = "$fakeBin;$env:PATH"
            'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
            'COZYGATEWAY_HOME' = $occupiedHome
            'COZYGATEWAY_GIT_BASH' = $fakeBash
            'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
        } @('--port', [string]$occupiedPort)
    } finally { $listener.Stop() }
    Assert-True ($occupied.ExitCode -ne 0) 'PowerShell bootstrap must reject an occupied Gateway port'
    Assert-True ($occupied.Output -match "(?s)Gateway port $occupiedPort.*PID.*Stop that process.*No CozyGateway state was changed") "occupied-port failure must name the port, PID, process, action, and no-partial-install guarantee: $($occupied.Output)"
    Assert-True (-not (Test-Path -LiteralPath $occupiedHome)) 'occupied-port preflight must run before install-root or asset mutation'
    Assert-True (-not (Test-Path -LiteralPath $eventLog)) 'occupied-port preflight must run before Hermes/model mutation'

    $result = Invoke-Bootstrap $installer @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Cozy Gateway')
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
        'COZYGATEWAY_TEST_USER_PATH' = 'C:\Existing Tools'
        'COZYGATEWAY_TEST_USER_PATH_LOG' = $pathLog
        'COZYGATEWAY_TEST_HELPER_EVENT_LOG' = $eventLog
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
    $installedHelper = Join-Path $temp 'Cozy Gateway\bin\cozygateway-windows-helper.ps1'
    Assert-True (Test-Path -LiteralPath $installedHelper) 'bootstrap must checksum-verify and install the Windows helper beside the bundle'
    Assert-True ((Get-FileHash -LiteralPath $installedHelper -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath (Join-Path $fixtures 'cozygateway-windows-helper.ps1') -Algorithm SHA256).Hash) 'installed Windows helper bytes must match the verified release asset'
    $localState = Join-Path $temp 'Cozy Gateway\local'
    $pending = Get-Content -LiteralPath (Join-Path $localState 'network-onboarding.json') -Raw | ConvertFrom-Json
    Assert-True ($pending.stage -eq 'pending_choice') 'fresh bootstrap must create the pending marker before shared config work'
    $tokenPath = Join-Path $localState 'operator-control.token'
    Assert-True ((Get-Content -LiteralPath $tokenPath -Raw) -match '^[A-Za-z0-9_-]{43}$') 'fresh bootstrap must create a 256-bit operator-control token outside config'
    $initializeIndex = [Array]::IndexOf($events, 'helper:initialize-pending')
    $protectTokenIndex = [Array]::IndexOf($events, 'helper:protect-path', $initializeIndex + 1)
    Assert-True ($initializeIndex -ge 0 -and $initializeIndex -lt $bashIndex) 'pending marker must be initialized before Bash can write config'
    Assert-True ($protectTokenIndex -gt $initializeIndex -and $protectTokenIndex -lt $bashIndex) 'operator token must be ACL-protected before Bash can write config'
    Assert-True (($events | Select-Object -Skip ($bashIndex + 1)) -contains 'helper:protect-path') 'config, SQLite, environment, and resume state must be helper-ACL-protected after Bash creates them'
    $authorityLocator = Join-Path $localState 'network-authority.json'
    Assert-True (Test-Path -LiteralPath $authorityLocator -PathType Leaf) 'install must persist a protected database authority locator'
    $locatedAuthority = Get-Content -LiteralPath $authorityLocator -Raw | ConvertFrom-Json
    Assert-True ($locatedAuthority.schemaVersion -eq 1 -and $locatedAuthority.dbPath -eq (Join-Path $localState 'cozygateway.sqlite')) 'authority locator must record the exact installed database path'
    Assert-True (($events -join "`n") -match ('onboarding-token:' + [regex]::Escape($tokenPath))) 'shared config handoff must receive only the operator token path'
    Assert-True (([regex]::Matches($result.Output, 'Resume phone access setup with:')).Count -eq 1) 'noninteractive bootstrap must print exactly one resume command'
    Assert-True ($result.Output -notmatch 'setup code|fake-qr') 'noninteractive bootstrap must not print pairing material'
    $registeredPath = Get-Content -LiteralPath $pathLog -Raw
    Assert-True ($registeredPath -match [regex]::Escape((Join-Path $temp 'Cozy Gateway\bin'))) 'bootstrap must add the native CozyGateway command directory to the user PATH'
    Assert-True (($registeredPath -split ';' | Where-Object { $_ -eq (Join-Path $temp 'Cozy Gateway\bin') }).Count -eq 1) 'bootstrap must register the command directory once'

    # Exercise the real PowerShell 5.1 bootstrap -> fixed helper stdin/stdout boundary. A text
    # pipeline uses the active OEM code page and corrupts this custom root before JSON parsing.
    $realHelperFixtures = Join-Path $temp 'real helper release assets'
    New-ReleaseFixtures $realHelperFixtures (Join-Path $repoRoot 'scripts\cozygateway-windows-helper.ps1')

    $dashboardEventLog = Join-Path $temp 'dashboard occupied events.log'
    $dashboardHermesBin = Join-Path $temp 'dashboard occupied hermes bin'
    $dashboardHermesConfig = Join-Path $temp 'dashboard occupied Hermes Home\config.yaml'
    $dashboardBash = Join-Path $temp 'dashboard occupied Git\bash.cmd'
    $dashboardHome = Join-Path $temp 'Dashboard Occupied Gateway'
    New-FakeHermes $dashboardHermesBin $dashboardHermesConfig $dashboardEventLog
    New-FakeBash $dashboardBash $dashboardEventLog
    $dashboardListener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $dashboardListener.Start()
    try {
        $occupiedDashboardPort = ([Net.IPEndPoint]$dashboardListener.LocalEndpoint).Port
        $dashboardOccupied = Invoke-Bootstrap $installer @{
            'PATH' = "$dashboardHermesBin;$env:PATH"
            'COZYGATEWAY_INSTALL_ASSET_BASE' = $realHelperFixtures
            'COZYGATEWAY_HOME' = $dashboardHome
            'COZYGATEWAY_GIT_BASH' = $dashboardBash
            'COZYGATEWAY_TEST_HERMES' = (Join-Path $dashboardHermesBin 'hermes.cmd')
        } @('--dashboard-port', [string]$occupiedDashboardPort)
    } finally { $dashboardListener.Stop() }
    Assert-True ($dashboardOccupied.ExitCode -ne 0) 'real PowerShell/helper pipeline must reject an unrelated Dashboard listener'
    Assert-True ($dashboardOccupied.Output -match "(?s)Dashboard port $occupiedDashboardPort.*PID.*Stop that process.*No CozyGateway or Hermes state was changed") "Dashboard occupied-port failure must identify the listener and actionable safe next step: $($dashboardOccupied.Output)"
    Assert-True (-not (Test-Path -LiteralPath $dashboardHome)) 'Dashboard port preflight must precede install-root, token, state, env, config, plugin, and runtime mutation'
    $dashboardEvents = @(Get-Content -LiteralPath $dashboardEventLog -ErrorAction SilentlyContinue)
    Assert-True (-not ($dashboardEvents -match '^bash:|hermes:model|hermes:status')) 'Dashboard port preflight must run before the Bash installer and Hermes model mutation'

    $unicodeLeaf = 'Cozy G' + [char]0x00E4 + 'teway ' + [char]0x4F60 + [char]0x597D
    $unicodeHome = Join-Path $temp $unicodeLeaf
    $unicodePathLog = Join-Path $temp 'unicode-user-path.txt'
    $unicode = Invoke-Bootstrap $installer @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $realHelperFixtures
        'COZYGATEWAY_HOME' = $unicodeHome
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
        'COZYGATEWAY_TEST_USER_PATH' = 'C:\Existing Tools'
        'COZYGATEWAY_TEST_USER_PATH_LOG' = $unicodePathLog
    }
    Assert-True ($unicode.ExitCode -eq 0) "PowerShell 5.1 UTF-8 bootstrap/helper pipeline failed for a non-ASCII root: $($unicode.Output)"
    Assert-True (Test-Path -LiteralPath (Join-Path $unicodeHome 'local\network-onboarding.json')) 'real helper must receive the exact non-ASCII root'
    foreach ($protected in @($unicodeHome, (Join-Path $unicodeHome 'bin'), (Join-Path $unicodeHome 'bin\cozygateway-windows-helper.ps1'), (Join-Path $unicodeHome 'runtime'))) {
        Assert-PrivateDacl $protected
    }

    $unsafeHome = Join-Path $temp 'unsafe existing root'
    New-Item -ItemType Directory -Path $unsafeHome | Out-Null
    $unsafeAcl = Get-Acl -LiteralPath $unsafeHome
    $unsafeAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        (New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),
        [Security.AccessControl.FileSystemRights]::Modify,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )))
    Set-Acl -LiteralPath $unsafeHome -AclObject $unsafeAcl
    $unsafe = Invoke-Bootstrap $installer @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $realHelperFixtures
        'COZYGATEWAY_HOME' = $unsafeHome
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
    }
    Assert-True ($unsafe.ExitCode -ne 0) 'bootstrap must fail closed on an existing install root writable by Everyone'
    Assert-True ($unsafe.Output -match 'unsafe_install_root') 'unsafe install root failure must identify the trust-boundary problem'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $unsafeHome 'bin\cozygateway.mjs'))) 'unsafe existing root must fail before executable assets are installed'

    $interactiveHome = Join-Path $temp 'Interactive Gateway'
    $interactiveBin = Join-Path $interactiveHome 'bin'
    $interactivePathLog = Join-Path $temp 'interactive-user-path.txt'
    New-Item -ItemType Directory -Force -Path $interactiveBin | Out-Null
    Write-Utf8NoBom (Join-Path $interactiveBin 'cozygateway.cmd') "@echo off`necho setup:%*>>`"$eventLog`"`nexit /b 0`n"
    Remove-Item -LiteralPath $eventLog -Force
    $interactive = Invoke-Bootstrap $installer @{
        'PATH' = "$fakeBin;$env:PATH"
        'COZYGATEWAY_INSTALL_ASSET_BASE' = $fixtures
        'COZYGATEWAY_HOME' = $interactiveHome
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_HERMES' = (Join-Path $fakeBin 'hermes.cmd')
        'COZYGATEWAY_TEST_INTERACTIVE' = '1'
        'COZYGATEWAY_TEST_HELPER_EVENT_LOG' = $eventLog
        'COZYGATEWAY_TEST_USER_PATH' = 'C:\Existing Tools'
        'COZYGATEWAY_TEST_USER_PATH_LOG' = $interactivePathLog
    }
    Assert-True ($interactive.ExitCode -eq 0) "interactive bootstrap failed: $($interactive.Output)"
    $interactiveEvents = Get-Content -LiteralPath $eventLog
    $interactiveBash = ($interactiveEvents | Select-String '^bash:' | Select-Object -First 1).LineNumber - 1
    $interactiveSetup = ($interactiveEvents | Select-String '^setup:' | Select-Object -First 1).LineNumber - 1
    Assert-True ($interactiveSetup -gt $interactiveBash) 'the original PowerShell process must invoke setup after the Bash handoff'
    Assert-True ($interactiveEvents[$interactiveSetup] -match '^setup:setup --config ' -and $interactiveEvents[$interactiveSetup] -match [regex]::Escape((Join-Path $interactiveHome 'local\cozygateway.config.json'))) 'PowerShell must invoke setup with the native config path'
    Assert-True (($interactiveEvents -join "`n") -notmatch 'setup:pair') 'PowerShell must never fall back to unconditional pair'

    $shellOnlyHome = Join-Path $temp 'shell cleanup without network database'
    $shellOnlyBin = Join-Path $shellOnlyHome 'bin'
    $shellOnlyLocal = Join-Path $shellOnlyHome 'local'
    $shellOnlyConfig = Join-Path $shellOnlyLocal 'cozygateway.config.json'
    $shellOnlyDatabase = Join-Path $shellOnlyLocal 'cozygateway.sqlite'
    $shellOnlyLog = Join-Path $temp 'shell-only-uninstall.log'
    $shellOnlyBash = Join-Path $temp 'Shell Only Bash\bash.cmd'
    $emptyProcesses = Join-Path $temp 'empty-processes.json'
    Write-Utf8NoBom $emptyProcesses '[]'
    New-Item -ItemType Directory -Force -Path $shellOnlyBin, $shellOnlyLocal | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\agent-install.sh') -Destination (Join-Path $shellOnlyBin 'agent-install.sh')
    Write-Utf8NoBom (Join-Path $shellOnlyLocal 'install-state') "profiles=default`nhermes_root=C:\fixture\hermes`nhermes_bin=C:\fixture\hermes\hermes.exe`nservice_default=installed`n"
    Write-Utf8NoBom $shellOnlyConfig (@{ name='cozygateway'; host='127.0.0.1'; port=8787; dbPath=$shellOnlyDatabase } | ConvertTo-Json -Compress)
    New-FakeBash $shellOnlyBash $shellOnlyLog
    $shellOnlyUninstall = Invoke-Bootstrap $installer @{
        'PATH' = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
        'APPDATA' = (Join-Path $temp 'shell-only-appdata')
        'LOCALAPPDATA' = (Join-Path $temp 'shell-only-localappdata')
        'COZYGATEWAY_HOME' = $shellOnlyHome
        'COZYGATEWAY_GIT_BASH' = $shellOnlyBash
        'COZYGATEWAY_TEST_NATIVE_UNINSTALL_LOG' = $shellOnlyLog
        'COZYGATEWAY_TEST_WINDOWS_PROCESS_FIXTURE' = $emptyProcesses
        'COZYGATEWAY_TEST_USER_PATH' = "C:\Existing Tools;$shellOnlyBin"
    } @('--uninstall')
    Assert-True ($shellOnlyUninstall.ExitCode -eq 0) "database-absent uninstall must still run shell-owned Hermes cleanup: $($shellOnlyUninstall.Output)"
    Assert-True ((Get-Content -LiteralPath $shellOnlyLog -Raw) -match 'bash:.*agent-install\.sh.*--uninstall') 'database absence must skip only network reconcile, not agent-install.sh uninstall'
    Assert-True (-not ((Get-Content -LiteralPath $shellOnlyLog -Raw) -match 'network-cleanup:')) 'database absence must not pretend to reconcile network ownership'

    $legacyAmbiguousHome = Join-Path $temp 'legacy ambiguous authority'
    $legacyAmbiguousBin = Join-Path $legacyAmbiguousHome 'bin'
    $legacyAmbiguousLocal = Join-Path $legacyAmbiguousHome 'local'
    $legacyAmbiguousLog = Join-Path $temp 'legacy-ambiguous-uninstall.log'
    $legacyAmbiguousBash = Join-Path $temp 'Legacy Ambiguous Bash\bash.cmd'
    New-Item -ItemType Directory -Force -Path $legacyAmbiguousBin, $legacyAmbiguousLocal | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\agent-install.sh') -Destination (Join-Path $legacyAmbiguousBin 'agent-install.sh')
    Write-Utf8NoBom (Join-Path $legacyAmbiguousLocal 'install-state') "profiles=default`nhermes_root=C:\fixture\hermes`nhermes_bin=C:\fixture\hermes\hermes.exe`nservice_default=installed`n"
    New-FakeBash $legacyAmbiguousBash $legacyAmbiguousLog
    $legacyAmbiguous = Invoke-Bootstrap $installer @{
        'PATH' = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
        'APPDATA' = (Join-Path $temp 'legacy-ambiguous-appdata')
        'LOCALAPPDATA' = (Join-Path $temp 'legacy-ambiguous-localappdata')
        'COZYGATEWAY_HOME' = $legacyAmbiguousHome
        'COZYGATEWAY_GIT_BASH' = $legacyAmbiguousBash
        'COZYGATEWAY_TEST_NATIVE_UNINSTALL_LOG' = $legacyAmbiguousLog
        'COZYGATEWAY_TEST_WINDOWS_PROCESS_FIXTURE' = $emptyProcesses
        'COZYGATEWAY_TEST_USER_PATH' = "C:\Existing Tools;$legacyAmbiguousBin"
    } @('--uninstall')
    Assert-True ($legacyAmbiguous.ExitCode -ne 0 -and $legacyAmbiguous.Output -match 'authority.*locator|repair.*retry') 'legacy config loss must retain recovery state with actionable locator guidance'
    Assert-True (Test-Path -LiteralPath $legacyAmbiguousHome) 'legacy ambiguous authority must preserve the install root'
    Assert-True ((Get-Content -LiteralPath $legacyAmbiguousLog -Raw) -match 'task-delete:CozyGateway') 'legacy ambiguity must deactivate Windows persistence'
    Assert-True ((Get-Content -LiteralPath $legacyAmbiguousLog -Raw) -match 'bash:.*--deactivate-for-repair') 'legacy ambiguity must ask the shell payload to deactivate owned Hermes lifecycle'

    $uninstallPathLog = Join-Path $temp 'uninstall-user-path.txt'
    $managedBin = Join-Path $temp 'Cozy Gateway\bin'
    $managedConfig = Join-Path $temp 'Cozy Gateway\local\cozygateway.config.json'
    $managedDatabase = Join-Path $temp 'Cozy Gateway\local\cozygateway.sqlite'
    Write-Utf8NoBom $managedConfig (@{ name='cozygateway'; host='127.0.0.1'; port=8787; dbPath=$managedDatabase } | ConvertTo-Json -Compress)
    $uninstallAppData = Join-Path $temp 'uninstall-appdata'
    $uninstallStartup = Join-Path $uninstallAppData 'Microsoft\Windows\Start Menu\Programs\Startup\CozyGateway.vbs'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $uninstallStartup) | Out-Null
    Write-Utf8NoBom $uninstallStartup 'owned startup fixture'
    $processFixture = Join-Path $temp 'uninstall-processes.json'
    Write-Utf8NoBom $processFixture (@(
        @{ ProcessId = 4101; Name = 'node.exe'; CommandLine = "node cozygateway.mjs serve --config `"$managedConfig`"" },
        @{ ProcessId = 4102; Name = 'node.exe'; CommandLine = 'node cozygateway.mjs serve --config "C:\Other\cozygateway.config.json"' }
    ) | ConvertTo-Json -Compress)
    $failedCleanupNativeLog = Join-Path $temp 'failed-cleanup-native-events.log'
    $failedCleanup = Invoke-Bootstrap $installer @{
        'PATH' = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
        'APPDATA' = $uninstallAppData
        'LOCALAPPDATA' = (Join-Path $temp 'failed-cleanup-localappdata')
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Cozy Gateway')
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_NATIVE_UNINSTALL_LOG' = $failedCleanupNativeLog
        'COZYGATEWAY_TEST_WINDOWS_PROCESS_FIXTURE' = $processFixture
        'COZYGATEWAY_TEST_USER_PATH' = "C:\Existing Tools;$managedBin"
    } @('--uninstall')
    Assert-True ($failedCleanup.ExitCode -ne 0 -and $failedCleanup.Output -match 'owned network cleanup failed') 'failed owned-network reconciliation must abort uninstall'
    Assert-True (Test-Path -LiteralPath $managedConfig) 'failed owned-network reconciliation must preserve config and install files'
    Assert-True (-not (Test-Path -LiteralPath $failedCleanupNativeLog)) 'failed owned-network reconciliation must happen before Task/process/PATH teardown'
    Assert-True (Test-Path -LiteralPath $uninstallStartup) 'failed owned-network reconciliation must preserve persistence for a retry'
    $mustNotRunHermesInstaller = Join-Path $temp 'must-not-run-hermes-installer.ps1'
    Write-Utf8NoBom $mustNotRunHermesInstaller "throw 'uninstall must not install Hermes'`n"
    Remove-Item -LiteralPath $eventLog -Force
    $uninstall = Invoke-Bootstrap $installer @{
        'PATH' = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
        'APPDATA' = $uninstallAppData
        'LOCALAPPDATA' = (Join-Path $temp 'uninstall without prerequisites')
        'COZYGATEWAY_INSTALL_ASSET_BASE' = (Join-Path $temp 'missing release assets')
        'COZYGATEWAY_HOME' = (Join-Path $temp 'Cozy Gateway')
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_HERMES_INSTALL_URL' = $mustNotRunHermesInstaller
        'COZYGATEWAY_TEST_USER_PATH' = "C:\Existing Tools;$managedBin"
        'COZYGATEWAY_TEST_USER_PATH_LOG' = $uninstallPathLog
        'COZYGATEWAY_TEST_NATIVE_UNINSTALL_LOG' = $eventLog
        'COZYGATEWAY_TEST_WINDOWS_PROCESS_FIXTURE' = $processFixture
        'COZYGATEWAY_TEST_NETWORK_CLEANUP_LOG' = $eventLog
    } @('--uninstall')
    Assert-True ($uninstall.ExitCode -eq 0) "bootstrap uninstall failed: $($uninstall.Output)"
    $uninstalledPath = Get-Content -LiteralPath $uninstallPathLog -Raw
    Assert-True (-not ($uninstalledPath -match [regex]::Escape($managedBin))) 'uninstall must remove the managed command directory from the user PATH'
    Assert-True (-not ((Get-Content -LiteralPath $eventLog -Raw) -match 'hermes:model')) 'uninstall must not open Hermes model selection'
    $uninstallEvents = Get-Content -LiteralPath $eventLog
    $cleanupIndex = ($uninstallEvents | Select-String '^network-cleanup:' | Select-Object -First 1).LineNumber - 1
    $taskIndex = ($uninstallEvents | Select-String '^task-delete:' | Select-Object -First 1).LineNumber - 1
    $processIndex = ($uninstallEvents | Select-String '^process-stop:4101$' | Select-Object -First 1).LineNumber - 1
    $uninstallBashIndex = ($uninstallEvents | Select-String '^bash:.*--uninstall' | Select-Object -First 1).LineNumber - 1
    Assert-True ($cleanupIndex -ge 0 -and $cleanupIndex -lt $taskIndex -and $taskIndex -lt $uninstallBashIndex) 'owned network cleanup must succeed before native persistence or Bash teardown'
    Assert-True ($processIndex -gt $cleanupIndex -and -not (($uninstallEvents -join "`n") -match 'process-stop:4102')) 'native teardown must stop only the exact config-owned process'
    Assert-True (-not (Test-Path -LiteralPath $uninstallStartup)) 'native teardown must remove only the exact CozyGateway Startup entry'

    $bundledCleanupHome = Join-Path $temp 'bundled cleanup integration'
    $bundledCleanupBin = Join-Path $bundledCleanupHome 'bin'
    $bundledCleanupRuntime = Join-Path $bundledCleanupHome 'runtime\node'
    $bundledCleanupLocal = Join-Path $bundledCleanupHome 'local'
    $bundledCleanupConfig = Join-Path $bundledCleanupLocal 'cozygateway.config.json'
    $bundledCleanupDatabase = Join-Path $bundledCleanupLocal 'cozygateway.sqlite'
    New-Item -ItemType Directory -Force -Path $bundledCleanupBin, $bundledCleanupRuntime, $bundledCleanupLocal | Out-Null
    Copy-Item -LiteralPath $bundle -Destination (Join-Path $bundledCleanupBin 'cozygateway.mjs')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\cozygateway-windows-helper.ps1') -Destination (Join-Path $bundledCleanupBin 'cozygateway-windows-helper.ps1')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\agent-install.sh') -Destination (Join-Path $bundledCleanupBin 'agent-install.sh')
    $systemNode = (Get-Command node.exe -ErrorAction Stop).Source
    $bundledCleanupNode = Join-Path $bundledCleanupRuntime 'node.exe'
    Copy-Item -LiteralPath $systemNode -Destination $bundledCleanupNode
    & $bundledCleanupNode -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('CREATE TABLE fixture(value TEXT)');db.close()" $bundledCleanupDatabase
    Assert-True ($LASTEXITCODE -eq 0 -and (Get-Item -LiteralPath $bundledCleanupDatabase).Length -gt 0) 'bundled cleanup fixture must contain a real SQLite database'
    Write-Utf8NoBom $bundledCleanupConfig (@{
        name = 'cozygateway'; host = '127.0.0.1'; port = 8787; dbPath = $bundledCleanupDatabase
        hermes = @{
            url = 'ws://127.0.0.1:19119/api/ws'; tokenEnv = 'HERMES_TOKEN'
            profiles = @{ default = @{ tokenEnv = 'HERMES_DEFAULT_TOKEN' } }
        }
    } | ConvertTo-Json -Depth 6)
    $bundledCleanupNativeLog = Join-Path $temp 'bundled-cleanup-native.log'
    $bundledCleanupProcesses = Join-Path $temp 'bundled-cleanup-processes.json'
    Write-Utf8NoBom $bundledCleanupProcesses '[]'
    $bundledCleanup = Invoke-Bootstrap $installer @{
        'PATH' = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
        'APPDATA' = (Join-Path $temp 'bundled-cleanup-appdata')
        'LOCALAPPDATA' = (Join-Path $temp 'bundled-cleanup-localappdata')
        'COZYGATEWAY_HOME' = $bundledCleanupHome
        'COZYGATEWAY_GIT_BASH' = $fakeBash
        'COZYGATEWAY_TEST_NATIVE_UNINSTALL_LOG' = $bundledCleanupNativeLog
        'COZYGATEWAY_TEST_WINDOWS_PROCESS_FIXTURE' = $bundledCleanupProcesses
        'COZYGATEWAY_TEST_USER_PATH' = "C:\Existing Tools;$(Join-Path $bundledCleanupHome 'bin')"
        'COZYGATEWAY_TEST_NETWORK_CLEANUP_LOG' = ''
    } @('--uninstall')
    Assert-True ($bundledCleanup.ExitCode -eq 0) "PowerShell bootstrap must execute the real bundled cleanup command: $($bundledCleanup.Output)"
    Assert-True (Test-Path -LiteralPath $bundledCleanupNativeLog) 'native teardown must begin only after the real bundled cleanup command returns zero'

    Assert-AuthorityPreservingUninstallRefusal $installer $temp 'missing bundle with database' 'missing-bundle'
    Assert-AuthorityPreservingUninstallRefusal $installer $temp 'missing config with default database' 'missing-config'
    Assert-AuthorityPreservingUninstallRefusal $installer $temp 'unreadable config with database' 'unreadable-config'
    Assert-AuthorityPreservingUninstallRefusal $installer $temp 'missing config with database sidecar' 'sidecar-only'

    $damagedNativeHome = Join-Path $temp 'damaged native uninstall'
    $damagedNativeConfig = Join-Path $damagedNativeHome 'local\cozygateway.config.json'
    $damagedNativeAppData = Join-Path $temp 'damaged-native-appdata'
    $damagedNativeStartup = Join-Path $damagedNativeAppData 'Microsoft\Windows\Start Menu\Programs\Startup\CozyGateway.vbs'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $damagedNativeConfig), (Split-Path -Parent $damagedNativeStartup) | Out-Null
    Write-Utf8NoBom $damagedNativeConfig '{not-json'
    Write-Utf8NoBom (Join-Path $damagedNativeHome 'local\network-authority.json') (@{
        schemaVersion = 1; dbPath = (Join-Path $damagedNativeHome 'local\cozygateway.sqlite')
    } | ConvertTo-Json -Compress)
    Write-Utf8NoBom $damagedNativeStartup 'owned startup fixture'
    $damagedNativeLog = Join-Path $temp 'damaged-native-events.log'
    $damagedNativePathLog = Join-Path $temp 'damaged-native-path.txt'
    $damagedNative = Invoke-Bootstrap $installer @{
        'PATH' = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
        'APPDATA' = $damagedNativeAppData
        'LOCALAPPDATA' = (Join-Path $temp 'damaged-native-localappdata')
        'COZYGATEWAY_HOME' = $damagedNativeHome
        'COZYGATEWAY_GIT_BASH' = (Join-Path $temp 'missing-git-bash.exe')
        'COZYGATEWAY_TEST_USER_PATH' = "C:\Existing Tools;$(Join-Path $damagedNativeHome 'bin')"
        'COZYGATEWAY_TEST_USER_PATH_LOG' = $damagedNativePathLog
        'COZYGATEWAY_TEST_NATIVE_UNINSTALL_LOG' = $damagedNativeLog
        'COZYGATEWAY_TEST_WINDOWS_PROCESS_FIXTURE' = $processFixture
        'COZYGATEWAY_TEST_NETWORK_CLEANUP_LOG' = $damagedNativeLog
    } @('--uninstall')
    Assert-True ($damagedNative.ExitCode -eq 0) "damaged native uninstall must not require Git Bash or the installed shell payload: $($damagedNative.Output)"
    Assert-True ($damagedNative.Output -match 'locator proves no SQLite ownership authority remains.*shell payload is missing') 'damaged fallback must disclose the exact proof that permits native file removal'
    Assert-True (-not (Test-Path -LiteralPath $damagedNativeHome)) 'damaged native fallback must remove the recoverable install root'
    Assert-True (-not (Test-Path -LiteralPath $damagedNativeStartup)) 'damaged native fallback must remove the exact Startup entry'
    Assert-True (-not ((Get-Content -LiteralPath $damagedNativeLog -Raw) -match 'network-cleanup:')) 'damaged fallback must not pretend to reconcile absent/corrupt authority'

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

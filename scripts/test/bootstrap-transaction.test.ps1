param([string] $Installer = (Join-Path $PSScriptRoot '..\install.ps1'))

$ErrorActionPreference = 'Stop'

function Assert-True {
    param([bool] $Condition, [string] $Message)
    if (-not $Condition) { throw "ASSERT: $Message" }
}

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Installer), [ref] $tokens, [ref] $errors)
if ($errors.Count) { throw ($errors | Out-String) }

# Execute actual bootstrap helpers. Only the native Task Scheduler boundary is
# replaced below, so this suite also runs on macOS.
$needed = @(
    'Assert-BootstrapPath', 'Test-BootstrapWindows', 'Get-BootstrapRuntimeFiles',
    'Test-BootstrapRuntimeFileId', 'Assert-BootstrapPathAndParents',
    'Assert-BootstrapRegularFile', 'Assert-BootstrapTreeSafe',
    'Assert-BootstrapAssetName', 'Get-BootstrapAclToken',
    'Test-BootstrapAclToken', 'Restore-BootstrapAcl',
    'Get-BootstrapTemporaryPath', 'Assert-BootstrapRestoreDestination',
    'Copy-BootstrapSnapshotFile', 'Restore-BootstrapFile',
    'Set-BootstrapTransactionState', 'Get-GatewayTaskExec',
    'Test-BootstrapPathEquals', 'Test-OwnedGatewayStartupEntry',
    'Test-OwnedGatewayTask', 'Get-GatewayRegistrationForRecovery',
    'Restore-GatewayRegistration', 'Restart-OwnedGatewayService',
    'Start-BootstrapTransaction', 'Recover-BootstrapTransaction',
    'Finish-BootstrapRecovery', 'Commit-BootstrapTransaction'
)
foreach ($name in $needed) {
    $fn = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true) | Select-Object -First 1
    Assert-True ($null -ne $fn) "installer must define $name"
    Invoke-Expression $fn.Extent.Text
}
function Fail { param([string] $Message) throw $Message }
function Write-Info { param([string] $Message) }
function Write-Ok { param([string] $Message) }

$script:FakeTaskXml = $null
$script:StartupPath = $null
$script:TaskOperations = @()

# Fake native Task Scheduler commands for the component test. Production
# functions are invoked by the Windows CI integration suite.
function Get-GatewayScheduledTaskXml { return $script:FakeTaskXml }
function Register-GatewayScheduledTask {
    param([string] $TaskXmlPath)
    $script:TaskOperations += 'create'
    $script:FakeTaskXml = Get-Content -LiteralPath $TaskXmlPath -Raw
    return $true
}
function Remove-GatewayScheduledTask {
    $script:TaskOperations += 'delete'
    $script:FakeTaskXml = $null
    return $true
}
function Start-GatewayScheduledTask {
    $script:TaskOperations += 'start-task'
    return $true
}
function Get-GatewayStartupEntryPath { return $script:StartupPath }
function Start-GatewayStartupEntry {
    param([string] $EntryPath)
    $script:TaskOperations += 'start-startup'
    return $true
}

function Write-TestFile {
    param([string] $Path, [string] $Content)
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Content, (New-Object -TypeName 'System.Text.UTF8Encoding' -ArgumentList $false))
}
function Read-TestFile { param([string] $Path) return [IO.File]::ReadAllText($Path) }
function Assert-Absent {
    param([string] $Path, [string] $Message)
    Assert-True ($null -eq (Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue)) $Message
}

function New-OwnedTaskXml {
    param([string] $InstallRoot, [string] $Worker)
    $node = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'runtime\node\node.exe'))
    $supervisor = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'local\gateway-supervisor.cjs'))
    $bundle = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'bin\cozygateway.mjs'))
    $values = @(
        $supervisor, '--platform', 'Windows', '--gateway-env', (Join-Path $InstallRoot 'local\gateway.env'),
        '--bundle', $bundle, '--config', (Join-Path $InstallRoot 'local\cozygateway.config.json'),
        '--maintenance-socket', '\\.\pipe\cozygateway-maintenance', '--maintenance-worker', $Worker,
        '--database', (Join-Path $InstallRoot 'local\cozygateway.sqlite')
    )
    $quote = [string][char]34
    $arguments = ($values | ForEach-Object { $quote + $_ + $quote }) -join ' '
    return '<Task><Actions><Exec><Command>' + $node + '</Command><Arguments>' + $arguments + '</Arguments></Exec></Actions></Task>'
}
function New-OwnedStartupEntry {
    param([string] $InstallRoot, [string] $BashPath)
    $wrapper = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'local\run-gateway.sh'))
    $quote = [string][char]34
    $triple = $quote + $quote + $quote
    $command = 'command = ' + $triple + $BashPath + $quote + $quote + ' ' + $quote + $quote + $wrapper + $triple
    return @(
        'Set shell = CreateObject("WScript.Shell")', $command, 'For attempt = 0 To 3',
        '  code = shell.Run(command, 0, True)', '  If code = 0 Then Exit For',
        '  If attempt < 3 Then WScript.Sleep 60000', 'Next'
    ) -join [Environment]::NewLine
}

$root = Join-Path $PSScriptRoot ('.bootstrap-transaction-' + [guid]::NewGuid().ToString('N'))
$assets = @('cozygateway.mjs')
$assetNames = @('cozygateway.mjs', 'cozygateway.mjs.sha256')
$journal = Join-Path $root '.bootstrap-transaction'
$backup = Join-Path $root '.bootstrap-previous'
$outside = Join-Path ([IO.Path]::GetDirectoryName($root)) ('cozygateway-outside-' + [guid]::NewGuid().ToString('N'))

function Reset-Fixture {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path (Join-Path $root 'bin') -Force | Out-Null
    $script:StartupPath = Join-Path $root 'startup\CozyGateway.vbs'
    $script:FakeTaskXml = $null
    $script:TaskOperations = @()
    Remove-Item -LiteralPath $outside -Force -ErrorAction SilentlyContinue
    Write-TestFile $outside 'outside-sentinel'
}
function Write-Assets {
    param([string] $Label)
    foreach ($name in $assetNames) { Write-TestFile (Join-Path (Join-Path $root 'bin') $name) "${Label}:$name" }
}
function Write-Runtime {
    param([string[]] $Present, [string] $Label)
    foreach ($id in Get-BootstrapRuntimeFiles) {
        if ($Present -ccontains $id) { Write-TestFile (Join-Path $root $id) "${Label}:$id" }
    }
}
function New-InterruptedFixture {
    Reset-Fixture
    Write-Assets 'old'
    Start-BootstrapTransaction $root (Join-Path $root 'bin') $assets
    Write-Assets 'fresh'
}
function Assert-RecoveryRefusesBeforeAssetMutation {
    param([string] $Name, [scriptblock] $Tamper)
    New-InterruptedFixture
    & $Tamper
    $failed = $false
    try { Recover-BootstrapTransaction $root (Join-Path $root 'bin') $assets } catch { $failed = $true }
    Assert-True $failed "$Name inventory must fail closed"
    Assert-True ((Read-TestFile (Join-Path (Join-Path $root 'bin') 'cozygateway.mjs')) -eq 'fresh:cozygateway.mjs') "$Name inventory must fail before asset mutation"
    Assert-True ((Read-TestFile $outside) -eq 'outside-sentinel') "$Name inventory must not alter an outside sentinel"
}

try {
    Reset-Fixture
    $bundle = [IO.Path]::GetFullPath((Join-Path $root 'bin\cozygateway.mjs'))
    $taskXml = New-OwnedTaskXml $root (Join-Path $root 'local\maintenance-worker.cjs')
    Assert-True (Test-OwnedGatewayTask $root $taskXml) 'a strict direct Gateway task must be accepted for recovery'
    Assert-True (-not (Test-OwnedGatewayTask $root $taskXml.Replace($bundle, (Join-Path $root 'foreign.mjs')))) 'a task whose bundle escapes the Gateway home must be refused'
    $legacyLauncher = Join-Path $root 'local\run-gateway.vbs'
    $launcherContent = New-OwnedStartupEntry $root 'C:\Legacy\bash.exe'
    Write-TestFile $legacyLauncher $launcherContent
    $quote = [string][char]34
    $legacyTask = '<Task><Actions><Exec><Command>wscript.exe</Command><Arguments>' + $quote + [IO.Path]::GetFullPath($legacyLauncher) + $quote + '</Arguments></Exec></Actions></Task>'
    Assert-True (Test-OwnedGatewayTask $root $legacyTask) 'a legacy Task that invokes an owned Gateway launcher must be accepted'
    $legacyStartup = @(($launcherContent -split [Environment]::NewLine)[0], ($launcherContent -split [Environment]::NewLine)[1], 'shell.Run command, 0, False') -join [Environment]::NewLine
    Write-TestFile $script:StartupPath $legacyStartup
    Assert-True (Test-OwnedGatewayStartupEntry $root $script:StartupPath) 'a legacy owned Startup launcher must be accepted'

    # v2 restores every explicit local file state, prior Task XML, and removes
    # a fallback created by the failed update. Unlisted state remains untouched.
    Reset-Fixture
    Write-Assets 'old'
    $present = @(
        'local/install-state', 'local/profiles.json', 'local/bootstrap-source',
        'local/cozygateway.config.json', 'local/gateway.env',
        'local/gateway-supervisor.cjs', 'local/run-gateway.sh',
        'local/run-gateway.vbs', 'local/dashboard.env', 'bin/cozygateway.cmd'
    )
    Write-Runtime $present 'old'
    $oldRuntime = @{}
    foreach ($id in $present) { $oldRuntime[$id] = Read-TestFile (Join-Path $root $id) }
    $oldTask = New-OwnedTaskXml $root (Join-Path $root 'local\maintenance-worker.cjs')
    $script:FakeTaskXml = $oldTask
    $oldInstallerLog = Join-Path $root 'old-installer-ran'
    Write-TestFile (Join-Path (Join-Path $root 'bin') 'agent-install.sh') ('touch ' + $oldInstallerLog)
    $database = Join-Path $root 'local\cozygateway.sqlite'
    $log = Join-Path $root 'local\cozygateway.log'
    $hermes = Join-Path $root 'external-hermes\profile.env'
    $agents = Join-Path $root 'external-agents\install.json'
    Write-TestFile $database 'sqlite-before'; Write-TestFile $log 'log-before'
    Write-TestFile $hermes 'hermes-before'; Write-TestFile $agents 'agents-before'
    Start-BootstrapTransaction $root (Join-Path $root 'bin') $assets
    $inventory = Get-Content -LiteralPath (Join-Path $backup 'inventory')
    Assert-True ($inventory[0] -eq 'version=2') 'new transaction must use the versioned inventory'
    foreach ($required in @('local/install-state', 'local/profiles.json', 'local/bootstrap-source', 'local/cozygateway.config.json', 'local/gateway.env', 'local/run-gateway.sh', 'bin/cozygateway.cmd')) {
        Assert-True (@($inventory | Where-Object { $_ -match ('^state:(present|absent):' + [regex]::Escape($required) + ':') }).Count -eq 1) "runtime inventory must cover $required"
    }
    Assert-True ($inventory -contains 'registration:task:present') 'prior owned Task XML must be snapshotted'
    Assert-True ($inventory -contains 'registration:startup:absent:-') 'prior absent Startup entry must be explicit'

    Write-Assets 'fresh'
    foreach ($id in Get-BootstrapRuntimeFiles) { Write-TestFile (Join-Path $root $id) "fresh:$id" }
    $script:FakeTaskXml = New-OwnedTaskXml $root (Join-Path $root 'bin\gateway-maintenance-worker.cjs')
    Write-TestFile $script:StartupPath (New-OwnedStartupEntry $root 'C:\New\bash.exe')
    Write-TestFile $database 'sqlite-after'; Write-TestFile $log 'log-after'
    Write-TestFile $hermes 'hermes-after'; Write-TestFile $agents 'agents-after'
    Assert-True (Recover-BootstrapTransaction $root (Join-Path $root 'bin') $assets) 'v2 recovery must report restored bytes'
    Assert-True ((Read-TestFile (Join-Path (Join-Path $root 'bin') 'cozygateway.mjs')) -eq 'old:cozygateway.mjs') 'v2 recovery must restore old asset bytes'
    foreach ($id in Get-BootstrapRuntimeFiles) {
        $path = Join-Path $root $id
        if ($oldRuntime.ContainsKey($id)) {
            Assert-True ((Read-TestFile $path) -eq $oldRuntime[$id]) "v2 recovery must restore present runtime state $id"
        } else {
            Assert-Absent $path "v2 recovery must remove newly created runtime state $id"
        }
    }
    Assert-True ($script:FakeTaskXml -eq $oldTask) 'v2 recovery must restore the prior Task XML'
    Assert-Absent $script:StartupPath 'v2 recovery must remove a newly created owned Startup fallback'
    Assert-True (-not (Test-Path -LiteralPath $oldInstallerLog)) 'recovery must never replay an old agent installer'
    Assert-True ((Read-TestFile $database) -eq 'sqlite-after') 'SQLite state must remain outside rollback'
    Assert-True ((Read-TestFile $log) -eq 'log-after') 'logs must remain outside rollback'
    Assert-True ((Read-TestFile $hermes) -eq 'hermes-after') 'external Hermes state must remain outside rollback'
    Assert-True ((Read-TestFile $agents) -eq 'agents-after') 'external CozyAgents state must remain outside rollback'
    Restart-OwnedGatewayService $root
    Assert-True ($script:TaskOperations -contains 'start-task') 'only the restored owned Task must be reactivated'
    Finish-BootstrapRecovery $root
    Assert-Absent $journal 'finished v2 recovery must clear its journal'
    Assert-Absent $backup 'finished v2 recovery must clear snapshots'

    # A prior Startup registration is authoritative too; a new owned Task is
    # removed while the exact Startup entry is restored and reactivated.
    Reset-Fixture
    Write-Assets 'old'
    Write-Runtime @('local/run-gateway.sh') 'old'
    $oldStartup = New-OwnedStartupEntry $root 'C:\Old\bash.exe'
    Write-TestFile $script:StartupPath $oldStartup
    Start-BootstrapTransaction $root (Join-Path $root 'bin') $assets
    Write-Assets 'fresh'
    $script:FakeTaskXml = New-OwnedTaskXml $root (Join-Path $root 'local\maintenance-worker.cjs')
    Write-TestFile $script:StartupPath (New-OwnedStartupEntry $root 'C:\New\bash.exe')
    Recover-BootstrapTransaction $root (Join-Path $root 'bin') $assets | Out-Null
    Assert-True ($null -eq $script:FakeTaskXml) 'recovery must remove a new owned Task when none existed before'
    Assert-True ((Read-TestFile $script:StartupPath) -eq $oldStartup) 'recovery must restore the prior owned Startup entry'
    Restart-OwnedGatewayService $root
    Assert-True ($script:TaskOperations -contains 'start-startup') 'the restored owned Startup entry must be reactivated'
    Finish-BootstrapRecovery $root

    # A first install had neither registration. A late failure may create both;
    # recovery removes both only after ownership validation.
    Reset-Fixture
    Write-Assets 'old'
    Start-BootstrapTransaction $root (Join-Path $root 'bin') $assets
    Write-Assets 'fresh'
    $script:FakeTaskXml = New-OwnedTaskXml $root (Join-Path $root 'local\maintenance-worker.cjs')
    Write-TestFile $script:StartupPath (New-OwnedStartupEntry $root 'C:\Fresh\bash.exe')
    Recover-BootstrapTransaction $root (Join-Path $root 'bin') $assets | Out-Null
    Assert-True ($null -eq $script:FakeTaskXml) 'fresh recovery must remove its new owned Task'
    Assert-Absent $script:StartupPath 'fresh recovery must remove its new owned Startup entry'
    Finish-BootstrapRecovery $root

    # These corruptions must all refuse before the first asset mutation.
    Assert-RecoveryRefusesBeforeAssetMutation 'malformed' {
        Set-Content -LiteralPath (Join-Path $backup 'inventory') -Value @('version=2', 'present:../outside') -Encoding ascii
    }
    Assert-RecoveryRefusesBeforeAssetMutation 'incomplete' {
        $inventoryPath = Join-Path $backup 'inventory'
        $incompleteInventory = @(Get-Content -LiteralPath $inventoryPath | Where-Object { $_ -notmatch '^state:' })
        Set-Content -LiteralPath $inventoryPath -Value $incompleteInventory -Encoding ascii
    }
    Assert-RecoveryRefusesBeforeAssetMutation 'duplicate' {
        $inventoryPath = Join-Path $backup 'inventory'
        $duplicate = Get-Content -LiteralPath $inventoryPath | Where-Object { $_ -match '^state:' } | Select-Object -First 1
        Add-Content -LiteralPath $inventoryPath -Value $duplicate -Encoding ascii
    }
    New-InterruptedFixture
    $script:FakeTaskXml = '<Task><Actions><Exec><Command>foreign.exe</Command><Arguments>"foreign"</Arguments></Exec></Actions></Task>'
    $failed = $false
    try { Recover-BootstrapTransaction $root (Join-Path $root 'bin') $assets } catch { $failed = $true }
    Assert-True $failed 'a foreign Task must block recovery before mutation'
    Assert-True ((Read-TestFile (Join-Path (Join-Path $root 'bin') 'cozygateway.mjs')) -eq 'fresh:cozygateway.mjs') 'a foreign Task must preserve promoted bytes for inspection'
    New-InterruptedFixture
    $inventoryPath = Join-Path $backup 'inventory'
    Remove-Item -LiteralPath $inventoryPath -Force
    $redirected = $false
    try {
        New-Item -ItemType SymbolicLink -Path $inventoryPath -Target $outside -ErrorAction Stop | Out-Null
        $redirected = $true
    } catch [System.UnauthorizedAccessException] {
        Write-Host 'bootstrap transaction helper tests: reparse inventory case skipped (symlink privilege unavailable)'
    }
    if ($redirected) {
        $failed = $false
        try { Recover-BootstrapTransaction $root (Join-Path $root 'bin') $assets } catch { $failed = $true }
        Assert-True $failed 'redirected inventory must fail closed'
        Assert-True ((Read-TestFile (Join-Path (Join-Path $root 'bin') 'cozygateway.mjs')) -eq 'fresh:cozygateway.mjs') 'redirected inventory must fail before asset mutation'
        Assert-True ((Read-TestFile $outside) -eq 'outside-sentinel') 'redirected inventory must not alter an outside sentinel'
    }

    # Legacy binary-only journals still recover offline, without creating or
    # restoring any new runtime metadata or registration state.
    Reset-Fixture
    Write-Assets 'prior'
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    foreach ($name in $assetNames) {
        Copy-Item -LiteralPath (Join-Path (Join-Path $root 'bin') $name) -Destination (Join-Path $backup $name)
        Add-Content -LiteralPath (Join-Path $backup 'inventory') -Value "present:$name" -Encoding ascii
    }
    Write-TestFile $journal 'intent=replace-release-assets'
    Write-Assets 'replacement'
    $legacyRuntime = Join-Path $root 'local\gateway.env'
    Write-TestFile $legacyRuntime 'legacy-runtime-sentinel'
    $script:FakeTaskXml = '<foreign/>'
    Recover-BootstrapTransaction $root (Join-Path $root 'bin') $assets | Out-Null
    Assert-True ((Read-TestFile (Join-Path (Join-Path $root 'bin') 'cozygateway.mjs')) -eq 'prior:cozygateway.mjs') 'legacy recovery must restore old binary bytes'
    Assert-True ((Read-TestFile $legacyRuntime) -eq 'legacy-runtime-sentinel') 'legacy recovery must not invent runtime metadata'
    Assert-True ($script:FakeTaskXml -eq '<foreign/>') 'legacy recovery must not inspect or change registrations'
    Finish-BootstrapRecovery $root

    Write-Host 'bootstrap transaction helper tests passed'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $outside -Force -ErrorAction SilentlyContinue
}

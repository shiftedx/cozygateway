$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$installer = Get-Content -Raw (Join-Path $repoRoot 'scripts\agent-install.sh')
$classifier = [regex]::Match(
    $installer,
    '(?s)# COZYGATEWAY_DASHBOARD_OWNER_BEGIN\r?\n(.*?)# COZYGATEWAY_DASHBOARD_OWNER_END'
)
if (-not $classifier.Success) { throw 'embedded Windows Dashboard ownership helper was not found' }
Invoke-Expression $classifier.Groups[1].Value

$failures = New-Object System.Collections.Generic.List[string]
function Assert-Equal {
    param([string] $Name, $Expected, $Actual)
    if ($Actual -ne $Expected) { $failures.Add("$Name expected $Expected but got $Actual") }
}

function New-TestProcess {
    param(
        [int] $Id,
        [int] $ParentId,
        [AllowNull()][string] $ExecutablePath,
        [AllowNull()][string] $CommandLine,
        [string] $CreationDate = '20260829120000.000000-300'
    )
    [pscustomobject]@{
        ProcessId = $Id
        ParentProcessId = $ParentId
        ExecutablePath = $ExecutablePath
        CommandLine = $CommandLine
        CreationDate = $CreationDate
        Name = if ($Id -eq 104) { 'hermes.exe' } else { 'python.exe' }
        SessionId = 1
        Owner = 'Alex'
    }
}

function Assert-Owner {
    param([string] $Name, [string] $Expected, $Process, [hashtable] $Processes)
    $resolver = { param([int] $Id) $Processes[$Id] }
    $actual = Test-CozyDashboardOwner `
        -Process $Process `
        -ExpectedRoot $root `
        -ExpectedHermes $hermes `
        -ExpectedLauncher $launcher `
        -ExpectedPort 9119 `
        -ResolveProcess $resolver
    Assert-Equal $Name $Expected $actual
}

$root = 'C:\Users\Alex\AppData\Local\hermes'
$hermes = Join-Path $root 'bin\hermes'
$launcher = Join-Path $root 'bin\hermes.exe'
$venvPython = Join-Path $root 'hermes-agent\venv\Scripts\python.exe'
$venvHermes = Join-Path $root 'hermes-agent\venv\Scripts\hermes.exe'
$uvPython = 'C:\Users\Alex\AppData\Roaming\uv\python\cpython-3.11\python.exe'

$ownerHelper = [regex]::Match($installer, "(?ms)<<'POWERSHELL_OWNER'\r?\n(?<Body>.*?)\r?\nPOWERSHELL_OWNER")
Assert-Equal 'generated owner helper is present' $true $ownerHelper.Success
Assert-Equal 'owner helper exposes trusted system executable resolver' $true ($null -ne (Get-Command Resolve-CozySystemExecutable -ErrorAction SilentlyContinue))
if (Get-Command Resolve-CozySystemExecutable -ErrorAction SilentlyContinue) {
    $poisonedEnvironment = @{
        PATH = 'C:\poison\path'
        PSHOME = 'C:\poison\powershell-home'
        PSModulePath = 'C:\poison\modules'
        SystemRoot = 'C:\poison\system-root'
        WINDIR = 'C:\poison\windows'
        COMSPEC = 'C:\poison\cmd.exe'
        TEMP = 'C:\poison\temp'
        TMP = 'C:\poison\tmp'
        COZYGATEWAY_UAC_BOUNDARY_SENTINEL = 'C:\poison\sentinel'
    }
    $savedEnvironment = @{}
    foreach ($entry in $poisonedEnvironment.GetEnumerator()) {
        $savedEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
    try {
        $resolvedTaskkill = Resolve-CozySystemExecutable 'taskkill.exe'
        $expectedTaskkill = [IO.Path]::Combine([Environment]::SystemDirectory, 'taskkill.exe')
        Assert-Equal 'taskkill path ignores poisoned installer environment' $expectedTaskkill $resolvedTaskkill
        Assert-Equal 'taskkill path contains no poisoned value' $false ($resolvedTaskkill -match '(?i)poison')
    } finally {
        foreach ($entry in $savedEnvironment.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
        }
    }
}
foreach ($methodName in @('GetSystemDirectoryW', 'GetWindowsDirectoryW')) {
    $nativeMethod = $script:CozyNativeDirectoryApi.GetMethod($methodName)
    $import = $nativeMethod.GetCustomAttributes([Runtime.InteropServices.DllImportAttribute], $false)[0]
    Assert-Equal "$methodName preserves its Win32 error" $true $import.SetLastError
}
Assert-Equal 'owner helper reads only preserved native errors' $true ($ownerHelper.Groups['Body'].Value -match '\[Runtime\.InteropServices\.Marshal\]::GetLastWin32Error\(\)')
Assert-Equal 'owner helper does not select taskkill through inherited environment' $false ($ownerHelper.Groups['Body'].Value -match '\$env:(?:PATH|PSHOME|SystemRoot|WINDIR|COMSPEC|TEMP|TMP)')
Assert-Equal 'owner helper resolves the system directory through kernel32 KnownDLL' $true ($ownerHelper.Groups['Body'].Value -match 'GetSystemDirectoryW' -and $ownerHelper.Groups['Body'].Value -match 'kernel32\.dll')
Assert-Equal 'owner helper invokes an absolute resolved taskkill executable' $true ($ownerHelper.Groups['Body'].Value -match '(?m)^\s*& \$taskkillExecutable /PID')

$launcherProcess = New-TestProcess 100 0 $launcher ('"{0}" dashboard --host 127.0.0.1 --port 9119 --no-open' -f $launcher)
Assert-Owner 'native launcher' 'Owned' $launcherProcess @{ 100 = $launcherProcess }

$moduleParent = New-TestProcess 201 0 $venvPython ('"{0}" -m hermes_cli.main dashboard --port 9119' -f $venvPython)
$moduleListener = New-TestProcess 200 201 $uvPython ('"{0}" -m hermes_cli.main dashboard --host 127.0.0.1 --port 9119 --no-open' -f $uvPython)
Assert-Owner 'UV child with Hermes ancestor' 'Owned' $moduleListener @{ 200 = $moduleListener; 201 = $moduleParent }

$launcherChild = New-TestProcess 202 201 $uvPython ('"{0}" "{1}" dashboard --port 9119' -f $uvPython, $launcher)
Assert-Owner 'UV child carrying Hermes launcher' 'Owned' $launcherChild @{ 202 = $launcherChild; 201 = $moduleParent }

$externalPython = 'C:\Python311\python.exe'
$normalizedHermes = Join-Path $root 'bin\..\bin\hermes'
$exactHermesChild = New-TestProcess 203 299 $externalPython ('"{0}" "{1}" dashboard --port 9119' -f $externalPython, $normalizedHermes)
Assert-Owner 'external Python carrying exact normalized ExpectedHermes without readable ancestry' 'Owned' $exactHermesChild @{ 203 = $exactHermesChild }

# Hermes' Windows bin launcher delegates through the installed virtualenv
# launcher. The listener therefore names this canonical under-root executable,
# not the bin path originally resolved by the installer.
$venvHermesChild = New-TestProcess 211 299 $uvPython ('"{0}" "{1}" dashboard --host 127.0.0.1 --port 9119 --no-open --skip-build' -f $uvPython, $venvHermes)
Assert-Owner 'external UV Python carrying canonical installed Hermes venv launcher' 'Owned' $venvHermesChild @{ 211 = $venvHermesChild }

$exactHermesGatewayChild = New-TestProcess 210 299 $externalPython ('"{0}" "{1}" gateway --port 9119' -f $externalPython, $normalizedHermes)
Assert-Owner 'external Python carrying exact normalized ExpectedHermes with gateway subcommand' 'Foreign' $exactHermesGatewayChild @{ 210 = $exactHermesGatewayChild }

$externalParent = New-TestProcess 204 0 'C:\Python311\pythonw.exe' '"C:\Python311\pythonw.exe" worker'
$normalizedLauncher = Join-Path $root 'bin\..\bin\hermes.exe'
$exactLauncherChild = New-TestProcess 205 204 $externalPython ('"{0}" "{1}" dashboard --port=9119' -f $externalPython, $normalizedLauncher)
Assert-Owner 'external Python carrying exact normalized ExpectedLauncher with external ancestry' 'Owned' $exactLauncherChild @{ 204 = $externalParent; 205 = $exactLauncherChild }

$externalModuleChild = New-TestProcess 206 204 $externalPython ('"{0}" -m hermes_cli.main dashboard --port 9119' -f $externalPython)
Assert-Owner 'external Python module form still requires trusted under-root ancestry' 'Foreign' $externalModuleChild @{ 204 = $externalParent; 206 = $externalModuleChild }

$exactScriptForeignCases = @(
    @{ Name = 'external Python carrying wrong Hermes script path'; Process = New-TestProcess 207 0 $externalPython ('"{0}" "C:\Other\hermes.exe" dashboard --port 9119' -f $externalPython) },
    @{ Name = 'external Python carrying right script with wrong port'; Process = New-TestProcess 208 0 $externalPython ('"{0}" "{1}" dashboard --port 9120' -f $externalPython, $launcher) },
    @{ Name = 'external Python carrying main.py from wrong root'; Process = New-TestProcess 209 0 $externalPython ('"{0}" "C:\Other\hermes-agent\hermes_cli\main.py" dashboard --port 9119' -f $externalPython) }
)
foreach ($case in $exactScriptForeignCases) {
    Assert-Owner $case.Name 'Foreign' $case.Process @{ ($case.Process.ProcessId) = $case.Process }
}

$mainScript = Join-Path $root 'hermes-agent\hermes_cli\main.py'
$scriptProcess = New-TestProcess 300 0 $uvPython ('"{0}" "{1}" dashboard --port=9119' -f $uvPython, $mainScript)
Assert-Owner 'orphaned in-root main.py' 'Owned' $scriptProcess @{ 300 = $scriptProcess }

$foreignCases = @(
    @{ Name = 'dashboard token outside subcommand position'; Process = New-TestProcess 400 201 $uvPython ('"{0}" -m hermes_cli.main gateway --profile dashboard --port 9119' -f $uvPython); Parents = @{ 201 = $moduleParent } },
    @{ Name = 'wrong port'; Process = New-TestProcess 500 201 $uvPython ('"{0}" -m hermes_cli.main dashboard --port 9120' -f $uvPython); Parents = @{ 201 = $moduleParent } },
    @{ Name = 'module without Hermes-root ancestry'; Process = New-TestProcess 600 0 $uvPython ('"{0}" -m hermes_cli.main dashboard --port 9119' -f $uvPython); Parents = @{} },
    @{ Name = 'main.py suffix spoof'; Process = New-TestProcess 700 0 $uvPython ('"{0}" "{1}" dashboard --port 9119' -f $uvPython, (Join-Path $root 'hermes-agent\evilhermes_cli\main.py')); Parents = @{} },
    @{ Name = 'unrelated listener'; Process = New-TestProcess 800 0 'C:\Python\python.exe' 'python.exe -m http.server 9119 --directory dashboard'; Parents = @{} },
    @{ Name = 'embedded launcher sequence'; Process = New-TestProcess 900 201 'C:\Other\wrapper.exe' ('"C:\Other\wrapper.exe" --run "{0}" dashboard --port 9119' -f $launcher); Parents = @{ 201 = $moduleParent } },
    @{ Name = 'embedded module sequence'; Process = New-TestProcess 901 201 'C:\Other\wrapper.exe' '"C:\Other\wrapper.exe" --run -m hermes_cli.main dashboard --port 9119'; Parents = @{ 201 = $moduleParent } },
    @{ Name = 'embedded script sequence'; Process = New-TestProcess 902 201 'C:\Other\wrapper.exe' ('"C:\Other\wrapper.exe" --run "{0}" dashboard --port 9119' -f $mainScript); Parents = @{ 201 = $moduleParent } }
)
foreach ($case in $foreignCases) {
    $processes = @{ ($case.Process.ProcessId) = $case.Process }
    foreach ($entry in $case.Parents.GetEnumerator()) { $processes[$entry.Key] = $entry.Value }
    Assert-Owner $case.Name 'Foreign' $case.Process $processes
}

function New-AlexChain {
    param(
        [ValidateSet('Valid', 'Hidden', 'WrongRoot', 'WrongGrammar', 'WrongSubcommand', 'WrongPort')]
        [string] $Variant
    )
    $listenerCommand = ('"{0}" -m hermes_cli.main dashboard --host 127.0.0.1 --port 9119 --no-open' -f $uvPython)
    if ($Variant -eq 'WrongGrammar') { $listenerCommand = ('"{0}" --run -m hermes_cli.main dashboard --port 9119' -f $uvPython) }
    if ($Variant -eq 'WrongSubcommand') { $listenerCommand = ('"{0}" -m hermes_cli.main gateway --port 9119' -f $uvPython) }
    if ($Variant -eq 'WrongPort') { $listenerCommand = ('"{0}" -m hermes_cli.main dashboard --port 9120' -f $uvPython) }
    $endingHermes = if ($Variant -eq 'WrongRoot') { 'C:\Other\hermes.exe' } else { $launcher }
    $paths = @($uvPython, $uvPython, $uvPython, $uvPython, $endingHermes)
    $commands = @(
        $listenerCommand,
        ('"{0}" worker --child 1' -f $uvPython),
        ('"{0}" worker --child 2' -f $uvPython),
        ('"{0}" worker --child 3' -f $uvPython),
        ('"{0}" dashboard --port 9119' -f $endingHermes)
    )
    if ($Variant -eq 'Hidden') {
        $paths = @($null, $null, $null, $null, $null)
        $commands = @($null, $null, $null, $null, $null)
    }
    $result = @{}
    for ($index = 0; $index -lt 5; $index++) {
        $id = 100 + $index
        $parentId = if ($index -lt 4) { $id + 1 } else { 0 }
        $result[$id] = New-TestProcess $id $parentId $paths[$index] $commands[$index]
    }
    return $result
}

$alexCases = @(
    @{ Name = 'reported hidden four-Python ancestry'; Variant = 'Hidden'; Expected = 'Indeterminate' },
    @{ Name = 'reported readable four-Python ancestry'; Variant = 'Valid'; Expected = 'Owned' },
    @{ Name = 'reported ancestry with wrong root'; Variant = 'WrongRoot'; Expected = 'Foreign' },
    @{ Name = 'reported ancestry with wrong command grammar'; Variant = 'WrongGrammar'; Expected = 'Foreign' },
    @{ Name = 'reported ancestry with wrong subcommand'; Variant = 'WrongSubcommand'; Expected = 'Foreign' },
    @{ Name = 'reported ancestry with wrong port'; Variant = 'WrongPort'; Expected = 'Foreign' }
)
foreach ($case in $alexCases) {
    $chain = New-AlexChain $case.Variant
    Assert-Owner $case.Name $case.Expected $chain[100] $chain
}

$missingListenerPath = New-TestProcess 950 0 $null '"python.exe" -m hermes_cli.main dashboard --port 9119'
Assert-Owner 'same-user/session/name/port evidence without executable path' 'Indeterminate' $missingListenerPath @{ 950 = $missingListenerPath }
$missingListenerCommand = New-TestProcess 951 0 $uvPython $null
Assert-Owner 'same-user/session/name/port evidence without command line' 'Indeterminate' $missingListenerCommand @{ 951 = $missingListenerCommand }

function Invoke-TestStop {
    param(
        [scriptblock] $ResolveListener,
        [scriptblock] $ResolveProcess,
        [int] $KillCode = 0
    )
    $state = @{ KillCount = 0 }
    $killTree = { param([int] $Id) $state.KillCount++; return $KillCode }.GetNewClosure()
    try {
        $code = Stop-CozyDashboardOwner `
            -ExpectedRoot $root `
            -ExpectedHermes $hermes `
            -ExpectedLauncher $launcher `
            -ExpectedPort 9119 `
            -ResolveListener $ResolveListener `
            -ResolveProcess $ResolveProcess `
            -KillTree $killTree `
            -Sleep { param([int] $Milliseconds) }
    } catch {
        $code = 'Threw: ' + $_.Exception.Message
    }
    [pscustomobject]@{ Code = $code; KillCount = $state.KillCount }
}

if (Get-Command Stop-CozyDashboardOwner -ErrorAction SilentlyContinue) {
    $ownedProcess = New-TestProcess 1000 0 $launcher ('"{0}" dashboard --port 9119' -f $launcher)
    $listener = [pscustomobject]@{ OwningProcess = 1000 }

    $result = Invoke-TestStop { $null } { param([int] $Id) throw 'process lookup should not run' }
    Assert-Equal 'absent listener exit code' 0 $result.Code
    Assert-Equal 'absent listener taskkill count' 0 $result.KillCount

    $foreignProcess = New-TestProcess 1000 0 $launcher ('"{0}" dashboard --port 9120' -f $launcher)
    $result = Invoke-TestStop { $listener }.GetNewClosure() { param([int] $Id) $foreignProcess }.GetNewClosure()
    Assert-Equal 'foreign listener exit code' 42 $result.Code
    Assert-Equal 'foreign listener taskkill count' 0 $result.KillCount

    $inaccessibleProcess = New-TestProcess 1000 0 $null $null
    $result = Invoke-TestStop { $listener }.GetNewClosure() { param([int] $Id) $inaccessibleProcess }.GetNewClosure()
    Assert-Equal 'first-pass inaccessible process metadata exit code' 43 $result.Code
    Assert-Equal 'first-pass inaccessible process metadata taskkill count' 0 $result.KillCount

    $listenerState = @{ Count = 0 }
    $releaseListener = {
        $listenerState.Count++
        if ($listenerState.Count -le 2) { return $listener }
        return $null
    }.GetNewClosure()
    $result = Invoke-TestStop $releaseListener { param([int] $Id) $ownedProcess }.GetNewClosure()
    Assert-Equal 'successful termination exit code' 0 $result.Code
    Assert-Equal 'successful termination taskkill count' 1 $result.KillCount

    $result = Invoke-TestStop { $listener }.GetNewClosure() { param([int] $Id) $ownedProcess }.GetNewClosure()
    Assert-Equal 'port-release failure exit code' 45 $result.Code
    Assert-Equal 'port-release failure taskkill count' 1 $result.KillCount

    $result = Invoke-TestStop { throw 'listener query denied' } { param([int] $Id) $ownedProcess }.GetNewClosure()
    Assert-Equal 'first-pass listener resolver exception exit code' 43 $result.Code
    Assert-Equal 'first-pass listener resolver exception taskkill count' 0 $result.KillCount

    $listenerState = @{ Count = 0 }
    $secondListenerFailure = {
        $listenerState.Count++
        if ($listenerState.Count -eq 1) { return $listener }
        throw 'listener query denied'
    }.GetNewClosure()
    $result = Invoke-TestStop $secondListenerFailure { param([int] $Id) $ownedProcess }.GetNewClosure()
    Assert-Equal 'second-pass listener resolver exception exit code' 45 $result.Code
    Assert-Equal 'second-pass listener resolver exception taskkill count' 0 $result.KillCount

    $moduleWithParent = New-TestProcess 1100 1101 $uvPython ('"{0}" -m hermes_cli.main dashboard --port 9119' -f $uvPython)
    $moduleListenerSnapshot = [pscustomobject]@{ OwningProcess = 1100 }
    $firstAncestryFailure = {
        param([int] $Id)
        if ($Id -eq 1100) { return $moduleWithParent }
        throw 'ancestry query denied'
    }.GetNewClosure()
    $result = Invoke-TestStop { $moduleListenerSnapshot }.GetNewClosure() $firstAncestryFailure
    Assert-Equal 'first-pass ancestry resolver exception exit code' 43 $result.Code
    Assert-Equal 'first-pass ancestry resolver exception taskkill count' 0 $result.KillCount

    $underRootParent = New-TestProcess 1101 0 $venvPython ('"{0}" worker' -f $venvPython)
    $listenerState = @{ Count = 0 }
    $twoPassListener = { $listenerState.Count++; return $moduleListenerSnapshot }.GetNewClosure()
    $secondAncestryFailure = {
        param([int] $Id)
        if ($Id -eq 1100) { return $moduleWithParent }
        if ($listenerState.Count -eq 1) { return $underRootParent }
        throw 'ancestry query denied'
    }.GetNewClosure()
    $result = Invoke-TestStop $twoPassListener $secondAncestryFailure
    Assert-Equal 'second-pass ancestry resolver exception exit code' 45 $result.Code
    Assert-Equal 'second-pass ancestry resolver exception taskkill count' 0 $result.KillCount
}

$productionListenerResolver = [regex]::Match($installer, '(?s)\$listenerResolver = \{(.*?)\r?\n\}').Value
Assert-Equal 'production listener resolver surfaces query failures' $true ($productionListenerResolver -match '-ErrorAction Stop')

if (-not (Get-Command Stop-CozyDashboardOwner -ErrorAction SilentlyContinue)) {
    $failures.Add('race-safe stop function Stop-CozyDashboardOwner is missing')
} else {
    function Invoke-RaceCase {
        param([string] $Name, [scriptblock] $BuildSecondListener, [scriptblock] $BuildSecondProcess)
        $firstProcess = New-TestProcess 1000 0 $launcher ('"{0}" dashboard --port 9119' -f $launcher) '20260829120000.000000-300'
        $secondListener = & $BuildSecondListener
        $secondProcess = & $BuildSecondProcess $firstProcess
        $state = @{ ListenerPass = 0; KillCount = 0 }
        $resolveListener = {
            $state.ListenerPass++
            if ($state.ListenerPass -eq 1) { return [pscustomobject]@{ OwningProcess = 1000 } }
            return $secondListener
        }.GetNewClosure()
        $resolveProcess = {
            param([int] $Id)
            if ($state.ListenerPass -eq 1) { return $firstProcess }
            return $secondProcess
        }.GetNewClosure()
        $killTree = { param([int] $Id) $state.KillCount++; return 0 }.GetNewClosure()
        $code = Stop-CozyDashboardOwner `
            -ExpectedRoot $root `
            -ExpectedHermes $hermes `
            -ExpectedLauncher $launcher `
            -ExpectedPort 9119 `
            -ResolveListener $resolveListener `
            -ResolveProcess $resolveProcess `
            -KillTree $killTree `
            -Sleep { param([int] $Milliseconds) }
        Assert-Equal "$Name exit code" 45 $code
        Assert-Equal "$Name taskkill count" 0 $state.KillCount
    }

    Invoke-RaceCase 'changed PID' `
        { [pscustomobject]@{ OwningProcess = 1001 } } `
        { param($First) New-TestProcess 1001 0 $launcher ('"{0}" dashboard --port 9119' -f $launcher) $First.CreationDate }
    Invoke-RaceCase 'changed creation time' `
        { [pscustomobject]@{ OwningProcess = 1000 } } `
        { param($First) New-TestProcess 1000 0 $launcher $First.CommandLine '20260829120001.000000-300' }
    Invoke-RaceCase 'second-pass metadata loss' `
        { [pscustomobject]@{ OwningProcess = 1000 } } `
        { param($First) New-TestProcess 1000 0 $null $null $First.CreationDate }
    Invoke-RaceCase 'second-pass ownership mismatch' `
        { [pscustomobject]@{ OwningProcess = 1000 } } `
        { param($First) New-TestProcess 1000 0 $launcher ('"{0}" dashboard --port 9120' -f $launcher) $First.CreationDate }
}

if ($failures.Count -gt 0) { throw ($failures -join [Environment]::NewLine) }
'windows dashboard ownership tests passed'

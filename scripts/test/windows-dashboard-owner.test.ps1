$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$installer = Get-Content -Raw (Join-Path $repoRoot 'scripts\agent-install.sh')
$classifier = [regex]::Match(
    $installer,
    '(?s)# COZYGATEWAY_DASHBOARD_OWNER_BEGIN\r?\n(.*?)# COZYGATEWAY_DASHBOARD_OWNER_END'
)
if (-not $classifier.Success) {
    throw 'embedded Windows Dashboard ownership classifier was not found'
}
Invoke-Expression $classifier.Groups[1].Value

function New-TestProcess {
    param(
        [int] $Id,
        [int] $ParentId,
        [string] $ExecutablePath,
        [string] $CommandLine
    )
    [pscustomobject]@{
        ProcessId       = $Id
        ParentProcessId = $ParentId
        ExecutablePath  = $ExecutablePath
        CommandLine     = $CommandLine
    }
}

function Assert-Owner {
    param([string] $Name, [bool] $Expected, $Process, [hashtable] $Processes)
    $resolver = { param([int] $Id) $Processes[$Id] }
    $actual = Test-CozyDashboardOwner `
        -Process $Process `
        -ExpectedRoot $root `
        -ExpectedHermes $hermes `
        -ExpectedLauncher $launcher `
        -ExpectedPort 9119 `
        -ResolveProcess $resolver
    if ($actual -ne $Expected) {
        throw "$Name expected $Expected but got $actual"
    }
}

$root = 'C:\Users\Alex\AppData\Local\hermes'
$hermes = Join-Path $root 'bin\hermes'
$launcher = Join-Path $root 'bin\hermes.exe'
$venvPython = Join-Path $root 'hermes-agent\venv\Scripts\python.exe'
$uvPython = 'C:\Users\Alex\AppData\Roaming\uv\python\cpython-3.11\python.exe'

$launcherProcess = New-TestProcess 100 0 $launcher ('"{0}" dashboard --host 127.0.0.1 --port 9119 --no-open' -f $launcher)
Assert-Owner 'native launcher' $true $launcherProcess @{ 100 = $launcherProcess }

$moduleParent = New-TestProcess 201 0 $venvPython ('"{0}" -m hermes_cli.main dashboard --port 9119' -f $venvPython)
$moduleListener = New-TestProcess 200 201 $uvPython ('"{0}" -m hermes_cli.main dashboard --host 127.0.0.1 --port 9119 --no-open' -f $uvPython)
Assert-Owner 'UV child with Hermes ancestor' $true $moduleListener @{ 200 = $moduleListener; 201 = $moduleParent }

$launcherChild = New-TestProcess 202 201 $uvPython ('"{0}" "{1}" dashboard --port 9119' -f $uvPython, $launcher)
Assert-Owner 'UV child carrying Hermes launcher' $true $launcherChild @{ 202 = $launcherChild; 201 = $moduleParent }

$mainScript = Join-Path $root 'hermes-agent\hermes_cli\main.py'
$scriptProcess = New-TestProcess 300 0 $uvPython ('"{0}" "{1}" dashboard --port=9119' -f $uvPython, $mainScript)
Assert-Owner 'orphaned in-root main.py' $true $scriptProcess @{ 300 = $scriptProcess }

$wrongSubcommand = New-TestProcess 400 201 $uvPython ('"{0}" -m hermes_cli.main gateway --profile dashboard --port 9119' -f $uvPython)
Assert-Owner 'dashboard token outside subcommand position' $false $wrongSubcommand @{ 400 = $wrongSubcommand; 201 = $moduleParent }

$wrongPort = New-TestProcess 500 201 $uvPython ('"{0}" -m hermes_cli.main dashboard --port 9120' -f $uvPython)
Assert-Owner 'wrong port' $false $wrongPort @{ 500 = $wrongPort; 201 = $moduleParent }

$foreignModule = New-TestProcess 600 0 $uvPython ('"{0}" -m hermes_cli.main dashboard --port 9119' -f $uvPython)
Assert-Owner 'module without Hermes-root ancestry' $false $foreignModule @{ 600 = $foreignModule }

$spoofScript = Join-Path $root 'hermes-agent\evilhermes_cli\main.py'
$suffixSpoof = New-TestProcess 700 0 $uvPython ('"{0}" "{1}" dashboard --port 9119' -f $uvPython, $spoofScript)
Assert-Owner 'main.py suffix spoof' $false $suffixSpoof @{ 700 = $suffixSpoof }

$unrelated = New-TestProcess 800 0 'C:\Python\python.exe' 'python.exe -m http.server 9119 --directory dashboard'
Assert-Owner 'unrelated listener' $false $unrelated @{ 800 = $unrelated }

$wrapper = 'C:\Other\wrapper.exe'
$embeddedLauncher = New-TestProcess 900 201 $wrapper ('"{0}" --run "{1}" dashboard --port 9119' -f $wrapper, $launcher)
Assert-Owner 'embedded launcher sequence' $false $embeddedLauncher @{ 900 = $embeddedLauncher; 201 = $moduleParent }

$embeddedModule = New-TestProcess 901 201 $wrapper ('"{0}" --run -m hermes_cli.main dashboard --port 9119' -f $wrapper)
Assert-Owner 'embedded module sequence' $false $embeddedModule @{ 901 = $embeddedModule; 201 = $moduleParent }

$embeddedScript = New-TestProcess 902 201 $wrapper ('"{0}" --run "{1}" dashboard --port 9119' -f $wrapper, $mainScript)
Assert-Owner 'embedded script sequence' $false $embeddedScript @{ 902 = $embeddedScript; 201 = $moduleParent }

'windows dashboard ownership tests passed'

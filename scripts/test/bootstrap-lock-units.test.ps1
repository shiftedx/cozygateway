<#
The bootstrap lock, on any host with a pwsh.

scripts/test/windows-bootstrap-durability.test.ps1 covers cross-process ownership and OS cleanup
after an abrupt exit, and needs a Windows host to do it. What it could not cover is the failure a
user actually hit: an interrupted `irm ... | iex` left the lock handle open for the life of the
PowerShell process, so every later install and `cozygateway repair` -- in any window -- failed with
"another CozyGateway bootstrap is running" until that window was closed. Two days, on one machine.

The cause is the `finally` block: a cmdlet called while the pipeline is stopping throws
PipelineStoppedException, which abandoned the rest of the block before it reached the release.

  pwsh -NoProfile -File scripts/test/bootstrap-lock-units.test.ps1
#>
param([string] $Installer = (Join-Path $PSScriptRoot '../install.ps1'))
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:Failures = 0
$script:Checks = 0
function Assert-True([bool] $Condition, [string] $What) {
    $script:Checks++
    if ($Condition) { Write-Host "ok    $What" } else { $script:Failures++; Write-Host "FAIL  $What" -ForegroundColor Red }
}

$installerPath = (Resolve-Path $Installer).Path
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($installerPath, [ref] $tokens, [ref] $errors)
if ($errors.Count) { throw ($errors | Out-String) }
$functions = $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)
foreach ($fn in $functions) { Invoke-Expression $fn.Extent.Text }
$source = Get-Content -LiteralPath $installerPath -Raw

# --- The release must survive a stopping pipeline --------------------------------------------
# Which means: no cmdlets, and it goes first in the `finally`.
$release = $functions | Where-Object { $_.Name -eq 'Release-BootstrapLock' }
Assert-True ($null -ne $release) 'install.ps1 still defines Release-BootstrapLock'
$cmdlets = @($release.Body.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] }, $true) |
    ForEach-Object { $_.GetCommandName() } | Where-Object { $_ })
Assert-True ($cmdlets.Count -eq 0) "Release-BootstrapLock calls no command, only .NET (found: $($cmdlets -join ', '))"

$finallyBlock = [regex]::Match($source, '(?ms)^\} finally \{.*?^\}').Value
Assert-True ($finallyBlock -match '(?ms)finally \{[^\}]*?Release-BootstrapLock') `
    'the finally block releases the lock before anything that could throw on an interrupt'

# --- Acquire, hold, name the owner, release ----------------------------------------------------
# Fully resolved, component by component: the installer refuses a bootstrap path that passes
# through a reparse point, and on macOS the temp directory reaches it through a symlinked /var.
# On Windows, where this matters in production, %TEMP% is already a real path and this is a no-op.
function Resolve-RealPath([string] $Path) {
    $resolved = ''
    foreach ($part in ($Path.TrimEnd('/', '\') -split '[/\\]')) {
        if ($part -eq '') { continue }
        $resolved = if ($resolved) { Join-Path $resolved $part } else { if ($Path.StartsWith('/')) { "/$part" } else { $part } }
        $link = [IO.Directory]::ResolveLinkTarget($resolved, $true)
        if ($link) { $resolved = $link.FullName }
    }
    return $resolved
}
$root = Join-Path (Resolve-RealPath ([IO.Path]::GetTempPath())) ('cozy-lock-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
try {
    Acquire-BootstrapLock $root
    $lock = Join-Path $root '.bootstrap-lock'
    $owner = "$lock.owner"

    Assert-True (Test-Path -LiteralPath $owner -PathType Leaf) 'acquiring records the owning process id in a readable sidecar'
    Assert-True ((Get-Content -LiteralPath $owner -Raw).Trim() -eq "$PID") 'the sidecar names this process'
    $held = $false
    try { $other = [IO.File]::Open($lock, 'OpenOrCreate', 'ReadWrite', 'None'); $other.Dispose() } catch { $held = $true }
    Assert-True $held 'the lock is held exclusively while acquired'

    # The sidecar is readable even though the lock itself is FileShare::None -- the whole point,
    # since a blocked run cannot open the lock to find out who has it.
    Assert-True ((Get-BootstrapLockOwner $owner) -eq '') 'the owner is not reported back to the process already holding it'

    Release-BootstrapLock
    Assert-True (-not (Test-Path -LiteralPath $owner)) 'releasing removes the owner sidecar'
    $reopened = [IO.File]::Open($lock, 'OpenOrCreate', 'ReadWrite', 'None'); $reopened.Dispose()
    Assert-True $true 'the lock is free again after release'

    # Releasing twice, or without ever acquiring, must be silent: `finally` runs on paths where
    # the lock was never taken.
    Release-BootstrapLock
    Release-BootstrapLock
    Assert-True $true 'releasing an unheld lock is a no-op rather than an error'
    # Including before the installer's own top-level initialization has run, since a `finally`
    # must not be the place a StrictMode error is discovered.
    $bare = [powershell]::Create().AddScript("Set-StrictMode -Version 2.0`n$($release.Extent.Text)`nRelease-BootstrapLock`n'survived'")
    try { Assert-True ("$($bare.Invoke())" -eq 'survived') 'releasing without any initialized state does not throw' }
    finally { $bare.Dispose() }

    # A crashed owner leaves its sidecar behind. Naming a dead process id would send someone after
    # a window that is not there, or worse, after whatever reused the id.
    [IO.File]::WriteAllText($owner, "2147483647`n")
    Assert-True ((Get-BootstrapLockOwner $owner) -eq '') 'a dead recorded owner is not reported'
    [IO.File]::WriteAllText($owner, "not-a-pid`n")
    Assert-True ((Get-BootstrapLockOwner $owner) -eq '') 'a corrupt sidecar is not reported'
    Assert-True ((Get-BootstrapLockOwner (Join-Path $root 'absent')) -eq '') 'a missing sidecar is not reported'
} finally {
    Release-BootstrapLock
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($script:Failures -gt 0) { Write-Host "FAIL  $($script:Failures) of $($script:Checks) checks failed" -ForegroundColor Red; exit 1 }
Write-Host "ok    all $($script:Checks) checks passed"

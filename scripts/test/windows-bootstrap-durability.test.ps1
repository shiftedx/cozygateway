param([string] $Installer = (Join-Path $PSScriptRoot '..\install.ps1'))
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Installer), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($fn in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) { Invoke-Expression $fn.Extent.Text }
function Assert-True([bool] $Condition, [string] $Message) { if (-not $Condition) { throw "ASSERT: $Message" } }
$root = Join-Path ([IO.Path]::GetTempPath()) ('cozy-durability-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
    Acquire-BootstrapLock $root
    Release-BootstrapLock
    # Exercise actual cross-process ownership and OS cleanup after abrupt exit.
    $ready = Join-Path $root 'child-ready'
    $definitions = ($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $false) | ForEach-Object { $_.Extent.Text }) -join "`n"
    $childCode = $definitions + "`nAcquire-BootstrapLock '" + $root.Replace("'", "''") + "'`n[IO.File]::WriteAllText('" + $ready.Replace("'", "''") + "', 'ready')`nStart-Sleep -Seconds 30"
    $childScript = Join-Path $root 'lock-child.ps1'
    [IO.File]::WriteAllText($childScript, $childCode)
    $child = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $childScript + '"')) -WindowStyle Hidden -PassThru
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while (-not (Test-Path -LiteralPath $ready) -and [DateTime]::UtcNow -lt $deadline -and -not $child.HasExited) { Start-Sleep -Milliseconds 50 }
        Assert-True (Test-Path -LiteralPath $ready) 'child must acquire the lock'
        $blocked = $false
        try { Acquire-BootstrapLock $root } catch { $blocked = $true }
        Assert-True $blocked 'second installer must reject a live owner'
    } finally {
        if (-not $child.HasExited) { Stop-Process -Id $child.Id -Force }
        $child.WaitForExit()
        $child.Dispose()
    }
    Acquire-BootstrapLock $root
    Release-BootstrapLock
    $lock = Join-Path $root '.bootstrap-lock'
    Remove-Item -LiteralPath $lock
    New-Item -ItemType Directory -Path $lock | Out-Null
    $blocked = $false
    try { Acquire-BootstrapLock $root } catch { $blocked = $true }
    Assert-True $blocked 'empty legacy lock may still be initializing and must not be stolen'
    Set-Content -LiteralPath (Join-Path $lock 'pid') -Value $PID
    $blocked = $false
    try { Acquire-BootstrapLock $root } catch { $blocked = $true }
    Assert-True $blocked 'live legacy owner must block migration'
    Set-Content -LiteralPath (Join-Path $lock 'pid') -Value 2147483647
    Acquire-BootstrapLock $root
    Release-BootstrapLock
    Assert-True (Test-Path -LiteralPath $lock -PathType Leaf) 'dead legacy lock must migrate to stable file'
    Assert-True (Test-Path -LiteralPath (Join-Path $root '.bootstrap-lock') -PathType Leaf) 'released lock must remain a stable file'
    Acquire-BootstrapLock $root
    $blocked = $false
    try { $other = [IO.File]::Open((Join-Path $root '.bootstrap-lock'), 'OpenOrCreate', 'ReadWrite', 'None'); $other.Dispose() } catch { $blocked = $true }
    Assert-True $blocked 'exclusive lock must reject a concurrent owner'
    Release-BootstrapLock
    Set-Content -LiteralPath (Join-Path $root '.bootstrap-lock') -Value $PID
    Acquire-BootstrapLock $root
    Release-BootstrapLock
    # A interrupted marker write must not strand the following invocation.
    Set-Content -LiteralPath (Join-Path $root '.bootstrap-transaction.next') -Value 'prepare=replace-release-assets' -NoNewline
    Recover-BootstrapTransaction $root (Join-Path $root 'bin') @('cozygateway.mjs')
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $root '.bootstrap-transaction.next'))) 'orphan next marker must be cleaned'
    Set-BootstrapTransactionState $root 'prepare=replace-release-assets'
    Set-Content -LiteralPath (Join-Path $root '.bootstrap-transaction.next') -Value 'intent=replace-release-assets' -NoNewline
    Recover-BootstrapTransaction $root (Join-Path $root 'bin') @('cozygateway.mjs')
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $root '.bootstrap-transaction'))) 'authoritative prepare marker must recover despite staged intent'
    $next = Join-Path $root '.bootstrap-transaction.next'
    New-Item -ItemType Directory -Path $next | Out-Null
    $blocked = $false
    try { Recover-BootstrapTransaction $root (Join-Path $root 'bin') @('cozygateway.mjs') } catch { $blocked = $true }
    Assert-True $blocked 'unexpected staging directory must fail closed'
    Assert-True (Test-Path -LiteralPath $next -PathType Container) 'unexpected staging directory must remain untouched'
    Remove-Item -LiteralPath $next
    # Simulate failure at the first backup mkdir: intent must already be durable.
    function Get-GatewayRegistrationForRecovery { return [pscustomobject]@{TaskXml=''; StartupPresent=$false} }
    function New-Item { throw 'injected snapshot mkdir failure' }
    try { Start-BootstrapTransaction $root (Join-Path $root 'bin') @('cozygateway.mjs') } catch { }
    Remove-Item Function:New-Item
    Assert-True ((Get-Content -LiteralPath (Join-Path $root '.bootstrap-transaction') -Raw) -eq 'prepare=replace-release-assets') 'prepare must precede snapshot creation'
    Recover-BootstrapTransaction $root (Join-Path $root 'bin') @('cozygateway.mjs')
    Write-Host 'Windows bootstrap durability tests passed'
} finally {
    Release-BootstrapLock
    if (Test-Path Function:New-Item) { Remove-Item Function:New-Item }
    $resolved = [IO.Path]::GetFullPath($root)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe fixture cleanup' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

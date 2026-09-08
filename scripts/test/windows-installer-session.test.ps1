param([switch] $ElevatedIntegration)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$tokens = $null
$parseErrors = $null
$installerAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../install.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Installer must parse before session tests can load its functions' }
$helperNames = @('Get-CozyInstallerSourceText', 'Get-CozySessionNativeSource', 'Initialize-CozySessionNative', 'New-CozySessionPayload', 'Get-CozySessionContinuation', 'Invoke-CozyInstallerSession')
foreach ($helperName in $helperNames) {
    $definition = $installerAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $helperName }, $true)
    if ($null -eq $definition) { throw "Missing session helper: $helperName" }
    . ([scriptblock]::Create($definition.Extent.Text))
}
function Assert-Session { param($Condition, [string] $Message) if (-not $Condition) { throw $Message } }
$parameters = @{ Repair = [switch]$true; Harness = 'both'; CozyAgentsInstaller = 'C:\a b\quo''te.ps1' }
$arguments = @('--value', '', 'quote"value', ('line' + "`n" + 'two'), ('snowman ' + [char]0x2603))
$payload = New-CozySessionPayload $parameters $arguments
$roundtrip = [Management.Automation.PSSerializer]::Deserialize([Management.Automation.PSSerializer]::Serialize($payload))
Assert-Session ($roundtrip.Parameters.Repair -eq $true) 'Switch must survive as a Boolean'
Assert-Session ($roundtrip.Parameters.CozyAgentsInstaller -ceq $parameters.CozyAgentsInstaller) 'Literal path changed'
Assert-Session ($roundtrip.Arguments.Count -eq $arguments.Count) 'Argument count changed'
for ($i = 0; $i -lt $arguments.Count; $i++) { Assert-Session ($roundtrip.Arguments[$i] -ceq $arguments[$i]) "Argument $i changed" }
Initialize-CozySessionNative
$elevated = [CozyGateway.DesktopInstallerSession]::IsElevated()
$scriptText = @'
param([switch] $Repair, [string] $Harness, [string] $CozyAgentsInstaller, [string[]] $InstallerArguments)
if (-not $Repair -or $Harness -ne 'both' -or $CozyAgentsInstaller -ne "C:\a b\quo'te.ps1") { throw 'Bound arguments changed' }
if ($InstallerArguments.Count -ne 5 -or $InstallerArguments[1] -cne '' -or $InstallerArguments[2] -cne 'quote"value') { throw 'Remaining arguments changed' }
if ($env:COZY_SESSION_TEST_VALUE -cne 'preserved value') { throw 'Environment changed' }
if ($env:COZY_SESSION_TEST_CWD -and ((Get-Location).ProviderPath -ine $env:COZY_SESSION_TEST_CWD -or -not (Test-Path -LiteralPath './relative-input.txt'))) { throw 'Original working directory was not restored' }
if ($env:COZY_SESSION_TEST_CWD -and [IO.File]::ReadAllText('relative-input.txt').Trim() -cne 'relative source') { throw 'Native relative paths were not restored' }
exit 37
'@
if (-not $elevated) {
    $result = Invoke-CozyInstallerSession -ScriptText 'throw "Must not run"' -BoundParameters @{} -InstallerArguments @()
    Assert-Session (-not $result.HandedOff -and $result.ExitCode -eq 0) 'Limited token must continue in current process'
    # Exercise the actual continuation process even without permission to elevate.
    $folder = Join-Path ([IO.Path]::GetTempPath()) ('cozy-session-test-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $folder
    $prior = [Environment]::GetEnvironmentVariable('COZY_SESSION_TEST_VALUE')
    $priorCwd = [Environment]::GetEnvironmentVariable('COZY_SESSION_TEST_CWD')
    try {
        $env:COZY_SESSION_TEST_VALUE = 'preserved value'
        $env:COZY_SESSION_TEST_CWD = $folder
        Set-Content -LiteralPath (Join-Path $folder 'relative-input.txt') -Value 'relative source'
        $payload.ExpectedSid = [CozyGateway.DesktopInstallerSession]::CurrentSid()
        $payload.WorkingDirectory = $folder
        $payload | Export-Clixml -LiteralPath (Join-Path $folder 'parameters.xml') -Depth 8
        Set-Content -LiteralPath (Join-Path $folder 'native.cs') -Value (Get-CozySessionNativeSource) -Encoding UTF8
        Set-Content -LiteralPath (Join-Path $folder 'installer.ps1') -Value $scriptText -Encoding UTF8
        $wrapper = Join-Path $folder 'continue.ps1'
        Set-Content -LiteralPath $wrapper -Value (Get-CozySessionContinuation) -Encoding UTF8
        $application = Join-Path $PSHOME 'powershell.exe'
        if ($PSVersionTable.PSEdition -eq 'Core') { $application = Join-Path $PSHOME 'pwsh.exe' }
        # Exercise the real native shell-parent launch even from a limited terminal.
        # This catches token/STARTUPINFOEX/attribute marshalling errors locally.
        $nativeExit = [CozyGateway.DesktopInstallerSession]::Launch($application, $wrapper, [Environment]::SystemDirectory)
        Assert-Session ($nativeExit -eq 37) 'Native shell-parent launch must preserve the payload and exact exit status'
        & $application -NoProfile -ExecutionPolicy Bypass -File $wrapper
        Assert-Session ($LASTEXITCODE -eq 37) 'Continuation must preserve parameters and exit status'
        $payload.ExpectedSid = 'S-1-5-18'
        $payload | Export-Clixml -LiteralPath (Join-Path $folder 'parameters.xml') -Depth 8
        $rejectedOutput = (& $application -NoProfile -ExecutionPolicy Bypass -File $wrapper | Out-String)
        Assert-Session ($LASTEXITCODE -eq 1) 'Continuation must reject a different account before installer runs'
        Assert-Session ($rejectedOutput -like '*limited token*') 'Account rejection must identify the token boundary'
        # The published installer captures its own complete source before calling helpers.
        # Exercise both PowerShell entrypoints without running any install operations.
        $fixtureHead = @'
[CmdletBinding(PositionalBinding = $false)]
param([switch] $Repair, [string] $Harness, [Parameter(ValueFromRemainingArguments = $true)][string[]] $InstallerArguments)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$capturedParameters = @{} + $PSBoundParameters
'@
        $helperText = $helperNames | ForEach-Object {
            'function ' + $_ + " {`n" + (Get-Command $_).Definition + "`n}"
        }
        $fixtureTail = @'
$capturedSource = Get-CozyInstallerSourceText
$session = Invoke-CozyInstallerSession -ScriptText $capturedSource -BoundParameters $capturedParameters -InstallerArguments $InstallerArguments
if ($session.HandedOff -or $session.ExitCode -ne 0) { throw 'Read-only limited-user fixture unexpectedly handed off' }
@{ Source = $capturedSource; Payload = (New-CozySessionPayload $capturedParameters $InstallerArguments) } | Export-Clixml -LiteralPath (Join-Path ([IO.Path]::GetTempPath()) $env:COZY_SESSION_RESULT) -Depth 8
'@
        $fixtureText = $fixtureHead + "`n" + ($helperText -join "`n") + "`n" + ('# long source ' + ('x' * 12000)) + "`n" + $fixtureTail
        $fixturePath = Join-Path $folder 'entry.ps1'
        [IO.File]::WriteAllText($fixturePath, $fixtureText, (New-Object Text.UTF8Encoding($true)))
        $env:COZY_SESSION_RESULT = (Split-Path $folder -Leaf) + '/entry-result.xml'
        $longArgument = 'argument-' + ('x' * 4096)
        & $application -NoProfile -ExecutionPolicy Bypass -File $fixturePath -Repair -Harness both --entry $longArgument
        Assert-Session ($LASTEXITCODE -eq 0) '-File source capture failed'
        $entry = Import-Clixml -LiteralPath (Join-Path $folder 'entry-result.xml')
        Assert-Session ($entry.Source -ceq $fixtureText) '-File must capture complete original source'
        Assert-Session ($entry.Payload.Parameters.Repair -and $entry.Payload.Parameters.Harness -ceq 'both') '-File bound parameters changed'
        Assert-Session ($entry.Payload.Arguments.Count -eq 2 -and $entry.Payload.Arguments[1] -ceq $longArgument) '-File long remaining argument changed'
        # Raw irm|iex has no invocation arguments; defaults must bind and source must survive.
        $iexDriver = Join-Path $folder 'iex-entry.ps1'
        Set-Content -LiteralPath $iexDriver -Encoding UTF8 -Value @'
param([string] $CallerOnly)
$ErrorActionPreference = 'Stop'
Get-Content -LiteralPath (Join-Path $PSScriptRoot 'entry.ps1') -Raw | Invoke-Expression
'@
        & $application -NoProfile -ExecutionPolicy Bypass -File $iexDriver -CallerOnly unrelated
        Assert-Session ($LASTEXITCODE -eq 0) 'Raw iex source capture failed'
        $entry = Import-Clixml -LiteralPath (Join-Path $folder 'entry-result.xml')
        Assert-Session ($entry.Source -ceq $fixtureText) 'Raw iex must capture complete original source'
        Assert-Session ($entry.Payload.Parameters.Count -eq 0 -and $entry.Payload.Arguments.Count -eq 0) 'Raw iex must preserve default binding'
    } finally {
        [Environment]::SetEnvironmentVariable('COZY_SESSION_TEST_VALUE', $prior)
        [Environment]::SetEnvironmentVariable('COZY_SESSION_TEST_CWD', $priorCwd)
        Remove-Item Env:COZY_SESSION_RESULT -ErrorAction SilentlyContinue
        foreach ($name in @('continue.ps1', 'native.cs', 'installer.ps1', 'parameters.xml', 'entry.ps1', 'iex-entry.ps1', 'entry-result.xml', 'relative-input.txt')) { Remove-Item -LiteralPath (Join-Path $folder $name) -Force -ErrorAction SilentlyContinue }
        [IO.Directory]::Delete($folder, $false)
    }
} elseif (-not $ElevatedIntegration) {
    Write-Host 'SKIP native handoff: specify -ElevatedIntegration from an elevated same-user terminal'
}
if ($ElevatedIntegration) {
    Assert-Session $elevated 'Elevated integration requires an elevated split-token terminal'
    if (-not [CozyGateway.DesktopInstallerSession]::HasLinkedLimitedToken()) {
        Write-Host 'SKIP native handoff: this elevated account has no UAC linked limited token'
        return
    }
    $priorValue = [Environment]::GetEnvironmentVariable('COZY_SESSION_TEST_VALUE')
    $priorCwd = [Environment]::GetEnvironmentVariable('COZY_SESSION_TEST_CWD')
    $nativeCwd = Join-Path ([IO.Path]::GetTempPath()) ('cozy-session-cwd ' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $nativeCwd
    Set-Content -LiteralPath (Join-Path $nativeCwd 'relative-input.txt') -Value 'relative source'
    $env:COZY_SESSION_TEST_VALUE = 'preserved value'
    $env:COZY_SESSION_TEST_CWD = $nativeCwd
    Push-Location -LiteralPath $nativeCwd
    try {
        $result = Invoke-CozyInstallerSession -ScriptText $scriptText -BoundParameters $parameters -InstallerArguments $arguments
        Assert-Session ($result.HandedOff -and $result.ExitCode -eq 37) 'Child exit status must propagate exactly'
    } finally {
        Pop-Location
        [Environment]::SetEnvironmentVariable('COZY_SESSION_TEST_VALUE', $priorValue)
        [Environment]::SetEnvironmentVariable('COZY_SESSION_TEST_CWD', $priorCwd)
        Remove-Item -LiteralPath (Join-Path $nativeCwd 'relative-input.txt') -Force
        [IO.Directory]::Delete($nativeCwd, $false)
    }
}
Write-Host 'PASS Windows installer session tests'


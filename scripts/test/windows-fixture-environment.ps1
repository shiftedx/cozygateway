function New-IsolatedInstallerFixture {
    param([string] $Installer, [string] $Root)
    # Fixture processes must never open an interactive UAC continuation or
    # depend on CI's token policy. Stub source, not a production security flag.
    $source = [IO.File]::ReadAllText($Installer)
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
    $stubs = @{
        'Find-CozyLocalModels' = 'function Find-CozyLocalModels { return @() }'
        'Get-WindowsSavedProviderChoices' = 'function Get-WindowsSavedProviderChoices { return @() }'
        'Get-WindowsSavedProviderCatalog' = 'function Get-WindowsSavedProviderCatalog { return [pscustomobject]@{Provider="";DefaultModel="";Models=@();AuthConfigured=$false;RequiresSharedConfig=$false} }'
        'Invoke-CozyInstallerSession' = 'function Invoke-CozyInstallerSession { param([string] $ScriptText, [hashtable] $BoundParameters, [string[]] $InstallerArguments) return [pscustomobject]@{ HandedOff = $false; ExitCode = 0 } }'
        'Wait-WindowsGatewayReady' = 'function Wait-WindowsGatewayReady { param([string] $InstallRoot, [int] $TimeoutSeconds) }'
        'Stop-OwnedGatewayForRecovery' = 'function Stop-OwnedGatewayForRecovery { param([string] $InstallRoot) }'
        'Test-WindowsGitBash' = 'function Test-WindowsGitBash { param([string] $Path) return Test-Path -LiteralPath $Path -PathType Leaf }'
    }
    $functions = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $stubs.ContainsKey($node.Name) }, $false) | Sort-Object { $_.Extent.StartOffset } -Descending
    foreach ($function in $functions) {
        $source = $source.Remove($function.Extent.StartOffset, $function.Extent.EndOffset - $function.Extent.StartOffset).Insert($function.Extent.StartOffset, $stubs[$function.Name])
    }
    $path = Join-Path $Root 'isolated-installer.ps1'
    [IO.File]::WriteAllText($path, $source, (New-Object Text.UTF8Encoding($false)))
    return $path
}

function New-IsolatedBootstrapEnvironment {
    param([hashtable] $Environment, [string] $Root)
    $isolated = $Environment.Clone()
    if (-not $isolated.ContainsKey('PI_CODING_AGENT_DIR')) {
        $isolated['PI_CODING_AGENT_DIR'] = Join-Path $Root 'isolated-pi'
    }
    if (-not $isolated.ContainsKey('HERMES_HOME')) {
        $isolated['HERMES_HOME'] = Join-Path $Root 'isolated-hermes'
    }
    if ([string]::IsNullOrWhiteSpace([string]$isolated['COZYGATEWAY_TEST_USER_PATH_LOG'])) {
        $isolated['COZYGATEWAY_TEST_USER_PATH_LOG'] = Join-Path $Root 'isolated-user-path.txt'
    }
    if (-not $isolated.ContainsKey('COZYGATEWAY_TEST_USER_PATH')) {
        $isolated['COZYGATEWAY_TEST_USER_PATH'] = 'C:\Fixture Existing Tools'
    }
    $isolated['COZYGATEWAY_TEST_APPDATA'] = Join-Path $Root 'isolated-appdata'
    # Fake Hermes binaries have no Python installation. Never discover or build
    # the real user's Dashboard from a bootstrap fixture.
    if (-not $isolated.ContainsKey('COZYGATEWAY_TEST_DASHBOARD_BUILDER')) {
        $builder = Join-Path $Root 'isolated-dashboard-builder.ps1'
        [IO.File]::WriteAllText($builder, 'param($HermesPath) $global:LASTEXITCODE = 0')
        $isolated['COZYGATEWAY_TEST_DASHBOARD_BUILDER'] = $builder
    }
    # Transaction snapshots must see only fixture registrations, never the user's installed task.
    $systemBin = Join-Path $Root 'isolated-system'
    $taskCommand = Join-Path $systemBin 'schtasks.exe'
    if (-not (Test-Path -LiteralPath $taskCommand)) {
        New-Item -ItemType Directory -Force -Path $systemBin | Out-Null
        $className = 'AbsentFixtureTask' + [guid]::NewGuid().ToString('N')
        Add-Type -TypeDefinition "public static class $className { public static int Main(string[] args) { return 1; } }" -Language CSharp -OutputAssembly $taskCommand -OutputType ConsoleApplication
    }
    $isolated['COZYGATEWAY_TEST_SCHTASKS'] = $taskCommand
    $processPath = if ($isolated.ContainsKey('PATH')) { [string]$isolated['PATH'] } else { $env:PATH }
    $isolated['PATH'] = $systemBin + ';' + $processPath
    return $isolated
}

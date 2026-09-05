function New-IsolatedBootstrapEnvironment {
    param([hashtable] $Environment, [string] $Root)
    $isolated = $Environment.Clone()
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

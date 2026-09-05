function New-IsolatedBootstrapEnvironment {
    param([hashtable] $Environment, [string] $Root)
    $isolated = $Environment.Clone()
    if ([string]::IsNullOrWhiteSpace([string]$isolated['COZYGATEWAY_TEST_USER_PATH_LOG'])) {
        $isolated['COZYGATEWAY_TEST_USER_PATH_LOG'] = Join-Path $Root 'isolated-user-path.txt'
    }
    if (-not $isolated.ContainsKey('COZYGATEWAY_TEST_USER_PATH')) {
        $isolated['COZYGATEWAY_TEST_USER_PATH'] = 'C:\Fixture Existing Tools'
    }
    $isolated['COZYGATEWAY_TEST_APPDATA'] = Join-Path $Root 'isolated-appdata'
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

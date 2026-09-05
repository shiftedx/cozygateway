$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$temp = Join-Path ([IO.Path]::GetTempPath()) ('cozygateway-path-isolation-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $fixture = Join-Path $temp 'isolated-installer.ps1'
    [IO.File]::WriteAllText($fixture, @'
if (-not $env:COZYGATEWAY_TEST_USER_PATH_LOG) { Write-Output 'missing isolated PATH log'; exit 81 }
if (-not $env:COZYGATEWAY_TEST_USER_PATH) { Write-Output 'missing simulated user PATH'; exit 82 }
[IO.File]::WriteAllText($env:COZYGATEWAY_TEST_USER_PATH_LOG, $env:COZYGATEWAY_TEST_USER_PATH)
$env:PATH = 'child-process-only'
if ($env:COZYGATEWAY_TEST_PATH_FAILURE -eq '1') { exit 9 }
exit 0
'@)
    foreach ($suite in @('windows-bootstrap.test.ps1', 'windows-agents-bootstrap.test.ps1')) {
        # Load only the invocation helper. The suites and production installer are never executed.
        $tokens = $null; $errors = $null
        $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $suite), [ref]$tokens, [ref]$errors)
        $helper = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Bootstrap' }, $true)
        if (-not $helper) { throw "missing invocation helper in $suite" }
        Invoke-Expression $helper.Extent.Text
        foreach ($failure in @('0', '1')) {
            $before = @{}
            foreach ($key in @('PATH', 'COZYGATEWAY_TEST_USER_PATH', 'COZYGATEWAY_TEST_USER_PATH_LOG')) {
                $before[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
            }
            $result = Invoke-Bootstrap $fixture @{ 'COZYGATEWAY_TEST_PATH_FAILURE' = $failure }
            $expected = if ($failure -eq '1') { 9 } else { 0 }
            if ($result.ExitCode -ne $expected) { throw "$suite isolation failed: $($result.Output)" }
            $log = Join-Path $temp 'isolated-user-path.txt'
            if (-not (Test-Path -LiteralPath $log)) { throw "$suite must capture default PATH writes in a fixture file" }
            foreach ($key in $before.Keys) {
                if ([Environment]::GetEnvironmentVariable($key, 'Process') -cne $before[$key]) { throw "$suite leaked process variable $key after exit $expected" }
            }
        }
        $explicitLog = Join-Path $temp 'explicit-user-path.txt'
        $result = Invoke-Bootstrap $fixture @{
            'COZYGATEWAY_TEST_USER_PATH' = 'C:\Simulated Existing Tools'
            'COZYGATEWAY_TEST_USER_PATH_LOG' = $explicitLog
        }
        if ($result.ExitCode -ne 0 -or [IO.File]::ReadAllText($explicitLog) -cne 'C:\Simulated Existing Tools') { throw "$suite must retain explicit fixture overrides" }
    }
    Write-Host 'windows bootstrap PATH isolation tests passed'
} finally {
    $resolved = [IO.Path]::GetFullPath($temp)
    $allowed = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\cozygateway-path-isolation-'
    if ($resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}

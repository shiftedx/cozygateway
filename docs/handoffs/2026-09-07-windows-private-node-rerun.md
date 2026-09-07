# Windows private Node installer failure: narrow rerun

The integrated Windows run failed at private Node staging and then tried to invoke a missing `node/node.exe`. The fixture captured the installer's original output without printing it. We need that original error before changing installer behavior.

## Candidate and scope

- Published v0.2.14 source: `da8027c6f56120ae9cef32a78ca0d023218bc07d` (earlier native installer lane passed).
- Failed integration candidate: `8dcd6a3c9d87d8504f7751f8475d7cbc2787504e`; merged [Agents #173](https://github.com/shiftedx/cozyagents/pull/173) is `388764e31d56fd1bbe069cf5ac1c0929a311e255`.
- Diagnostic-only followup: `7dddd5efdccae52be68b0f0383f073b50c254e0d`, based on that merged main. It prints the failed child output and asserts executable existence before invoking it. Only `tests/windows/install.test.ps1` changed.
- Combined v0.2.15 candidate: `a3f16493dea098aa6438ce73306a319c0e06ecf7` on the pushed `codex/cozyagents-v0.2.15-release` branch. This includes the diagnostic fix, version preparation, and directory-alias updater entrypoint fix. Fetch this exact candidate or record the merge SHA if using main; do not identify old hashes as new release bytes.

The installer, installer fixture before this diagnostic change, and Windows suite launcher are unchanged between v0.2.14 and #173. The private Node fixture uses a fake product bundle, so it does not exercise the changed updater entrypoint. The new failure remains unqualified; it is not a billing failure.

Use an isolated Windows checkout containing the diagnostic change. Do not change the real installation, services, tasks, credentials, model configuration, or machine PATH. Do not run model tests, benchmarks, the full Windows suite, or production installation. This packet runs only the one existing private Node fixture.

## Narrow native command

Run this from the isolated CozyAgents checkout in PowerShell 7.6.5 (the reported failing host version). It extracts the existing fixture setup and exactly the private Node case, preserving their source and assertions. No dependencies or real bundle build are required; the fixture uses the already installed Node executable to construct a disposable distribution. The temporary script is under `tests/windows` so its existing `$PSScriptRoot` calculation remains correct.

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repo = (Get-Location).Path
$pwshExe = (Get-Process -Id $PID).Path
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$logRoot = Join-Path $env:TEMP ('cozyagents-private-node-evidence-' + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $logRoot | Out-Null
git rev-parse HEAD | Set-Content (Join-Path $logRoot 'candidate.txt')
@{ PowerShell = $PSVersionTable.PSVersion.ToString(); Node = (& $nodeExe -v); Architecture = $env:PROCESSOR_ARCHITECTURE; Architecture6432 = $env:PROCESSOR_ARCHITEW6432 } | ConvertTo-Json | Set-Content (Join-Path $logRoot 'tools.json')
$source = Get-Content -LiteralPath 'tests/windows/install.test.ps1' -Raw
$setupEnd = $source.IndexOf("Write-Host ''")
$caseStart = $source.IndexOf("Write-Host '== a private Node installs from same-home verified staging =='")
$caseEnd = $source.IndexOf("Write-Host ''", $caseStart)
if ($setupEnd -lt 0 -or $caseStart -lt 0 -or $caseEnd -le $caseStart) { throw 'fixture anchors changed; inspect source before proceeding' }
$finish = @'
    if ($script:Failures -gt 0) { exit 1 }
} finally {
    $script:TempRoots | ForEach-Object { Remove-Item -LiteralPath $_ -Recurse -Force -ErrorAction SilentlyContinue }
}
'@
$body = $source.Substring(0, $setupEnd) + "`ntry {`n" + '$assets = New-AssetDirectory' + "`n" + $source.Substring($caseStart, $caseEnd - $caseStart) + $finish
$fixture = Join-Path $repo ('tests/windows/private-node-rerun-' + [guid]::NewGuid().ToString('n') + '.local.ps1')
[IO.File]::WriteAllText($fixture, $body)
try {
    & $pwshExe -NoProfile -File $fixture *> (Join-Path $logRoot 'private-node.log')
    $result = $LASTEXITCODE
    @{ ExitCode = $result; FinishedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content (Join-Path $logRoot 'result.json')
    Get-Content (Join-Path $logRoot 'private-node.log')
    Write-Host "Evidence: $logRoot; exit=$result"
} finally {
    Remove-Item -LiteralPath $fixture -Force -ErrorAction SilentlyContinue
}
```

The private Node case itself sets a disposable home, local checksum-verified Node archive, empty `COZYAGENTS_NODE`, and child-process PATH `C:\Windows\system32`, then invokes the real installer with `-NoPair` and a fake product bundle. No real pairing code is supplied. Do not print the parent environment, tokens, or configuration files. Redact personal paths before sharing logs if needed.

## Return evidence

Return candidate SHA, tool versions, exit code, and the complete private case log, especially the original installer `FAIL` sentence now printed from `$privateNodeResult.Output`. Preserve the prior `<logs>/integration/native-windows.*` evidence too. Do not infer a cause from the later missing-executable error alone.

If this isolated case passes, rerun it once under the failing integration invocation's exact process-local environment and compare only nonsecret installer control variables and Node/PATH resolution. Do not expand to the full suite without identifying why isolation changes the result. If it fails, propose the smallest product or fixture correction supported by that original error, then repeat this exact case. No timeout increases or skipped assertions.

Current local validation of the diagnostic change: PowerShell parser passed; a portable missing-executable simulation prints the original error, records both failed assertions, and does not invoke the absent binary. This is diagnostic validation, not Windows installer acceptance.

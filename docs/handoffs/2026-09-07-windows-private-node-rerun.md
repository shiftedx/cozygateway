# Windows v0.2.15 candidate: focused delta verification

The original unknown private Node failure is resolved by [Gateway #421](https://github.com/shiftedx/cozygateway/pull/421), merged as `c24ff91b1443d5c79baa4067448d350262dc2da2`. A deeper fixture temp prefix produced a 267-character staged executable path that native process launch rejected; ZIP extraction was successful. The same code passed with a 255-character path and the original shorter temp prefix. The full native suite at `8dcd6a3c9d87d8504f7751f8475d7cbc2787504e` passed at 2026-09-07T22:52:08Z: exit 0, 130 checks (entrypoint, bundle, 109 installer, 19 lifecycle).

Do not repeat that diagnosis or the full suite. The remaining request is focused verification of the subsequently merged v0.2.15 candidate, especially its new Windows junction entrypoint regression.

## Candidate and scope

- Published v0.2.14 source: `da8027c6f56120ae9cef32a78ca0d023218bc07d` (earlier native installer lane passed).
- Failed integration candidate: `8dcd6a3c9d87d8504f7751f8475d7cbc2787504e`; merged [Agents #173](https://github.com/shiftedx/cozyagents/pull/173) is `388764e31d56fd1bbe069cf5ac1c0929a311e255`.
- Diagnostic-only followup: `7dddd5efdccae52be68b0f0383f073b50c254e0d`, based on that merged main. It prints the failed child output and asserts executable existence before invoking it. Only `tests/windows/install.test.ps1` changed.
- Current merged v0.2.15 candidate: `1ab29c7cb65764f2a53068cf1f80296f252c4c4c`, [Agents #174](https://github.com/shiftedx/cozyagents/pull/174); reviewed branch head was `a3f16493dea098aa6438ce73306a319c0e06ecf7`. It includes the diagnostic fix, version preparation, and directory-alias updater entrypoint fix. Verify this exact merge SHA or record the newer coordinated candidate; do not identify old hashes as new release bytes.

The installer, installer fixture before the diagnostic change, and Windows suite launcher are unchanged between v0.2.14 and #173. The private Node fixture uses a fake product bundle, so it does not exercise the changed updater entrypoint. The path limitation persists in product staging: custom `COZYAGENTS_HOME` / `-InstallHome` paths can create the same long executable path. No product fix or general long-path acceptance is claimed. The observed 267/255 values are measurements on that host, not a universal supported-length boundary. Startup fallback, real session transitions, and paired Gateway acceptance remain unqualified.

Use an isolated Windows checkout at the candidate with its lockfile dependencies already installed (run `npm ci` there only if needed). Do not change the real installation, services, tasks, credentials, model configuration, or machine PATH. Do not run model tests, benchmarks, the full Windows suite, or production installation. Run the existing native bundle check once; it builds with GNU tar and runs the standalone CLI/update-worker checks through both real and junction paths. The optional private Node replay below runs just that one fixture if exact-candidate diagnostic coverage is still desired.

## Narrow native command

Run the bundle delta from the isolated checkout in PowerShell 7.6.5, using a short disposable temp prefix for this process only. Capture the candidate SHA, command exit code, stdout/stderr, and SHA-256 of both resulting `.mjs` bundles. The native bundle check already runs `scripts/test/bundle-entrypoints.mjs`; do not repeat it separately.

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$scratch = Join-Path (Join-Path $env:LOCALAPPDATA 'Temp') ('ca-' + [guid]::NewGuid().ToString('n').Substring(0,8))
New-Item -ItemType Directory -Path $scratch | Out-Null
$oldTemp = $env:TEMP; $oldTmp = $env:TMP; $oldTmpDir = $env:TMPDIR
try {
    $env:TEMP = $scratch; $env:TMP = $scratch; $env:TMPDIR = $scratch
    git rev-parse HEAD
    & (Get-Process -Id $PID).Path -NoProfile -File tests/windows/bundle.test.ps1
    if ($LASTEXITCODE -ne 0) { throw 'candidate Windows bundle delta failed' }
    Get-FileHash dist-bundle/cozyagents.mjs, dist-bundle/cozyagents-update.mjs -Algorithm SHA256
} finally {
    $env:TEMP = $oldTemp; $env:TMP = $oldTmp; $env:TMPDIR = $oldTmpDir
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
```

Optional private Node diagnostic replay: this extracts the existing setup and exactly the private Node case. No real product bundle is used. The temporary script stays under `tests/windows` so its existing `$PSScriptRoot` calculation remains correct. Keep evidence outside the short disposable fixture temp root.

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
$scratch = Join-Path (Join-Path $env:LOCALAPPDATA 'Temp') ('ca-' + [guid]::NewGuid().ToString('n').Substring(0,8))
New-Item -ItemType Directory -Path $scratch | Out-Null
$oldTemp = $env:TEMP; $oldTmp = $env:TMP; $oldTmpDir = $env:TMPDIR
try {
    $env:TEMP = $scratch; $env:TMP = $scratch; $env:TMPDIR = $scratch
    & $pwshExe -NoProfile -File $fixture *> (Join-Path $logRoot 'private-node.log')
    $result = $LASTEXITCODE
    @{ ExitCode = $result; FinishedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content (Join-Path $logRoot 'result.json')
    Get-Content (Join-Path $logRoot 'private-node.log')
    Write-Host "Evidence: $logRoot; exit=$result"
} finally {
    $env:TEMP = $oldTemp; $env:TMP = $oldTmp; $env:TMPDIR = $oldTmpDir
    Remove-Item -LiteralPath $fixture -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
```

The private Node case itself sets a disposable home, local checksum-verified Node archive, empty `COZYAGENTS_NODE`, and child-process PATH `C:\Windows\system32`, then invokes the real installer with `-NoPair` and a fake product bundle. No real pairing code is supplied. Do not print the parent environment, tokens, or configuration files. Redact personal paths before sharing logs if needed.

## Return evidence

Return exact candidate SHA, tool versions, bundle command exit code/output, both bundle hashes, and whether the junction regression passed. If the optional private case runs, include its exit-code sidecar and log. A failure must retain the original installer `FAIL` sentence now exposed by the diagnostic fix. Preserve prior long-path failure and successful short-path evidence; do not rerun the known failing deep-prefix case merely to reconfirm it.

No broader replay is requested if these focused deltas pass. If a new failure occurs, return its direct evidence before proposing a fix. No timeout increases or skipped assertions. Fresh v0.2.15 release assets and hashes must come from the final reviewed candidate; the passing older candidate hash does not qualify new release bytes.

Current local validation of the diagnostic change: PowerShell parser passed; a portable missing-executable simulation prints the original error, records both failed assertions, and does not invoke the absent binary. This is diagnostic validation, not Windows installer acceptance.

param([string] $Installer = (Join-Path $PSScriptRoot '..\install.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Installer),[ref]$tokens,[ref]$errors)
foreach($name in @('Copy-OrDownload','Test-TransientBootstrapDownloadError','Get-VerifiedAsset','Fail','Write-Ok')) {
    $fn=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true) | Select-Object -First 1
    if($fn) { Invoke-Expression $fn.Extent.Text }
}
function Assert-True([bool]$Value,[string]$Message) { if(-not $Value) {throw "ASSERT: $Message"} }
function Start-Sleep { param($Seconds) $script:delays+=@($Seconds) }
function Invoke-WebRequest {
    param([switch]$UseBasicParsing,$Uri,$OutFile,$TimeoutSec)
    $script:calls++
    [IO.File]::WriteAllText($OutFile,'partial')
    if($script:calls -le $script:failures) {
        if($script:mode -eq 'timeout') {throw [Net.WebException]::new('timeout',[Net.WebExceptionStatus]::Timeout)}
        $e=[Exception]::new('HTTP fixture')
        $e | Add-Member -NotePropertyName Response -NotePropertyValue ([pscustomobject]@{StatusCode=$script:mode})
        throw $e
    }
    [IO.File]::WriteAllText($OutFile,'complete')
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('cozy-download-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$destination=Join-Path $root 'asset'
try {
    foreach($case in @(@('timeout',2,3,$true),@(503,2,3,$true),@(429,1,2,$true),@(408,1,2,$true),@(404,5,1,$false),@(403,5,1,$false),@('timeout',5,3,$false))) {
        $script:mode=$case[0]; $script:failures=$case[1]; $script:calls=0; $script:delays=@()
        [IO.File]::WriteAllText($destination,'previous')
        $succeeded=$true
        try { Copy-OrDownload 'https://example.invalid/asset' $destination } catch {$succeeded=$false}
        Assert-True ($succeeded -eq $case[3]) "outcome for $($case[0])"
        Assert-True ($script:calls -eq $case[2]) "attempt bound for $($case[0])"
        Assert-True ($script:delays.Count -eq ($case[2]-1)) 'only retries may sleep'
        $expected=if($succeeded){'complete'}else{'previous'}
        Assert-True (([IO.File]::ReadAllText($destination)) -eq $expected) 'failed transfers must preserve destination'
        Assert-True (@(Get-ChildItem -LiteralPath $root).Count -eq 1) 'download staging files must be removed'
    }
    $local=Join-Path $root 'local'
    [IO.File]::WriteAllText($local,'local bytes')
    $script:calls=0; $script:delays=@()
    Copy-OrDownload $local $destination
    Assert-True ($script:calls -eq 0) 'local copy must not use network'
    $failed=$false
    try { Copy-OrDownload $local (Join-Path $root 'missing\destination') } catch {$failed=$true}
    Assert-True ($failed -and $script:calls -eq 0 -and $script:delays.Count -eq 0) 'local copy errors must not retry or fall back to network'
    $script:calls=0; $script:failures=0; $script:delays=@()
    $failed=$false
    $failureMessage=''
    try { Get-VerifiedAsset 'asset' (Join-Path $root 'verified') 'https://example.invalid' } catch { $failureMessage=$_.Exception.Message; $failed=$failureMessage -match 'checksum mismatch' }
    Assert-True ($failed -and $script:calls -eq 2 -and $script:delays.Count -eq 0) "checksum mismatch must fail without retrying either completed download (calls=$script:calls; error=$failureMessage)"
    Write-Host 'Windows download retry tests passed'
} finally {
    $resolved=[IO.Path]::GetFullPath($root)
    if(-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)){throw 'unsafe cleanup'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

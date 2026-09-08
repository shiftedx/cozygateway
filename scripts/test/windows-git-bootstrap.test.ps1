$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$tokens = $null
$parseErrors = $null
$installerAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../install.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Installer must parse before private Git tests can load its functions' }
foreach ($helperName in @('Test-TransientBootstrapDownloadError', 'Copy-OrDownload', 'Test-WindowsGitBash', 'Get-WindowsGitRelease', 'Save-WindowsGitAsset', 'Expand-WindowsGitAsset', 'Assert-WindowsGitPath', 'Ensure-WindowsGitBash', 'Resolve-GitBash')) {
    $definition = $installerAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $helperName }, $true)
    if ($null -eq $definition) { throw "Missing Git helper: $helperName" }
    . ([scriptblock]::Create($definition.Extent.Text))
}
$expandNative = ${function:Expand-WindowsGitAsset}
$probeNative = ${function:Test-WindowsGitBash}
$releaseNative = ${function:Get-WindowsGitRelease}
$saveNative = ${function:Save-WindowsGitAsset}
function Assert-Git { param($Condition, [string] $Message) if (-not $Condition) { throw $Message } }
$folder = Join-Path ([IO.Path]::GetTempPath()) ('cozy-git-test-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $folder
$script:Downloads = 0
$script:Extractions = 0
$script:MissingDigest = $false
$script:BadDigest = $false
$script:BadUrl = $false
$script:BadExtraction = $false
$script:ExtractionTimeout = $false
$bytes = [Text.Encoding]::UTF8.GetBytes('fixture archive')
$hasher = [Security.Cryptography.SHA256]::Create()
try { $script:FixtureHash = ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $hasher.Dispose() }
function Get-WindowsGitRelease {
    $digest = 'sha256:' + $script:FixtureHash
    if ($script:MissingDigest) { $digest = $null }
    if ($script:BadDigest) { $digest = 'sha256:' + ('0' * 64) }
    $url = 'https://github.com/git-for-windows/git/releases/download/v9.0.0.windows.1/PortableGit-9.0.0-64-bit.7z.exe'
    if ($script:BadUrl) { $url = 'https://example.org/PortableGit-9.0.0-64-bit.7z.exe' }
    return [pscustomobject]@{ assets = @(
        [pscustomobject]@{ name = 'PortableGit-9.0.0-64-bit.7z.exe'; digest = $digest; browser_download_url = $url },
        [pscustomobject]@{ name = 'PortableGit-9.0.0-arm64.7z.exe'; digest = $digest; browser_download_url = $url.Replace('64-bit', 'arm64') }
    ) }
}
function Save-WindowsGitAsset { param($Uri, $Path) $script:Downloads++; $script:LastDownload = $Uri; [IO.File]::WriteAllBytes($Path, $bytes) }
function Expand-WindowsGitAsset {
    param($Archive, $Destination)
    $script:Extractions++
    if($script:ExtractionTimeout){throw 'Portable Git extraction timed out'}
    $null = New-Item -ItemType Directory -Path (Join-Path $Destination 'bin') -Force
    if (-not $script:BadExtraction) { Set-Content -LiteralPath (Join-Path $Destination 'bin/bash.exe') -Value 'usable' }
}
function Test-WindowsGitBash { param($Path) return ((Test-Path -LiteralPath $Path -PathType Leaf) -and (Get-Content -LiteralPath $Path -Raw).Trim() -eq 'usable') }
try {
    $script:NetworkCalls=0
    $script:NetworkPermanent=$false; $script:NetworkAlwaysFail=$false
    function Start-Sleep {param($Seconds)}
    function Invoke-RestMethod {param([switch]$UseBasicParsing,$Headers,$Uri,$TimeoutSec)
        Assert-Git ($TimeoutSec -gt 0) 'Git release requests must set a timeout'
        $script:NetworkCalls++
        if($script:NetworkPermanent){throw [Net.WebException]::new('permanent',[Net.WebExceptionStatus]::ProtocolError)}
        if($script:NetworkCalls -lt 3 -or $script:NetworkAlwaysFail){throw [Net.WebException]::new('timeout',[Net.WebExceptionStatus]::Timeout)}
        return [pscustomobject]@{tag_name='fixture'}
    }
    $release = & $releaseNative
    Assert-Git ($release.tag_name -eq 'fixture' -and $script:NetworkCalls -eq 3) 'Git metadata must retry transient errors'
    $script:NetworkCalls=0;$script:NetworkAlwaysFail=$true
    $failed=$false;try{& $releaseNative | Out-Null}catch{$failed=$true}
    Assert-Git ($failed -and $script:NetworkCalls -eq 3) 'Git metadata retries must be bounded'
    $script:NetworkCalls=0;$script:NetworkPermanent=$true
    $failed=$false;try{& $releaseNative | Out-Null}catch{$failed=$true}
    Assert-Git ($failed -and $script:NetworkCalls -eq 1) 'Git metadata permanent failure must not retry'
    $script:NetworkCalls=0
    function Invoke-WebRequest {param([switch]$UseBasicParsing,$Uri,$OutFile,$TimeoutSec)
        Assert-Git ($TimeoutSec -gt 0) 'Git download must set a timeout'
        $script:NetworkCalls++
        [IO.File]::WriteAllText($OutFile,'download')
        if($script:NetworkCalls -lt 3){throw [Net.WebException]::new('timeout',[Net.WebExceptionStatus]::Timeout)}
    }
    & $saveNative 'https://example.invalid/archive' (Join-Path $folder 'network-archive')
    Assert-Git ($script:NetworkCalls -eq 3 -and [IO.File]::ReadAllText((Join-Path $folder 'network-archive')) -eq 'download') 'Git downloads must use bounded transient retry'
    Remove-Item Function:Invoke-WebRequest
    Remove-Item Function:Invoke-RestMethod
    Remove-Item Function:Start-Sleep
    $hang=Join-Path $folder 'hang.exe'
    Add-Type -TypeDefinition 'public static class HangingGitProbe { public static void Main() { System.Threading.Thread.Sleep(30000); } }' -Language CSharp -OutputAssembly $hang -OutputType ConsoleApplication
    $timer=[Diagnostics.Stopwatch]::StartNew()
    Assert-Git (-not (& $probeNative $hang -TimeoutSeconds 1)) 'Hanging Bash must fail its bounded probe'
    Assert-Git ($timer.Elapsed.TotalSeconds -lt 5) 'Hanging Bash probe must not wait for the executable to finish'
    Assert-Git (@(Get-CimInstance Win32_Process | Where-Object ExecutablePath -eq $hang).Count -eq 0) 'Timed-out probe process must be stopped'
    $timer.Restart()
    $failed=$false
    try { & $expandNative -Archive $hang -Destination (Join-Path $folder 'timed-extraction') -TimeoutSeconds 1 } catch { $failed=$_.Exception.Message -like '*timed out*' }
    Assert-Git ($failed -and $timer.Elapsed.TotalSeconds -lt 5) 'Git extractor must have a bounded wait'
    Assert-Git (@(Get-CimInstance Win32_Process | Where-Object ExecutablePath -eq $hang).Count -eq 0) 'Timed-out extractor process must be stopped'
    $script:BadDigest = $true
    try { $null = Ensure-WindowsGitBash -InstallHome $folder -Architecture 'AMD64'; throw 'Expected checksum failure' } catch { Assert-Git ($_.Exception.Message -like '*checksum mismatch*') 'Checksum failure must be explicit' }
    Assert-Git ($script:Extractions -eq 0) 'Unverified archive was executed'
    Assert-Git (-not (Test-Path -LiteralPath (Join-Path $folder 'tools/git'))) 'Failed verification published Git'
    $script:BadDigest = $false
    $script:MissingDigest = $true
    $before = $script:Downloads
    try { $null = Ensure-WindowsGitBash -InstallHome $folder -Architecture 'AMD64'; throw 'Expected missing digest failure' } catch { Assert-Git ($_.Exception.Message -like '*SHA-256*') 'Missing digest must fail closed' }
    Assert-Git ($script:Downloads -eq $before) 'Missing digest must fail before downloading'
    $script:MissingDigest = $false
    $script:BadUrl = $true
    try { $null = Ensure-WindowsGitBash -InstallHome $folder -Architecture 'AMD64'; throw 'Expected source failure' } catch { Assert-Git ($_.Exception.Message -like '*official*') 'Unexpected asset origin accepted' }
    $script:BadUrl = $false
    try { $null = Ensure-WindowsGitBash -InstallHome $folder -ExplicitPath (Join-Path $folder 'missing.exe') -Architecture 'AMD64'; throw 'Expected explicit path failure' } catch { Assert-Git ($_.Exception.Message -like '*COZYGATEWAY_GIT_BASH*') 'Invalid explicit choice must not be silently replaced' }
    $script:BadExtraction = $true
    try { $null = Ensure-WindowsGitBash -InstallHome $folder -Architecture 'AMD64'; throw 'Expected unusable extraction failure' } catch { Assert-Git ($_.Exception.Message -like '*usable Bash*') 'Unusable extraction accepted' }
    Assert-Git (-not (Test-Path -LiteralPath (Join-Path $folder 'tools/git'))) 'Unusable extraction published Git'
    $script:BadExtraction = $false
    $bash = Ensure-WindowsGitBash -InstallHome $folder -Architecture 'AMD64'
    Assert-Git ($bash -eq (Join-Path $folder 'tools/git/bin/bash.exe')) 'Git must stay in private tools directory'
    $before = $script:Downloads
    $again = Ensure-WindowsGitBash -InstallHome $folder -Architecture 'AMD64'
    Assert-Git ($again -eq $bash -and $script:Downloads -eq $before) 'Repeat install must reuse usable private Git'
    $script:InstallHome = $folder
    Assert-Git ((Resolve-GitBash '') -eq $bash) 'Resolver must prefer the existing private Git copy'
    Assert-Git ((Resolve-GitBash $bash) -eq $bash) 'Resolver must preserve an explicit usable Git choice'
    $redirectRoot=Join-Path $folder 'redirected-install'
    New-Item -ItemType Directory -Path (Join-Path $redirectRoot 'tools') -Force | Out-Null
    $junction=Join-Path $redirectRoot 'tools\git'
    New-Item -ItemType Junction -Path $junction -Target (Join-Path $folder 'tools\git') | Out-Null
    try {
        $script:InstallHome=$redirectRoot
        foreach($choice in @('',(Join-Path $junction 'bin\bash.exe'))) {
            $failed=$false;try{Resolve-GitBash $choice | Out-Null}catch{$failed=$_.Exception.Message -like '*redirected private Git*'}
            Assert-Git $failed 'Resolver must reject redirected private Git before probing even when explicitly selected'
        }
    } finally { $script:InstallHome=$folder; [IO.Directory]::Delete($junction) }
    Set-Content -LiteralPath $bash -Value 'broken'
    $sentinel=Join-Path (Split-Path (Split-Path $bash)) 'user-file'
    Set-Content -LiteralPath $sentinel -Value 'preserve'
    $script:ExtractionTimeout=$true
    try { $null=Ensure-WindowsGitBash -InstallHome $folder -Architecture 'AMD64'; throw 'Expected extraction timeout' } catch { Assert-Git ($_.Exception.Message -like '*timed out*') 'Extraction timeout must be reported' }
    $script:ExtractionTimeout=$false
    Assert-Git ((Get-Content -LiteralPath $bash -Raw).Trim() -eq 'broken' -and (Get-Content -LiteralPath $sentinel -Raw).Trim() -eq 'preserve') 'Extraction timeout must preserve the old Git tree and user files'
    $script:FailPromotionTarget=Split-Path (Split-Path $bash)
    function Move-Item {
        param($LiteralPath,$Destination)
        if($Destination -eq $script:FailPromotionTarget -and $LiteralPath -like '*\.git-bootstrap-*\git'){throw 'injected promotion failure'}
        Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination
    }
    try { $null=Ensure-WindowsGitBash -InstallHome $folder -Architecture 'AMD64'; throw 'Expected promotion failure' } catch { Assert-Git ($_.Exception.Message -like '*injected promotion failure*') 'Replacement failure must be reported' }
    Remove-Item Function:Move-Item
    Assert-Git ((Get-Content -LiteralPath $bash -Raw).Trim() -eq 'broken' -and (Get-Content -LiteralPath $sentinel -Raw).Trim() -eq 'preserve') 'Failed publication must restore the old tree and user files'
    Set-Content -LiteralPath $bash -Value 'usable'
    try { $null = Resolve-GitBash (Join-Path $folder 'explicit-missing.exe'); throw 'Expected explicit resolver failure' } catch { Assert-Git ($_.Exception.Message -like '*COZYGATEWAY_GIT_BASH*') 'Resolver must not fall back from an invalid explicit choice'
    }
    $null = Ensure-WindowsGitBash -InstallHome (Join-Path $folder 'arm') -Architecture 'ARM64'
    Assert-Git ($script:LastDownload -like '*-arm64.7z.exe') 'ARM64 must use the native ARM64 asset'
    Assert-Git (@(Get-ChildItem -LiteralPath (Join-Path $folder 'tools') -Filter '.git-bootstrap-*').Count -eq 0) 'Staging directories leaked'
    function Start-Process {
        param($FilePath, $ArgumentList, $WindowStyle, [switch] $Wait, [switch] $PassThru)
        Assert-Git ($WindowStyle -eq 'Hidden' -and -not $Wait -and $PassThru) 'Extractor must be hidden and return a handle for bounded waiting'
        $null = New-Item -ItemType Directory -Path (Join-Path (Split-Path $FilePath) 'PortableGit/bin') -Force
        $process=[pscustomobject]@{ ExitCode=0; HasExited=$true }
        $process | Add-Member ScriptMethod WaitForExit {param($Milliseconds) return $true}
        $process | Add-Member ScriptMethod Dispose {$script:ExtractorDisposed=$true}
        return $process
    }
    $extractStage = Join-Path $folder 'native-extract'
    $null = New-Item -ItemType Directory -Path $extractStage
    & $expandNative -Archive (Join-Path $extractStage 'portable-git.exe') -Destination (Join-Path $extractStage 'git')
    Assert-Git (Test-Path -LiteralPath (Join-Path $extractStage 'git/bin') -PathType Container) 'Compiled PortableGit extraction default must remain supported inside staging'
    Assert-Git $script:ExtractorDisposed 'Extractor process handle must be disposed'
    Write-Host 'PASS Windows private Git bootstrap tests'
} finally {
    $resolved = [IO.Path]::GetFullPath($folder)
    if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -like 'cozy-git-test-*') { Remove-Item -LiteralPath $resolved -Recurse -Force }
}

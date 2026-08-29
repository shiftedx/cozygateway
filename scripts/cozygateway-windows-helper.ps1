param([string] $Command)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$ProgressPreference = 'SilentlyContinue'
$script:SchemaVersion = 1
$script:MaxJsonBytes = 65536
$script:MaxDownloadBytes = 268435456
$script:InstallerUrl = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe'
$script:Fixture = $null

[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

# Windows PowerShell 5.1 lacks ProcessStartInfo.ArgumentList and a duplicate-aware JSON parser.
# This small in-memory helper keeps the fixed CLI read bounded and rejects duplicate top-level keys
# before ConvertFrom-Json can silently keep the last value.
function Initialize-HelperTypes {
if ($null -eq ('CozyGatewayBoundedProcess' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

public sealed class CozyGatewayProcessResult {
    public int ExitCode;
    public string Stdout;
    public bool TimedOut;
    public bool ExceededBound;
}

public static class CozyGatewayBoundedProcess {
    private static string ReadBounded(StreamReader reader, int maximum) {
        var value = new StringBuilder();
        var buffer = new char[2048];
        var utf8 = new UTF8Encoding(false, true);
        var bytes = 0;
        while (true) {
            var read = reader.Read(buffer, 0, buffer.Length);
            if (read <= 0) break;
            bytes += utf8.GetByteCount(buffer, 0, read);
            if (bytes > maximum) throw new InvalidDataException("bounded output exceeded");
            value.Append(buffer, 0, read);
        }
        return value.ToString();
    }

    public static CozyGatewayProcessResult Run(string executable, string arguments, int timeoutMs, int maximum) {
        var result = new CozyGatewayProcessResult();
        using (var process = new Process()) {
            process.StartInfo = new ProcessStartInfo {
                FileName = executable,
                Arguments = arguments,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            process.Start();
            var stdout = Task.Factory.StartNew(() => ReadBounded(process.StandardOutput, maximum));
            var stderr = Task.Factory.StartNew(() => ReadBounded(process.StandardError, 8192));
            var watch = Stopwatch.StartNew();
            while (!process.WaitForExit(25)) {
                if (watch.ElapsedMilliseconds > timeoutMs || stdout.IsFaulted || stderr.IsFaulted) {
                    result.TimedOut = watch.ElapsedMilliseconds > timeoutMs;
                    result.ExceededBound = stdout.IsFaulted || stderr.IsFaulted;
                    try { process.Kill(); } catch { }
                    process.WaitForExit();
                    break;
                }
            }
            try { Task.WaitAll(new Task[] { stdout, stderr }, 1000); } catch { result.ExceededBound = true; }
            result.ExitCode = process.HasExited ? process.ExitCode : -1;
            result.Stdout = stdout.Status == TaskStatus.RanToCompletion ? stdout.Result : "";
        }
        return result;
    }
}

public static class CozyGatewayJsonGuard {
    private static void SkipWhitespace(string value, ref int index) {
        while (index < value.Length && Char.IsWhiteSpace(value[index])) index++;
    }

    private static string ReadString(string value, ref int index) {
        if (index >= value.Length || value[index] != '"') throw new FormatException();
        index++;
        var decoded = new StringBuilder();
        while (index < value.Length) {
            var current = value[index++];
            if (current == '"') return decoded.ToString();
            if (current < 0x20) throw new FormatException();
            if (current != '\\') { decoded.Append(current); continue; }
            if (index >= value.Length) throw new FormatException();
            var escaped = value[index++];
            switch (escaped) {
                case '"': decoded.Append('"'); break;
                case '\\': decoded.Append('\\'); break;
                case '/': decoded.Append('/'); break;
                case 'b': decoded.Append('\b'); break;
                case 'f': decoded.Append('\f'); break;
                case 'n': decoded.Append('\n'); break;
                case 'r': decoded.Append('\r'); break;
                case 't': decoded.Append('\t'); break;
                case 'u':
                    if (index + 4 > value.Length) throw new FormatException();
                    decoded.Append((char)Convert.ToInt32(value.Substring(index, 4), 16));
                    index += 4;
                    break;
                default: throw new FormatException();
            }
        }
        throw new FormatException();
    }

    private static void SkipValue(string value, ref int index) {
        SkipWhitespace(value, ref index);
        if (index >= value.Length) throw new FormatException();
        if (value[index] == '"') { ReadString(value, ref index); return; }
        var objectDepth = 0;
        var arrayDepth = 0;
        var inString = false;
        var escaped = false;
        for (; index < value.Length; index++) {
            var current = value[index];
            if (inString) {
                if (escaped) { escaped = false; continue; }
                if (current == '\\') { escaped = true; continue; }
                if (current == '"') inString = false;
                continue;
            }
            if (current == '"') { inString = true; continue; }
            if (current == '{') { objectDepth++; continue; }
            if (current == '[') { arrayDepth++; continue; }
            if (current == '}') {
                if (objectDepth == 0 && arrayDepth == 0) return;
                objectDepth--;
                continue;
            }
            if (current == ']') { arrayDepth--; continue; }
            if (current == ',' && objectDepth == 0 && arrayDepth == 0) return;
        }
        if (inString || objectDepth != 0 || arrayDepth != 0) throw new FormatException();
    }

    public static bool HasDuplicateTopLevelKeys(string value) {
        var index = 0;
        SkipWhitespace(value, ref index);
        if (index >= value.Length || value[index++] != '{') throw new FormatException();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        SkipWhitespace(value, ref index);
        if (index < value.Length && value[index] == '}') return false;
        while (index < value.Length) {
            SkipWhitespace(value, ref index);
            var name = ReadString(value, ref index);
            if (!names.Add(name)) return true;
            SkipWhitespace(value, ref index);
            if (index >= value.Length || value[index++] != ':') throw new FormatException();
            SkipValue(value, ref index);
            SkipWhitespace(value, ref index);
            if (index >= value.Length) throw new FormatException();
            if (value[index] == ',') { index++; continue; }
            if (value[index] == '}') {
                index++;
                SkipWhitespace(value, ref index);
                if (index != value.Length) throw new FormatException();
                return false;
            }
            throw new FormatException();
        }
        throw new FormatException();
    }
}
'@
}
}

function Throw-Reason { param([string]$Reason) throw (New-Object InvalidOperationException($Reason)) }

function Test-Record {
    param($Value)
    return ($null -ne $Value -and ($Value -is [System.Management.Automation.PSCustomObject] -or $Value -is [hashtable] -or $Value -is [System.Collections.Specialized.OrderedDictionary]))
}

function Test-ExactKeys {
    param($Value, [string[]]$Keys)
    if (-not (Test-Record $Value)) { return $false }
    $actual = @($Value.PSObject.Properties | ForEach-Object { [string]$_.Name } | Sort-Object)
    $expected = @($Keys | Sort-Object)
    if ($actual.Count -ne $expected.Count) { return $false }
    for ($index = 0; $index -lt $actual.Count; $index++) { if ($actual[$index] -cne $expected[$index]) { return $false } }
    return $true
}

function Get-FixtureProperty {
    param([string]$Name)
    if ($null -eq $script:Fixture) { return $null }
    $property = $script:Fixture.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Write-TestEvent {
    param([string]$Operation, [string[]]$Arguments = @())
    $eventLog = Get-FixtureProperty 'eventLog'
    if ([string]::IsNullOrWhiteSpace([string]$eventLog)) { return }
    $event = [ordered]@{ operation = $Operation; arguments = @($Arguments) } | ConvertTo-Json -Compress
    [IO.File]::AppendAllText([string]$eventLog, "$event`n", (New-Object Text.UTF8Encoding($false)))
}

function Get-ProgramFilesRoot {
    $fixtureRoot = Get-FixtureProperty 'programFiles'
    $root = if (-not [string]::IsNullOrWhiteSpace([string]$fixtureRoot)) { [string]$fixtureRoot } else { [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles) }
    if ([string]::IsNullOrWhiteSpace($root)) { Throw-Reason 'tailscale_not_installed' }
    return Normalize-FullyQualifiedPath $root
}

function Get-ServiceRecord {
    $fixtureService = Get-FixtureProperty 'service'
    if ($null -ne $fixtureService) { return $fixtureService }
    $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='Tailscale'" -ErrorAction SilentlyContinue
    if ($null -eq $service) { return [pscustomobject]@{ exists = $false } }
    return [pscustomobject]@{ exists = $true; imagePath = [string]$service.PathName; startMode = [string]$service.StartMode; state = [string]$service.State }
}

function Get-ServiceExecutable {
    param([string]$ImagePath)
    if ([string]::IsNullOrWhiteSpace($ImagePath)) { return $null }
    $match = [regex]::Match($ImagePath.Trim(), '^(?:"(?<quoted>[^"]+\.exe)"|(?<plain>[^\s]+\.exe))(?:\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) { return $null }
    $value = if ($match.Groups['quoted'].Success) { $match.Groups['quoted'].Value } else { $match.Groups['plain'].Value }
    try { return [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($value)) } catch { return $null }
}

function Test-Organization {
    param([string]$Subject)
    foreach ($part in [regex]::Split($Subject, '(?<!\\),\s*')) {
        if ($part.Trim() -ceq 'O=Tailscale Inc.') { return $true }
    }
    return $false
}

function Get-SignatureRecord {
    param([string]$Path, $ExplicitFixture)
    if ($null -ne $ExplicitFixture) { return $ExplicitFixture }
    $signatures = Get-FixtureProperty 'signatures'
    if ($null -ne $signatures) {
        $property = $signatures.PSObject.Properties[$Path]
        if ($null -ne $property) { return $property.Value }
        return [pscustomobject]@{ status = 'NotSigned'; organization = '' }
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    return [pscustomobject]@{
        status = [string]$signature.Status
        organization = if ($null -eq $signature.SignerCertificate) { '' } elseif (Test-Organization ([string]$signature.SignerCertificate.Subject)) { 'Tailscale Inc.' } else { '' }
    }
}

function Assert-TailscaleSignature {
    param([string]$Path, [string]$InvalidReason = 'tailscale_signature_invalid', $ExplicitFixture = $null)
    $signature = Get-SignatureRecord $Path $ExplicitFixture
    if ([string]$signature.status -cne 'Valid') { Throw-Reason $InvalidReason }
    if ([string]$signature.organization -cne 'Tailscale Inc.') {
        if ($InvalidReason -eq 'installer_signature_invalid') { Throw-Reason $InvalidReason }
        Throw-Reason 'tailscale_publisher_invalid'
    }
}

function Test-ReparsePath {
    param([string]$Path)
    $cursor = [IO.Path]::GetFullPath($Path)
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $attributes = [IO.File]::GetAttributes($cursor)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $true }
        }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $false
}

function Get-TrustedTailscale {
    $root = Get-ProgramFilesRoot
    $directory = Join-Path $root 'Tailscale'
    $daemon = [IO.Path]::GetFullPath((Join-Path $directory 'tailscaled.exe'))
    $cli = [IO.Path]::GetFullPath((Join-Path $directory 'tailscale.exe'))
    $legacy = [IO.Path]::GetFullPath((Join-Path $directory 'tailscale-ipn.exe'))
    if ((Test-Path -LiteralPath $legacy) -and -not (Test-Path -LiteralPath $cli)) { Throw-Reason 'tailscale_legacy_unsupported' }
    if (-not (Test-Path -LiteralPath $daemon) -or -not (Test-Path -LiteralPath $cli)) { Throw-Reason 'tailscale_not_installed' }
    if ((Test-ReparsePath $directory) -or (Test-ReparsePath $daemon) -or (Test-ReparsePath $cli)) { Throw-Reason 'tailscale_service_mismatch' }
    $service = Get-ServiceRecord
    if ($null -eq $service -or -not [bool]$service.exists) { Throw-Reason 'tailscale_service_mismatch' }
    $serviceExecutable = Get-ServiceExecutable ([string]$service.imagePath)
    if ($null -eq $serviceExecutable -or -not [string]::Equals($serviceExecutable, $daemon, [StringComparison]::OrdinalIgnoreCase)) { Throw-Reason 'tailscale_service_mismatch' }
    if ([string]$service.startMode -eq 'Disabled') { Throw-Reason 'tailscale_prerequisite_disabled' }
    Assert-TailscaleSignature $daemon
    Assert-TailscaleSignature $cli
    return [pscustomobject]@{ cliPath = $cli; daemonPath = $daemon }
}

function Invoke-DiscoverTailscale {
    param($Request)
    $requestKeys = @($Request.PSObject.Properties | ForEach-Object { [string]$_.Name })
    if (-not (Test-Record $Request) -or $requestKeys.Count -ne 0) { Throw-Reason 'invalid_request' }
    try {
        $trusted = Get-TrustedTailscale
        return [ordered]@{ state = 'ready'; cliPath = $trusted.cliPath; daemonPath = $trusted.daemonPath }
    } catch {
        $reason = $_.Exception.Message
        if ($reason -notin @('tailscale_not_installed','tailscale_legacy_unsupported','tailscale_service_mismatch','tailscale_signature_invalid','tailscale_publisher_invalid','tailscale_prerequisite_disabled')) { throw }
        return [ordered]@{ state = 'paused'; reason = $reason }
    }
}

function Invoke-UacProcess {
    param([string]$Path, [string[]]$Arguments, [string]$Operation)
    Write-TestEvent $Operation (@($Path) + @($Arguments))
    $fixtureExit = Get-FixtureProperty 'uacExitCode'
    if ($null -ne $fixtureExit) { return [int]$fixtureExit }
    if ($null -ne $script:Fixture) { Throw-Reason 'internal_error' }
    try {
        $process = if ($Arguments.Count -eq 0) {
            Start-Process -FilePath $Path -Verb RunAs -Wait -PassThru
        } else {
            Start-Process -FilePath $Path -ArgumentList $Arguments -Verb RunAs -Wait -PassThru
        }
        return [int]$process.ExitCode
    } catch {
        $native = $_.Exception.NativeErrorCode
        if ($native -eq 1223 -or (($_.Exception.HResult -band 0xffff) -eq 1223)) { return 1223 }
        throw
    }
}

function Copy-InstallerFixture {
    param([string]$Destination)
    $redirects = @(Get-FixtureProperty 'redirects')
    if ($redirects.Count -gt 3) { Throw-Reason 'download_redirect_rejected' }
    $origin = [Uri]$script:InstallerUrl
    foreach ($redirect in $redirects) {
        $candidate = $null
        if (-not [Uri]::TryCreate([string]$redirect, [UriKind]::Absolute, [ref]$candidate)) { Throw-Reason 'download_redirect_rejected' }
        if ($candidate.Scheme -cne 'https' -or $candidate.Host -cne $origin.Host -or $candidate.Port -ne 443 -or -not [string]::IsNullOrEmpty($candidate.UserInfo) -or -not [string]::IsNullOrEmpty($candidate.Fragment)) { Throw-Reason 'download_redirect_rejected' }
    }
    $length = Get-FixtureProperty 'contentLength'
    if ($null -ne $length -and [long]$length -gt $script:MaxDownloadBytes) { Throw-Reason 'download_too_large' }
    $source = Get-FixtureProperty 'installerSource'
    if ([string]::IsNullOrWhiteSpace([string]$source)) { Throw-Reason 'download_failed' }
    Copy-Item -LiteralPath ([string]$source) -Destination $Destination -Force
    if ((Get-Item -LiteralPath $Destination).Length -gt $script:MaxDownloadBytes) { Throw-Reason 'download_too_large' }
}

function Download-OfficialInstaller {
    param([string]$Destination)
    if ($null -ne $script:Fixture) { Copy-InstallerFixture $Destination; return }
    $current = [Uri]$script:InstallerUrl
    $origin = $current
    for ($redirects = 0; $redirects -le 3; $redirects++) {
        $request = [Net.HttpWebRequest]::CreateHttp($current)
        $request.AllowAutoRedirect = $false
        $request.Timeout = 30000
        $request.ReadWriteTimeout = 30000
        $request.UserAgent = 'cozygateway-windows-helper/1'
        $response = $null
        try {
            $response = [Net.HttpWebResponse]$request.GetResponse()
            if ([int]$response.StatusCode -in @(301,302,303,307,308)) {
                if ($redirects -eq 3) { Throw-Reason 'download_redirect_rejected' }
                $next = New-Object Uri($current, $response.Headers['Location'])
                if ($next.Scheme -cne 'https' -or $next.Host -cne $origin.Host -or $next.Port -ne 443 -or -not [string]::IsNullOrEmpty($next.UserInfo) -or -not [string]::IsNullOrEmpty($next.Fragment)) { Throw-Reason 'download_redirect_rejected' }
                $current = $next
                continue
            }
            if ([int]$response.StatusCode -ne 200) { Throw-Reason 'download_failed' }
            if ($response.ContentLength -gt $script:MaxDownloadBytes) { Throw-Reason 'download_too_large' }
            $inputStream = $response.GetResponseStream()
            $outputStream = New-Object IO.FileStream($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $buffer = New-Object byte[] 65536
                [long]$total = 0
                while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $total += $read
                    if ($total -gt $script:MaxDownloadBytes) { Throw-Reason 'download_too_large' }
                    $outputStream.Write($buffer, 0, $read)
                }
                $outputStream.Flush($true)
            } finally { $outputStream.Dispose(); $inputStream.Dispose() }
            return
        } finally { if ($null -ne $response) { $response.Dispose() } }
    }
}

function Invoke-InstallTailscale {
    param($Request)
    $requestKeys = @($Request.PSObject.Properties | ForEach-Object { [string]$_.Name })
    if (-not (Test-Record $Request) -or $requestKeys.Count -ne 0) { Throw-Reason 'invalid_request' }
    Write-TestEvent 'download' @($script:InstallerUrl)
    $tempDirectory = Join-Path ([IO.Path]::GetTempPath()) ("cozygateway-tailscale-" + [guid]::NewGuid().ToString('N'))
    $installer = Join-Path $tempDirectory 'tailscale-setup.exe'
    try {
        New-Item -ItemType Directory -Path $tempDirectory | Out-Null
        if ($null -eq $script:Fixture) { Set-PrivateAcl $tempDirectory }
        try { Download-OfficialInstaller $installer } catch {
            if ($_.Exception.Message -in @('download_redirect_rejected','download_too_large','download_failed')) { throw }
            Throw-Reason 'download_failed'
        }
        $installerSignature = Get-FixtureProperty 'installerSignature'
        Assert-TailscaleSignature $installer 'installer_signature_invalid' $installerSignature
        $exitCode = Invoke-UacProcess $installer @() 'installer-uac'
        if ($exitCode -eq 1223) { Throw-Reason 'installer_cancelled' }
        if ($exitCode -in @(1641,3010)) { Throw-Reason 'installer_reboot_required' }
        if ($exitCode -ne 0) { Throw-Reason 'installer_failed' }
        return [ordered]@{ applied = $true }
    } finally { Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue }
}

function Invoke-CliGet {
    param([string]$CliPath, [string]$Preference)
    Write-TestEvent 'cli' @($CliPath, 'get', '--json', $Preference)
    $fixtureGet = Get-FixtureProperty 'cliGet'
    if ($null -ne $fixtureGet) { return $fixtureGet }
    $run = [CozyGatewayBoundedProcess]::Run($CliPath, "get --json $Preference", 15000, $script:MaxJsonBytes)
    if ($run.TimedOut -or $run.ExceededBound -or $run.ExitCode -ne 0) { Throw-Reason 'preference_verification_failed' }
    $output = $run.Stdout
    try { return $output | ConvertFrom-Json } catch { Throw-Reason 'preference_verification_failed' }
}

function Invoke-SetPreference {
    param($Request)
    if (-not (Test-ExactKeys $Request @('preference','enabled')) -or $Request.preference -notin @('unattended','shields-up') -or $Request.enabled -isnot [bool]) { Throw-Reason 'invalid_request' }
    $trusted = Get-TrustedTailscale
    $flag = if ($Request.preference -eq 'unattended') { '--unattended=' } else { '--shields-up=' }
    $flag += if ([bool]$Request.enabled) { 'true' } else { 'false' }
    $exitCode = Invoke-UacProcess $trusted.cliPath @('set', $flag) 'cli'
    if ($exitCode -eq 1223) { Throw-Reason 'preference_cancelled' }
    if ($exitCode -ne 0) { Throw-Reason 'preference_failed' }
    $get = Invoke-CliGet $trusted.cliPath ([string]$Request.preference)
    $propertyName = if ($Request.preference -eq 'unattended') { 'unattended' } else { 'shieldsUp' }
    $verified = if ($get -is [bool]) { [bool]$get } else {
        $property = $get.PSObject.Properties[$propertyName]
        if ($null -eq $property -or $property.Value -isnot [bool]) { Throw-Reason 'preference_verification_failed' }
        [bool]$property.Value
    }
    if ($verified -ne [bool]$Request.enabled) { Throw-Reason 'preference_verification_failed' }
    return [ordered]@{ applied = $true }
}

function Invoke-OpenBrowser {
    param($Request)
    if (-not (Test-ExactKeys $Request @('purpose','url')) -or $Request.purpose -notin @('login','https-consent') -or $Request.url -isnot [string]) { Throw-Reason 'invalid_request' }
    $uri = $null
    if (-not [Uri]::TryCreate([string]$Request.url, [UriKind]::Absolute, [ref]$uri)) { Throw-Reason 'browser_url_rejected' }
    $hosts = if ($Request.purpose -eq 'login') { @('login.tailscale.com') } else { @('login.tailscale.com','console.tailscale.com') }
    if ($uri.Scheme -cne 'https' -or $uri.Port -ne 443 -or $uri.Host -cnotin $hosts -or -not [string]::IsNullOrEmpty($uri.UserInfo) -or -not [string]::IsNullOrEmpty($uri.Fragment)) { Throw-Reason 'browser_url_rejected' }
    Write-TestEvent 'browser' @([string]$Request.purpose)
    if ($null -eq $script:Fixture) {
        try { Start-Process -FilePath ([string]$Request.url) | Out-Null } catch { Throw-Reason 'browser_open_failed' }
    }
    return [ordered]@{ applied = $true }
}

function Resolve-ContainedPath {
    param([string]$Root, [string]$Path)
    if ([string]::IsNullOrWhiteSpace($Root) -or [string]::IsNullOrWhiteSpace($Path) -or -not (Test-FullyQualifiedWindowsPath $Root) -or -not (Test-FullyQualifiedWindowsPath $Path)) { Throw-Reason 'path_rejected' }
    $rootFull = Normalize-FullyQualifiedPath $Root
    $pathFull = Normalize-FullyQualifiedPath $Path
    $rootPrefix = if ($rootFull.EndsWith('\')) { $rootFull } else { $rootFull + '\' }
    if ($pathFull -ne $rootFull -and -not $pathFull.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { Throw-Reason 'path_rejected' }
    if ((Test-ReparsePath $rootFull) -or (Test-ReparsePath $pathFull)) { Throw-Reason 'path_reparse_point' }
    return $pathFull
}

function Test-FullyQualifiedWindowsPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    return ($Path -match '^[A-Za-z]:\\' -or $Path -match '^\\\\[^\\]+\\[^\\]+(?:\\|$)')
}

function Normalize-FullyQualifiedPath {
    param([string]$Path)
    $full = [IO.Path]::GetFullPath($Path)
    $volumeRoot = [IO.Path]::GetPathRoot($full)
    if ([string]::Equals($full.TrimEnd('\'), $volumeRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { return $volumeRoot.TrimEnd('\') + '\' }
    return $full.TrimEnd('\')
}

function Set-PrivateAcl {
    param([string]$Path)
    if ([bool](Get-FixtureProperty 'skipAcl')) { Write-TestEvent 'protect-acl' @($Path); return }
    try {
        $item = Get-Item -LiteralPath $Path
        $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $existing = Get-Acl -LiteralPath $Path
        $existingRules = @($existing.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
        $expectedIdentities = @($current.Value, 'S-1-5-18') | Sort-Object
        $actualIdentities = @($existingRules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object)
        $alreadyPrivate = $existing.AreAccessRulesProtected -and
            (($actualIdentities -join ',') -eq ($expectedIdentities -join ',')) -and
            (@($existingRules | Where-Object {
                $_.IsInherited -or $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
                (($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)
            }).Count -eq 0)
        if ($alreadyPrivate) { return }
        $acl = if ($item.PSIsContainer) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
        $acl.SetAccessRuleProtection($true, $false)
        $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
        $rights = [Security.AccessControl.FileSystemRights]::FullControl
        $type = [Security.AccessControl.AccessControlType]::Allow
        if ($item.PSIsContainer) {
            $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
            $propagation = [Security.AccessControl.PropagationFlags]::None
            $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($current, $rights, $inheritance, $propagation, $type)))
            $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, $rights, $inheritance, $propagation, $type)))
        } else {
            $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($current, $rights, $type)))
            $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, $rights, $type)))
        }
        $acl.SetOwner($current)
        Set-Acl -LiteralPath $Path -AclObject $acl
    } catch { Throw-Reason 'acl_failed' }
}

function Test-UnsafeInstallRootAcl {
    param([string]$Path)
    if ([bool](Get-FixtureProperty 'unsafeInstallRoot')) { return $true }
    try {
        $acl = Get-Acl -LiteralPath $Path
        $current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $allowed = @($current, 'S-1-5-18', 'S-1-5-32-544')
        $writeRights = [Security.AccessControl.FileSystemRights]::WriteData -bor
            [Security.AccessControl.FileSystemRights]::CreateFiles -bor
            [Security.AccessControl.FileSystemRights]::CreateDirectories -bor
            [Security.AccessControl.FileSystemRights]::AppendData -bor
            [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
            [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
            [Security.AccessControl.FileSystemRights]::Delete -bor
            [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
            [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
            [Security.AccessControl.FileSystemRights]::TakeOwnership
        foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                (($rule.FileSystemRights -band $writeRights) -ne 0) -and
                $rule.IdentityReference.Value -notin $allowed) { return $true }
        }
        return $false
    } catch { Throw-Reason 'acl_failed' }
}

function Invoke-PrepareInstallRoot {
    param($Request)
    if (-not (Test-ExactKeys $Request @('root')) -or $Request.root -isnot [string] -or
        -not (Test-FullyQualifiedWindowsPath ([string]$Request.root))) { Throw-Reason 'invalid_request' }
    $root = Normalize-FullyQualifiedPath ([string]$Request.root)
    $volumeRoot = [IO.Path]::GetPathRoot($root)
    if ([string]::Equals($root.TrimEnd('\'), $volumeRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { Throw-Reason 'path_rejected' }
    if (Test-ReparsePath $root) { Throw-Reason 'path_reparse_point' }
    $bin = Join-Path $root 'bin'
    $runtime = Join-Path $root 'runtime'
    foreach ($existing in @($root, $bin, $runtime)) {
        if ((Test-Path -LiteralPath $existing) -and (Test-UnsafeInstallRootAcl $existing)) { Throw-Reason 'unsafe_install_root' }
    }
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { New-Item -ItemType Directory -Path $root | Out-Null }
    Set-PrivateAcl $root
    if (-not (Test-Path -LiteralPath $bin -PathType Container)) { New-Item -ItemType Directory -Path $bin | Out-Null }
    Set-PrivateAcl $bin
    if (Test-Path -LiteralPath $runtime -PathType Container) { Set-PrivateAcl $runtime }
    return [ordered]@{ applied = $true }
}

function Invoke-ProtectPath {
    param($Request)
    if (-not (Test-ExactKeys $Request @('root','path')) -or $Request.root -isnot [string] -or $Request.path -isnot [string]) { Throw-Reason 'invalid_request' }
    $path = Resolve-ContainedPath ([string]$Request.root) ([string]$Request.path)
    if (-not (Test-Path -LiteralPath $path)) { Throw-Reason 'path_rejected' }
    Set-PrivateAcl $path
    return [ordered]@{ applied = $true }
}

function Invoke-InitializePending {
    param($Request)
    if (-not (Test-ExactKeys $Request @('root')) -or $Request.root -isnot [string]) { Throw-Reason 'invalid_request' }
    if (-not (Test-FullyQualifiedWindowsPath ([string]$Request.root))) { Throw-Reason 'path_rejected' }
    $root = Normalize-FullyQualifiedPath ([string]$Request.root)
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { Throw-Reason 'path_rejected' }
    if (Test-ReparsePath $root) { Throw-Reason 'path_reparse_point' }
    $local = Resolve-ContainedPath $root (Join-Path $root 'local')
    if (-not (Test-Path -LiteralPath $local)) { New-Item -ItemType Directory -Path $local | Out-Null }
    Set-PrivateAcl $local
    $destination = Resolve-ContainedPath $root (Join-Path $local 'network-onboarding.json')
    if (-not (Test-Path -LiteralPath $destination)) {
        $injectedTemporary = Get-FixtureProperty 'pendingTemporaryPath'
        $temporaryCandidate = if ([string]::IsNullOrWhiteSpace([string]$injectedTemporary)) { "$destination.new-$([guid]::NewGuid().ToString('N'))" } else { [string]$injectedTemporary }
        $temporary = Resolve-ContainedPath $root $temporaryCandidate
        try {
            $updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            $body = [ordered]@{ version = 1; stage = 'pending_choice'; updatedAt = $updatedAt } | ConvertTo-Json -Compress
            $stream = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $bytes = [Text.Encoding]::UTF8.GetBytes($body); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
            if (Test-ReparsePath $temporary) { Throw-Reason 'path_reparse_point' }
            Set-PrivateAcl $temporary
            [IO.File]::Move($temporary, $destination)
            if (Test-ReparsePath $destination) { Throw-Reason 'path_reparse_point' }
            Set-PrivateAcl $destination
        } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
    Set-PrivateAcl $destination
    return [ordered]@{ applied = $true }
}

function Get-RawAdapters {
    $fixtureAdapters = Get-FixtureProperty 'adapters'
    if ($null -ne $fixtureAdapters) { return @($fixtureAdapters) }
    $result = @()
    foreach ($item in @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetAdapter -ErrorAction Stop)) {
        $addresses = @(Get-NetIPAddress -InterfaceIndex $item.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.IPAddress })
        $result += [pscustomobject]@{
            id = [string]$item.InterfaceGuid
            displayName = [string]$item.Name
            ndisMedium = [int]$item.NdisMedium
            physicalMedium = [int]$item.NdisPhysicalMedium
            hardwareInterface = [bool]$item.HardwareInterface
            operationalStatus = [int]$item.InterfaceOperationalStatus
            adminStatus = [int]$item.InterfaceAdminStatus
            ipv4Addresses = $addresses
        }
    }
    return $result
}

function Invoke-AdapterInventory {
    param($Request)
    $requestKeys = @($Request.PSObject.Properties | ForEach-Object { [string]$_.Name })
    if (-not (Test-Record $Request) -or $requestKeys.Count -ne 0) { Throw-Reason 'invalid_request' }
    try {
        $adapters = @()
        foreach ($raw in @(Get-RawAdapters)) {
            if ([string]::IsNullOrWhiteSpace([string]$raw.id)) { continue }
            $hardware = [bool]$raw.hardwareInterface
            $medium = [int]$raw.ndisMedium
            $physical = [int]$raw.physicalMedium
            $kind = if (-not $hardware) { 'other' } elseif ($medium -eq 16 -or $physical -in @(1,9)) { 'wifi' } elseif ($physical -eq 14 -or ($medium -eq 0 -and $physical -eq 0)) { 'ethernet' } else { 'other' }
            $operational = [int]$raw.operationalStatus
            $admin = [int]$raw.adminStatus
            $status = if ($admin -eq 2) { 'disabled' } elseif ($admin -eq 1 -and $operational -eq 1) { 'up' } elseif ($admin -eq 1 -and $operational -in @(2,5,6,7)) { 'down' } else { 'unknown' }
            $addresses = @($raw.ipv4Addresses | Where-Object { $_ -is [string] -and $_ -match '^\d{1,3}(?:\.\d{1,3}){3}$' } | Select-Object -First 64)
            $adapters += [ordered]@{ id = [string]$raw.id; displayName = [string]$raw.displayName; kind = $kind; hardwareInterface = $hardware; status = $status; ipv4Addresses = $addresses }
            if ($adapters.Count -ge 256) { break }
        }
        return [ordered]@{ schemaVersion = 1; adapters = $adapters }
    } catch { if ($_.Exception.Message -eq 'invalid_request') { throw }; Throw-Reason 'inventory_failed' }
}

function Invoke-InspectNetworkSafety {
    param($Request)
    if (-not (Test-ExactKeys $Request @('adapterId')) -or $Request.adapterId -isnot [string] -or
        [string]::IsNullOrWhiteSpace([string]$Request.adapterId) -or ([string]$Request.adapterId).Length -gt 128) { Throw-Reason 'invalid_request' }
    try {
        $fixtureSafety = Get-FixtureProperty 'networkSafety'
        if ($null -ne $fixtureSafety) {
            $categoryRaw = [string]$fixtureSafety.networkCategory
            $enabled = [bool]$fixtureSafety.firewallEnabled
            $inboundRaw = [string]$fixtureSafety.defaultInboundAction
        } else {
            $adapter = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetAdapter -ErrorAction Stop |
                Where-Object { [string]$_.InterfaceGuid -eq [string]$Request.adapterId } | Select-Object -First 1)
            if ($adapter.Count -ne 1) { Throw-Reason 'network_inspection_failed' }
            $profile = @(Get-NetConnectionProfile -InterfaceIndex $adapter[0].InterfaceIndex -ErrorAction Stop | Select-Object -First 1)
            if ($profile.Count -ne 1) { Throw-Reason 'network_inspection_failed' }
            $categoryRaw = [string]$profile[0].NetworkCategory
            $firewallProfileName = if ($categoryRaw -match '^(?i:domain(?:authenticated)?)$') { 'Domain' } else { $categoryRaw }
            $firewall = @(Get-NetFirewallProfile -PolicyStore ActiveStore -Name $firewallProfileName -ErrorAction Stop | Select-Object -First 1)
            if ($firewall.Count -ne 1) { Throw-Reason 'network_inspection_failed' }
            $enabled = [bool]$firewall[0].Enabled
            $inboundRaw = [string]$firewall[0].DefaultInboundAction
        }
        $category = switch -Regex ($categoryRaw) {
            '^(?i:private)$' { 'private'; break }
            '^(?i:public)$' { 'public'; break }
            '^(?i:domain(?:authenticated)?)$' { 'domain'; break }
            default { 'unknown' }
        }
        $inbound = switch -Regex ($inboundRaw) {
            '^(?i:allow)$' { 'allow'; break }
            '^(?i:block)$' { 'block'; break }
            '^(?i:notconfigured)$' { 'not_configured'; break }
            default { 'unknown' }
        }
        return [ordered]@{ networkCategory = $category; firewallEnabled = $enabled; defaultInboundAction = $inbound }
    } catch {
        if ($_.Exception.Message -eq 'network_inspection_failed') { throw }
        Throw-Reason 'network_inspection_failed'
    }
}

function Invoke-FixedHelperCommand {
    param([string]$Name, $Request)
    switch -CaseSensitive ($Name) {
        'discover-tailscale' { return Invoke-DiscoverTailscale $Request }
        'install-tailscale' { return Invoke-InstallTailscale $Request }
        'set-preference' { return Invoke-SetPreference $Request }
        'open-browser' { return Invoke-OpenBrowser $Request }
        'initialize-pending' { return Invoke-InitializePending $Request }
        'protect-path' { return Invoke-ProtectPath $Request }
        'prepare-install-root' { return Invoke-PrepareInstallRoot $Request }
        'adapter-inventory' { return Invoke-AdapterInventory $Request }
        'inspect-network-safety' { return Invoke-InspectNetworkSafety $Request }
        default { Throw-Reason 'invalid_request' }
    }
}

$knownReasons = @(
    'invalid_request','request_too_large','path_rejected','path_reparse_point','acl_failed','unsafe_install_root',
    'tailscale_not_installed','tailscale_legacy_unsupported','tailscale_service_mismatch','tailscale_signature_invalid',
    'tailscale_publisher_invalid','tailscale_prerequisite_disabled','download_failed','download_redirect_rejected',
    'download_too_large','installer_signature_invalid','installer_cancelled','installer_reboot_required','installer_failed','preference_failed','preference_cancelled',
    'preference_verification_failed','browser_url_rejected','browser_open_failed','inventory_failed','network_inspection_failed','internal_error'
)

function Invoke-WindowsHelperMain {
    param([string]$Name, $InjectedFixture = $null)
    $script:Fixture = $InjectedFixture
    $fixedCommands = @('discover-tailscale','install-tailscale','set-preference','open-browser','initialize-pending','protect-path','prepare-install-root','adapter-inventory','inspect-network-safety')
    $envelopeCommand = if ($fixedCommands -ccontains $Name) { $Name } else { 'invalid' }
    $ok = $false
    $result = $null
    $reason = 'internal_error'
    try {
        Initialize-HelperTypes
        $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
        $stdinStream = [Console]::OpenStandardInput()
        $inputMemory = New-Object IO.MemoryStream
        $inputBuffer = New-Object byte[] 4096
        [long]$inputBytes = 0
        try {
            while (($inputRead = $stdinStream.Read($inputBuffer, 0, $inputBuffer.Length)) -gt 0) {
                $inputBytes += $inputRead
                if ($inputBytes -gt $script:MaxJsonBytes) { Throw-Reason 'request_too_large' }
                $inputMemory.Write($inputBuffer, 0, $inputRead)
            }
            try { $inputText = $strictUtf8.GetString($inputMemory.ToArray()).TrimStart([char]0xFEFF) } catch { Throw-Reason 'invalid_request' }
        } finally { $inputMemory.Dispose(); $stdinStream.Dispose() }
        if ([string]::IsNullOrWhiteSpace($inputText)) { Throw-Reason 'invalid_request' }
        try {
            if ([CozyGatewayJsonGuard]::HasDuplicateTopLevelKeys($inputText)) { Throw-Reason 'invalid_request' }
            $request = ConvertFrom-Json -InputObject $inputText
        } catch { Throw-Reason 'invalid_request' }
        if ($null -eq $request -or $request -is [string] -or $request -is [array] -or $request -is [ValueType]) { Throw-Reason 'invalid_request' }
        $result = Invoke-FixedHelperCommand $Name $request
        $ok = $true
    } catch {
        $candidate = $_.Exception.Message
        $reason = if ($candidate -in $knownReasons) { $candidate } else { 'internal_error' }
    }

    $envelope = if ($ok) {
        [ordered]@{ schemaVersion = $script:SchemaVersion; ok = $true; command = $envelopeCommand; result = $result }
    } else {
        [ordered]@{ schemaVersion = $script:SchemaVersion; ok = $false; command = $envelopeCommand; reason = $reason }
    }
    $json = $envelope | ConvertTo-Json -Depth 20 -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt $script:MaxJsonBytes) {
        $json = ([ordered]@{ schemaVersion = 1; ok = $false; command = $envelopeCommand; reason = 'internal_error' } | ConvertTo-Json -Compress)
        $ok = $false
    }
    [Console]::Out.Write($json)
    return $(if ($ok) { 0 } else { 1 })
}

if ($MyInvocation.InvocationName -ne '.') {
    $helperExitCode = Invoke-WindowsHelperMain $Command
    exit $helperExitCode
}

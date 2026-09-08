<#
The CozyGateway one-liner for Windows:

  irm https://cozylabs.ai/install.ps1 | iex

It installs one CozyGateway for the person running it, under their own profile and with no
administrator rights, and it offers Hermes Agent, CozyAgents, or both. Adding either harness
preserves the other one on the same gateway. A machine with none is offered CozyAgents first, which installs
the harness through its own native one-liner, pairs this computer as a runner with a code minted
here, and never asks anybody to read a code off a screen.

`irm | iex` runs in the current process, so the execution policy is not consulted and this script
never offers to change it.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [switch] $Repair,
    # Skips the harness question. Adding a harness preserves the other installed harness.
    # Invoke-Expression adds this attribute before binding defaults; its empty initial value is valid.
    [ValidateSet('', 'cozyagents', 'hermes', 'both')]
    [string] $Harness,
    # The CozyAgents Windows installer, as a path or a URL. Defaults to the published one-liner.
    [string] $CozyAgentsInstaller,
    # Required for a custom CozyAgents installer source. The default is pinned below.
    [string] $CozyAgentsInstallerSha256,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $InstallerArguments
)

$script:InstallerBoundParameters = @{} + $PSBoundParameters
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$ProgressPreference = 'SilentlyContinue'
# PowerShell 7.4 turns a non-zero exit from a native command into a terminating error under Stop.
# Every native call here checks $LASTEXITCODE itself and answers with a sentence a person can act
# on. Windows PowerShell 5.1 has no such variable, and assigning it there is harmless.
$PSNativeCommandUseErrorActionPreference = $false

$script:CozyAgentsInstallUrlDefault = 'https://cozylabs.ai/agents.ps1'
$script:CozyAgentsInstallSha256Default = '75cde8d569226a6ee2b5f198392fed9a7adb3ac0aab47c2ed3f5b2c165bb0abc'
$script:PromptAnswers = @{}
$script:PromptIndex = @{}

function Write-Info { param([string] $Message) Write-Host "INFO  $Message" }
function Write-Ok { param([string] $Message) Write-Host "OK    $Message" }
function Fail { param([string] $Message) throw "FAIL  $Message" }

# Windows-only installer session boundary. This file contains functions only and is
# embedded in the published one-liner; no download is needed to relinquish elevation.
# Native contract: the verified desktop parent supplies the child's limited token.
# https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
function Get-CozyInstallerSourceText {
    # Invoke-Expression leaves top-level MyInvocation pointing at its caller. A
    # function defined in this source retains the complete parsed installer AST.
    $node = $MyInvocation.MyCommand.ScriptBlock.Ast
    while ($null -ne $node.Parent) { $node = $node.Parent }
    return $node.Extent.Text
}

function Get-CozySessionNativeSource {
    return @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
namespace CozyGateway {
    public static class DesktopInstallerSession {
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
        struct STARTUPINFO {
            public int cb; public string reserved; public string desktop; public string title;
            public int x, y, xSize, ySize, xChars, yChars, fill, flags;
            public short show, reservedSize; public IntPtr reserved2, input, output, error;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION { public IntPtr process, thread; public uint processId, threadId; }
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
        struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
        [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int needed);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
        static Win32Exception Error(string operation) { int code = Marshal.GetLastWin32Error(); return new Win32Exception(code, operation + " failed (" + code + "): " + new Win32Exception(code).Message); }
        static IntPtr CurrentToken() {
            IntPtr token;
            if (!OpenProcessToken(GetCurrentProcess(), 0x000A, out token)) throw Error("Opening installer token");
            return token;
        }
        static IntPtr Information(IntPtr token, int kind) {
            int needed;
            GetTokenInformation(token, kind, IntPtr.Zero, 0, out needed);
            if (needed <= 0) throw Error("Reading installer token");
            IntPtr data = Marshal.AllocHGlobal(needed);
            if (!GetTokenInformation(token, kind, data, needed, out needed)) { var e = Error("Reading installer token"); Marshal.FreeHGlobal(data); throw e; }
            return data;
        }
        static int Number(IntPtr token, int kind) { IntPtr data = Information(token, kind); try { return Marshal.ReadInt32(data); } finally { Marshal.FreeHGlobal(data); } }
        static string Sid(IntPtr token) { using (var identity = new WindowsIdentity(token)) { return identity.User.Value; } }
        public static bool IsElevated() { IntPtr token = CurrentToken(); try { return Number(token, 20) != 0; } finally { CloseHandle(token); } }
        public static bool HasLinkedLimitedToken() { IntPtr token = CurrentToken(); try { return Number(token, 18) == 2; } finally { CloseHandle(token); } }
        public static string CurrentSid() { IntPtr token = CurrentToken(); try { return Sid(token); } finally { CloseHandle(token); } }
        public static void ValidateChild(string expectedSid) {
            IntPtr token = CurrentToken();
            try {
                using (var identity = new WindowsIdentity(token)) {
                    if (identity.User.Value != expectedSid || Number(token, 20) != 0 || new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                        throw new InvalidOperationException("Windows did not provide the same account's limited token; installation stopped before changing files.");
                }
            } finally { CloseHandle(token); }
        }
        static IntPtr OpenLimitedDesktopParent(IntPtr current) {
            IntPtr window = GetShellWindow();
            if (window == IntPtr.Zero) throw new InvalidOperationException("Windows has no interactive desktop shell for this session. Run setup in a normal PowerShell terminal in your signed-in desktop session.");
            uint pid; GetWindowThreadProcessId(window, out pid);
            // PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_CREATE_PROCESS.
            IntPtr process = OpenProcess(0x1080, false, pid);
            if (process == IntPtr.Zero) throw Error("Checking desktop account");
            IntPtr token = IntPtr.Zero;
            try {
                if (!OpenProcessToken(process, 0x0008, out token)) throw Error("Checking desktop account");
                if (Sid(token) != Sid(current) || Number(token, 12) != Number(current, 12)) throw new InvalidOperationException("This administrator terminal belongs to a different account or session from the desktop. Open PowerShell as the desktop user and run the installer there to preserve that user's configuration.");
                if (Number(token, 8) != 1 || Number(token, 20) != 0) throw new InvalidOperationException("The Windows desktop is itself elevated, so it cannot provide a normal user session. Enable UAC and sign in again, or run setup from a normal user account.");
                return process;
            } catch { CloseHandle(process); throw; }
            finally { if (token != IntPtr.Zero) CloseHandle(token); }
        }
        public static int Launch(string application, string wrapper, string cwd) {
            IntPtr current = CurrentToken(), desktop = IntPtr.Zero, environment = IntPtr.Zero, attributes = IntPtr.Zero, parentValue = IntPtr.Zero;
            bool initialized = false;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            try {
                desktop = OpenLimitedDesktopParent(current);
                var entries = new List<string>();
                foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) entries.Add((string)entry.Key + "=" + (string)entry.Value);
                entries.Sort(StringComparer.OrdinalIgnoreCase);
                environment = Marshal.StringToHGlobalUni(String.Join("\0", entries.ToArray()) + "\0\0");
                string command = "\"" + application + "\" -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"" + wrapper + "\"";
                if (command.Length >= 32767) throw new InvalidOperationException("The Windows installer handoff path exceeds the native command-line limit.");
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                if (size == IntPtr.Zero) throw Error("Sizing desktop launch attributes");
                attributes = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw Error("Initializing desktop launch attributes");
                initialized = true;
                parentValue = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(parentValue, desktop);
                if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020000), parentValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw Error("Selecting the limited desktop parent");
                STARTUPINFOEX startup = new STARTUPINFOEX(); startup.startup.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.startup.title = "CozyGateway setup"; startup.attributes = attributes;
                // EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_CONSOLE.
                // Windows inherits the verified parent's real primary token. A linked
                // identification token cannot be used as a process token without SeTcb.
                if (!CreateProcessW(application, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false, 0x00080410, environment, cwd, ref startup, out process)) throw Error("Launching setup through the limited desktop parent");
                uint wait;
                do { wait = WaitForSingleObject(process.process, 250); } while (wait == 258);
                if (wait != 0) throw Error("Waiting for installer");
                uint exitCode;
                if (!GetExitCodeProcess(process.process, out exitCode)) throw Error("Reading installer result");
                return unchecked((int)exitCode);
            } finally {
                if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
                if (process.process != IntPtr.Zero) CloseHandle(process.process);
                if (initialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (parentValue != IntPtr.Zero) Marshal.FreeHGlobal(parentValue);
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
                if (desktop != IntPtr.Zero) CloseHandle(desktop);
                CloseHandle(current);
            }
        }
    }
}
'@
}

function Initialize-CozySessionNative {
    if (-not ('CozyGateway.DesktopInstallerSession' -as [type])) { Add-Type -TypeDefinition (Get-CozySessionNativeSource) }
}

function New-CozySessionPayload {
    param([hashtable] $BoundParameters, [string[]] $InstallerArguments)
    $parameters = @{}
    foreach ($key in $BoundParameters.Keys) {
        if ($key -eq 'InstallerArguments') { continue }
        $value = $BoundParameters[$key]
        if ($value -is [Management.Automation.SwitchParameter]) { $value = [bool]$value }
        $parameters[$key] = $value
    }
    $remaining = @()
    if ($null -ne $InstallerArguments) { $remaining = @($InstallerArguments) }
    return @{ Parameters = $parameters; Arguments = $remaining }
}

function Get-CozySessionContinuation {
    return @'
$ErrorActionPreference = 'Stop'
try {
    Add-Type -LiteralPath (Join-Path $PSScriptRoot 'native.cs')
    $payload = Import-Clixml -LiteralPath (Join-Path $PSScriptRoot 'parameters.xml')
    [CozyGateway.DesktopInstallerSession]::ValidateChild([string]$payload.ExpectedSid)
    # The native launch starts us in Windows' physical system directory.
    # Restore both PowerShell and native/.NET path resolution before any installer work.
    if (-not (Test-Path -LiteralPath $payload.WorkingDirectory -PathType Container)) { throw 'The original installer working directory is not available to this account.' }
    Set-Location -LiteralPath $payload.WorkingDirectory
    [Environment]::CurrentDirectory = [string]$payload.WorkingDirectory
    $parameters = @{}
    foreach ($key in $payload.Parameters.Keys) { $parameters[$key] = $payload.Parameters[$key] }
    if ($parameters.ContainsKey('Repair')) { $parameters.Repair = [switch][bool]$parameters.Repair }
    $parameters.InstallerArguments = [string[]]$payload.Arguments
    $global:LASTEXITCODE = 0
    & (Join-Path $PSScriptRoot 'installer.ps1') @parameters
    exit $global:LASTEXITCODE
} catch {
    # Preserve only the installer exception, not child output or environment data.
    # Limit UTF-16 length so its UTF-8 representation stays below the 16 KiB reader cap.
    $message = [string]$_.Exception.Message
    if ($message.Length -gt 4096) { $message = $message.Substring(0, 4096) }
    try { [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'failure.txt'), $message, (New-Object Text.UTF8Encoding($false))) } catch { }
    Write-Host ('FAIL  ' + $message) -ForegroundColor Red
    exit 1
}
'@
}

function Get-CozySessionError {
    param([string] $Directory)
    $path = Join-Path $Directory 'failure.txt'
    $stream = $null
    try {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.Attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) { return '' }
        $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ($stream.Length -eq 0 -or $stream.Length -gt 16384) { return '' }
        $bytes = New-Object byte[] ([int]$stream.Length)
        $read = 0
        while ($read -lt $bytes.Length) {
            $count = $stream.Read($bytes, $read, $bytes.Length - $read)
            if ($count -eq 0) { return '' }
            $read += $count
        }
        return (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes).Trim()
    } catch { return '' }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Invoke-CozyInstallerSession {
    param([Parameter(Mandatory = $true)][string] $ScriptText, [hashtable] $BoundParameters = @{}, [string[]] $InstallerArguments = @())
    Initialize-CozySessionNative
    if (-not [CozyGateway.DesktopInstallerSession]::IsElevated()) { return [pscustomobject]@{ HandedOff = $false; ExitCode = 0 } }
    $sid = [CozyGateway.DesktopInstallerSession]::CurrentSid()
    $folder = Join-Path ([IO.Path]::GetTempPath()) ('cozygateway-session-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $folder
    try {
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetAccessRuleProtection($true, $false)
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        $acl.SetOwner($identity)
        $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', $inherit, 'None', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $folder -AclObject $acl
        $encoding = New-Object Text.UTF8Encoding($true)
        [IO.File]::WriteAllText((Join-Path $folder 'installer.ps1'), $ScriptText, $encoding)
        [IO.File]::WriteAllText((Join-Path $folder 'native.cs'), (Get-CozySessionNativeSource), $encoding)
        $payload = New-CozySessionPayload $BoundParameters $InstallerArguments
        $payload.ExpectedSid = $sid
        $cwd = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath('.')
        $payload.WorkingDirectory = $cwd
        $payload | Export-Clixml -LiteralPath (Join-Path $folder 'parameters.xml') -Depth 8
        $wrapper = Get-CozySessionContinuation
        $wrapperPath = Join-Path $folder 'continue.ps1'
        [IO.File]::WriteAllText($wrapperPath, $wrapper, $encoding)
        $application = Join-Path $PSHOME 'powershell.exe'
        if ($PSVersionTable.PSEdition -eq 'Core') { $application = Join-Path $PSHOME 'pwsh.exe' }
        # Resolve relative paths in the child after checking its account/token.
        $launchDirectory = [Environment]::SystemDirectory
        Write-Host 'INFO  Continuing setup as your normal Windows account in a new PowerShell window. Complete any prompts there; this window will wait for the result.'
        try { $exitCode = [CozyGateway.DesktopInstallerSession]::Launch($application, $wrapperPath, $launchDirectory) }
        catch { throw "Windows setup handoff failed (launch directory '$launchDirectory'; original directory '$cwd'): $($_.Exception.Message)" }
        $errorMessage = if ($exitCode -ne 0) { Get-CozySessionError $folder } else { '' }
        return [pscustomobject]@{ HandedOff = $true; ExitCode = $exitCode; ErrorMessage = $errorMessage }
    } finally {
        # Only these known staging files are removed; never recurse through user-controlled links.
        foreach ($name in @('continue.ps1', 'parameters.xml', 'native.cs', 'installer.ps1', 'failure.txt')) {
            Remove-Item -LiteralPath (Join-Path $folder $name) -Force -ErrorAction SilentlyContinue
        }
        try { [IO.Directory]::Delete($folder, $false) } catch { }
    }
}

function Get-CozyLocalAppData {
    # Return the filesystem redirection target when hosted by an MSIX app.
    # GetFullPath/LOCALAPPDATA alone can retain an alias invisible to Task Scheduler.
    if (-not ('CozyGateway.KnownFolders' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace CozyGateway {
    public static class KnownFolders {
        [DllImport("shell32.dll")]
        private static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
        public static string LocalAppData() {
            Guid id = new Guid("F1B32785-6FBA-4FCF-9D55-7B8E7F157091");
            IntPtr path = IntPtr.Zero;
            try {
                const uint ReturnFilterRedirectionTarget = 0x00040000;
                Marshal.ThrowExceptionForHR(SHGetKnownFolderPath(ref id, ReturnFilterRedirectionTarget, IntPtr.Zero, out path));
                return Marshal.PtrToStringUni(path);
            } finally { if (path != IntPtr.Zero) Marshal.FreeCoTaskMem(path); }
        }
    }
}
'@
    }
    $path = [CozyGateway.KnownFolders]::LocalAppData()
    if ([string]::IsNullOrWhiteSpace($path)) { Fail 'Windows could not resolve the physical local application-data directory' }
    return [IO.Path]::GetFullPath($path).TrimEnd('\')
}

function Resolve-InstallHome {
    param([string] $RequestedHome)
    if ([string]::IsNullOrWhiteSpace($RequestedHome)) {
        $RequestedHome = Join-Path (Get-CozyLocalAppData) 'cozygateway'
        $existingHome = Join-Path $env:LOCALAPPDATA 'cozygateway'
        if ((Test-Path -LiteralPath $existingHome) -and -not (Test-Path -LiteralPath $RequestedHome)) {
            $RequestedHome = $existingHome
        }
    }
    $full = [IO.Path]::GetFullPath($RequestedHome)
    $local = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')
    if ($full.TrimEnd('\') -eq $local -or $full.TrimEnd('\') -eq (Get-CozyLocalAppData)) { Fail 'COZYGATEWAY_HOME must name a dedicated directory' }
    return $full.TrimEnd('\')
}

function Get-LatestTag {
    param([string] $Repository)
    $headers = @{ 'User-Agent' = 'cozygateway-windows-installer' }
    $release = Invoke-RestMethod -UseBasicParsing -Headers $headers -Uri "https://api.github.com/repos/$Repository/releases/latest"
    if ([string]::IsNullOrWhiteSpace([string]$release.tag_name)) { Fail "could not resolve latest release for $Repository" }
    return [string]$release.tag_name
}

function Test-TransientBootstrapDownloadError {
    param([Exception] $Exception)
    $current = $Exception
    while ($null -ne $current) {
        $response = $current.PSObject.Properties['Response']
        if ($response -and $null -ne $response.Value) {
            $status = $response.Value.PSObject.Properties['StatusCode']
            if ($status -and $null -ne $status.Value) {
                $code = [int]$status.Value
                return $code -eq 408 -or $code -eq 429 -or ($code -ge 500 -and $code -le 599)
            }
        }
        if ($current -is [Net.WebException]) {
            return $current.Status -in @(
                [Net.WebExceptionStatus]::Timeout, [Net.WebExceptionStatus]::ConnectFailure,
                [Net.WebExceptionStatus]::ConnectionClosed, [Net.WebExceptionStatus]::ReceiveFailure,
                [Net.WebExceptionStatus]::SendFailure, [Net.WebExceptionStatus]::NameResolutionFailure,
                [Net.WebExceptionStatus]::ProxyNameResolutionFailure, [Net.WebExceptionStatus]::KeepAliveFailure
            )
        }
        if ($current -is [TimeoutException] -or $current -is [Net.Sockets.SocketException] -or
            $current.GetType().FullName -eq 'System.Net.Http.HttpRequestException' -or
            $current.GetType().FullName -eq 'System.Threading.Tasks.TaskCanceledException') { return $true }
        $current = $current.InnerException
    }
    return $false
}

function Copy-OrDownload {
    param([string] $Source, [string] $Destination)
    if (Test-Path -LiteralPath $Source) {
        Copy-Item -LiteralPath $Source -Destination $Destination -Force
    } else {
        # Only the unique download staging file belongs to a failed attempt.
        # Preserve an existing destination until a complete transfer succeeds.
        $temporary = "$Destination.download.$([guid]::NewGuid().ToString('N'))"
        try {
            for ($attempt = 1; $attempt -le 3; $attempt++) {
                try {
                    Invoke-WebRequest -UseBasicParsing -Uri $Source -OutFile $temporary -TimeoutSec 60
                    break
                } catch {
                    if ($attempt -eq 3 -or -not (Test-TransientBootstrapDownloadError $_.Exception)) { throw }
                    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction Stop }
                    Start-Sleep -Seconds $attempt
                }
            }
            Move-Item -LiteralPath $temporary -Destination $Destination -Force -ErrorAction Stop
        } finally {
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction Stop }
        }
    }
}

function Resolve-BootstrapReleaseBase {
    param([string] $Base)
    if (-not [string]::IsNullOrWhiteSpace($Base)) { return $Base }
    $repository = if ($env:COZYGATEWAY_INSTALL_REPO) { $env:COZYGATEWAY_INSTALL_REPO } else { 'shiftedx/cozygateway' }
    $releaseTag = $env:COZYGATEWAY_INSTALL_TAG
    if ([string]::IsNullOrWhiteSpace($releaseTag)) { $releaseTag = Get-LatestTag $repository }
    return "https://github.com/$repository/releases/download/$releaseTag"
}

function Get-VerifiedAsset {
    param([string] $Name, [string] $Destination, [string] $BaseUri)
    $localBase = $BaseUri
    if ($BaseUri -match '^file://') {
        try { $localBase = ([Uri]$BaseUri).LocalPath } catch { Fail "invalid local release source: $BaseUri" }
    }
    $source = if (Test-Path -LiteralPath $localBase) { Join-Path $localBase $Name } else { "$($BaseUri.TrimEnd('/'))/$Name" }
    $newPath = "$Destination.new"
    $shaPath = "$Destination.sha256"
    Remove-Item -LiteralPath $newPath -Force -ErrorAction SilentlyContinue
    Copy-OrDownload $source $newPath
    Copy-OrDownload "$source.sha256" $shaPath
    $expected = ((Get-Content -LiteralPath $shaPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $newPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($expected) -or $expected -ne $actual) {
        Remove-Item -LiteralPath $newPath -Force -ErrorAction SilentlyContinue
        Fail "$Name checksum mismatch"
    }
    Move-Item -LiteralPath $newPath -Destination $Destination -Force
    Write-Ok "verified $Name"
}

function Promote-VerifiedAsset {
    param([string] $Name, [string] $Stage, [string] $Destination)
    Move-Item -LiteralPath (Join-Path $Stage $Name) -Destination (Join-Path $Destination $Name) -Force
    Move-Item -LiteralPath (Join-Path $Stage "$Name.sha256") -Destination (Join-Path $Destination "$Name.sha256") -Force
}

function Acquire-BootstrapLock {
    param([string] $InstallRoot)
    $script:BootstrapLockPath = Join-Path $InstallRoot '.bootstrap-lock'
    Assert-BootstrapPathAndParents $script:BootstrapLockPath
    if (Test-Path -LiteralPath $script:BootstrapLockPath -PathType Container) {
        # Old versions used a directory followed by a PID write. An empty
        # directory may belong to an initializing installer; never reclaim it.
        $pidPath = Join-Path $script:BootstrapLockPath 'pid'
        Assert-BootstrapRegularFile $pidPath 'legacy lock owner' -MustExist
        $entries = @(Get-ChildItem -LiteralPath $script:BootstrapLockPath -Force)
        if ($entries.Count -ne 1 -or $entries[0].Name -cne 'pid') { Fail 'another CozyGateway bootstrap may be running; preserve its lock and retry after it finishes' }
        $owner = (Get-Content -LiteralPath $pidPath -Raw).Trim()
        $ownerId = 0
        if (-not [int]::TryParse($owner, [ref]$ownerId) -or $ownerId -le 0 -or $null -ne (Get-Process -Id $ownerId -ErrorAction SilentlyContinue)) { Fail 'another CozyGateway bootstrap may be running; wait for it to finish and rerun' }
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction Stop
        Remove-Item -LiteralPath $script:BootstrapLockPath -Force -ErrorAction Stop
    }
    # Keep the file after releasing it. Unlinking a lock allows separate owners
    # to hold handles to different files. Windows releases this handle on crash.
    Assert-BootstrapRegularFile $script:BootstrapLockPath 'lock'
    try { $script:BootstrapLockHandle = [IO.File]::Open($script:BootstrapLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { Fail 'another CozyGateway bootstrap is running or its lock is unavailable; wait for it to finish and rerun' }
}

function Release-BootstrapLock {
    if (Get-Variable -Name BootstrapLockHandle -Scope Script -ErrorAction SilentlyContinue) {
        if ($null -ne $script:BootstrapLockHandle) { $script:BootstrapLockHandle.Dispose(); $script:BootstrapLockHandle = $null }
    }
}

function Assert-BootstrapPath {
    param([string] $Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Fail "refusing redirected bootstrap path: $Path"
    }
}

function Test-BootstrapWindows {
    return [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
}

# These are the small, durable Gateway runtime contract. They deliberately omit
# databases, logs, sockets, Hermes profiles, and CozyAgents state: a bootstrap
# rollback must restore the Gateway launcher without trying to rewind user data.
function Get-BootstrapRuntimeFiles {
    return @(
        'local/install-state',
        'local/profiles.json',
        'local/cozygateway.config.json',
        'local/gateway.env',
        'local/gateway-supervisor.cjs',
        'local/run-gateway.sh',
        'local/dashboard.env',
        'local/dashboard-port',
        'local/dashboard-owner.ps1',
        'local/dashboard-owner-elevate.ps1',
        'local/run-gateway.vbs',
        'local/cozygateway-task.xml',
        'local/bootstrap-source',
        'bin/cozygateway',
        'bin/cozygateway.cmd'
    )
}

function Test-BootstrapRuntimeFileId {
    param([string] $Id)
    return (Get-BootstrapRuntimeFiles) -ccontains $Id
}

function Assert-BootstrapPathAndParents {
    param([string] $Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { Fail 'bootstrap path is empty' }
    $current = [IO.Path]::GetFullPath($Path)
    while ($true) {
        Assert-BootstrapPath $current
        $parent = [IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrWhiteSpace($parent) -or [string]::Equals($parent, $current, [StringComparison]::OrdinalIgnoreCase)) { return }
        $current = $parent
    }
}

function Assert-BootstrapRegularFile {
    param([string] $Path, [string] $Label, [switch] $MustExist)
    Assert-BootstrapPathAndParents $Path
    if (Test-Path -LiteralPath $Path) {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail "bootstrap $Label is not a regular file" }
        return
    }
    if ($MustExist) { Fail "bootstrap $Label is missing" }
}

function Assert-BootstrapTreeSafe {
    param([string] $Path)
    Assert-BootstrapPathAndParents $Path
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { Fail 'bootstrap snapshot is not a directory' }
    foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop)) {
        Assert-BootstrapPath $child.FullName
        if ($child.PSIsContainer) { Assert-BootstrapTreeSafe $child.FullName }
    }
}

function Assert-BootstrapAssetName {
    param([string] $Name)
    if ([string]::IsNullOrWhiteSpace($Name) -or $Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        Fail 'bootstrap asset name is invalid'
    }
}

function Get-BootstrapAclToken {
    param([string] $Path, [string] $Label)
    if (-not (Test-BootstrapWindows)) { return '-' }
    try {
        $sddl = (Get-Acl -LiteralPath $Path -ErrorAction Stop).Sddl
        if ([string]::IsNullOrWhiteSpace($sddl)) { Fail "could not read bootstrap ACL: $Label" }
        return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sddl))
    } catch {
        Fail "could not read bootstrap ACL: $Label"
    }
}

function Test-BootstrapAclToken {
    param([string] $Token)
    if (-not (Test-BootstrapWindows)) { return $Token -eq '-' }
    if ([string]::IsNullOrWhiteSpace($Token) -or $Token -eq '-') { return $false }
    try {
        $sddl = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Token))
        if ([string]::IsNullOrWhiteSpace($sddl)) { return $false }
        $descriptor = New-Object -TypeName 'System.Security.AccessControl.RawSecurityDescriptor' -ArgumentList $sddl
        return $null -ne $descriptor
    } catch {
        return $false
    }
}

function Restore-BootstrapAcl {
    param([string] $Path, [string] $Token, [string] $Label)
    if (-not (Test-BootstrapWindows)) { return }
    if (-not (Test-BootstrapAclToken $Token)) { Fail "bootstrap ACL snapshot is invalid: $Label" }
    try {
        $sddl = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Token))
        $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
        $acl.SetSecurityDescriptorSddlForm($sddl)
        Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
    } catch {
        Fail "could not restore bootstrap ACL: $Label"
    }
}

function Get-BootstrapTemporaryPath {
    param([string] $Path)
    return "$Path.recover.$PID"
}

function Assert-BootstrapRestoreDestination {
    param([string] $Path, [string] $Label)
    Assert-BootstrapRegularFile $Path $Label
    $temporary = Get-BootstrapTemporaryPath $Path
    Assert-BootstrapPathAndParents $temporary
    if (Test-Path -LiteralPath $temporary) { Fail "bootstrap restore staging file already exists: $Label" }
}

function Copy-BootstrapSnapshotFile {
    param([string] $Source, [string] $Destination, [string] $Label)
    Assert-BootstrapRegularFile $Source "snapshot source $Label" -MustExist
    Assert-BootstrapRegularFile $Destination "snapshot destination $Label"
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Destination))
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop | Out-Null }
    Assert-BootstrapPathAndParents $Destination
    $temporary = "$Destination.snapshot.$PID"
    Assert-BootstrapPathAndParents $temporary
    if (Test-Path -LiteralPath $temporary) { Fail "bootstrap snapshot staging file already exists: $Label" }
    try {
        Copy-Item -LiteralPath $Source -Destination $temporary -Force -ErrorAction Stop
        if (-not (Test-Path -LiteralPath $temporary -PathType Leaf)) { Fail "could not snapshot bootstrap $Label" }
        Move-Item -LiteralPath $temporary -Destination $Destination -Force -ErrorAction Stop
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Assert-BootstrapPath $temporary
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Restore-BootstrapFile {
    param([string] $Path, [string] $Source, [string] $State, [string] $AclToken, [string] $Label)
    Assert-BootstrapRestoreDestination $Path $Label
    if ($State -eq 'absent') {
        if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop }
        return
    }
    if ($State -ne 'present') { Fail "bootstrap restore state is invalid: $Label" }
    Assert-BootstrapRegularFile $Source "snapshot $Label" -MustExist
    if ($AclToken -ne '-' -and -not (Test-BootstrapAclToken $AclToken)) { Fail "bootstrap ACL snapshot is invalid: $Label" }
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop | Out-Null }
    Assert-BootstrapRestoreDestination $Path $Label
    $temporary = Get-BootstrapTemporaryPath $Path
    try {
        Copy-Item -LiteralPath $Source -Destination $temporary -Force -ErrorAction Stop
        if ($AclToken -ne '-') { Restore-BootstrapAcl $temporary $AclToken $Label }
        Move-Item -LiteralPath $temporary -Destination $Path -Force -ErrorAction Stop
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Assert-BootstrapPath $temporary
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Set-BootstrapTransactionState {
    param([string] $InstallRoot, [string] $State)
    if ($State -notin @('prepare=replace-release-assets', 'intent=replace-release-assets', 'commit=installer-succeeded', 'restored=previous-release')) {
        Fail 'bootstrap transaction state is invalid'
    }
    $journal = Join-Path $InstallRoot '.bootstrap-transaction'
    $next = "$journal.next"
    Assert-BootstrapPathAndParents $journal
    Assert-BootstrapPathAndParents $next
    if (Test-Path -LiteralPath $next) { Fail 'bootstrap transaction staging marker already exists' }
    try {
        Set-Content -LiteralPath $next -Value $State -NoNewline -Encoding ascii -ErrorAction Stop
        Move-Item -LiteralPath $next -Destination $journal -Force -ErrorAction Stop
    } finally {
        if (Test-Path -LiteralPath $next) {
            Assert-BootstrapPath $next
            Remove-Item -LiteralPath $next -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-GatewayTaskExec {
    param([string] $TaskXml)
    try { [xml] $document = $TaskXml } catch { return $null }
    $execs = @($document.SelectNodes('//*[local-name()="Actions"]/*[local-name()="Exec"]'))
    if ($execs.Count -ne 1) { return $null }
    $actions = @($document.SelectNodes('//*[local-name()="Actions"]/*'))
    if ($actions.Count -ne 1) { return $null }
    $command = [string]$execs[0].Command
    $arguments = [string]$execs[0].Arguments
    if ([string]::IsNullOrWhiteSpace($command) -or [string]::IsNullOrWhiteSpace($arguments)) { return $null }
    return [pscustomobject]@{ Command = $command; Arguments = $arguments }
}

function Test-BootstrapPathEquals {
    param([string] $Left, [string] $Right)
    return [string]::Equals($Left, $Right, [StringComparison]::OrdinalIgnoreCase)
}

function Test-OwnedGatewayStartupEntry {
    param([string] $InstallRoot, [string] $EntryPath)
    $item = Get-Item -LiteralPath $EntryPath -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -or $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
    try { $content = [IO.File]::ReadAllText($EntryPath) } catch { return $false }
    $content = ($content -replace "`r", '').TrimEnd([char[]]"`n")
    $lines = @($content -split "`n")
    $wrapper = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'local\run-gateway.sh'))
    if ($lines.Count -eq 7 -and $lines[0] -eq 'Set shell = CreateObject("WScript.Shell")' -and
        $lines[2] -eq 'For attempt = 0 To 3' -and $lines[3] -eq '  code = shell.Run(command, 0, True)' -and
        $lines[4] -eq '  If code = 0 Then Exit For' -and $lines[5] -eq '  If attempt < 3 Then WScript.Sleep 60000' -and $lines[6] -eq 'Next') {
        $match = [regex]::Match($lines[1], '^command = """(?<bash>[^"]+)"" ""(?<wrapper>[^"]+)"""$')
        return $match.Success -and -not [string]::IsNullOrWhiteSpace($match.Groups['bash'].Value) -and (Test-BootstrapPathEquals $match.Groups['wrapper'].Value $wrapper)
    }
    if ($lines.Count -eq 3 -and $lines[0] -eq 'Set shell = CreateObject("WScript.Shell")' -and $lines[2] -eq 'shell.Run command, 0, False') {
        $match = [regex]::Match($lines[1], '^command = """(?<bash>[^"]+)"" ""(?<wrapper>[^"]+)"""$')
        return $match.Success -and -not [string]::IsNullOrWhiteSpace($match.Groups['bash'].Value) -and (Test-BootstrapPathEquals $match.Groups['wrapper'].Value $wrapper)
    }
    if ($lines.Count -eq 7 -and $lines[0] -eq 'Set shell = CreateObject("WScript.Shell")' -and
        $lines[2] -eq 'For attempt = 0 To 3' -and $lines[3] -eq '  code = shell.Run(command, 0, True)' -and
        $lines[4] -eq '  If code = 0 Then Exit For' -and $lines[5] -eq '  If attempt < 3 Then WScript.Sleep 60000' -and $lines[6] -eq 'Next') {
        $match = [regex]::Match($lines[1], '^command = "(?<wrapper>[^"]+)"$')
        return $match.Success -and (Test-BootstrapPathEquals $match.Groups['wrapper'].Value $wrapper)
    }
    return $false
}

function Test-OwnedGatewayTask {
    param([string] $InstallRoot, [string] $TaskXml, [string] $LauncherPath = (Join-Path $InstallRoot 'local\run-gateway.vbs'), [string] $StatePath = (Join-Path $InstallRoot 'local\install-state'))
    $exec = Get-GatewayTaskExec $TaskXml
    if ($null -eq $exec) { return $false }
    $matches = [regex]::Matches($exec.Arguments, '"([^"]*)"')
    if ($matches.Count -eq 0 -or (($matches | ForEach-Object { $_.Value }) -join ' ') -ne $exec.Arguments.Trim()) { return $false }
    $values = @($matches | ForEach-Object { $_.Groups[1].Value })
    $trustedWscript = [IO.Path]::Combine([Environment]::SystemDirectory, 'wscript.exe')
    if ([string]::Equals($exec.Command, 'wscript.exe', [StringComparison]::OrdinalIgnoreCase) -or (Test-BootstrapPathEquals $exec.Command $trustedWscript)) {
        return $values.Count -eq 1 -and (Test-BootstrapPathEquals $values[0] ([IO.Path]::GetFullPath((Join-Path $InstallRoot 'local\run-gateway.vbs')))) -and (Test-OwnedGatewayStartupEntry $InstallRoot $LauncherPath)
    }
    $node = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'runtime\node\node.exe'))
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        $recordedNodes = @(Get-Content -LiteralPath $statePath | Where-Object { $_ -like 'node_resolved=*' })
        if ($recordedNodes.Count -gt 1) { return $false }
        if ($recordedNodes.Count -eq 1) {
            $recordedNode = $recordedNodes[0].Substring(14)
            if ($recordedNode -match '^/([A-Za-z])/(.*)$') { $recordedNode = $matches[1] + ':\' + $matches[2].Replace('/', '\') }
            if ($recordedNode -notmatch '^[A-Za-z]:[\\/]') { return $false }
            $node = [IO.Path]::GetFullPath($recordedNode)
        }
    }
    $supervisor = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'local\gateway-supervisor.cjs'))
    if (-not (Test-BootstrapPathEquals $exec.Command $node) -or $values.Count -lt 1 -or -not (Test-BootstrapPathEquals $values[0] $supervisor)) { return $false }
    $required = @{
        '--platform' = 'Windows'
        '--gateway-env' = (Join-Path $InstallRoot 'local\gateway.env')
        '--bundle' = (Join-Path $InstallRoot 'bin\cozygateway.mjs')
        '--config' = (Join-Path $InstallRoot 'local\cozygateway.config.json')
        '--maintenance-socket' = '\\.\pipe\cozygateway-maintenance'
        '--database' = (Join-Path $InstallRoot 'local\cozygateway.sqlite')
    }
    $known = @($required.Keys + @('--maintenance-worker', '--dashboard-env', '--hermes-root', '--hermes', '--hermes-launcher', '--owner-helper', '--dashboard-port', '--dashboard-port-state'))
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $provided = @{}
    for ($index = 1; $index -lt $values.Count; $index += 1) {
        $flag = $values[$index]
        if ($flag -eq '--windows-dashboard-profile') {
            if (-not $seen.Add($flag)) { return $false }
            $provided[$flag] = 'true'
            continue
        }
        if ($known -cnotcontains $flag -or $index + 1 -ge $values.Count -or -not $seen.Add($flag)) { return $false }
        $index += 1
        $provided[$flag] = $values[$index]
    }
    foreach ($flag in $required.Keys) {
        if (-not $provided.ContainsKey($flag) -or -not (Test-BootstrapPathEquals $provided[$flag] $required[$flag])) { return $false }
    }
    if (-not $provided.ContainsKey('--maintenance-worker')) { return $false }
    $workers = @((Join-Path $InstallRoot 'local\maintenance-worker.cjs'), (Join-Path $InstallRoot 'bin\gateway-maintenance-worker.cjs'))
    if ($workers -cnotcontains $provided['--maintenance-worker']) { return $false }
    $dashboardFlags = @('--dashboard-env', '--hermes-root', '--hermes', '--hermes-launcher', '--owner-helper', '--dashboard-port', '--dashboard-port-state', '--windows-dashboard-profile')
    $hasDashboard = @($dashboardFlags | Where-Object { $provided.ContainsKey($_) }).Count -gt 0
    if (-not $hasDashboard) { return $true }
    foreach ($flag in @('--dashboard-env', '--hermes-root', '--hermes', '--hermes-launcher', '--owner-helper', '--dashboard-port', '--windows-dashboard-profile')) {
        if (-not $provided.ContainsKey($flag)) { return $false }
    }
    if (-not (Test-BootstrapPathEquals $provided['--dashboard-env'] (Join-Path $InstallRoot 'local\dashboard.env')) -or
        -not (Test-BootstrapPathEquals $provided['--owner-helper'] (Join-Path $InstallRoot 'local\dashboard-owner.ps1')) -or
        $provided['--hermes-root'] -notmatch '^[A-Za-z]:\\' -or $provided['--hermes'] -notmatch '^[A-Za-z]:\\' -or
        -not (Test-BootstrapPathEquals $provided['--hermes-launcher'] ($provided['--hermes-root'].TrimEnd('\') + '\bin\hermes.exe'))) { return $false }
    $port = 0
    return [int]::TryParse($provided['--dashboard-port'], [ref] $port) -and $port -ge 1 -and $port -le 65535 -and
        (-not $provided.ContainsKey('--dashboard-port-state') -or (Test-BootstrapPathEquals $provided['--dashboard-port-state'] (Join-Path $InstallRoot 'local\dashboard-port')))
}

function Get-GatewayScheduledTaskXml {
    try {
        $taskXml = (& $(if ($env:COZYGATEWAY_TEST_SCHTASKS) { $env:COZYGATEWAY_TEST_SCHTASKS } else { 'schtasks.exe' }) /Query /TN CozyGateway /XML 2>$null | Out-String)
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($taskXml)) { return $taskXml }
    } catch { }
    return $null
}

function Register-GatewayScheduledTask {
    param([string] $TaskXmlPath)
    try {
        & $(if ($env:COZYGATEWAY_TEST_SCHTASKS) { $env:COZYGATEWAY_TEST_SCHTASKS } else { 'schtasks.exe' }) /Create /F /TN CozyGateway /XML $TaskXmlPath | Out-Null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Remove-GatewayScheduledTask {
    try {
        & $(if ($env:COZYGATEWAY_TEST_SCHTASKS) { $env:COZYGATEWAY_TEST_SCHTASKS } else { 'schtasks.exe' }) /Delete /F /TN CozyGateway | Out-Null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Start-GatewayScheduledTask {
    try {
        & $(if ($env:COZYGATEWAY_TEST_SCHTASKS) { $env:COZYGATEWAY_TEST_SCHTASKS } else { 'schtasks.exe' }) /Run /TN CozyGateway | Out-Null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Get-GatewayStartupEntryPath {
    $appData = $env:COZYGATEWAY_TEST_APPDATA
    if ([string]::IsNullOrWhiteSpace($appData)) { $appData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData) }
    if ([string]::IsNullOrWhiteSpace($appData)) { $appData = $env:APPDATA }
    if ([string]::IsNullOrWhiteSpace($appData)) { Fail 'Windows Startup folder is unavailable' }
    return Join-Path $appData 'Microsoft\Windows\Start Menu\Programs\Startup\CozyGateway.vbs'
}

function Start-GatewayStartupEntry {
    param([string] $EntryPath)
    try {
        & wscript.exe $EntryPath | Out-Null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Get-GatewayRegistrationForRecovery {
    param([string] $InstallRoot)
    $taskXml = Get-GatewayScheduledTaskXml
    if (-not [string]::IsNullOrWhiteSpace($taskXml) -and -not (Test-OwnedGatewayTask $InstallRoot $taskXml)) {
        Fail 'existing Gateway Scheduled Task is not owned by this installer'
    }
    $startup = Get-GatewayStartupEntryPath
    Assert-BootstrapRegularFile $startup 'Gateway Startup entry'
    $startupPresent = Test-Path -LiteralPath $startup
    if ($startupPresent -and -not (Test-OwnedGatewayStartupEntry $InstallRoot $startup)) {
        Fail 'existing Gateway Startup entry is not owned by this installer'
    }
    return [pscustomobject]@{ TaskXml = $taskXml; StartupPath = $startup; StartupPresent = $startupPresent }
}

function Restore-GatewayRegistration {
    param(
        [string] $InstallRoot,
        [string] $TaskState,
        [string] $TaskSnapshot,
        [string] $StartupState,
        [string] $StartupSnapshot,
        [string] $StartupAcl
    )
    $current = Get-GatewayRegistrationForRecovery $InstallRoot
    if ($TaskState -eq 'present') {
        Assert-BootstrapRegularFile $TaskSnapshot 'Gateway Scheduled Task snapshot' -MustExist
        $taskXml = Get-Content -LiteralPath $TaskSnapshot -Raw -ErrorAction Stop
        if (-not (Test-OwnedGatewayTask $InstallRoot $taskXml)) { Fail 'Gateway Scheduled Task snapshot is invalid' }
        if (-not (Register-GatewayScheduledTask $TaskSnapshot)) { Fail 'could not restore the previous Gateway Scheduled Task' }
    } elseif ($TaskState -eq 'absent') {
        if (-not [string]::IsNullOrWhiteSpace($current.TaskXml) -and -not (Remove-GatewayScheduledTask)) { Fail 'could not remove the failed Gateway Scheduled Task' }
    } else {
        Fail 'Gateway Scheduled Task snapshot state is invalid'
    }
    if ($StartupState -eq 'present') {
        Assert-BootstrapRegularFile $StartupSnapshot 'Gateway Startup snapshot' -MustExist
        if (-not (Test-OwnedGatewayStartupEntry $InstallRoot $StartupSnapshot)) { Fail 'Gateway Startup snapshot is invalid' }
        Restore-BootstrapFile $current.StartupPath $StartupSnapshot 'present' $StartupAcl 'Gateway Startup entry'
    } elseif ($StartupState -eq 'absent') {
        if ($current.StartupPresent) {
            Assert-BootstrapRegularFile $current.StartupPath 'Gateway Startup entry'
            if (-not (Test-OwnedGatewayStartupEntry $InstallRoot $current.StartupPath)) { Fail 'failed Gateway Startup entry is not owned by this installer' }
            Remove-Item -LiteralPath $current.StartupPath -Force -ErrorAction Stop
        }
    } else {
        Fail 'Gateway Startup snapshot state is invalid'
    }
}

function Get-WindowsGatewayBundleVersion {
    param([string] $BundlePath)
    Assert-BootstrapRegularFile $BundlePath 'Gateway bundle' -MustExist
    $content = [IO.File]::ReadAllText($BundlePath)
    $assignments = [regex]::Matches($content, '\bGATEWAY_VERSION\s*=')
    $version = [regex]::Matches($content, '\b(?:var|let|const)\s+GATEWAY_VERSION\s*=\s*["''](?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)["'']\s*;')
    if ($assignments.Count -ne 1 -or $version.Count -ne 1) { throw 'Could not determine the verified Gateway bundle version.' }
    return $version[0].Groups['version'].Value
}

function Wait-WindowsGatewayReady {
    param([string] $InstallRoot, [ValidateRange(1, 30)][int] $TimeoutSeconds = 30)
    Assert-BootstrapPathAndParents $InstallRoot
    $expected = Get-WindowsGatewayBundleVersion (Join-Path $InstallRoot 'bin\cozygateway.mjs')
    $node = Join-Path $InstallRoot 'runtime\node\node.exe'
    $state = Join-Path $InstallRoot 'local\install-state'
    Assert-BootstrapRegularFile $state 'Gateway runtime identity'
    if (Test-Path -LiteralPath $state -PathType Leaf) {
        $records = @(Get-Content -LiteralPath $state | Where-Object { $_ -match '^node_resolved=' })
        if ($records.Count -gt 1) { throw 'Gateway runtime identity is ambiguous.' }
        if ($records.Count -eq 1) {
            $node = $records[0].Substring('node_resolved='.Length)
            if ($node -match '^/([A-Za-z])/(.*)$') { $node = $Matches[1] + ':\' + $Matches[2].Replace('/', '\') }
        }
    }
    if (-not [IO.Path]::IsPathRooted($node) -or -not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Gateway runtime is unavailable for its readiness check.' }
    Assert-BootstrapRegularFile $node 'Gateway Node runtime' -MustExist
    $config = Join-Path $InstallRoot 'local\cozygateway.config.json'
    Assert-BootstrapRegularFile $config 'Gateway configuration' -MustExist
    $gatewayEnv = Join-Path $InstallRoot 'local\gateway.env'
    Assert-BootstrapRegularFile $gatewayEnv 'Gateway environment'
    $probe = Join-Path $InstallRoot ('local\.gateway-health-' + [guid]::NewGuid().ToString('N') + '.cjs')
    Assert-BootstrapRegularFile $probe 'Gateway readiness staging file'
    if (Test-Path -LiteralPath $probe) { throw 'Gateway readiness staging file already exists.' }
    # Use the installed Node runtime to support the configured TLS certificate
    # without changing this PowerShell process's certificate validation policy.
    $source = @'
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { rootCertificates } = require('node:tls');
const { X509Certificate } = require('node:crypto');
const path = require('node:path');
const { parseEnv } = require('node:util');
const [configPath, expected, seconds] = process.argv.slice(2);
async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  // The service wrapper runs in local/ and the supervisor reads this same file.
  // Do not use the installer shell's transient environment as service settings.
  const envPath = path.join(path.dirname(configPath), 'gateway.env');
  const env = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {};
  if (env.COZYGATEWAY_HOST) config.host = env.COZYGATEWAY_HOST;
  if (env.COZYGATEWAY_PORT) config.port = Number(env.COZYGATEWAY_PORT);
  if (env.COZYGATEWAY_DB_PATH) config.dbPath = env.COZYGATEWAY_DB_PATH;
  if (env.COZY_TLS_CERT_FILE || env.COZY_TLS_KEY_FILE) {
    const certFile = env.COZY_TLS_CERT_FILE || config.tls?.certFile;
    const keyFile = env.COZY_TLS_KEY_FILE || config.tls?.keyFile;
    if (!certFile || !keyFile) throw Error();
    config.tls = { certFile, keyFile };
  }
  const endpoints = config.hermesEndpoints === undefined ? [] : config.hermesEndpoints;
  if (!Array.isArray(endpoints) || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw Error();
  // Match server.ts publicProfileId/profileEntries: one endpoint can own many
  // identities, and durable deleted_bots tombstones suppress stale config entries.
  // Read only the existing DB; never openStorage(), migrate, or create user state.
  const profileIds = new Set();
  for (const endpoint of endpoints) {
    if (!endpoint || !endpoint.profiles || typeof endpoint.profiles !== 'object' || Array.isArray(endpoint.profiles)) throw Error();
    for (const raw of Object.keys(endpoint.profiles)) {
      const name = raw.trim().toLowerCase();
      const id = endpoints.length > 1 ? `${endpoint.id}:${name}` : name;
      if (!name || profileIds.has(id)) throw Error();
      profileIds.add(id);
    }
  }
  if (profileIds.size) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.resolve(path.dirname(configPath), config.dbPath || 'cozygateway.db'), { readOnly: true, timeout: 1000 });
    try {
      // Older rollback releases predate tombstones; an absent table means none.
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deleted_bots'").get()) {
        const deleted = db.prepare('SELECT 1 FROM deleted_bots WHERE bot = ?');
        for (const id of profileIds) if (deleted.get(id) !== undefined) profileIds.delete(id);
      }
    } finally { db.close(); }
  }
  const expectedProfiles = profileIds.size;
  const host = !config.host || config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
  const options = { hostname: host, port: config.port, path: '/health', method: 'GET' };
  if (config.tls !== undefined) {
    const cert = fs.readFileSync(path.resolve(path.dirname(configPath), config.tls.certFile));
    const fingerprint = new X509Certificate(cert).fingerprint256;
    options.ca = [...rootCertificates, cert];
    options.checkServerIdentity = (_host, peer) => new X509Certificate(peer.raw).fingerprint256 === fingerprint ? undefined : Error();
  }
  const deadline = Date.now() + Number(seconds) * 1000;
  async function probe(timeout) {
    return new Promise((resolve, reject) => {
      const req = (config.tls === undefined ? http : https).request(options, res => {
        const chunks = []; let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 65536) req.destroy(Error()); else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(Error());
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Error()); }
        });
      });
      // Absolute timeout, including a peer that keeps sending response bytes.
      const timer = setTimeout(() => req.destroy(Error()), timeout);
      req.on('close', () => clearTimeout(timer));
      req.on('error', reject);
      req.end();
    });
  }
  while (Date.now() < deadline) {
    try {
      const health = await probe(Math.max(1, Math.min(2000, deadline - Date.now())));
      const scope = health.attach && ('hermes' in health.attach ? health.attach.hermes : health.attach);
      if (health.version === expected && (endpoints.length === 0 ||
          (scope && scope.configured === expectedProfiles && scope.online === expectedProfiles && health.attach.deadLetters === 0))) return;
    } catch {}
    if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(300, deadline - Date.now())));
  }
  throw Error();
}
main().then(() => process.exit(0), () => process.exit(1));
'@
    try {
        [IO.File]::WriteAllText($probe, $source, (New-Object Text.UTF8Encoding($false)))
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & $node $probe $config $expected ([string]$TimeoutSeconds) *> $null
        } finally { $ErrorActionPreference = $previousPreference }
        if ($LASTEXITCODE -ne 0) { throw 'Gateway did not become ready on the verified version with its configured Hermes profiles; recovery state was preserved.' }
    } finally {
        if (Test-Path -LiteralPath $probe) { Assert-BootstrapRegularFile $probe 'Gateway readiness staging file'; Remove-Item -LiteralPath $probe -Force }
    }
}

function Split-WindowsRecoveryCommandLine {
    param([string] $CommandLine)
    if (-not ('CozyGateway.RecoveryCommandLine' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace CozyGateway {
  public static class RecoveryCommandLine {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
    public static string[] Split(string command) {
      int count; IntPtr argv = CommandLineToArgvW(command, out count);
      if (argv == IntPtr.Zero) throw new InvalidOperationException("Cannot read process command line");
      try {
        string[] result = new string[count];
        for (int i=0;i<count;i++) result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv,i*IntPtr.Size));
        return result;
      } finally { LocalFree(argv); }
    }
  }
}
'@
    }
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return @() }
    return [CozyGateway.RecoveryCommandLine]::Split($CommandLine)
}

function Test-WindowsRecoveryProcess {
    param($Process, $Descriptor)
    if (-not [string]::Equals([string]$Process.ExecutablePath, $Descriptor.Executable, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $tokens = @(Split-WindowsRecoveryCommandLine ([string]$Process.CommandLine))
    if ($tokens.Count -ne $Descriptor.Arguments.Count + 1) { return $false }
    if (-not [string]::Equals($tokens[0], $Descriptor.Executable, [StringComparison]::OrdinalIgnoreCase) -and
        -not [string]::Equals($tokens[0], [IO.Path]::GetFileName($Descriptor.Executable), [StringComparison]::OrdinalIgnoreCase)) { return $false }
    for ($index = 0; $index -lt $Descriptor.Arguments.Count; $index++) {
        if ($tokens[$index + 1] -cne $Descriptor.Arguments[$index]) { return $false }
    }
    return $true
}

function Invoke-WindowsRecoveryTaskkill {
    param([int] $ProcessId)
    $command = Join-Path ([Environment]::SystemDirectory) 'taskkill.exe'
    if (-not [IO.File]::Exists($command)) { throw 'Trusted Windows process shutdown tool is unavailable.' }
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $PSNativeCommandUseErrorActionPreference = $false
        & $command /PID ([string]$ProcessId) /T /F *> $null
    } finally { $ErrorActionPreference = $previousPreference }
    # A process can exit between validation and taskkill. The caller verifies
    # that the exact registered processes have gone instead of trusting exit code.
}

function Get-WindowsRecoveryOrphanDescriptors {
    param([string] $InstallRoot, [object[]] $Processes, [bool] $HasRegistration)
    $state = Join-Path $InstallRoot 'local\install-state'
    Assert-BootstrapRegularFile $state 'Gateway recovery runtime identity'
    if (-not $HasRegistration -and -not (Test-Path -LiteralPath $state -PathType Leaf)) { return @() }
    $node = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'runtime\node\node.exe'))
    if (Test-Path -LiteralPath $state -PathType Leaf) {
        $records = @(Get-Content -LiteralPath $state | Where-Object { $_ -like 'node_resolved=*' })
        if ($records.Count -gt 1) { throw 'Gateway recovery runtime identity is ambiguous.' }
        if ($records.Count -eq 1) {
            $node = $records[0].Substring(14)
            if ($node -match '^/([A-Za-z])/(.*)$') { $node = $Matches[1] + ':\' + $Matches[2].Replace('/', '\') }
            if ($node -notmatch '^[A-Za-z]:[\\/]') { throw 'Gateway recovery runtime identity is invalid.' }
            $node = [IO.Path]::GetFullPath($node)
        }
    }
    Assert-BootstrapRegularFile $node 'Gateway recovery Node'
    $bundle = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'bin\cozygateway.mjs'))
    if (Test-Path -LiteralPath $state -PathType Leaf) {
        $bundles = @(Get-Content -LiteralPath $state | Where-Object { $_ -like 'bundle_path=*' })
        if ($bundles.Count -gt 1) { throw 'Gateway recovery bundle identity is ambiguous.' }
        if ($bundles.Count -eq 1) {
            $recorded = $bundles[0].Substring(12)
            if ($recorded -match '^/([A-Za-z])/(.*)$') { $recorded = $Matches[1] + ':\' + $Matches[2].Replace('/', '\') }
            if (-not (Test-BootstrapPathEquals $recorded $bundle)) { throw 'Gateway recovery bundle identity does not match this installation.' }
        }
    }
    $config = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'local\cozygateway.config.json'))
    foreach ($path in @($bundle, $config, (Join-Path $InstallRoot 'local\gateway-supervisor.cjs'))) { Assert-BootstrapRegularFile $path 'Gateway recovery runtime file' }
    $result = @()
    # Validate orphan supervisors against precisely the same full runtime
    # contract as an owned Task. This also handles Dashboard argument variants.
    foreach ($process in $Processes) {
        if (-not [string]::Equals([string]$process.ExecutablePath, $node, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $tokens = @(Split-WindowsRecoveryCommandLine ([string]$process.CommandLine))
        if ($tokens.Count -lt 2) { continue }
        $arguments = @($tokens | Select-Object -Skip 1)
        $quoted = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
        $xml = '<Task><Actions><Exec><Command>' + [Security.SecurityElement]::Escape($node) + '</Command><Arguments>' + [Security.SecurityElement]::Escape($quoted) + '</Arguments></Exec></Actions></Task>'
        if (Test-OwnedGatewayTask $InstallRoot $xml) { $result += [pscustomobject]@{Executable=$node;Arguments=$arguments} }
    }
    # Supervisors are stopped first so they cannot recreate the exact child.
    $result += [pscustomobject]@{Executable=$node;Arguments=@($bundle, 'serve', '--config', $config)}
    return $result
}

function Stop-OwnedGatewayForRecovery {
    param([string] $InstallRoot)
    $registration = Get-GatewayRegistrationForRecovery $InstallRoot
    $descriptors = @()
    if (-not [string]::IsNullOrWhiteSpace($registration.TaskXml)) {
        $exec = Get-GatewayTaskExec $registration.TaskXml
        if ($null -eq $exec) { throw 'Gateway recovery task identity is unavailable.' }
        $executable = $exec.Command
        if ($executable -ieq 'wscript.exe') { $executable = Join-Path ([Environment]::SystemDirectory) 'wscript.exe' }
        if (-not [IO.Path]::IsPathRooted($executable)) { throw 'Gateway recovery task executable is not absolute.' }
        $arguments = @(Split-WindowsRecoveryCommandLine ('placeholder.exe ' + $exec.Arguments) | Select-Object -Skip 1)
        $descriptors += [pscustomobject]@{Executable=$executable;Arguments=$arguments}
    }
    if ($registration.StartupPresent) {
        $descriptors += [pscustomobject]@{Executable=(Join-Path ([Environment]::SystemDirectory) 'wscript.exe');Arguments=@($registration.StartupPath)}
    }
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $descriptors += @(Get-WindowsRecoveryOrphanDescriptors $InstallRoot $processes ($descriptors.Count -gt 0))
    if ($descriptors.Count -eq 0) { return }
    $attempted = @{}
    foreach ($descriptor in $descriptors) {
        foreach ($process in $processes) {
            if (-not (Test-WindowsRecoveryProcess $process $descriptor)) { continue }
            $processId = [int]$process.ProcessId
            if ($attempted.ContainsKey($processId)) { continue }
            $attempted[$processId] = $true
            $current = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $processId) -ErrorAction Stop
            if ($null -eq $current) { continue }
            if ($null -eq $process.CreationDate -or $current.CreationDate -ne $process.CreationDate -or
                -not (Test-WindowsRecoveryProcess $current $descriptor)) { continue }
            Invoke-WindowsRecoveryTaskkill $processId
        }
    }
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $remaining = $false
        foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
            foreach ($descriptor in $descriptors) { if (Test-WindowsRecoveryProcess $process $descriptor) { $remaining = $true } }
        }
        if (-not $remaining) { return }
        Start-Sleep -Milliseconds 200
    }
    throw 'The owned Gateway process did not stop; recovery cannot replace its runtime files yet.'
}

function Restart-OwnedGatewayService {
    param([string] $InstallRoot)
    $registration = Get-GatewayRegistrationForRecovery $InstallRoot
    if (-not [string]::IsNullOrWhiteSpace($registration.TaskXml)) {
        if (-not (Start-GatewayScheduledTask)) { Fail 'owned Gateway Scheduled Task did not start' }
        Wait-WindowsGatewayReady $InstallRoot
        return
    }
    if ($registration.StartupPresent -and -not (Start-GatewayStartupEntry $registration.StartupPath)) {
        Fail 'owned Gateway Startup entry did not start'
    }
    if ($registration.StartupPresent) { Wait-WindowsGatewayReady $InstallRoot }
}

function Start-BootstrapTransaction {
    param([string] $InstallRoot, [string] $Bin, [string[]] $Assets)
    $journal = Join-Path $InstallRoot '.bootstrap-transaction'
    $backup = Join-Path $InstallRoot '.bootstrap-previous'
    $inventory = Join-Path $backup 'inventory'
    Assert-BootstrapPathAndParents $InstallRoot
    foreach ($path in @($journal, $backup, "$journal.next", $Bin, $inventory)) { Assert-BootstrapPathAndParents $path }
    if ((Test-Path -LiteralPath $journal) -or (Test-Path -LiteralPath $backup)) { Fail 'bootstrap recovery state already exists; rerun this installer to recover it' }
    $assetNames = New-Object 'System.Collections.Generic.List[string]'
    $assetSeen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($asset in $Assets) {
        Assert-BootstrapAssetName $asset
        foreach ($name in @($asset, "$asset.sha256")) {
            if (-not $assetSeen.Add($name)) { Fail 'bootstrap assets are duplicated' }
            $assetNames.Add($name)
            Assert-BootstrapRegularFile (Join-Path $Bin $name) "installed bootstrap asset $name"
        }
    }
    foreach ($id in Get-BootstrapRuntimeFiles) {
        Assert-BootstrapRegularFile (Join-Path $InstallRoot $id) "runtime state $id"
    }
    # Query and validate both registration mechanisms before the installer can
    # replace any bytes. A task and a Startup fallback can briefly coexist after
    # an interrupted update, so snapshot both exact prior states.
    $registration = Get-GatewayRegistrationForRecovery $InstallRoot
    Set-BootstrapTransactionState $InstallRoot 'prepare=replace-release-assets'
    New-Item -ItemType Directory -Path (Join-Path $backup 'runtime') -Force -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $backup 'registration') -Force -ErrorAction Stop | Out-Null
    Set-Content -LiteralPath $inventory -Value 'version=2' -Encoding ascii -ErrorAction Stop
    foreach ($name in $assetNames) {
        $live = Join-Path $Bin $name
        if (Test-Path -LiteralPath $live) {
            Copy-BootstrapSnapshotFile $live (Join-Path $backup $name) "asset $name"
            Add-Content -LiteralPath $inventory -Value "present:$name" -Encoding ascii -ErrorAction Stop
        } else {
            Add-Content -LiteralPath $inventory -Value "absent:$name" -Encoding ascii -ErrorAction Stop
        }
    }
    foreach ($id in Get-BootstrapRuntimeFiles) {
        $live = Join-Path $InstallRoot $id
        if (Test-Path -LiteralPath $live) {
            $acl = Get-BootstrapAclToken $live "runtime state $id"
            Copy-BootstrapSnapshotFile $live (Join-Path (Join-Path $backup 'runtime') $id) "runtime state $id"
            Add-Content -LiteralPath $inventory -Value "state:present:${id}:$acl" -Encoding ascii -ErrorAction Stop
        } else {
            Add-Content -LiteralPath $inventory -Value "state:absent:${id}:-" -Encoding ascii -ErrorAction Stop
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($registration.TaskXml)) {
        $taskSnapshot = Join-Path (Join-Path $backup 'registration') 'task.xml'
        $taskTemporary = "$taskSnapshot.snapshot.$PID"
        Assert-BootstrapPathAndParents $taskTemporary
        if (Test-Path -LiteralPath $taskTemporary) { Fail 'Gateway Scheduled Task snapshot staging file already exists' }
        try {
            [IO.File]::WriteAllText($taskTemporary, $registration.TaskXml, [Text.Encoding]::Unicode)
            Move-Item -LiteralPath $taskTemporary -Destination $taskSnapshot -Force -ErrorAction Stop
        } finally {
            if (Test-Path -LiteralPath $taskTemporary) { Remove-Item -LiteralPath $taskTemporary -Force -ErrorAction SilentlyContinue }
        }
        Add-Content -LiteralPath $inventory -Value 'registration:task:present' -Encoding ascii -ErrorAction Stop
    } else {
        Add-Content -LiteralPath $inventory -Value 'registration:task:absent' -Encoding ascii -ErrorAction Stop
    }
    if ($registration.StartupPresent) {
        $startupSnapshot = Join-Path (Join-Path $backup 'registration') 'startup.vbs'
        $acl = Get-BootstrapAclToken $registration.StartupPath 'Gateway Startup entry'
        Copy-BootstrapSnapshotFile $registration.StartupPath $startupSnapshot 'Gateway Startup entry'
        Add-Content -LiteralPath $inventory -Value "registration:startup:present:$acl" -Encoding ascii -ErrorAction Stop
    } else {
        Add-Content -LiteralPath $inventory -Value 'registration:startup:absent:-' -Encoding ascii -ErrorAction Stop
    }
    Set-BootstrapTransactionState $InstallRoot 'intent=replace-release-assets'
}

function Recover-BootstrapTransaction {
    param([string] $InstallRoot, [string] $Bin, [string[]] $Assets)
    $journal = Join-Path $InstallRoot '.bootstrap-transaction'
    $backup = Join-Path $InstallRoot '.bootstrap-previous'
    Assert-BootstrapPathAndParents $InstallRoot
    Assert-BootstrapPathAndParents $journal
    Assert-BootstrapPathAndParents $backup
    Assert-BootstrapPathAndParents $Bin
    if (Test-Path -LiteralPath $backup) { Assert-BootstrapTreeSafe $backup }
    # The published journal is authoritative. A .next file was never committed;
    # a killed writer can leave even partially written contents here.
    $next = "$journal.next"
    Assert-BootstrapRegularFile $next 'transaction staging marker'
    if (Test-Path -LiteralPath $next) { Remove-Item -LiteralPath $next -Force -ErrorAction Stop }
    if (-not (Test-Path -LiteralPath $journal)) {
        if (Test-Path -LiteralPath $backup) {
            if (@(Get-ChildItem -LiteralPath $backup -Force).Count -ne 0) { Fail 'bootstrap snapshots exist without a transaction marker; preserve them and rerun the verified installer' }
            Remove-Item -LiteralPath $backup -Force -ErrorAction Stop
        }
        return
    }
    Assert-BootstrapRegularFile $journal 'transaction marker' -MustExist
    $state = (Get-Content -LiteralPath $journal -Raw).Trim()
    if ($state -in @('commit=installer-succeeded', 'restored=previous-release', 'prepare=replace-release-assets')) {
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction Stop }
        Remove-Item -LiteralPath $journal -Force -ErrorAction Stop
        return
    }
    if ($state -ne 'intent=replace-release-assets') { Fail 'bootstrap transaction marker is invalid; preserve it and rerun the verified installer' }
    $inventory = Join-Path $backup 'inventory'
    Assert-BootstrapRegularFile $inventory 'transaction inventory' -MustExist
    $entries = @(Get-Content -LiteralPath $inventory)
    $version = 1
    if ($entries.Count -gt 0 -and $entries[0] -eq 'version=2') { $version = 2 }
    $expected = New-Object 'System.Collections.Generic.List[string]'
    foreach ($asset in $Assets) {
        Assert-BootstrapAssetName $asset
        $expected.Add($asset)
        $expected.Add("$asset.sha256")
    }
    $assetSeen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $runtimeSeen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $registrations = @{}
    $assetRecords = @()
    $runtimeRecords = @()
    foreach ($entry in $entries) {
        if ($entry -eq 'version=2') {
            if ($version -ne 2 -or $entry -ne $entries[0]) { Fail 'bootstrap transaction inventory is invalid' }
            continue
        }
        if ($entry -match '^(present|absent):(.+)$') {
            $presence = $Matches[1]
            $name = $Matches[2]
            if ($expected -cnotcontains $name -or -not $assetSeen.Add($name)) { Fail 'bootstrap transaction inventory is invalid' }
            $live = Join-Path $Bin $name
            Assert-BootstrapRestoreDestination $live "asset $name"
            $snapshot = Join-Path $backup $name
            if ($presence -eq 'present') { Assert-BootstrapRegularFile $snapshot "asset snapshot $name" -MustExist }
            $assetRecords += [pscustomobject]@{ State = $presence; Name = $name; Live = $live; Snapshot = $snapshot }
            continue
        }
        if ($entry -match '^state:(present|absent):([^:]+):([^:]+)$') {
            if ($version -ne 2) { Fail 'bootstrap transaction inventory is invalid' }
            $presence = $Matches[1]
            $id = $Matches[2]
            $acl = $Matches[3]
            if (-not (Test-BootstrapRuntimeFileId $id) -or -not $runtimeSeen.Add($id) -or (($presence -eq 'present') -and -not (Test-BootstrapAclToken $acl)) -or (($presence -eq 'absent') -and $acl -ne '-')) { Fail 'bootstrap transaction inventory is invalid' }
            $live = Join-Path $InstallRoot $id
            Assert-BootstrapRestoreDestination $live "runtime state $id"
            $snapshot = Join-Path (Join-Path $backup 'runtime') $id
            if ($presence -eq 'present') { Assert-BootstrapRegularFile $snapshot "runtime snapshot $id" -MustExist }
            $runtimeRecords += [pscustomobject]@{ State = $presence; Id = $id; Live = $live; Snapshot = $snapshot; Acl = $acl }
            continue
        }
        if ($entry -match '^registration:task:(present|absent)$') {
            if ($version -ne 2 -or $registrations.ContainsKey('task')) { Fail 'bootstrap transaction inventory is invalid' }
            $presence = $Matches[1]
            $snapshot = Join-Path (Join-Path $backup 'registration') 'task.xml'
            if ($presence -eq 'present') {
                Assert-BootstrapRegularFile $snapshot 'Gateway Scheduled Task snapshot' -MustExist
                $taskLauncher = Join-Path (Join-Path (Join-Path $backup 'runtime') 'local') 'run-gateway.vbs'
                $taskXml = Get-Content -LiteralPath $snapshot -Raw -ErrorAction Stop
                if (-not (Test-OwnedGatewayTask $InstallRoot $taskXml $taskLauncher (Join-Path (Split-Path -Parent $taskLauncher) 'install-state'))) { Fail 'Gateway Scheduled Task snapshot is invalid' }
            }
            $registrations['task'] = [pscustomobject]@{ State = $presence; Snapshot = $snapshot }
            continue
        }
        if ($entry -match '^registration:startup:(present|absent):([^:]+)$') {
            if ($version -ne 2 -or $registrations.ContainsKey('startup')) { Fail 'bootstrap transaction inventory is invalid' }
            $presence = $Matches[1]
            $acl = $Matches[2]
            if (($presence -eq 'present' -and -not (Test-BootstrapAclToken $acl)) -or ($presence -eq 'absent' -and $acl -ne '-')) { Fail 'bootstrap transaction inventory is invalid' }
            $snapshot = Join-Path (Join-Path $backup 'registration') 'startup.vbs'
            if ($presence -eq 'present') {
                Assert-BootstrapRegularFile $snapshot 'Gateway Startup snapshot' -MustExist
                if (-not (Test-OwnedGatewayStartupEntry $InstallRoot $snapshot)) { Fail 'Gateway Startup snapshot is invalid' }
            }
            $registrations['startup'] = [pscustomobject]@{ State = $presence; Snapshot = $snapshot; Acl = $acl }
            continue
        }
        Fail 'bootstrap transaction inventory is invalid'
    }
    if ($assetSeen.Count -ne $expected.Count) { Fail 'bootstrap transaction inventory is incomplete' }
    if ($version -eq 2) {
        foreach ($id in Get-BootstrapRuntimeFiles) { if (-not $runtimeSeen.Contains($id)) { Fail 'bootstrap transaction inventory is incomplete' } }
        if (-not $registrations.ContainsKey('task') -or -not $registrations.ContainsKey('startup')) { Fail 'bootstrap transaction inventory is incomplete' }
        # This check happens before the first asset copy or removal. It protects
        # a same-name foreign registration even when the snapshot says that no
        # registration existed before this failed first install.
        $currentRegistration = Get-GatewayRegistrationForRecovery $InstallRoot
        Stop-OwnedGatewayForRecovery $InstallRoot
        # Remove the verified current task while its launcher and runtime identity
        # still exist. Restoring those files first invalidates the current task's
        # ownership evidence (especially after a failed first installation).
        if (-not [string]::IsNullOrWhiteSpace($currentRegistration.TaskXml) -and -not (Remove-GatewayScheduledTask)) {
            Fail 'could not remove the failed Gateway Scheduled Task before restoring runtime state'
        }
    }
    Write-Info 'recovering an interrupted CozyGateway bootstrap before fetching a new release'
    foreach ($record in $assetRecords) { Restore-BootstrapFile $record.Live $record.Snapshot $record.State '-' "asset $($record.Name)" }
    if ($version -eq 2) {
        foreach ($record in $runtimeRecords) { Restore-BootstrapFile $record.Live $record.Snapshot $record.State $record.Acl "runtime state $($record.Id)" }
        Restore-GatewayRegistration $InstallRoot $registrations['task'].State $registrations['task'].Snapshot $registrations['startup'].State $registrations['startup'].Snapshot $registrations['startup'].Acl
    }
    return $true
}

function Finish-BootstrapRecovery {
    param([string] $InstallRoot)
    $journal = Join-Path $InstallRoot '.bootstrap-transaction'
    $backup = Join-Path $InstallRoot '.bootstrap-previous'
    Assert-BootstrapPathAndParents $journal
    Assert-BootstrapTreeSafe $backup
    Set-BootstrapTransactionState $InstallRoot 'restored=previous-release'
    Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction Stop
    Remove-Item -LiteralPath $journal -Force -ErrorAction Stop
}

function Commit-BootstrapTransaction {
    param([string] $InstallRoot)
    $journal = Join-Path $InstallRoot '.bootstrap-transaction'
    $backup = Join-Path $InstallRoot '.bootstrap-previous'
    Assert-BootstrapPathAndParents $journal
    Assert-BootstrapTreeSafe $backup
    Set-BootstrapTransactionState $InstallRoot 'commit=installer-succeeded'
    Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction Stop
    Remove-Item -LiteralPath $journal -Force -ErrorAction Stop
}

function Save-ExplicitBootstrapSource {
    param([string] $InstallRoot, [string] $Base)
    $source = Join-Path $InstallRoot 'local\bootstrap-source'
    if ([string]::IsNullOrWhiteSpace($Base)) { Remove-Item -LiteralPath $source -Force -ErrorAction SilentlyContinue; return }
    if ($Base -notmatch '^file:///.+') { return }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $source) | Out-Null
    $staged = "$source.tmp.$PID"
    Set-Content -LiteralPath $staged -Value $Base -NoNewline -Encoding utf8 -ErrorAction Stop
    Move-Item -LiteralPath $staged -Destination $source -Force -ErrorAction Stop
}

function Invoke-TransactionalRelease {
    param([string] $InstallRoot, [string] $Bin, [string] $Stage, [string[]] $Assets, [scriptblock] $Install, [scriptblock] $Restore)
    Start-BootstrapTransaction $InstallRoot $Bin $Assets
    try {
        foreach ($asset in $Assets) {
            Promote-VerifiedAsset $asset $Stage $Bin
            if ($env:COZYGATEWAY_TEST_BOOTSTRAP_KILL_AFTER_PROMOTION -eq $asset) { Stop-Process -Id $PID -Force }
        }
        & $Install
        Wait-WindowsGatewayReady $InstallRoot
        Commit-BootstrapTransaction $InstallRoot
    } catch {
        $failure = $_
        $journal = Join-Path $InstallRoot '.bootstrap-transaction'
        $committed = (Test-Path -LiteralPath $journal -PathType Leaf) -and ((Get-Content -LiteralPath $journal -Raw).Trim() -eq 'commit=installer-succeeded')
        if (-not $committed) {
            $restored = $false
            try {
                $recovered = Recover-BootstrapTransaction $InstallRoot $Bin $Assets
                $restored = $true
                & $Restore
                if ($recovered) { Finish-BootstrapRecovery $InstallRoot }
                Write-Ok 'restarted the previous CozyGateway service after the failed update'
            } catch {
                if ($restored) { Write-Warning 'previous release assets were restored, but its service restart failed; rerun CozyGateway repair after resolving that error' }
                else { Write-Warning 'the previous release could not be fully restored; its recovery journal was preserved for retry' }
            }
        }
        throw $failure
    }
}

function Get-PersistedRepairMode {
    param([string] $StatePath)
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $null }
    $line = (Get-Content -LiteralPath $StatePath | Where-Object { $_ -like 'repair_mode=*' } | Select-Object -Last 1)
    if ($line -eq 'repair_mode=runtime-only') { return 'runtime-only' }
    return $null
}
function Get-PersistedRepairProfiles {
    param([string] $StatePath)
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
        Fail 'repair metadata is unavailable. Reinstall with: irm https://cozylabs.ai/install.ps1 | iex'
    }
    $line = (Get-Content -LiteralPath $StatePath | Where-Object { $_ -like 'profiles=*' } | Select-Object -Last 1)
    if ($null -eq $line) {
        Fail 'repair metadata is invalid. Reinstall with: irm https://cozylabs.ai/install.ps1 | iex'
    }
    $profiles = $line.Substring(9)
    if ([string]::IsNullOrWhiteSpace($profiles) -or $profiles -notmatch '^(?:default|[A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:,(?:default|[A-Za-z0-9][A-Za-z0-9._-]{0,63}))*$') {
        Fail 'repair metadata is invalid. Reinstall with: irm https://cozylabs.ai/install.ps1 | iex'
    }
    return $profiles
}

function Refresh-HermesEnvironment {
    param([string] $HermesHome)
    $env:HERMES_HOME = $HermesHome
    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    $machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
    $env:PATH = (@((Join-Path $HermesHome 'bin'), $userPath, $machinePath, $env:PATH) | Where-Object { $_ }) -join ';'
    $userBash = [Environment]::GetEnvironmentVariable('HERMES_GIT_BASH_PATH', 'User')
    if (-not [string]::IsNullOrWhiteSpace($userBash)) { $env:HERMES_GIT_BASH_PATH = $userBash }
}

function Resolve-NativeHermesPath {
    param([string] $Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    $full = Resolve-PhysicalHermesPath $Path
    if ([IO.Path]::GetExtension($full) -ieq '.cmd') {
        $full = [IO.Path]::ChangeExtension($full, '.exe')
    }
    if ([IO.Path]::GetExtension($full) -ieq '.exe' -and (Test-Path -LiteralPath $full -PathType Leaf)) {
        return $full
    }
    return $null
}

function Resolve-PhysicalHermesPath {
    param([string] $Path)
    $full = [IO.Path]::GetFullPath($Path)
    $alias = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') + '\'
    $physical = (Get-CozyLocalAppData).TrimEnd('\') + '\'
    $hermesAlias = $alias + 'hermes'
    if ($alias -ine $physical -and ($full -ieq $hermesAlias -or $full.StartsWith($hermesAlias + '\', [StringComparison]::OrdinalIgnoreCase))) {
        $mapped = $physical + $full.Substring($alias.Length)
        # Packaged apps can also read a pre-existing, unpackaged install through
        # this path. Preserve it when there is no corresponding redirected item.
        if ((Test-Path -LiteralPath $full) -and -not (Test-Path -LiteralPath $mapped)) { return $full }
        return $mapped
    }
    return $full
}

function Find-Hermes {
    $resolved = Resolve-NativeHermesPath $env:COZYGATEWAY_TEST_HERMES
    if ($resolved) { return $resolved }
    # An explicit empty home means a fresh installation, not the unrelated Hermes on PATH.
    if (-not [string]::IsNullOrWhiteSpace($env:HERMES_HOME)) {
        $env:HERMES_HOME = Resolve-PhysicalHermesPath $env:HERMES_HOME
        return (Resolve-NativeHermesPath (Join-Path $env:HERMES_HOME 'bin\hermes.exe'))
    }
    $command = Get-Command hermes.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
        $resolved = Resolve-NativeHermesPath $command.Source
        if ($resolved) { return $resolved }
    }
    $resolved = Resolve-NativeHermesPath (Join-Path $env:LOCALAPPDATA 'hermes\bin\hermes.exe')
    if ($resolved) { return $resolved }
    return $null
}

function Get-HermesVersion {
    param([string] $HermesPath)
    $versionOutput = (& $HermesPath --version 2>&1 | Out-String)
    $versionExit = $LASTEXITCODE
    $match = [regex]::Match($versionOutput, '(?i)\bHermes Agent v(?<version>(?<core>\d+\.\d+\.\d+)(?<prerelease>-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b')
    if ($versionExit -ne 0 -or -not $match.Success) {
        Fail 'could not verify the installed Hermes version; Hermes v0.21.0 or newer is required. Run hermes update, then retry this installer'
    }
    return [pscustomobject]@{
        Text = $match.Groups['version'].Value
        Core = [Version]$match.Groups['core'].Value
        IsPrerelease = $match.Groups['prerelease'].Success
    }
}

function Test-CompatibleHermesVersion {
    param($Version)
    return (-not $Version.IsPrerelease -and $Version.Core -ge [Version]'0.21.0')
}

function Ensure-CompatibleHermes {
    param([string] $HermesPath)
    $before = Get-HermesVersion $HermesPath
    if (Test-CompatibleHermesVersion $before) { return }
    Write-Info "Hermes v$($before.Text) must be updated for reliable multi-profile gateway attach"
    & $HermesPath update --yes | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail "Hermes update failed; Hermes v0.21.0 or newer is required. Resolve the update error, then retry this installer" }
    $after = Get-HermesVersion $HermesPath
    if (-not (Test-CompatibleHermesVersion $after)) {
        Fail "Hermes update did not install a compatible stable version (found v$($after.Text); v0.21.0 or newer is required)"
    }
    Write-Ok "updated Hermes from v$($before.Text) to v$($after.Text)"
}

function Get-HermesModelRequest {
    $endpoint = $env:COZYGATEWAY_HERMES_MODEL_ENDPOINT
    $model = $env:COZYGATEWAY_HERMES_MODEL_ID
    if ([string]::IsNullOrWhiteSpace($endpoint) -and [string]::IsNullOrWhiteSpace($model)) { return $null }
    if (-not (Test-SafeModelEndpoint $endpoint) -or -not (Test-SafeModelWord $model)) {
        Fail 'set a valid COZYGATEWAY_HERMES_MODEL_ENDPOINT and COZYGATEWAY_HERMES_MODEL_ID together for unattended Hermes setup'
    }
    return @{ Endpoint = $endpoint; Id = $model }
}

function Get-HermesLauncherInterpreter {
    param([string] $Launcher)
    # uv's Windows trampoline stores its absolute Python path in its payload.
    # Only recognize one unambiguous interpreter; other native launcher formats
    # remain under their own installer's control.
    $payload = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($Launcher))
    $paths = @([regex]::Matches($payload, '(?i)[A-Z]:\\[^\x00\r\n"]+\\python(?:w)?\.exe') | ForEach-Object { $_.Value } | Select-Object -Unique)
    if ($paths.Count -eq 1) { return $paths[0] }
    return $null
}

function Repair-HermesLauncherInterpreter {
    param([string] $Uv, [string] $Python, [string] $Repository)
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $Uv pip install --python $Python --reinstall-package hermes-agent --no-deps --editable $Repository | Out-Host
        $repairExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousErrorAction }
    if ($repairExit -ne 0) { Fail 'Hermes launcher repair failed; its existing command was retained' }
}

function Ensure-HermesLauncherInterpreter {
    param([string] $HermesPath)
    $bin = Split-Path -Parent $HermesPath
    if ((Split-Path -Leaf $bin) -ine 'bin') { return }
    $hermesHome = Split-Path -Parent $bin
    $repository = Join-Path $hermesHome 'hermes-agent'
    $python = Join-Path $repository 'venv\Scripts\python.exe'
    $alias = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') + '\'
    $physical = (Get-CozyLocalAppData).TrimEnd('\') + '\'
    if ($alias -ieq $physical) { return }
    $targets = @()
    foreach ($candidate in @($HermesPath, (Join-Path $bin 'hermes-acp.exe'))) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $interpreter = Get-HermesLauncherInterpreter $candidate
        if (-not $interpreter -or $interpreter -ieq $python -or -not $interpreter.StartsWith($alias, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if (($physical + $interpreter.Substring($alias.Length)) -ieq $python) { $targets += $candidate }
    }
    if ($targets.Count -eq 0) { return }
    if ($env:COZYGATEWAY_INSTALL_DRYRUN -eq '1') {
        Write-Info 'dry run: would repair the Hermes launcher to use its physical Python path'
        return
    }
    $uv = Join-Path $bin 'uv.exe'
    foreach ($path in @($HermesPath, $python, $uv, $repository)) { Assert-BootstrapPathAndParents $path }
    foreach ($path in @($python, $uv)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Fail 'Hermes launcher repair requires its managed Python and uv; rerun the Hermes installer' }
    }
    Write-Info 'Repairing the Hermes launcher for background access outside this packaged application.'
    Repair-HermesLauncherInterpreter $uv $python $repository
    foreach ($target in $targets) {
        $rebuilt = Join-Path (Join-Path $repository 'venv\Scripts') (Split-Path -Leaf $target)
        Assert-BootstrapPathAndParents $target
        Assert-BootstrapPathAndParents $rebuilt
        if ((Get-HermesLauncherInterpreter $rebuilt) -ine $python) { Fail 'Hermes rebuilt launcher does not target its physical Python path; its existing command was retained' }
    }
    # Stage first, then rename the old executable aside. Windows may allow a
    # running image to be renamed even while overwriting it is prohibited.
    # Leave a locked backup in place until its existing process exits.
    foreach ($target in $targets) {
        $rebuilt = Join-Path (Join-Path $repository 'venv\Scripts') (Split-Path -Leaf $target)
        $suffix = [guid]::NewGuid().ToString('N')
        $pending = "$target.pending-$suffix"
        $backup = "$target.backup-$suffix"
        Copy-Item -LiteralPath $rebuilt -Destination $pending
        try {
            try { Move-Item -LiteralPath $target -Destination $backup } catch {
                Fail 'close the Hermes processes using its command, then rerun repair; its existing launcher was retained'
            }
            try { Move-Item -LiteralPath $pending -Destination $target } catch {
                Move-Item -LiteralPath $backup -Destination $target
                throw
            }
            Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
        } finally { Remove-Item -LiteralPath $pending -Force -ErrorAction SilentlyContinue }
    }
    Write-Ok 'Hermes launcher uses its physical Python path'
}

function Expand-HermesArchive {
    param([string] $Path, [string] $DestinationPath)
    Assert-BootstrapRegularFile $Path 'Hermes archive' -MustExist
    Assert-BootstrapPathAndParents $DestinationPath
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) { Fail 'Windows tar.exe is required to extract Hermes archives with long paths' }
    New-Item -ItemType Directory -Force -Path $DestinationPath | Out-Null
    & $tar -xf $Path -C $DestinationPath | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail 'Hermes archive extraction failed' }
}

function Invoke-OfficialHermesInstaller {
    param([string] $InstallerPath, [string] $Tag, [string] $HermesHome, [bool] $NonInteractive)
    Assert-BootstrapPathAndParents $HermesHome
    $parameters = @{ HermesHome = $HermesHome; InstallDir = (Join-Path $HermesHome 'hermes-agent') }
    if ($Tag) { $parameters['Tag'] = $Tag; $parameters['Branch'] = $Tag }
    if ($NonInteractive) { $parameters['NonInteractive'] = $true; $parameters['SkipSetup'] = $true }
    # Windows PowerShell 5.1 Expand-Archive fails on Hermes' long documentation
    # paths. This function shadows it only inside the upstream invocation.
    function Expand-Archive {
        param([string] $Path, [string] $DestinationPath, [switch] $Force)
        Expand-HermesArchive $Path $DestinationPath
    }
    # Upstream writes git --global compatibility settings and replaces GIT_CONFIG_COUNT.
    # Contain those writes in a private temporary config and keep longpaths effective.
    $gitConfig = Join-Path ([IO.Path]::GetTempPath()) ('cozy-hermes-git-' + [guid]::NewGuid().ToString('N'))
    $oldGlobal = $env:GIT_CONFIG_GLOBAL
    $oldCount = $env:GIT_CONFIG_COUNT; $oldKey = $env:GIT_CONFIG_KEY_0; $oldValue = $env:GIT_CONFIG_VALUE_0
    $oldSsh = $env:GIT_SSH_COMMAND
    try {
        [IO.File]::WriteAllText($gitConfig, "[core]`nlongpaths = true`n[windows]`nappendAtomically = false`n")
        Protect-FileToOwner $gitConfig
        $env:GIT_CONFIG_GLOBAL = $gitConfig
        $content = [IO.File]::ReadAllText($InstallerPath).TrimStart([char]0xFEFF)
        & ([scriptblock]::Create($content)) @parameters | Out-Host
    } finally {
        $env:GIT_CONFIG_GLOBAL = $oldGlobal
        $env:GIT_CONFIG_COUNT = $oldCount; $env:GIT_CONFIG_KEY_0 = $oldKey; $env:GIT_CONFIG_VALUE_0 = $oldValue
        $env:GIT_SSH_COMMAND = $oldSsh
        Remove-Item -LiteralPath $gitConfig -Force -ErrorAction SilentlyContinue
    }
}

function Resolve-Hermes {
    param([string] $InstallerUri)
    $script:FreshHermesInstall = $false
    $hermes = Find-Hermes
    $wasInstalled = [bool]$hermes
    if (-not $hermes) {
        $tag = ''
        $request = Get-HermesModelRequest
        $hermesHome = if ($env:HERMES_HOME) { Resolve-PhysicalHermesPath $env:HERMES_HOME } else { Resolve-PhysicalHermesPath (Join-Path $env:LOCALAPPDATA 'hermes') }
        $freshModelSetup = -not (Test-Path -LiteralPath (Join-Path $hermesHome 'config.yaml') -PathType Leaf)
        if ([string]::IsNullOrWhiteSpace($InstallerUri)) {
            $tag = Get-LatestTag 'NousResearch/hermes-agent'
            $InstallerUri = "https://raw.githubusercontent.com/NousResearch/hermes-agent/$tag/scripts/install.ps1"
        }
        Write-Info 'Hermes Agent is not installed; starting the official Windows installer.'
        $hermesInstaller = Join-Path ([IO.Path]::GetTempPath()) ("hermes-install-" + [guid]::NewGuid().ToString('N') + '.ps1')
        try {
            Copy-OrDownload $InstallerUri $hermesInstaller
            Invoke-OfficialHermesInstaller $hermesInstaller $tag $hermesHome ([bool]$request)
            $script:FreshHermesInstall = $freshModelSetup
        } finally {
            Remove-Item -LiteralPath $hermesInstaller -Force -ErrorAction SilentlyContinue
        }
        Refresh-HermesEnvironment $hermesHome
        $hermes = Find-Hermes
    }
    if (-not $hermes) { Fail 'Hermes installation did not produce hermes.exe; finish Hermes setup and run this command again' }
    Ensure-HermesLauncherInterpreter $hermes
    $configPath = [string](& $hermes -p default config path 2>$null | Select-Object -Last 1)
    $configPath = $configPath.Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($configPath) -or -not (Test-Path -LiteralPath $configPath)) {
        if (-not (Get-HermesModelRequest)) { Fail 'Hermes default profile is not configured; finish Hermes setup and run this command again' }
    }
    if ($wasInstalled) { $null = Update-HermesHarness $hermes }
    else { Ensure-CompatibleHermes $hermes }
    Ensure-HermesLauncherInterpreter $hermes
    return $hermes
}

function Get-HermesModelState {
    param([string] $HermesPath)
    $statusOutput = (& $HermesPath -p default status 2>&1 | Out-String)
    $statusExit = $LASTEXITCODE
    $modelMatch = [regex]::Match($statusOutput, '(?m)^\s*(?:Current model|Model):\s*(?<value>[^\r\n]+)')
    $providerMatch = [regex]::Match($statusOutput, '(?m)^\s*(?:Active provider|Provider):\s*(?<value>[^\r\n]+)')
    $model = if ($modelMatch.Success) { $modelMatch.Groups['value'].Value.Trim() } else { '' }
    $provider = if ($providerMatch.Success) { $providerMatch.Groups['value'].Value.Trim() } else { '' }
    $placeholder = '^(?i:\(?\s*(?:not set|not configured|unknown|none|null)\s*\)?)$'
    $hasModel = -not [string]::IsNullOrWhiteSpace($model) -and $model -notmatch $placeholder
    # Hermes reports Auto when provider resolution has no usable credentials.
    # A freshly copied template has a model name but is not configured yet.
    $hasProvider = -not [string]::IsNullOrWhiteSpace($provider) -and $provider -notmatch $placeholder -and $provider -ine 'Auto'
    return [pscustomobject]@{
        Configured = ($statusExit -eq 0 -and $hasModel -and $hasProvider)
    }
}

function Confirm-HermesModel {
    param([string] $HermesPath, [bool] $FreshInstall = $false)
    if ($env:COZYGATEWAY_INSTALL_DRYRUN -eq '1') {
        Write-Info 'dry run: would inspect Hermes model status and open model selection only when setup is incomplete'
        return
    }
    $request = if ($FreshInstall) { Get-HermesModelRequest } else { $null }
    $state = Get-HermesModelState $HermesPath
    if ($state.Configured -and -not $request) {
        Write-Ok 'Hermes provider and model are already configured; skipping model selection'
        return
    }
    if (-not $request) { $request = Get-HermesModelRequest }
    if ($request) {
        foreach ($setting in @(@('model.provider', 'custom'), @('model.base_url', $request.Endpoint), @('model.default', $request.Id))) {
            & $HermesPath -p default config set $setting[0] $setting[1]
            if ($LASTEXITCODE -ne 0) { Fail 'Hermes could not save the requested model configuration' }
        }
        $state = Get-HermesModelState $HermesPath
        if (-not $state.Configured) { Fail 'Hermes did not report the requested model as configured' }
        Write-Ok 'Hermes endpoint and model are configured'
        return
    }
    Write-Info 'Choose or confirm the Hermes inference provider and model.'
    & $HermesPath -p default model
    $modelExit = $LASTEXITCODE
    if ($modelExit -ne 0) {
        Fail 'Hermes model selection did not complete successfully'
    }
    $state = Get-HermesModelState $HermesPath
    if (-not $state.Configured) {
        Fail 'Hermes needs an active provider and model before CozyGateway can be installed'
    }
    Write-Ok 'Hermes provider and model are configured'
}

function Ensure-HermesDashboardAssets {
    param([string] $HermesPath)
    if ($env:COZYGATEWAY_INSTALL_DRYRUN -eq '1') {
        Write-Info 'dry run: would prepare Hermes Dashboard assets before starting its hidden service'
        return
    }
    if ($env:COZYGATEWAY_TEST_DASHBOARD_BUILDER) {
        & $env:COZYGATEWAY_TEST_DASHBOARD_BUILDER $HermesPath
        if ($LASTEXITCODE -ne 0) { Fail 'Hermes Dashboard asset preparation failed' }
        return
    }
    $configPath = (& $HermesPath -p default config path 2>$null | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($configPath)) { Fail 'could not resolve Hermes home for Dashboard preparation' }
    $hermesHome = Split-Path -Parent $configPath.Trim()
    $python = Get-HermesLauncherInterpreter $HermesPath
    if (-not $python) { $python = Join-Path $hermesHome 'hermes-agent\venv\Scripts\python.exe' }
    Assert-BootstrapPathAndParents $python
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { Fail 'Hermes virtual-environment Python is missing; finish its dependency installation before retrying' }
    # Build only; never start a Dashboard or open a browser here. The upstream builder
    # checks freshness and repairs EBADENGINE using its managed npm, never system npm.
    $builder = @'
from hermes_cli.main import PROJECT_ROOT, _build_web_ui
import sys
ok = _build_web_ui(PROJECT_ROOT / 'web', fatal=True)
index = PROJECT_ROOT / 'hermes_cli' / 'web_dist' / 'index.html'
if not ok or not index.is_file():
    print('Hermes Dashboard assets were not built successfully', file=sys.stderr)
    sys.exit(1)
'@
    Write-Info 'Preparing Hermes Dashboard assets before starting its hidden service.'
    & $python -c $builder
    if ($LASTEXITCODE -ne 0) { Fail 'Hermes Dashboard asset preparation failed; no new gateway service was started' }
    Write-Ok 'Hermes Dashboard assets are ready'
}

# Windows-only private prerequisite. Embedded into install.ps1 for the one-liner.
# Portable Git needs no administrator rights or registry/PATH modifications:
# https://github.com/git-for-windows/build-extra/blob/main/portable/root/README.portable
# Official extraction switches (including doubled backslashes):
# https://gitforwindows.org/zip-archives-extracting-the-released-archives.html
# GitHub release asset metadata supplies the required sha256 digest:
# https://docs.github.com/en/rest/releases/assets
function Test-WindowsGitBash {
    param([string] $Path, [ValidateRange(1, 15)][int] $TimeoutSeconds = 10)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $process = New-Object Diagnostics.Process
    try {
        $process.StartInfo.FileName = [IO.Path]::GetFullPath($Path)
        $process.StartInfo.Arguments = '--noprofile --norc -c "printf cozygateway-git-ready"'
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        if (-not $process.Start()) { return $false }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { return $false }
        if (-not $stdout.Wait(1000) -or -not $stderr.Wait(1000)) { return $false }
        return ($process.ExitCode -eq 0 -and $stdout.Result -ceq 'cozygateway-git-ready')
    } catch { return $false }
    finally {
        # This Process object retains the handle created above; never look up a
        # generic Bash process or kill a PID that could have been reused.
        try { if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(2000) } } catch { }
        $process.Dispose()
    }
}

function Get-WindowsGitRelease {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            return Invoke-RestMethod -UseBasicParsing -TimeoutSec 30 -Headers @{ 'User-Agent' = 'cozygateway-windows-installer'; 'Accept' = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' } -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest'
        } catch {
            if ($attempt -eq 3 -or -not (Test-TransientBootstrapDownloadError $_.Exception)) { throw }
            Start-Sleep -Seconds $attempt
        }
    }
}

function Save-WindowsGitAsset {
    param([string] $Uri, [string] $Path)
    Copy-OrDownload $Uri $Path
}

function Expand-WindowsGitAsset {
    param([string] $Archive, [string] $Destination, [ValidateRange(1, 600)][int] $TimeoutSeconds = 300)
    # Use the verified self-extractor so its bundled post-install step runs too.
    $arguments = @('-y', '-gm2', ('-InstallPath="' + $Destination.Replace('\', '\\') + '"'))
    $process = $null
    try {
        $process = Start-Process -FilePath $Archive -ArgumentList $arguments -WindowStyle Hidden -PassThru
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { throw 'Portable Git extraction timed out; the existing private Git copy was preserved.' }
        if ($process.ExitCode -ne 0) { throw "Portable Git extraction exited $($process.ExitCode)." }
    } finally {
        if ($null -ne $process) {
            try { if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(2000) } } finally { $process.Dispose() }
        }
    }
    # Recent official SFX builds use their compiled %%S\PortableGit default even
    # with -InstallPath. That location is still inside our unique staging folder.
    if (-not (Test-Path -LiteralPath $Destination)) {
        $archiveFolder = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Archive))
        $defaultExtraction = Join-Path $archiveFolder 'PortableGit'
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Destination)) -ne $archiveFolder) { throw 'Portable Git extraction must remain in its private staging directory.' }
        Assert-WindowsGitPath $defaultExtraction
        if (Test-Path -LiteralPath $defaultExtraction -PathType Container) { Move-Item -LiteralPath $defaultExtraction -Destination $Destination }
    }
}

function Assert-WindowsGitPath {
    param([string] $Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($true) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Refusing redirected private Git path: $current" }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) { break }
        $current = $parent
    }
}

function Ensure-WindowsGitBash {
    param([Parameter(Mandatory = $true)][string] $InstallHome, [string] $ExplicitPath, [string] $Architecture)
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        $privateRoot = [IO.Path]::GetFullPath((Join-Path $InstallHome 'tools\git')).TrimEnd('\') + '\'
        if ([IO.Path]::GetFullPath($ExplicitPath).StartsWith($privateRoot, [StringComparison]::OrdinalIgnoreCase)) { Assert-WindowsGitPath $ExplicitPath }
        if (Test-WindowsGitBash $ExplicitPath) { return [IO.Path]::GetFullPath($ExplicitPath) }
        throw 'COZYGATEWAY_GIT_BASH does not point to a usable Git Bash. Correct that explicit path or remove it so setup can install its private Git copy.'
    }
    $toolsRoot = [IO.Path]::GetFullPath((Join-Path $InstallHome 'tools'))
    $gitRoot = Join-Path $toolsRoot 'git'
    $bash = Join-Path $gitRoot 'bin/bash.exe'
    Assert-WindowsGitPath $bash
    if (Test-WindowsGitBash $bash) { return $bash }
    if ([string]::IsNullOrWhiteSpace($Architecture)) {
        $Architecture = $env:PROCESSOR_ARCHITEW6432
        if ([string]::IsNullOrWhiteSpace($Architecture)) { $Architecture = $env:PROCESSOR_ARCHITECTURE }
    }
    $suffix = switch ($Architecture.ToUpperInvariant()) {
        'AMD64' { '64-bit' }
        'ARM64' { 'arm64' }
        default { throw "Portable Git bootstrap supports x64 and ARM64 Windows; unsupported architecture: $Architecture" }
    }
    $release = Get-WindowsGitRelease
    $assetMatches = @($release.assets | Where-Object { $_.name -match ('^PortableGit-[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?-' + $suffix + '\.7z\.exe$') })
    if ($assetMatches.Count -ne 1) { throw "The official Git for Windows release did not provide exactly one portable $suffix archive." }
    $asset = $assetMatches[0]
    $digestProperty = $asset.PSObject.Properties['digest']
    if ($null -eq $digestProperty -or [string]$digestProperty.Value -notmatch '^sha256:([a-fA-F0-9]{64})$') { throw 'The official portable Git release has no SHA-256 digest; refusing to run an unverified download.' }
    $expected = ([string]$digestProperty.Value).Substring(7)
    $uri = [Uri]$asset.browser_download_url
    $expectedPath = '^/git-for-windows/git/releases/download/[^/]+/' + [regex]::Escape([string]$asset.name) + '$'
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'github.com' -or $uri.AbsolutePath -notmatch $expectedPath -or $uri.Query -or $uri.Fragment) { throw 'The portable Git archive URL is not an official Git for Windows release asset.' }
    $null = New-Item -ItemType Directory -Path $toolsRoot -Force
    $stage = Join-Path $toolsRoot ('.git-bootstrap-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $stage
    try {
        Write-Host 'INFO  Installing a verified private Git for Windows copy for CozyGateway.'
        $archive = Join-Path $stage 'portable-git.exe'
        Save-WindowsGitAsset -Uri $uri.AbsoluteUri -Path $archive
        $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
        if ($actual -ine $expected) { throw 'Portable Git checksum mismatch; the downloaded archive was not executed.' }
        $extracted = Join-Path $stage 'git'
        Expand-WindowsGitAsset -Archive $archive -Destination $extracted
        $stagedBash = Join-Path $extracted 'bin/bash.exe'
        Assert-WindowsGitPath $stagedBash
        if (-not (Test-WindowsGitBash $stagedBash)) { throw 'The verified portable Git archive did not produce a usable Bash; the existing private Git copy was preserved.' }
        # A broken old private copy is preserved until the replacement passes validation.
        # Renaming keeps any unexpected user-added files recoverable rather than deleting them.
        Assert-WindowsGitPath $gitRoot
        if (Test-Path -LiteralPath $gitRoot) {
            if (Test-WindowsGitBash $bash) { return $bash }
            $backup = Join-Path $toolsRoot ('git.previous-' + [guid]::NewGuid().ToString('N'))
            Move-Item -LiteralPath $gitRoot -Destination $backup
            try { Move-Item -LiteralPath $extracted -Destination $gitRoot } catch {
                Move-Item -LiteralPath $backup -Destination $gitRoot
                throw
            }
        } else { Move-Item -LiteralPath $extracted -Destination $gitRoot }
        if (-not (Test-WindowsGitBash $bash)) { throw 'The private Git copy did not provide a usable Bash after publishing; retry setup.' }
        return $bash
    } finally {
        $resolvedStage = [IO.Path]::GetFullPath($stage)
        $stageParent = [IO.Path]::GetDirectoryName($resolvedStage)
        if ($stageParent -eq $toolsRoot -and [IO.Path]::GetFileName($resolvedStage) -like '.git-bootstrap-*') {
            Assert-WindowsGitPath $resolvedStage
            # Extraction comes only from a verified official archive; refuse to traverse
            # any redirected entry should its contents nevertheless be unexpected.
            $links = @(Get-ChildItem -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
            if ($links.Count -eq 0) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
}

function Resolve-GitBash {
    param([string] $ExplicitPath, [string] $Guidance = 'Re-run the Hermes Windows installer, then paste this command again.')
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if ([IO.Path]::GetFullPath($ExplicitPath) -like "$env:WINDIR\System32\bash.exe") { Fail 'COZYGATEWAY_GIT_BASH must point to Git for Windows Bash, not the Windows Subsystem for Linux launcher.' }
        return Ensure-WindowsGitBash -InstallHome $script:InstallHome -ExplicitPath $ExplicitPath
    }
    $candidates = New-Object System.Collections.Generic.List[string]
    $programFilesX86Bash = $null
    if (${env:ProgramFiles(x86)}) { $programFilesX86Bash = Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe' }
    foreach ($candidate in @(
        (Join-Path $script:InstallHome 'tools\git\bin\bash.exe'),
        $env:HERMES_GIT_BASH_PATH,
        [Environment]::GetEnvironmentVariable('HERMES_GIT_BASH_PATH', 'User'),
        (Join-Path $env:LOCALAPPDATA 'hermes\git\bin\bash.exe'),
        (Join-Path $env:LOCALAPPDATA 'hermes\git\usr\bin\bash.exe'),
        (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
        $programFilesX86Bash,
        (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')
    )) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) { $candidates.Add($candidate) }
    }
    $git = Get-Command git.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($git) {
        $gitRoot = Split-Path -Parent (Split-Path -Parent $git.Source)
        $candidates.Add((Join-Path $gitRoot 'bin\bash.exe'))
        $candidates.Add((Join-Path $gitRoot 'usr\bin\bash.exe'))
    }
    foreach ($candidate in $candidates) {
        if ([string]::Equals([IO.Path]::GetFullPath($candidate), [IO.Path]::GetFullPath((Join-Path $script:InstallHome 'tools\git\bin\bash.exe')), [StringComparison]::OrdinalIgnoreCase)) { Assert-WindowsGitPath $candidate }
        if ((Test-Path -LiteralPath $candidate) -and ([IO.Path]::GetFullPath($candidate) -notlike "$env:WINDIR\System32\bash.exe") -and (Test-WindowsGitBash $candidate)) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    return Ensure-WindowsGitBash -InstallHome $script:InstallHome
}

# The shared installer owns the gateway on every platform. On the CozyAgents harness it owns only
# the gateway: COZYGATEWAY_WINDOWS_HARNESS_OWNER tells it that this script asks the model and
# network questions, installs the harness, pairs the runner and prints the QR.
function Invoke-CozyGatewayInstaller {
    param(
        [string] $BashPath,
        [string] $InstallerPath,
        [string] $HermesPath,
        [string[]] $ForwardedArguments,
        [string] $HarnessName = 'hermes',
        [string[]] $HarnessArguments = @()
    )
    $arguments = @($InstallerPath, '--service-platform', 'Windows', '--gateway-dir', $script:InstallHome, '--bundle', $script:BundlePath, '--harness', $HarnessName)
    if ($HarnessName -eq 'hermes') {
        $arguments += @('--plugin-archive', $script:PluginPath)
    }
    if ($HarnessArguments) { $arguments += $HarnessArguments }
    if ($env:COZYGATEWAY_INSTALL_DRYRUN -eq '1') { $arguments += '--dry-run' }
    if ($ForwardedArguments) { $arguments += $ForwardedArguments }
    $previousHermes = [Environment]::GetEnvironmentVariable('COZYGATEWAY_HERMES_BIN', 'Process')
    $previousPowerShell = [Environment]::GetEnvironmentVariable('COZYGATEWAY_POWERSHELL', 'Process')
    $previousOwner = [Environment]::GetEnvironmentVariable('COZYGATEWAY_WINDOWS_HARNESS_OWNER', 'Process')
    $previousAgentsHome = [Environment]::GetEnvironmentVariable('COZYAGENTS_HOME', 'Process')
    $trustedPowerShell = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (-not (Test-Path -LiteralPath $trustedPowerShell -PathType Leaf)) { Fail 'native Windows PowerShell is unavailable' }
    try {
        $env:COZYGATEWAY_HERMES_BIN = $HermesPath
        $env:COZYGATEWAY_POWERSHELL = $trustedPowerShell
        if ($HarnessName -eq 'cozyagents') {
            $env:COZYGATEWAY_WINDOWS_HARNESS_OWNER = '1'
            # The shared installer records the harness home as a POSIX path it can act on later.
            # A native path handed to it here would be recorded as one, and read back as unsafe.
            [Environment]::SetEnvironmentVariable('COZYAGENTS_HOME', $null, 'Process')
        }
        & $BashPath @arguments
        if ($LASTEXITCODE -ne 0) { Fail "CozyGateway installer exited $LASTEXITCODE" }
    } finally {
        [Environment]::SetEnvironmentVariable('COZYGATEWAY_HERMES_BIN', $previousHermes, 'Process')
        [Environment]::SetEnvironmentVariable('COZYGATEWAY_POWERSHELL', $previousPowerShell, 'Process')
        [Environment]::SetEnvironmentVariable('COZYGATEWAY_WINDOWS_HARNESS_OWNER', $previousOwner, 'Process')
        [Environment]::SetEnvironmentVariable('COZYAGENTS_HOME', $previousAgentsHome, 'Process')
    }
}

function Protect-CozyGatewayHome {
    param([string] $Path)
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
    $administrators = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($currentUser, $system, $administrators)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $identity,
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    if ($PSVersionTable.PSEdition -eq 'Core') {
        [IO.FileSystemAclExtensions]::SetAccessControl((Get-Item -LiteralPath $Path), $acl)
    } else {
        (Get-Item -LiteralPath $Path).SetAccessControl($acl)
    }
}

function Set-CozyGatewayCommandPath {
    param([string] $BinPath, [bool] $Present)
    $full = [IO.Path]::GetFullPath($BinPath).TrimEnd('\')
    $testPath = [Environment]::GetEnvironmentVariable('COZYGATEWAY_TEST_USER_PATH', 'Process')
    $userPath = if ($null -ne $testPath) { $testPath } else { [Environment]::GetEnvironmentVariable('PATH', 'User') }
    $parts = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and $_.TrimEnd('\') -ine $full })
    if ($Present) { $parts = @($full) + $parts }
    $next = $parts -join ';'

    $testLog = [Environment]::GetEnvironmentVariable('COZYGATEWAY_TEST_USER_PATH_LOG', 'Process')
    if (-not [string]::IsNullOrWhiteSpace($testLog)) {
        [IO.File]::WriteAllText($testLog, $next, (New-Object Text.UTF8Encoding($false)))
    } else {
        [Environment]::SetEnvironmentVariable('PATH', $next, 'User')
    }

    $processParts = @($env:PATH -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and $_.TrimEnd('\') -ine $full })
    if ($Present) {
        $env:PATH = (@($full) + $processParts) -join ';'
    } else {
        $env:PATH = $processParts -join ';'
    }
    Write-Ok $(if ($Present) { 'the cozygateway command is available in new PowerShell and Terminal windows' } else { 'removed the cozygateway command from the user PATH' })
}

# ---------------------------------------------------------------------------
# The harness choice, and the CozyAgents half of it
# ---------------------------------------------------------------------------

# The supported one-liner is pasted into a terminal, where Read-Host is the person. An unattended
# run has no terminal at all, and every question below then takes its safe default rather than
# reading a redirected stdin that was never meant as an answer.
function Test-CanPrompt {
    if (-not [Environment]::UserInteractive) { return $false }
    try { if ([Console]::IsInputRedirected) { return $false } } catch { return $false }
    return $true
}

function Test-PromptAvailable {
    param([string] $InputVariable)
    if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($InputVariable, 'Process'))) { return $true }
    return (Test-CanPrompt)
}

# $null means there was no way to ask at all, which is not the same answer as pressing Enter.
function Get-PromptAnswer {
    param([string] $Prompt, [string] $InputVariable, [string] $Fallback)
    $scripted = [Environment]::GetEnvironmentVariable($InputVariable, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($scripted)) {
        if (-not $script:PromptAnswers.ContainsKey($InputVariable)) {
            $lines = @()
            if (Test-Path -LiteralPath $scripted -PathType Leaf) { $lines = @(Get-Content -LiteralPath $scripted) }
            $script:PromptAnswers[$InputVariable] = $lines
            $script:PromptIndex[$InputVariable] = 0
        }
        Write-Host $Prompt
        $answers = $script:PromptAnswers[$InputVariable]
        $index = $script:PromptIndex[$InputVariable]
        if ($index -ge $answers.Count) { return $Fallback }
        $script:PromptIndex[$InputVariable] = $index + 1
        $value = [string]$answers[$index]
        if ([string]::IsNullOrWhiteSpace($value)) { return $Fallback }
        return $value.Trim()
    }
    if (-not (Test-CanPrompt)) { return $null }
    try { $answer = Read-Host -Prompt $Prompt } catch { return $Fallback }
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Fallback }
    return $answer.Trim()
}

function Get-RecordedHarness {
    param([string] $StatePath)
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return '' }
    $lines = @(Get-Content -LiteralPath $StatePath)
    $harnessLine = $lines | Where-Object { $_ -like 'harness=*' } | Select-Object -Last 1
    if ($harnessLine) { return ([string]$harnessLine).Substring(8).Trim() }
    # An install written before the harness question existed records a Hermes root instead, and
    # that is just as binding.
    if ($lines | Where-Object { $_ -like 'hermes_root=*' }) { return 'hermes' }
    return ''
}

function Test-HermesBridge {
    param([string] $ConfigPath)
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return $false }
    return ((Get-Content -LiteralPath $ConfigPath -Raw) -match '"hermesEndpoints"')
}

# Each selection adds to the harnesses already registered with this gateway.
function Select-Harness {
    param([string] $Requested, [string] $StatePath, [string] $ConfigPath)
    $recorded = Get-RecordedHarness $StatePath
    if ($recorded -notin @('', 'hermes', 'cozyagents', 'both')) { Fail 'installer state has an invalid harness' }
    $hasHermes = $recorded -in @('hermes', 'both') -or (Test-HermesBridge $ConfigPath)
    $hasAgents = $recorded -in @('cozyagents', 'both')
    if (-not $Requested -and (Test-Path -LiteralPath $ConfigPath -PathType Leaf) -and ($recorded -or $hasHermes)) {
        $existing = if ($hasHermes -and $hasAgents) { 'both' } elseif ($hasAgents) { 'cozyagents' } else { 'hermes' }
        Write-Ok "harness: $existing (already installed here)"
        return $existing
    }
    $default = if ($hasHermes -and $hasAgents) { 'both' } elseif ($hasAgents) { 'cozyagents' } elseif ($hasHermes -or (Find-Hermes)) { 'hermes' } else { 'cozyagents' }
    $harness = $Requested
    $source = 'from -Harness'
    if (-not $harness) {
        $harness = $default
        $source = 'already installed here'
        if (Test-PromptAvailable 'COZYGATEWAY_TEST_HARNESS_PROMPT_INPUT') {
            $fallback = switch ($default) { 'hermes' { '2' }; 'both' { '3' }; default { '1' } }
            while ($true) {
                $answer = Get-PromptAnswer "Which harness runs your bots? [1] CozyAgents (recommended) [2] Hermes Agent [3] Both [$fallback]" 'COZYGATEWAY_TEST_HARNESS_PROMPT_INPUT' $fallback
                if ($null -eq $answer) { break }
                $normalized = $answer.ToLowerInvariant()
                if ($normalized -in @('1', 'c', 'cozyagents')) { $harness = 'cozyagents'; break }
                if ($normalized -in @('2', 'h', 'hermes')) { $harness = 'hermes'; break }
                if ($normalized -in @('3', 'b', 'both')) { $harness = 'both'; break }
                Write-Host 'Please answer 1, 2 or 3.'
            }
            $source = 'selected'
        }
    }
    if (($hasHermes -and $harness -eq 'cozyagents') -or ($hasAgents -and $harness -eq 'hermes') -or $recorded -eq 'both') { $harness = 'both' }
    Write-Ok "harness: $harness ($source)"
    return $harness
}

# CozyAgents setup refuses elevation. Gateway updates can reuse its existing runtime
# without invoking that installer; require a normal token only when setup is needed.




function Test-SafeModelWord {
    param([string] $Value)
    return ($Value -cmatch '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$')
}

function Test-SafeModelEndpoint {
    param([string] $Value)
    return ($Value -cmatch '^https?://[A-Za-z0-9._~:/?#@%+=-]{1,255}$')
}

# A Codex login already on this machine is the one credential a person can share with their bots
# without typing a key anywhere. Detection only: nothing is read, copied, or written.
function Find-CodexLogin {
    $auth = $env:COZYGATEWAY_CODEX_AUTH_PATH
    if ([string]::IsNullOrWhiteSpace($auth)) { $auth = Join-Path $env:USERPROFILE '.pi\agent\auth.json' }
    if (Test-Path -LiteralPath $auth -PathType Leaf) { return $auth }
    $hermesHome = $env:HERMES_HOME
    if ([string]::IsNullOrWhiteSpace($hermesHome)) { $hermesHome = Join-Path $env:LOCALAPPDATA 'hermes' }
    $hermesEnv = Join-Path $hermesHome '.env'
    if (Test-Path -LiteralPath $hermesEnv -PathType Leaf) {
        if ((Get-Content -LiteralPath $hermesEnv -Raw) -match '(?m)^\s*(OPENAI_CODEX_[A-Z0-9_]*|CODEX_[A-Z0-9_]*)=\S') { return $hermesEnv }
    }
    return $null
}

# The CozyAgents half of provider-and-model onboarding: the same pair of questions the Hermes path
# asks, answered once, and written to the runner env by Write-RunnerModelEnv.
function Confirm-CozyAgentsModel {
    param([string] $RunnerEnvPath)
    $answers = @{ Provider = ''; Endpoint = ''; Id = ''; ShareHostAuth = $false }
    $provider = $env:COZYGATEWAY_RUNNER_MODEL_PROVIDER
    $endpoint = $env:COZYGATEWAY_RUNNER_MODEL_ENDPOINT
    $id = $env:COZYGATEWAY_RUNNER_MODEL_ID
    if (-not [string]::IsNullOrWhiteSpace($provider) -and -not [string]::IsNullOrWhiteSpace($endpoint)) {
        Fail 'COZYGATEWAY_RUNNER_MODEL_PROVIDER and COZYGATEWAY_RUNNER_MODEL_ENDPOINT are mutually exclusive; a bot has one model source'
    }
    if ((-not [string]::IsNullOrWhiteSpace($provider)) -or (-not [string]::IsNullOrWhiteSpace($endpoint))) {
        if ([string]::IsNullOrWhiteSpace($id)) { Fail 'a model provider or endpoint needs COZYGATEWAY_RUNNER_MODEL_ID as well' }
        $answers.Provider = [string]$provider
        $answers.Endpoint = [string]$endpoint
        $answers.Id = [string]$id
        $source = if ($answers.Provider) { $answers.Provider } else { $answers.Endpoint }
        Write-Ok "default model for new bots: $($answers.Id) on $source"
        return $answers
    }
    if (-not [string]::IsNullOrWhiteSpace($id)) { Fail 'COZYGATEWAY_RUNNER_MODEL_ID needs COZYGATEWAY_RUNNER_MODEL_PROVIDER or COZYGATEWAY_RUNNER_MODEL_ENDPOINT' }
    $savedProvider = Get-RunnerEnvValue $RunnerEnvPath 'COZYRUNNER_MODEL_PROVIDER'
    $savedEndpoint = Get-RunnerEnvValue $RunnerEnvPath 'COZYRUNNER_MODEL_ENDPOINT'
    $savedId = Get-RunnerEnvValue $RunnerEnvPath 'COZYRUNNER_MODEL_ID'
    $validProvider = $savedProvider -and -not $savedEndpoint -and (Test-SafeModelWord $savedProvider)
    $validEndpoint = $savedEndpoint -and -not $savedProvider -and (Test-SafeModelEndpoint $savedEndpoint)
    if ((Test-SafeModelWord $savedId) -and ($validProvider -or $validEndpoint)) {
        $answers.Provider = $savedProvider
        $answers.Endpoint = $savedEndpoint
        $answers.Id = $savedId
        $answers.ShareHostAuth = (Get-RunnerEnvValue $RunnerEnvPath 'COZYRUNNER_SHARE_HOST_MODEL_AUTH') -eq '1'
        $answers.PreserveExisting = $true
        Write-Ok 'CozyAgents provider and model are already configured; keeping the saved model settings'
        return $answers
    }
    if (-not (Test-PromptAvailable 'COZYGATEWAY_TEST_MODEL_PROMPT_INPUT')) {
        Write-Info "no terminal to ask about a model on; set COZYRUNNER_MODEL_PROVIDER (or COZYRUNNER_MODEL_ENDPOINT) and COZYRUNNER_MODEL_ID in $RunnerEnvPath"
        return $answers
    }
    while ($true) {
        $answer = Get-PromptAnswer 'Which provider should new bots use? A provider name (openai-codex) or a local endpoint URL (http://127.0.0.1:1234/v1) [openai-codex]' 'COZYGATEWAY_TEST_MODEL_PROMPT_INPUT' 'openai-codex'
        if ($null -eq $answer) { $answer = 'openai-codex' }
        if ($answer -like 'http://*' -or $answer -like 'https://*') {
            if (Test-SafeModelEndpoint $answer) { $answers.Endpoint = $answer; break }
            Write-Host 'That is not a usable endpoint URL.'
        } else {
            if (Test-SafeModelWord $answer) { $answers.Provider = $answer; break }
            Write-Host 'Provider names are letters, digits, and . _ : / -'
        }
    }
    while ($true) {
        $answer = Get-PromptAnswer 'Which model id should new bots use?' 'COZYGATEWAY_TEST_MODEL_PROMPT_INPUT' ''
        if ($null -ne $answer -and (Test-SafeModelWord $answer)) { $answers.Id = $answer; break }
        Write-Host 'Model ids are letters, digits, and . _ : / -'
    }
    if ($answers.Provider) {
        $codex = Find-CodexLogin
        if ($codex) {
            while ($true) {
                $answer = Get-PromptAnswer "Share the Codex login on this computer ($codex) with the bots that run here, so you never paste an API key? [y/N]" 'COZYGATEWAY_TEST_MODEL_PROMPT_INPUT' 'n'
                if ($null -eq $answer) { break }
                $normalized = $answer.ToLowerInvariant()
                if ($normalized -eq 'y' -or $normalized -eq 'yes') { $answers.ShareHostAuth = $true; break }
                if ($normalized -eq 'n' -or $normalized -eq 'no') { break }
                Write-Host 'Please answer y or n.'
            }
        }
    }
    $source = if ($answers.Provider) { $answers.Provider } else { $answers.Endpoint }
    Write-Ok "default model for new bots: $($answers.Id) on $source"
    return $answers
}

# Windows ignores the POSIX mode on a file, so a 0600 there is a lie. This resets the ACL to the
# owning user plus SYSTEM with inheritance disabled, and throws when it cannot.
function Protect-FileToOwner {
    param([string] $Path)
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($currentUser, $system)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $identity,
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    if ($PSVersionTable.PSEdition -eq 'Core') {
        [IO.FileSystemAclExtensions]::SetAccessControl((Get-Item -LiteralPath $Path), $acl)
    } else {
        (Get-Item -LiteralPath $Path).SetAccessControl($acl)
    }
}

function Get-RunnerEnvValue {
    param([string] $Path, [string] $Name)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $line = Get-Content -LiteralPath $Path | Where-Object { $_ -like "$Name=*" } | Select-Object -Last 1
    if (-not $line) { return '' }
    return ([string]$line).Substring($Name.Length + 1).Trim()
}

function Set-RunnerEnvValue {
    param([string] $Path, [string] $Name, [string] $Value, [switch] $Remove)
    $lines = @()
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $lines = @(Get-Content -LiteralPath $Path | Where-Object { -not ($_ -like "$Name=*") })
    }
    if (-not $Remove) { $lines += "$Name=$Value" }
    [IO.File]::WriteAllText($Path, (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
    Protect-FileToOwner $Path
}

# The answers land in the runner env CozyAgents already reads, next to the pairing token and never
# in this installer's own state. No key is ever written here.
function Write-RunnerModelEnv {
    param([string] $RunnerEnvPath, [hashtable] $Answers)
    if ($Answers.ContainsKey('PreserveExisting') -and $Answers.PreserveExisting) { return }
    if (-not $Answers.Provider -and -not $Answers.Endpoint) { return }
    if (-not $Answers.Id) { return }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $RunnerEnvPath) | Out-Null
    Set-RunnerEnvValue $RunnerEnvPath 'COZYRUNNER_MODEL_ID' $Answers.Id
    if ($Answers.Provider) {
        Set-RunnerEnvValue $RunnerEnvPath 'COZYRUNNER_MODEL_ENDPOINT' '' -Remove
        Set-RunnerEnvValue $RunnerEnvPath 'COZYRUNNER_MODEL_PROVIDER' $Answers.Provider
    } else {
        Set-RunnerEnvValue $RunnerEnvPath 'COZYRUNNER_MODEL_PROVIDER' '' -Remove
        Set-RunnerEnvValue $RunnerEnvPath 'COZYRUNNER_MODEL_ENDPOINT' $Answers.Endpoint
    }
    if ($Answers.ShareHostAuth) { Set-RunnerEnvValue $RunnerEnvPath 'COZYRUNNER_SHARE_HOST_MODEL_AUTH' '1' }
    Write-Ok "wrote the default model for new bots to $RunnerEnvPath"
}

function Resolve-CozyAgentsHome {
    $candidate = $env:COZYAGENTS_HOME
    if ([string]::IsNullOrWhiteSpace($candidate) -and (Get-Variable -Name PendingSetupPlan -Scope Script -ErrorAction SilentlyContinue) -and $script:PendingSetupPlan) {
        $candidate = [string]$script:PendingSetupPlan.AgentsHome
    }
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $record = Join-Path $script:InstallHome 'local\install-state'
        if (Test-Path -LiteralPath $record -PathType Leaf) {
            $line = Get-Content -LiteralPath $record | Where-Object { $_ -like 'cozyagents_home=*' } | Select-Object -Last 1
            if ($line) {
                $candidate = $line.Substring(16)
                if ($candidate -match '^/([A-Za-z])/(.*)$') { $candidate = $matches[1] + ':\' + $matches[2].Replace('/', '\') }
                elseif ($candidate -notmatch '^//[^/]+/[^/]+') { Fail 'installer state has an unsafe CozyAgents home' }
            }
        }
    }
    if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = Join-Path $env:USERPROFILE '.cozyagents' }
    return ([IO.Path]::GetFullPath($candidate)).TrimEnd('\')
}

function Save-CozyAgentsState {
    param([string] $StatePath, [string] $HarnessName, [string] $AgentsHome)
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { Fail 'the gateway did not write installation metadata' }
    $homePosix = $AgentsHome.Replace('\', '/')
    if ($homePosix -match '^([A-Za-z]):/(.*)$') { $homePosix = '/' + $matches[1].ToLowerInvariant() + '/' + $matches[2] }
    if ($homePosix -match '[\r\n]') { Fail 'CozyAgents home must not contain a newline' }
    $lines = @(Get-Content -LiteralPath $StatePath | Where-Object { $_ -notmatch '^(harness|cozyagents_home)=' })
    $lines += @("harness=$HarnessName", "cozyagents_home=$homePosix")
    [IO.File]::WriteAllText($StatePath, (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
}

function Get-CozyAgentsInstallerSource {
    param([string] $Requested)
    if (-not [string]::IsNullOrWhiteSpace($Requested)) { return $Requested }
    if (-not [string]::IsNullOrWhiteSpace($env:COZYAGENTS_INSTALL_URL)) { return $env:COZYAGENTS_INSTALL_URL }
    return $script:CozyAgentsInstallUrlDefault
}

function Get-CozyAgentsInstallerDigest {
    param([string] $Source, [string] $Requested)
    $expected = if (-not [string]::IsNullOrWhiteSpace($Requested)) { $Requested } elseif (-not [string]::IsNullOrWhiteSpace($env:COZYAGENTS_INSTALL_SHA256)) { $env:COZYAGENTS_INSTALL_SHA256 } elseif ($Source -eq $script:CozyAgentsInstallUrlDefault) { $script:CozyAgentsInstallSha256Default } else { $null }
    if ([string]::IsNullOrWhiteSpace($expected)) { Fail 'COZYAGENTS_INSTALL_SHA256 is required for a custom CozyAgents installer source' }
    if ($expected -notmatch '^[A-Fa-f0-9]{64}$') { Fail 'COZYAGENTS_INSTALL_SHA256 must be a SHA-256 digest' }
    return $expected.ToLowerInvariant()
}

# The CozyAgents half of the install: its own verified one-liner does the bundle, the private Node,
# the launcher and the scheduled task, and this script pairs it, because it is the one side that
# can mint a runner code without asking anybody to read one off a screen. The installer is run in
# this process the way irm | iex runs it, so no execution policy is consulted or changed.
function Install-CozyAgentsHarness {
    param([string] $AgentsHome, [string] $Source, [string] $ExpectedSha256)
    Write-Info 'installing CozyAgents, the harness that runs your bots on this machine.'
    # The scriptblock runs in this script's session state, so its $script: variables are this
    # script's: its $script:Tag, $script:Repo and $script:AssetBase are the same names as $tag,
    # $repo and $base here. Nothing reads those after this point; do not start.
    $staged = Join-Path ([IO.Path]::GetTempPath()) ('cozyagents-install-' + [guid]::NewGuid().ToString('N') + '.ps1')
    $previousAgentsHome = [Environment]::GetEnvironmentVariable('COZYAGENTS_HOME', 'Process')
    try {
        Copy-OrDownload $Source $staged
        $actual = (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $ExpectedSha256) { Fail 'CozyAgents installer checksum mismatch' }
        Write-Ok 'verified CozyAgents installer SHA-256'
        $content = [IO.File]::ReadAllText($staged).TrimStart([char]0xFEFF)
        $env:COZYAGENTS_HOME = $AgentsHome
        & ([scriptblock]::Create($content)) -NoPair -InstallHome $AgentsHome
    } finally {
        [Environment]::SetEnvironmentVariable('COZYAGENTS_HOME', $previousAgentsHome, 'Process')
        Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath (Join-Path $AgentsHome 'install.json') -PathType Leaf)) {
        Fail 'the CozyAgents install did not complete successfully'
    }
}

# node plus the bundle rather than the cozyagents.cmd launcher this install also writes: PowerShell
# runs a .cmd through cmd.exe, which parses the command line a second time, and a computer name or
# a gateway URL carrying an ampersand would then split it.
# Functions staged for inclusion in the published single-file Windows bootstrap.
function Update-CozyAgentsHarness {
    param([string] $AgentsHome, [bool] $DryRun = $false)
    if ($DryRun) { Write-Info 'dry run: would update CozyAgents from its saved verified release source and require its running version to attach'; return }
    $command = Get-CozyAgentsCommand $AgentsHome
    Write-Info 'Updating CozyAgents and restarting its runner with the existing pairing and model settings.'
    # Keep raw child output private: failures can include paths, URLs or environment values.
    $output = ''
    $exitCode = -1
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Node may write nonfatal runtime warnings to stderr before its JSON result.
        # Only stdout is the protocol; never surface raw diagnostics or mistake them for JSON.
        $ErrorActionPreference = 'Continue'
        $output = (& $command.Node $command.Bundle update --home $AgentsHome --json 2>$null | Out-String)
        $exitCode = $LASTEXITCODE
    } catch { Fail 'CozyAgents update could not run; the update was not verified. Repair CozyAgents with its official Windows installer, then retry.' }
    finally { $ErrorActionPreference = $previousErrorActionPreference }
    $result = $null
    try { $result = $output | ConvertFrom-Json -ErrorAction Stop } catch { }
    $status = if ($result -and $result.PSObject.Properties['status']) { [string]$result.status } else { '' }
    if ($exitCode -ne 0 -or $status -ne 'succeeded') {
        if ($status -eq 'rolled_back') { Fail 'CozyAgents update failed readiness and restored its previous release; the overall update did not complete.' }
        $code = if ($result -and $result.PSObject.Properties['code']) { [string]$result.code } else { '' }
        if ($code -eq 'rollback_failed') { Fail 'CozyAgents update and recovery failed. Keep its pairing and bot files and repair with the official Windows installer.' }
        Fail 'CozyAgents update did not report verified success. Repair CozyAgents with its official Windows installer, then retry.'
    }
    $version = if ($result.PSObject.Properties['resultingVersion']) { [string]$result.resultingVersion } else { '' }
    if ($version -notmatch '^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' -or
        -not $result.PSObject.Properties['restarted'] -or $result.restarted -isnot [bool] -or -not $result.restarted) {
        Fail 'CozyAgents update returned incomplete running-version evidence; the overall update was not verified.'
    }
    Write-Ok "CozyAgents $version updated and attached on its verified running release"
    return [pscustomobject]@{ Status = 'succeeded'; Version = $version }
}

function Update-HermesHarness {
    param([string] $HermesPath, [bool] $DryRun = $false)
    if ($DryRun) { Write-Info 'dry run: would run the Hermes updater and verify its version and launcher'; return }
    $before = Get-HermesVersion $HermesPath
    Write-Info 'Updating Hermes Agent with its supported Windows updater.'
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $HermesPath update --yes 2>&1 | ForEach-Object { Write-Host ([string]$_) }
        $exitCode = $LASTEXITCODE
    } catch { Fail 'Hermes update could not complete; resolve the Hermes updater error and retry. The overall update was not verified.' }
    finally { $ErrorActionPreference = $previousErrorActionPreference }
    if ($exitCode -ne 0) { Fail 'Hermes update failed or was refused; close other Hermes sessions, resolve the updater error, and retry. The overall update did not complete.' }
    Ensure-HermesLauncherInterpreter $HermesPath
    $after = Get-HermesVersion $HermesPath
    if (-not (Test-CompatibleHermesVersion $after)) { Fail "Hermes update did not install a compatible stable version (found v$($after.Text); v0.21.0 or newer is required)" }
    Write-Ok "updated Hermes from v$($before.Text) to v$($after.Text); gateway attachment will be checked after restart"
    return [pscustomobject]@{ Status = 'succeeded'; Version = $after.Text }
}

function Get-CozyAgentsCommand {
    param([string] $AgentsHome)
    $statePath = Join-Path $AgentsHome 'install.json'
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $nodeProperty = $state.PSObject.Properties['node']
    $node = if ($nodeProperty) { [string]$nodeProperty.Value } else { '' }
    $bundle = ''
    $bundleRecord = $null
    $schema = $state.PSObject.Properties['schemaVersion']
    if ($schema) {
        if ($schema.Value -ne 1) { Fail 'the CozyAgents install record has an unsupported schema version' }
        $assets = $state.PSObject.Properties['assets']
        if ($assets) {
            $main = @($assets.Value | Where-Object { $_.PSObject.Properties['name'] -and $_.name -eq 'cozyagents.mjs' })
            if ($main.Count -eq 1 -and $main[0].PSObject.Properties['path']) {
                $bundleRecord = $main[0]
                $bundle = [string]$bundleRecord.path
            }
        }
    } else {
        $legacyBundle = $state.PSObject.Properties['bundle']
        if ($legacyBundle -and $legacyBundle.Value.PSObject.Properties['path']) {
            $bundleRecord = $legacyBundle.Value
            $bundle = [string]$bundleRecord.path
        }
    }
    if ([string]::IsNullOrWhiteSpace($node) -or [string]::IsNullOrWhiteSpace($bundle)) {
        Fail 'the CozyAgents install did not record the node and bundle this computer pairs with'
    }
    return @{ Node = $node; Bundle = $bundle; BundleRecord = $bundleRecord }
}

function Test-CozyAgentsRuntime {
    param([string] $AgentsHome)
    try {
        $command = Get-CozyAgentsCommand $AgentsHome
        # Metadata alone does not mean an interrupted installation is usable.
        foreach ($path in @($command.Node, $command.Bundle)) {
            if (-not [IO.Path]::IsPathRooted($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
            $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
            try {
                if ($stream.Length -eq 0) { return $false }
                if ($path -eq $command.Bundle) {
                    # Legacy records may omit integrity fields. When recorded, they must
                    # still match before an elevated update can skip verified setup.
                    $size = $command.BundleRecord.PSObject.Properties['size']
                    if ($size -and (($size.Value -isnot [int] -and $size.Value -isnot [long]) -or $size.Value -ne $stream.Length)) { return $false }
                    $digest = $command.BundleRecord.PSObject.Properties['sha256']
                    if ($digest) {
                        if ($digest.Value -isnot [string] -or $digest.Value -notmatch '^[a-fA-F0-9]{64}$') { return $false }
                        $sha = [Security.Cryptography.SHA256]::Create()
                        try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
                        if ($actual -ne $digest.Value) { return $false }
                    }
                }
            } finally { $stream.Dispose() }
        }
        return $true
    } catch { return $false }
}

function Get-GatewayOrigin {
    param([string] $ConfigPath)
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { Fail "CozyGateway did not write its configuration at $ConfigPath" }
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $names = @($config.PSObject.Properties.Name)
    if ($names -contains 'publicUrl' -and -not [string]::IsNullOrWhiteSpace([string]$config.publicUrl)) { return ([string]$config.publicUrl) }
    $listenHost = [string]$config.host
    if ($listenHost -eq '0.0.0.0' -or $listenHost -eq '::') { $listenHost = '127.0.0.1' }
    elseif ($listenHost.Contains(':')) { $listenHost = "[$listenHost]" }
    return "http://$listenHost`:$([string]$config.port)"
}

# One runner pairing code, minted here through the gateway's own CLI and handed straight to the
# CozyAgents runner, so nobody types a code to pair the machine they are standing at. It is never
# printed, never logged, and never reaches an argument.
function New-RunnerPairCode {
    param([string] $Cli)
    $output = (& $Cli pair --kind runner --ttl 10 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { Fail "could not mint a runner pairing code; the gateway is installed, so retry with: $Cli pair --kind runner" }
    $match = [regex]::Match($output, '(?m)^Setup code:\s*(?<code>\S+)\s*$')
    if (-not $match.Success) { Fail 'the gateway did not return a usable runner pairing code' }
    $code = $match.Groups['code'].Value
    if ($code -cnotmatch '^[A-Za-z0-9-]{4,64}$') { Fail 'the gateway did not return a usable runner pairing code' }
    return $code
}

function Join-RunnerToGateway {
    param([string] $AgentsHome, [string] $Cli, [string] $ConfigPath)
    $runnerEnv = Join-Path $AgentsHome 'runner.env'
    # A computer that is already paired keeps the runner credential it has,
    # exactly as a second run leaves device trust alone.
    if (Get-RunnerEnvValue $runnerEnv 'COZYRUNNER_TOKEN') {
        Write-Ok 'this computer is already paired to CozyGateway as a runner; keeping that pairing'
        return
    }
    $origin = Get-GatewayOrigin $ConfigPath
    $name = $env:COMPUTERNAME
    if ([string]::IsNullOrWhiteSpace($name)) { $name = [Environment]::MachineName }
    $command = Get-CozyAgentsCommand $AgentsHome
    $code = New-RunnerPairCode $Cli
    # The code travels in the environment, never in an argument: it is a credential in waiting, and
    # an argument is readable by every other process on this machine while the command runs.
    $previous = [Environment]::GetEnvironmentVariable('COZYAGENTS_PAIR_CODE', 'Process')
    try {
        $env:COZYAGENTS_PAIR_CODE = $code
        & $command.Node $command.Bundle runner pair --gateway $origin --name $name --home $AgentsHome
        if ($LASTEXITCODE -ne 0) {
            Fail "CozyAgents is installed but pairing did not complete; mint a code with `"$Cli pair --kind runner`" and run: cozyagents runner pair <code> --gateway $origin"
        }
    } finally {
        [Environment]::SetEnvironmentVariable('COZYAGENTS_PAIR_CODE', $previous, 'Process')
    }
    Write-Ok "CozyAgents is paired to $origin as `"$name`"; bots you make in CozyChat run here"
}

# The network question, asked once on a fresh install and answered by the listener the shared
# installer is then told to use. An install that already has a listener keeps it.
function Select-Listener {
    param([bool] $AlreadyConfigured, [string[]] $ForwardedArguments)
    if ($AlreadyConfigured) { return @() }
    foreach ($flag in @('--bind-host', '--public-url', '--clear-public-url')) {
        if ($ForwardedArguments -contains $flag) { return @() }
    }
    while ($true) {
        $answer = Get-PromptAnswer 'Allow CozyChat to access this Gateway over your local network? [y/N]' 'COZYGATEWAY_TEST_LAN_PROMPT_INPUT' 'n'
        if ($null -eq $answer) { break }
        $normalized = $answer.ToLowerInvariant()
        if ($normalized -eq 'y' -or $normalized -eq 'yes') { return @('--bind-host', '0.0.0.0') }
        if ($normalized -eq 'n' -or $normalized -eq 'no') { break }
        Write-Host 'Please answer y or n.'
    }
    return @('--bind-host', '127.0.0.1')
}

# First setup ends ready to scan. Routine updates preserve device trust without
# asking an optional question; `cozygateway pair` explicitly adds another device.
function Complete-Pairing {
    param([string] $Cli, [bool] $AlreadyConfigured, [bool] $NoQr)
    $mint = $false
    if ($NoQr) {
        Write-Info "no pairing QR was printed (--no-qr); run $Cli pair when you want to add a device"
    } elseif (-not $AlreadyConfigured) {
        $mint = $true
    } else {
        Write-Info "no new pairing code created; run $Cli pair when you want to add a device"
    }
    if ($mint) {
        & $Cli pair
        if ($LASTEXITCODE -ne 0) { Fail "could not create a pairing code; the gateway is installed, so retry with: $Cli pair" }
    }
    Write-Info "codes expire after 10 minutes; mint a fresh QR and code with: $Cli pair"
    Write-Info 'for a tunnel, rerun the installer with: --public-url https://gateway.example.com'
}

# The CozyAgents branch: the same gateway with no Hermes discovery, no plugin and no Dashboard,
# plus the harness, its runner pairing, and the model answers the runner reads.


# A CozyAgents uninstall takes back exactly what this bootstrap put there: the gateway through the
# shared installer, and the harness through the CozyAgents uninstaller, which owns its launcher,
# its PATH line, its task and its runner state.
function Get-WindowsSetupPlan {
    param([string] $InstallRoot)
    $path = Join-Path $InstallRoot 'local\windows-setup.json'
    Assert-BootstrapRegularFile $path 'Windows setup receipt'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $receipt = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        if ($receipt.schemaVersion -ne 1) { throw 'unsupported schema' }
        if (-not $receipt.PSObject.Properties['harness']) { return $null }
        if ($receipt.harness -notin @('hermes', 'cozyagents', 'both')) { throw 'invalid selection' }
        $pairingPending = $receipt.PSObject.Properties['pairingPending'] -and $receipt.pairingPending -eq $true
        if (-not $pairingPending -and -not @($receipt.components.PSObject.Properties | Where-Object { $_.Value -ne 'succeeded' }).Count) { return $null }
        $agentsHome = if ($receipt.PSObject.Properties['agentsHome']) { [string]$receipt.agentsHome } else { '' }
        if ($agentsHome -and -not [IO.Path]::IsPathRooted($agentsHome)) { throw 'invalid home' }
        return [pscustomobject]@{ Harness = [string]$receipt.harness; AgentsHome = $agentsHome; PairingPending = [bool]$pairingPending }
    } catch { Fail 'Windows setup progress is unreadable; existing product files were not changed' }
}

function Set-WindowsSetupStage {
    param([string] $InstallRoot, [string] $Component, [string] $Status, [string] $HarnessName = '', [string] $AgentsHome = '', [bool] $PairingPending = $false)
    if ($Component -notin @('gateway', 'hermes', 'cozyagents') -or $Status -notin @('started', 'succeeded', 'failed')) { Fail 'invalid Windows setup stage' }
    $path = Join-Path $InstallRoot 'local\windows-setup.json'
    $next = "$path.next"
    Assert-BootstrapRegularFile $path 'Windows setup receipt'
    Assert-BootstrapRegularFile $next 'Windows setup receipt staging'
    $components = @{}
    $savedHarness = $HarnessName
    $savedHome = $AgentsHome
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        try {
            $previous = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
            if ($previous.schemaVersion -ne 1) { throw 'unsupported schema' }
            if (-not $PSBoundParameters.ContainsKey('PairingPending') -and $previous.PSObject.Properties['pairingPending']) { $PairingPending = [bool]$previous.pairingPending }
            if (-not $savedHarness -and $previous.PSObject.Properties['harness']) {
                $savedHarness = [string]$previous.harness
                $savedHome = if ($previous.PSObject.Properties['agentsHome']) { [string]$previous.agentsHome } else { '' }
            }
            foreach ($property in $previous.components.PSObject.Properties) {
                if ($property.Name -notin @('gateway', 'hermes', 'cozyagents') -or $property.Value -notin @('started', 'succeeded', 'failed')) { throw 'invalid component' }
                $components[$property.Name] = [string]$property.Value
            }
        } catch { Fail 'Windows setup progress is unreadable; existing product files were not changed' }
    }
    $components[$Component] = $Status
    New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
    $receipt = [ordered]@{ schemaVersion = 1; updatedAt = [DateTime]::UtcNow.ToString('o'); components = $components; pairingPending = $PairingPending }
    if ($savedHarness) {
        if ($savedHarness -notin @('hermes', 'cozyagents', 'both') -or ($savedHome -and -not [IO.Path]::IsPathRooted($savedHome))) { Fail 'invalid Windows setup plan' }
        $receipt.harness = $savedHarness
        $receipt.agentsHome = $savedHome
    }
    [IO.File]::WriteAllText($next, ($receipt | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $next -Destination $path -Force
}

function Invoke-WindowsSetupStage {
    param([string] $InstallRoot, [string] $Component, [scriptblock] $Action)
    Set-WindowsSetupStage $InstallRoot $Component 'started'
    try {
        & $Action
        Set-WindowsSetupStage $InstallRoot $Component 'succeeded'
    } catch {
        $failure = $_
        try { Set-WindowsSetupStage $InstallRoot $Component 'failed' } catch { Write-Warning 'Setup could not save its progress; product recovery records were preserved.' }
        Write-Warning "$Component did not complete. Rerun the Windows one-liner to retry; completed components and existing pairing are preserved."
        throw $failure
    }
}

function Uninstall-WithCozyAgents {
    param([string] $Bin, [string] $InstallerPath, [string[]] $ForwardedArguments, [bool] $IsDryRun)
    $agentsHome = Resolve-CozyAgentsHome
    $bash = Resolve-GitBash $env:COZYGATEWAY_GIT_BASH 'Install Git for Windows from https://git-scm.com/download/win, then paste this command again.'
    if (-not (Test-Path -LiteralPath $InstallerPath)) { Fail "no CozyGateway installer was found at $InstallerPath" }
    $arguments = @($InstallerPath, '--service-platform', 'Windows', '--gateway-dir', $script:InstallHome) + @($ForwardedArguments)
    if ($IsDryRun -and -not ($arguments -contains '--dry-run')) { $arguments += '--dry-run' }
    $previousOwner = [Environment]::GetEnvironmentVariable('COZYGATEWAY_WINDOWS_HARNESS_OWNER', 'Process')
    try {
        $env:COZYGATEWAY_WINDOWS_HARNESS_OWNER = '1'
        & $bash @arguments
        if ($LASTEXITCODE -ne 0) { Fail "CozyGateway installer exited $LASTEXITCODE" }
    } finally {
        [Environment]::SetEnvironmentVariable('COZYGATEWAY_WINDOWS_HARNESS_OWNER', $previousOwner, 'Process')
    }
    if ($IsDryRun) {
        Write-Info "dry run: would remove the CozyAgents harness through its own uninstaller at $agentsHome"
        return
    }
    Set-CozyGatewayCommandPath $Bin $false
    if (Test-Path -LiteralPath (Join-Path $agentsHome 'install.json') -PathType Leaf) {
        $command = Get-CozyAgentsCommand $agentsHome
        & $command.Node $command.Bundle uninstall --home $agentsHome --yes
        if ($LASTEXITCODE -ne 0) { Fail "the CozyAgents harness could not be removed; run: cozyagents uninstall --home $agentsHome" }
        Write-Ok 'removed the CozyAgents harness through its own uninstaller'
    } else {
        Write-Host "WARN  the cozyagents command is gone; leaving $agentsHome untouched"
    }
}

if ($PSVersionTable.PSVersion.Major -lt 5) { Fail 'Windows PowerShell 5.1 or newer is required' }
$script:InstallerSourceText = Get-CozyInstallerSourceText
$session = Invoke-CozyInstallerSession -ScriptText $script:InstallerSourceText -BoundParameters $script:InstallerBoundParameters -InstallerArguments $InstallerArguments
if ($session.HandedOff) {
    $global:LASTEXITCODE = $session.ExitCode
    if ($session.ExitCode -ne 0) {
        $detail = if ($session.ErrorMessage) { $session.ErrorMessage } else { 'The setup window exited without error details. Rerun this one-liner to retry.' }
        Fail "Windows setup did not complete (exit $($session.ExitCode)): $detail"
    }
    return
}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$script:InstallHome = Resolve-InstallHome $env:COZYGATEWAY_HOME
$bin = Join-Path $script:InstallHome 'bin'
$installerPath = Join-Path $bin 'agent-install.sh'
$bootstrapPath = Join-Path $bin 'cozygateway-bootstrap.ps1'
$cliPath = Join-Path $bin 'cozygateway.cmd'
$statePath = Join-Path $script:InstallHome 'local\install-state'
$configPath = Join-Path $script:InstallHome 'local\cozygateway.config.json'
$sourcePath = Join-Path $script:InstallHome 'local\bootstrap-source'
$explicitAssetBase = $env:COZYGATEWAY_INSTALL_ASSET_BASE
$isUninstall = $InstallerArguments -contains '--uninstall'
$isDryRun = $env:COZYGATEWAY_INSTALL_DRYRUN -eq '1' -or $InstallerArguments -contains '--dry-run'
$isNoQr = $InstallerArguments -contains '--no-qr'
$alreadyConfigured = Test-Path -LiteralPath $configPath -PathType Leaf
$cozyAgentsInstaller = Get-CozyAgentsInstallerSource $CozyAgentsInstaller
$script:CozyAgentsInstallerSha256 = Get-CozyAgentsInstallerDigest $cozyAgentsInstaller $CozyAgentsInstallerSha256

if ($Repair) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf) -or -not (Test-Path -LiteralPath "$bootstrapPath.sha256" -PathType Leaf)) {
        Fail 'repair bootstrap is unavailable. Reinstall with: irm https://cozylabs.ai/install.ps1 | iex'
    }
    $expected = ((Get-Content -LiteralPath "$bootstrapPath.sha256" -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $bootstrapPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($expected) -or $expected -ne $actual) {
        Fail 'repair bootstrap checksum mismatch. Reinstall with: irm https://cozylabs.ai/install.ps1 | iex'
    }
    if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
        $recordedSource = (Get-Content -LiteralPath $sourcePath -Raw).Trim()
        if ($recordedSource -notmatch '^file:///.+') { Fail 'recorded repair source is invalid. Reinstall with: irm https://cozylabs.ai/install.ps1 | iex' }
        $env:COZYGATEWAY_INSTALL_ASSET_BASE = $recordedSource
        $explicitAssetBase = $recordedSource
    }
    $repairHarness = Get-RecordedHarness $statePath
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { Fail 'repair metadata is unavailable. Reinstall with: irm https://cozylabs.ai/install.ps1 | iex' }
    $repairMode = if ($repairHarness -eq 'cozyagents' -and $Harness -in @('hermes', 'both')) { '' } else { Get-PersistedRepairMode $statePath }
    if ($repairMode -eq 'runtime-only' -and $InstallerArguments -notcontains '--runtime-only') {
        $InstallerArguments = @('--runtime-only') + @($InstallerArguments)
    }
    if ($repairHarness -and -not $Harness) { $Harness = $repairHarness }
    if ($Harness -eq 'cozyagents') {
        Write-Info 'repair refreshes verified runtime assets, then restarts CozyGateway'
    } elseif ($repairMode -eq 'runtime-only') {
        Write-Info 'repair refreshes verified runtime assets, then restarts CozyGateway'
    } elseif ($repairHarness -in @('hermes', 'both')) {
        $InstallerArguments = @('--profiles', (Get-PersistedRepairProfiles $statePath)) + @($InstallerArguments)
        Write-Info 'repair refreshes verified runtime and plugin assets, then restarts CozyGateway and Hermes attachment'
    }
}

if ($isUninstall) {
    $recorded = Get-RecordedHarness $statePath
    if ($recorded -in @('cozyagents', 'both') -or $Harness -in @('cozyagents', 'both')) {
        Uninstall-WithCozyAgents $bin $installerPath $InstallerArguments ([bool]$isDryRun)
        return
    }
    $bash = Resolve-GitBash $env:COZYGATEWAY_GIT_BASH
    if (-not (Test-Path -LiteralPath $installerPath)) { Fail "no CozyGateway installer was found at $installerPath" }
    $uninstallArguments = @($installerPath, '--service-platform', 'Windows', '--gateway-dir', $script:InstallHome) + @($InstallerArguments)
    if ($isDryRun -and -not ($uninstallArguments -contains '--dry-run')) { $uninstallArguments += '--dry-run' }
    & $bash @uninstallArguments
    if ($LASTEXITCODE -ne 0) { Fail "CozyGateway installer exited $LASTEXITCODE" }
    if (-not $isDryRun) { Set-CozyGatewayCommandPath $bin $false }
    return
}

# Step 1 of the approved order: the harness, before anything is installed.
$script:PendingSetupPlan = Get-WindowsSetupPlan $script:InstallHome
if ($script:PendingSetupPlan -and (-not $Harness -or ($Repair -and -not $script:InstallerBoundParameters.ContainsKey('Harness')))) {
    $Harness = $script:PendingSetupPlan.Harness
    Write-Info "Resuming the incomplete $Harness setup with the saved component homes."
}
$harness = Select-Harness $Harness $statePath $configPath
if ($isDryRun) {
    if ($harness -in @('cozyagents', 'both')) {
        $agentsHome = Resolve-CozyAgentsHome
        Write-Info "dry run: would ask for the model provider or a local endpoint, and the model id, then write COZYRUNNER_MODEL_* into $(Join-Path $agentsHome 'runner.env')"
        Write-Info 'dry run: would ask whether CozyChat may reach this Gateway over your local network'
        if ($harness -eq 'cozyagents') { Write-Info 'dry run: would resolve and checksum-verify the CozyGateway release assets, and no Hermes attach plugin' }
        Write-Info "dry run: would install CozyGateway under $script:InstallHome without administrator rights"
        Write-Info 'dry run: would install or update CozyAgents and verify its running version, preserving existing pairing'
        if ($harness -eq 'cozyagents') { $global:LASTEXITCODE = 0; return }
    }
    if (Find-Hermes) {
        Write-Info 'dry run: would update Hermes, inspect model status and open model selection only when setup is incomplete'
    } else {
        Write-Info 'dry run: would install Hermes Agent, inspect its model status, and open model selection only when setup is incomplete'
    }
    Write-Info 'dry run: would resolve and checksum-verify the CozyGateway release assets'
    Write-Info "dry run: would install CozyGateway under $script:InstallHome without administrator rights"
    $global:LASTEXITCODE = 0
    return
}

$base = $env:COZYGATEWAY_INSTALL_ASSET_BASE
# Every product change shares one Windows session lock. Its OS handle is released
# automatically after a killed process, so the next one-liner can recover.
Protect-CozyGatewayHome $script:InstallHome
Acquire-BootstrapLock $script:InstallHome
$stage = $null
try {
    $assets = @('cozygateway.mjs', 'agent-install.sh', 'gateway-supervisor.cjs', 'cozygateway-bootstrap.ps1')
    if ($harness -ne 'cozyagents') { $assets += 'cozygateway-hermes-attach-plugin.tar.gz' }
    $recovered = Recover-BootstrapTransaction $script:InstallHome $bin $assets
    if ($recovered) {
        Restart-OwnedGatewayService $script:InstallHome
        Finish-BootstrapRecovery $script:InstallHome
    }
    # Check the complete release before modifying any harness.
    $base = Resolve-BootstrapReleaseBase $base
    $stage = Join-Path $script:InstallHome ('.bootstrap-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $stage
    foreach ($asset in $assets) {
        $publishedName = switch ($asset) {
            'agent-install.sh' { 'cozygateway-installer.sh' }
            'cozygateway-bootstrap.ps1' { 'install.ps1' }
            default { $asset }
        }
        Get-VerifiedAsset $publishedName (Join-Path $stage $asset) $base
    }
    $script:BundlePath = Join-Path $bin 'cozygateway.mjs'
    $script:PluginPath = Join-Path $bin 'cozygateway-hermes-attach-plugin.tar.gz'
    $script:ResolvedHermes = ''
    $agentsHome = if ($harness -in @('cozyagents', 'both')) { Resolve-CozyAgentsHome } else { '' }
    $pairingPending = -not $alreadyConfigured -or ($script:PendingSetupPlan -and $script:PendingSetupPlan.PairingPending)
    Set-WindowsSetupStage $script:InstallHome 'gateway' 'started' $harness $agentsHome -PairingPending $pairingPending
    if ($harness -ne 'cozyagents') { Set-WindowsSetupStage $script:InstallHome 'hermes' 'started' }
    if ($harness -ne 'hermes') { Set-WindowsSetupStage $script:InstallHome 'cozyagents' 'started' }
    if ($harness -ne 'cozyagents') {
        Invoke-WindowsSetupStage $script:InstallHome 'hermes' {
            $script:ResolvedHermes = Resolve-Hermes $env:COZYGATEWAY_HERMES_INSTALL_URL
            Confirm-HermesModel $script:ResolvedHermes -FreshInstall $script:FreshHermesInstall
            Ensure-HermesDashboardAssets $script:ResolvedHermes
        }
    }
    $bash = Resolve-GitBash $env:COZYGATEWAY_GIT_BASH
    $model = $null
    if ($harness -in @('cozyagents', 'both')) {
        $agentsHome = Resolve-CozyAgentsHome
        $model = Confirm-CozyAgentsModel (Join-Path $agentsHome 'runner.env')
    }
    $listener = @(Select-Listener $alreadyConfigured $InstallerArguments)
    if ($harness -ne 'hermes' -or $alreadyConfigured) { $listener += '--no-qr' }
    # The same profile scope is preserved for regular reruns and repair.
    if ($alreadyConfigured -and -not $Repair -and (Get-RecordedHarness $statePath) -in @('hermes', 'both') -and $InstallerArguments -notcontains '--profiles') {
        if ((Get-PersistedRepairMode $statePath) -eq 'runtime-only') {
            if ($InstallerArguments -notcontains '--runtime-only') { $InstallerArguments = @('--runtime-only') + @($InstallerArguments) }
        } elseif (Test-Path -LiteralPath $statePath -PathType Leaf) {
            $InstallerArguments = @('--profiles', (Get-PersistedRepairProfiles $statePath)) + @($InstallerArguments)
        }
    }
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    Invoke-WindowsSetupStage $script:InstallHome 'gateway' {
        Invoke-TransactionalRelease $script:InstallHome $bin $stage $assets {
            $gatewayHarness = if ($harness -eq 'cozyagents') { 'cozyagents' } else { 'hermes' }
            Invoke-CozyGatewayInstaller $bash $installerPath $script:ResolvedHermes $InstallerArguments $gatewayHarness $listener
            Save-ExplicitBootstrapSource $script:InstallHome $explicitAssetBase
            Set-CozyGatewayCommandPath $bin $true
            if ($harness -in @('cozyagents', 'both')) {
                # Persist the selected home so interrupted harness setup can be resumed.
                Save-CozyAgentsState $statePath $harness $agentsHome
            }
        } {
            Restart-OwnedGatewayService $script:InstallHome
        }
    }
    if ($harness -in @('cozyagents', 'both')) {
        # Product-local recovery: a runner failure must not rewind a healthy gateway.
        Invoke-WindowsSetupStage $script:InstallHome 'cozyagents' {
            if (-not (Test-CozyAgentsRuntime $agentsHome)) {
                Install-CozyAgentsHarness $agentsHome $cozyAgentsInstaller $script:CozyAgentsInstallerSha256
            }
            Write-RunnerModelEnv (Join-Path $agentsHome 'runner.env') $model
            Join-RunnerToGateway $agentsHome $cliPath $configPath
            $null = Update-CozyAgentsHarness $agentsHome
        }
    }
    if ($harness -ne 'hermes' -or $alreadyConfigured) { Complete-Pairing $cliPath (-not $pairingPending) $isNoQr }
    Set-WindowsSetupStage $script:InstallHome 'gateway' 'succeeded' -PairingPending $false
    Write-Ok "Windows setup complete: CozyGateway and $harness are ready"
    $global:LASTEXITCODE = 0
} finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) {
        Assert-BootstrapTreeSafe $stage
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
    Release-BootstrapLock
}

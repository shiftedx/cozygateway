$ErrorActionPreference = 'Stop'

function Assert-True {
    param([bool] $Condition, [string] $Message)
    if (-not $Condition) { throw "ASSERT: $Message" }
}

function Write-Utf8NoBom {
    param([string] $Path, [string] $Content)
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Invoke-Spike {
    param(
        [string] $Spike,
        [string] $FakeTailscale,
        [string] $FakeProbe,
        [string] $Scenario,
        [string] $CommandLog,
        [string] $ProbeLog,
        [string] $StatePath,
        [string[]] $Arguments = @()
    )
    $environment = @{
        'COZYGATEWAY_TEST_SCENARIO' = $Scenario
        'COZYGATEWAY_TEST_COMMAND_LOG' = $CommandLog
        'COZYGATEWAY_TEST_PROBE_LOG' = $ProbeLog
        'COZYGATEWAY_TEST_STATE' = $StatePath
        'COZYGATEWAY_TEST_TARGET' = '127.0.0.1:18787'
    }
    $old = @{}
    foreach ($key in $environment.Keys) {
        $old[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $environment[$key], 'Process')
    }
    try {
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Spike `
            -TailscalePath $FakeTailscale `
            -NodePath (Get-Command node.exe).Source `
            -ProbeScript $FakeProbe `
            -ProbePort 18787 `
            @Arguments 2>&1
        return @{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
    } finally {
        $ErrorActionPreference = $previousPreference
        foreach ($key in $environment.Keys) {
            [Environment]::SetEnvironmentVariable($key, $old[$key], 'Process')
        }
    }
}

function Read-Lines {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    return @(Get-Content -LiteralPath $Path)
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$spike = Join-Path $repoRoot 'scripts\native\windows-tailscale-transport-spike.ps1'
$probe = Join-Path $repoRoot 'scripts\native\tailscale-transport-probe.mjs'
$temp = Join-Path ([IO.Path]::GetTempPath()) ("cozygateway-tailscale-spike-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

try {
    Assert-True (Test-Path -LiteralPath $spike) 'missing scripts/native/windows-tailscale-transport-spike.ps1'
    Assert-True (Test-Path -LiteralPath $probe) 'missing scripts/native/tailscale-transport-probe.mjs'

    $portReservation = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback), 0
    $portReservation.Start()
    $realProbePort = ([Net.IPEndPoint]$portReservation.LocalEndpoint).Port
    $portReservation.Stop()
    $realProbeOut = Join-Path $temp 'real-probe.stdout.log'
    $realProbeErr = Join-Path $temp 'real-probe.stderr.log'
    $realProbeProcess = $null
    try {
        $realProbeProcess = Start-Process -FilePath (Get-Command node.exe).Source `
            -ArgumentList @(('"' + $probe + '"'), 'serve', '--port', [string]$realProbePort) `
            -PassThru -NoNewWindow `
            -RedirectStandardOutput $realProbeOut `
            -RedirectStandardError $realProbeErr
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        while ([DateTime]::UtcNow -lt $deadline -and
            (-not (Test-Path -LiteralPath $realProbeOut) -or (Get-Content -LiteralPath $realProbeOut -Raw) -notmatch '"ready"\s*:\s*true')) {
            if ($realProbeProcess.HasExited) { break }
            Start-Sleep -Milliseconds 50
        }
        Assert-True (-not $realProbeProcess.HasExited) "real loopback probe exited early: $(Get-Content -LiteralPath $realProbeErr -Raw)"
        $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$realProbePort/health" -TimeoutSec 5
        Assert-True ($health.StatusCode -eq 200 -and $health.Content -match 'cozygateway-tailscale-transport') 'real loopback probe must serve bounded health'
        $webSocketClient = Join-Path $temp 'real-probe-client.mjs'
        Write-Utf8NoBom $webSocketClient @'
const port = process.argv[2];
const result = await new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const timer = setTimeout(() => reject(new Error("WebSocket timeout")), 3000);
  socket.addEventListener("open", () => socket.send("real-round-trip"));
  socket.addEventListener("message", (event) => {
    clearTimeout(timer);
    socket.close();
    resolve(event.data);
  });
  socket.addEventListener("error", () => reject(new Error("WebSocket failed")));
});
if (result !== "real-round-trip") process.exit(1);
'@
        & (Get-Command node.exe).Source $webSocketClient ([string]$realProbePort)
        Assert-True ($LASTEXITCODE -eq 0) 'real loopback probe must echo bidirectional WebSocket traffic'
    } finally {
        if ($null -ne $realProbeProcess -and -not $realProbeProcess.HasExited) {
            Stop-Process -Id $realProbeProcess.Id -Force -ErrorAction SilentlyContinue
            $realProbeProcess.WaitForExit()
        }
    }

    $fakeTailscale = Join-Path $temp 'fake-tailscale.ps1'
    Write-Utf8NoBom $fakeTailscale @'
$ErrorActionPreference = 'Stop'
$command = $args -join ' '
Add-Content -LiteralPath $env:COZYGATEWAY_TEST_COMMAND_LOG -Value $command
$state = if (Test-Path -LiteralPath $env:COZYGATEWAY_TEST_STATE) {
    (Get-Content -LiteralPath $env:COZYGATEWAY_TEST_STATE -Raw).Trim()
} else { 'initial' }

if ($command -eq 'status --json') {
    '{"BackendState":"Running","CurrentTailnet":{"Name":"fixture-personal-tailnet"},"Self":{"DNSName":"cozy.fixture-tailnet.ts.net.","Online":true},"CertDomains":["cozy.fixture-tailnet.ts.net"]}'
    exit 0
}
if ($command -eq 'serve status --json') {
    if ($state -eq 'created') {
        '{"TCP":{"443":{"TCPForward":"' + $env:COZYGATEWAY_TEST_TARGET + '","TerminateTLS":"cozy.fixture-tailnet.ts.net"}},"Web":{}}'
    } elseif ($state -eq 'concurrent') {
        '{"TCP":{"443":{"TCPForward":"127.0.0.1:29999","TerminateTLS":"cozy.fixture-tailnet.ts.net"}},"Web":{}}'
    } elseif ($env:COZYGATEWAY_TEST_SCENARIO -eq 'occupied') {
        '{"TCP":{"443":{"TCPForward":"127.0.0.1:9999","TerminateTLS":"cozy.fixture-tailnet.ts.net"}},"Web":{}}'
    } elseif ($env:COZYGATEWAY_TEST_SCENARIO -eq 'conflicting') {
        '{"TCP":{"443":{"HTTPS":true}},"Web":{"cozy.fixture-tailnet.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:9999"}}}}}'
    } else {
        '{"TCP":{},"Web":{}}'
    }
    exit 0
}
if ($command -eq 'funnel status --json') {
    if ($env:COZYGATEWAY_TEST_SCENARIO -eq 'funnel') {
        '{"TCP":{"443":{"TCPForward":"127.0.0.1:9999"}}}'
    } else {
        '{"TCP":{},"Web":{}}'
    }
    exit 0
}
if ($command -eq ('serve --bg --tls-terminated-tcp=443 tcp://' + $env:COZYGATEWAY_TEST_TARGET)) {
    Set-Content -LiteralPath $env:COZYGATEWAY_TEST_STATE -Value 'created' -NoNewline
    exit 0
}
if ($command -eq 'serve --tls-terminated-tcp=443 off') {
    Set-Content -LiteralPath $env:COZYGATEWAY_TEST_STATE -Value 'removed' -NoNewline
    exit 0
}
Write-Error "unexpected fake Tailscale argv: $command"
exit 64
'@

    $fakeProbe = Join-Path $temp 'fake-probe.mjs'
    Write-Utf8NoBom $fakeProbe @'
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const argv = process.argv.slice(2);
appendFileSync(process.env.COZYGATEWAY_TEST_PROBE_LOG, `${argv.join("\t")}\n`);
if (argv[0] === "serve") {
  const port = Number(argv[argv.indexOf("--port") + 1]);
  const server = createServer((_request, response) => response.end("ok"));
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`${JSON.stringify({ ready: true, host: "127.0.0.1", port })}\n`);
  });
} else if (argv[0] === "verify") {
  if (process.env.COZYGATEWAY_TEST_SCENARIO === "concurrent") {
    writeFileSync(process.env.COZYGATEWAY_TEST_STATE, "concurrent");
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, alpn: "http/1.1", health: true, wss: true })}\n`);
} else {
  process.exit(64);
}
'@

    $commonApply = @('-Apply', '-PersonalTailnet', '-Confirm', 'APPLY COZYGATEWAY TAILSCALE SPIKE')

    $commandLog = Join-Path $temp 'inspection-commands.log'
    $probeLog = Join-Path $temp 'inspection-probe.log'
    $state = Join-Path $temp 'inspection-state.txt'
    $inspection = Invoke-Spike $spike $fakeTailscale $fakeProbe 'empty' $commandLog $probeLog $state
    Assert-True ($inspection.ExitCode -eq 0) "inspection-only default failed: $($inspection.Output)"
    $inspectionCommands = Read-Lines $commandLog
    Assert-True (($inspectionCommands -join '|') -eq 'status --json|serve status --json|funnel status --json') 'default must perform only complete read-only inspections'
    Assert-True (-not (Test-Path -LiteralPath $probeLog)) 'default must not start or verify the probe'
    Assert-True ($inspection.Output -match 'inspection only') 'default must identify itself as inspection only'

    $unconfirmedCommandLog = Join-Path $temp 'unconfirmed-commands.log'
    $unconfirmedProbeLog = Join-Path $temp 'unconfirmed-probe.log'
    $unconfirmedState = Join-Path $temp 'unconfirmed-state.txt'
    $unconfirmed = Invoke-Spike $spike $fakeTailscale $fakeProbe 'empty' $unconfirmedCommandLog $unconfirmedProbeLog $unconfirmedState @('-Apply', '-PersonalTailnet')
    Assert-True ($unconfirmed.ExitCode -ne 0 -and $unconfirmed.Output -match 'Confirm') '-Apply must require the exact operator confirmation phrase'
    Assert-True (-not ((Read-Lines $unconfirmedCommandLog) -match '^serve --bg ')) 'missing confirmation must stop before mutation'

    foreach ($scenario in @('occupied', 'conflicting', 'funnel')) {
        $scenarioCommandLog = Join-Path $temp "$scenario-commands.log"
        $scenarioProbeLog = Join-Path $temp "$scenario-probe.log"
        $scenarioState = Join-Path $temp "$scenario-state.txt"
        $result = Invoke-Spike $spike $fakeTailscale $fakeProbe $scenario $scenarioCommandLog $scenarioProbeLog $scenarioState $commonApply
        Assert-True ($result.ExitCode -ne 0) "$scenario port 443 state must be rejected"
        Assert-True ($result.Output -match '443') "$scenario rejection must identify port 443"
        $commands = Read-Lines $scenarioCommandLog
        Assert-True (-not (($commands -join "`n") -match '^serve --bg ')) "$scenario rejection must happen before mutation"
        Assert-True (-not (($commands -join "`n") -match ' off$')) "$scenario rejection must not clean up state it did not create"
    }

    $successCommandLog = Join-Path $temp 'success-commands.log'
    $successProbeLog = Join-Path $temp 'success-probe.log'
    $successState = Join-Path $temp 'success-state.txt'
    $success = Invoke-Spike $spike $fakeTailscale $fakeProbe 'empty' $successCommandLog $successProbeLog $successState $commonApply
    Assert-True ($success.ExitCode -eq 0) "apply spike failed: $($success.Output)"
    $successCommands = Read-Lines $successCommandLog
    Assert-True (($successCommands | Where-Object { $_ -eq 'serve --bg --tls-terminated-tcp=443 tcp://127.0.0.1:18787' }).Count -eq 1) 'apply must use the exact TLS-terminated TCP creation argv'
    Assert-True (($successCommands | Where-Object { $_ -eq 'serve --tls-terminated-tcp=443 off' }).Count -eq 1) 'cleanup must use the exact scoped removal argv'
    Assert-True ((Get-Content -LiteralPath $successState -Raw) -eq 'removed') 'successful exact cleanup must remove the spike-owned mapping'
    $successProbe = Read-Lines $successProbeLog
    Assert-True (($successProbe | Where-Object { $_ -eq "serve`t--port`t18787" }).Count -eq 1) 'apply must start one disposable loopback probe'
    Assert-True (($successProbe | Where-Object { $_ -eq "verify`t--origin`thttps://cozy.fixture-tailnet.ts.net`t--expected-host`tcozy.fixture-tailnet.ts.net`t--timeout-ms`t5000`t--soak-seconds`t10" }).Count -eq 1) 'apply must run the exact bounded TLS/health/WSS verification'

    $concurrentCommandLog = Join-Path $temp 'concurrent-commands.log'
    $concurrentProbeLog = Join-Path $temp 'concurrent-probe.log'
    $concurrentState = Join-Path $temp 'concurrent-state.txt'
    $concurrent = Invoke-Spike $spike $fakeTailscale $fakeProbe 'concurrent' $concurrentCommandLog $concurrentProbeLog $concurrentState $commonApply
    Assert-True ($concurrent.ExitCode -ne 0) 'probe failure after a concurrent mapping change must fail'
    $concurrentCommands = Read-Lines $concurrentCommandLog
    Assert-True (($concurrentCommands | Where-Object { $_ -eq 'serve --tls-terminated-tcp=443 off' }).Count -eq 0) 'cleanup must preserve a concurrently changed mapping'
    Assert-True ((Get-Content -LiteralPath $concurrentState -Raw) -eq 'concurrent') 'concurrent live mapping must survive conditional cleanup'

    Write-Host 'windows Tailscale transport spike tests passed'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

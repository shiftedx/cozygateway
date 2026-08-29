# Windows Tailscale Transport Acceptance Gate

This gate proves that Tailscale TLS-terminated TCP can carry CozyGateway HTTP/1.1 and WebSocket
traffic without changing a real CozyGateway installation. It is release-blocking: failure never
falls back to Tailscale's L7 HTTPS Serve or silently selects LAN access.

## Safety and invocation

Run the automated harness first. It uses a fake Tailscale CLI and disposable loopback processes;
it does not mutate live Serve or Funnel state.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-tailscale-transport-spike.test.ps1
```

The native spike defaults to inspection only. It reads full `status --json`, `serve status --json`,
and `funnel status --json` output and makes no change:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/native/windows-tailscale-transport-spike.ps1
```

Live application requires a user-owned personal tailnet, an explicit attestation, and the exact
confirmation phrase. Obtain host permission before running it:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File scripts/native/windows-tailscale-transport-spike.ps1 `
  -Apply -PersonalTailnet -SoakSeconds 900 `
  -Confirm 'APPLY COZYGATEWAY TAILSCALE SPIKE'
```

The spike creates only:

```text
tailscale serve --bg --tls-terminated-tcp=443 tcp://127.0.0.1:18787
```

It never enables Funnel, L7 HTTPS Serve, PROXY protocol, or identity headers, and never calls
`serve reset`. Cleanup re-reads complete Serve and Funnel state and runs
`tailscale serve --tls-terminated-tcp=443 off` only when the live mapping remains an exact match
for the spike-owned target. A reused mapping or concurrent change is preserved.

## Native matrix

Save sanitized client versions, complete Serve/Funnel JSON before and after, certificate issuer and
SAN evidence, negotiated ALPN, health/WSS results, path type, timestamps, and cleanup state for every
row. Do not save account credentials, auth URLs, node keys, or other tailnet secrets.

| Client | Phone | Path | Required exercise |
| --- | --- | --- | --- |
| Tailscale 1.102.1 | Current iOS / Safari | direct and forced DERP | Trusted page load, bounded `/health`, 15-minute bidirectional WSS soak, background/foreground, reconnect |
| Tailscale 1.102.1 | Current Android / Chrome | direct and forced DERP | Trusted page load, bounded `/health`, 15-minute bidirectional WSS soak, background/foreground, reconnect |
| Release-time stable | Current iOS / Safari | direct and forced DERP | Repeat the complete minimum-version row |
| Release-time stable | Current Android / Chrome | direct and forced DERP | Repeat the complete minimum-version row |

For both client versions and both phone platforms, also exercise:

- Tailscale VPN off/on on the phone: off breaks private reachability and on restores it.
- Tailscale daemon restart on Windows during the WSS/reconnect sequence.
- Windows logout/login and a full reboot, followed by transport and mapping re-inspection.
- At least 15 continuous minutes of bidirectional WSS traffic, including app background/foreground.
- Direct and DERP paths, with the observed path recorded rather than inferred.
- Proof that Funnel is absent on port 443 and the endpoint is not publicly reachable.
- Exact conditional cleanup, with unrelated Serve/Funnel ports unchanged byte-for-byte after
  sanitization.

## Pass/fail criteria

The TLS certificate must be publicly trusted for the exact lowercase `.ts.net` host and contain the
host in its SANs. A TLS client offering `h2,http/1.1` may negotiate no ALPN or `http/1.1`; negotiating
`h2` is a hard failure. HTTPS health must complete within five seconds without redirects, and WSS
must echo payloads in both directions without premature closure.

Any certificate/SAN failure, `h2` negotiation, WSS break, mapping persistence failure, public Funnel
reachability, or unsafe cleanup blocks personal-Tailscale automation and release. Record the failure;
do not substitute L7 Serve or a Gateway-managed certificate listener without a separate approved
design.

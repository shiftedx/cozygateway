# Personal Tailscale onboarding and network-gated pairing

## Goal and scope

Give a nontechnical Windows user one end-to-end CozyGateway setup that can optionally install and
configure Tailscale under the user's confirmed account. This is an ordinary user-owned integration:
no business partnership, Cozy-managed tailnet, OAuth application, auth key, reusable credential,
special API access, or vendor-side change is required.

The installer must not emit a CozyChat pairing QR or setup code until the user chooses a network
posture, that posture is healthy, and a phone explicitly proves it can reach the final Gateway
HTTPS/WebSocket path.

The normal choices are phrased as outcomes:

1. **Secure access from anywhere** (recommended): the user's Tailscale account and private
   TLS-terminated TCP forwarding.
2. **Same Wi-Fi only**: plaintext LAN access on a trusted private network.
3. **Set up phone access later**: finish a loopback-only install with no pairing material.
   `cozygateway setup` resumes the flow.

This release is Windows-first. The Gateway verification primitives are portable, but existing
macOS/Linux installation behavior is unchanged until separate platform work is designed and tested.
Bind addresses, ports, MagicDNS, certificates, and `publicUrl` remain under advanced configuration.

## Product invariants

- Network choice precedes all automatic onboarding pairing material.
- A valid phone proof for the exact current deployment precedes setup-code creation.
- The first QR is clearly labelled **Phone connection check**. It contains a short-lived,
  high-entropy readiness capability, not a CozyChat setup code or device credential.
- `GET`, `HEAD`, `OPTIONS`, link previews, and scanner prefetches never advance verification.
- The phone must complete an explicit tap and a challenge-scoped WebSocket echo through the final
  advertised origin.
- Phone and desktop show the same random phrase. The desktop asks
  `Is this your phone? [y/N]`; Enter is No.
- Only the phone proof plus affirmative desktop confirmation permits one atomic setup-code mint.
- A listener, port, public origin, network mode, account/tailnet, or owned Tailscale mapping change
  invalidates the saved posture. A Gateway restart invalidates only an active phone challenge, not
  a previously completed unchanged posture.
- Tailscale belongs to the user. CozyGateway never stores account credentials, auth keys, login
  URLs, OAuth credentials, or tailnet administration secrets.
- Remote setup never enables Funnel. CozyGateway remains loopback-only behind Tailscale.
- Existing Tailscale accounts, unrelated preferences, routes, applications, and Funnel/Serve
  mappings are preserved. CozyGateway never logs out, switches accounts, resets all mappings,
  removes unowned state, or uninstalls Tailscale automatically.

## User flow

The one-line installer completes Hermes provider/model selection, CozyGateway installation,
service persistence, Gateway health, and Hermes attach readiness on loopback. It then runs
`cozygateway setup` in the original PowerShell window.

Before Tailscale changes, the user is told that:

- Windows may show UAC;
- authentication and first-time HTTPS consent open in a browser;
- Tailscale must also be installed, signed in to the intended tailnet, and active on the phone;
- authorized or shared tailnet peers may reach the endpoint according to tailnet policy;
- tailnet administrators can observe/manage the device and policy;
- unattended mode keeps the PC reachable after logout but does not prevent sleep; and
- enabling HTTPS publishes the machine and tailnet DNS name in Certificate Transparency.

The user can choose **Not now** at every external consent boundary. Cancellation leaves no setup
code and never silently falls back from remote access to LAN.

Once the final route is healthy, the terminal prints the Phone connection check QR. The phone page
checks `/health`, performs a bounded WebSocket echo, and enables **Verify this phone** only after
both pass. After the tap, the matching phrase appears on phone and desktop. An affirmative desktop
answer creates and prints the real CozyChat pairing QR.

This proves that a phone browser permitted by the selected network reached the final origin. It
does not cryptographically attest a physical device or bind that browser to the later CozyChat app.
That stronger guarantee requires a future CozyChat app handshake.

## Pairing compatibility

The strict gate applies to new Windows onboarding and its automatic finale. A fresh Windows install
writes a pending marker before Gateway configuration exists, so `cozygateway pair` cannot bypass
unfinished network setup.

After onboarding is complete, later explicit `cozygateway pair` calls may mint another code only
while the saved deployment fingerprint still matches and local Gateway/attach readiness passes. A
network change routes the user back through `cozygateway setup`. Existing installs without
onboarding state are recorded as `legacy_unreviewed` without changing their listener; their explicit
pairing workflow remains compatible, while the TUI offers the new setup review.

The installer and TUI never use a bypass. Existing App Review, Docker, conformance, and headless
test workflows retain explicit pairing through their established non-Windows/legacy or injected
test boundaries. Onboarding-created setup codes always use the contract's ten-minute lifetime;
existing advanced TTL behavior is outside this change.

## Authoritative state and concurrency

SQLite is authoritative for all security transitions. Add setup sessions and verification
challenges with these challenge states:

```text
active -> ws_probed -> phone_confirmed -> consumed
```

The database enforces one active challenge per setup session and at most one setup code per
challenge. A Windows named mutex prevents confusing duplicate wizards, but correctness does not
depend on it.

`local/network-onboarding.json` is an atomic, current-user/SYSTEM-only resume projection for
external steps:

```text
pending_choice
network_selected(mode)
endpoint_ready(mode, deploymentFingerprint)
verifying_phone(mode, deploymentFingerprint)
complete(mode, deploymentFingerprint, verifiedAt)
legacy_unreviewed(mode, deploymentFingerprint)
```

It contains no raw readiness capability, login URL, account identity, setup code, or device token.
External Tailscale state is re-probed on resume. Relevant database, config, state, ownership
metadata, and environment files receive explicit Windows DACLs for the current user and SYSTEM;
Git Bash mode bits are insufficient.

Gateway startup writes a fresh verification epoch and invalidates every pending challenge. The
durable posture fingerprint covers listener, port, advertised origin, a keyed hash of the
desktop-confirmed account/tailnet identity, and the exact Tailscale mapping when applicable. The
challenge fingerprint adds the current verification epoch. Completed onboarding saves only the
durable posture fingerprint, so an ordinary restart does not repeat the network choice.

The phone POST atomically moves `ws_probed` to `phone_confirmed`; it does not consume the challenge
or mint. Desktop confirmation first generates the candidate setup code and complete final QR/text
in memory. One `BEGIN IMMEDIATE` transaction then verifies session, state, expiry, verification epoch,
and fingerprint; moves `phone_confirmed` to `consumed`; inserts exactly that setup code; and records
the winning session. The buffered terminal output is written afterward. Detectable output failure
revokes the code, and startup revokes any code left in `pending_output` by a crash.

The sidecar is updated only after the SQLite commit and is never used as compare-and-swap authority.

## Phone verification protocol

The Gateway exposes an additive core/operator onboarding exception to the normal device-token
boundary. The wire contract explicitly documents this separate, low-authority readiness
capability. It is not a normal vendor endpoint and cannot access Gateway data.

Routes are:

```text
GET  /cozy/onboarding/<capability>          inert verification page
WS   /cozy/onboarding/<capability>/probe    bounded fixed-schema echo
POST /cozy/onboarding/<capability>/confirm  explicit phone confirmation
```

`http.ts` handles page and confirmation. `phone-verification.ts` owns challenge semantics and a
bounded upgrade handler. `server.ts` and `upgrade-dispatcher.ts` add prefix-based dispatch for the
probe before normal `/ws`; the verifier never uses `WsHub` or reads application data.

Each capability is 256 random bits encoded as 43 base64url characters, stored only as a hash, and
expires within ten minutes. It is scoped to session, mode, exact canonical origin, durable posture
fingerprint, and verification epoch. The server also generates the matching phrase and binds it to
that challenge; neither UI may substitute caller text. Missing, expired, malformed, wrong-host, and
replayed capabilities receive the same 404 response. `GET`, `HEAD`, and `OPTIONS` never change
state.

GET, WebSocket upgrade, and confirmation all require the exact canonical authority. Default ports
are normalized: `https://name.ts.net` expects `Host: name.ts.net` and an Origin without literal
`:443`, while a non-default port must be present. No forwarded-host fallback is accepted.

WebSocket upgrade additionally requires the exact same-origin `Origin` before it may advance the
challenge to `ws_probed`. Confirmation requires:

- the same exact canonical authority and same-origin `Origin`;
- the same challenge's successful WebSocket probe;
- the expected unexpired state and current fingerprint; and
- an explicit fixed-schema body no larger than 256 bytes.

There is one active challenge per session, at most four verification WebSockets globally, a
five-second upgrade/auth deadline, one probe frame up to 256 bytes, a 60-second maximum socket
lifetime, and five confirmation attempts per minute with a global ceiling. Startup invalidation and
in-process monotonic deadlines limit clock-rollback effects.

Responses use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, a strict same-origin CSP,
`frame-ancestors 'none'`, and `X-Content-Type-Options: nosniff`. The page loads no third-party
resources and calls `history.replaceState()` to remove the capability path after load. Gateway
access logs, traces, errors, crash reports, and diagnostics redact the entire capability path.
External browser/proxy history outside CozyGateway's control is disclosed as a reason for the short
lifetime and one-time use.

The local Windows account and administrators are trusted. A process already running as the same
user can alter the database or forge loopback traffic and is outside this network-onboarding threat
model.

## Windows Tailscale adapter

The adapter uses only public, local Tailscale CLI behavior and a user-confirmed account. It invokes
an absolute trusted executable with argument arrays, bounded output, and timeouts. Supported
clients must provide the current status, targeted `set/get`, certificate-domain, and
TLS-terminated-TCP command surface (baseline Tailscale 1.102.1 or newer). Older clients are offered
an official update or manual setup; the adapter does not mutate them through ambiguous fallbacks.

### Detection and installation

Detection correlates the `Tailscale` Windows service image with the official Program Files binary
and requires a valid Authenticode signature whose publisher organization is `Tailscale Inc.`. A
user-writable `PATH` result, unsigned/custom client, or custom control server is not automatically
operated.

If absent and the user consents, PowerShell downloads the architecture-selecting bootstrapper from
the exact official HTTPS origin, with bounded size/time and no off-origin redirects:

```text
https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe
```

It writes a private unique temporary file, verifies Authenticode publisher/status, and invokes the
signed installer exactly once through UAC. Because Tailscale does not document silent EXE switches,
the normal path uses its interactive installer. UAC cancellation pauses safely. The setup reports
disabled prerequisite Windows services but does not silently change service policy. Only the
signed installer or one fixed-argument preference command is elevated, never the whole Cozy setup.

The Windows helper is a checksum-verified CozyGateway release asset installed under `bin`. It has
fixed subcommands and machine-readable bounded JSON for trusted discovery, signature verification,
installer invocation, targeted UAC preference changes, and browser opening. Node never constructs
arbitrary elevated PowerShell. Bootstrap, bundle, release-asset, and Windows tests cover the helper.

### Authentication and preferences

An existing running account is displayed and requires explicit confirmation; CozyGateway cannot
prove that every account is personally rather than organizationally managed. A managed/custom
case pauses for manual handling and is never silently switched.

New login uses `tailscale up --json` and independent status polling. Device authentication URLs
must be HTTPS on exact `login.tailscale.com`. Serve/HTTPS consent may use exact
`login.tailscale.com` or `console.tailscale.com`. Browser URLs are memory-only and redacted.
`NeedsMachineAuth`, policy denial, timeout, cancellation, malformed output, and work-managed policy
produce resumable guidance and no network fallback.

Unattended mode is a separate disclosed preference. After explicit consent, use only targeted
`tailscale set --unattended=true` and verify with `tailscale get --json unattended`. If unavailable
or policy-controlled, pause for an official update or manual tray action; never use whole-config
`tailscale up --unattended=true` as an automatic fallback.

Preflight incoming-connections/shields-up policy. If disabled, ask before using a targeted setting
change and verify it. Managed policy refusal produces a precise diagnostic instead of a phone
timeout. All unrelated preferences remain untouched.

## Private remote transport

Do not use Tailscale's L7 HTTPS reverse proxy. Current Tailscale issue #20882 shows browser HTTP/2
WebSocket upgrades can reach the backend as plain GET/426, and #18827 reports L7 WebSocket drops.

Use the ordinary TLS-terminated TCP byte-stream forwarder without PROXY protocol:

```text
tailscale serve --bg --tls-terminated-tcp=443 tcp://127.0.0.1:<gateway-port>
```

The phone validates Tailscale's `.ts.net` certificate. Tailscale terminates TLS, advertises no `h2`
for this mode, and byte-for-byte forwards decrypted HTTP/1.1/WebSocket traffic to the existing
loopback Gateway. Hermes remains on `http://127.0.0.1:<gateway-port>`. Tailscale retains certificate
issuance and renewal, so CozyGateway stores no private key or certificate files.

Do not enable PROXY v1/v2. It is unnecessary for capability-based reachability, the Gateway does
not parse it, and open issue #18865 reports broken TLS when PROXY v2 is combined with terminated
TCP. L4 mode provides no Tailscale identity headers; any such headers are ignored.

Before changing port 443, inspect complete Serve and Funnel state. Reuse an exact compatible
mapping as `createdByWizard=false`. Any other HTTP/HTTPS/TCP/Funnel mapping on 443 stops automatic
setup and offers Wi-Fi, later, or advanced configuration. Other ports are preserved. Never call
`serve reset`.

If tailnet HTTPS is not enabled, use a checked, temporary foreground HTTPS text mapping on an
otherwise unused port only to open Tailscale's standard consent flow; remove it and re-read complete
state before continuing. If no safe temporary port is available, open the normal Tailscale console
instructions and resume after the user enables HTTPS. The irreversible Certificate Transparency
disclosure appears before this step.

The canonical origin comes from validated machine-readable status/certificate-domain data. It must
match the current MagicDNS suffix and exact `.ts.net` label boundary. After configuring the L4
mapping, require:

- Gateway exact-loopback health and attach readiness;
- complete state showing TLS-terminated TCP on 443, no PROXY protocol, target exactly
  `127.0.0.1:<gateway-port>`, and no Funnel on 443;
- a normal certificate-valid `/health` request through the final origin;
- a TLS probe offering `h2,http/1.1` that negotiates no ALPN or `http/1.1`, never `h2`; and
- the phone's actual verification WebSocket echo.

The mapping fingerprint records mode, port 443, no-PROXY, exact target, Funnel false, ownership,
and account/tailnet hash. Conditional rollback removes only an exact live mapping with
`createdByWizard=true`:

```text
tailscale serve --tls-terminated-tcp=443 off
```

It never removes a reused compatible mapping or concurrent user change.

## LAN adapter

LAN mode uses the existing atomic listener update, Hermes target synchronization, restart, attach
readiness, and rollback. Address selection accepts one active RFC1918 Wi-Fi or Ethernet address and
excludes loopback, Tailscale, virtual-machine, container, and link-local adapters. Ambiguity pauses
for advanced selection instead of advertising an arbitrary address.

The Gateway may listen on `0.0.0.0` for compatibility, but the installer discloses that this covers
other interfaces. LAN mode is plaintext and assumes a trusted private network; phone verification
proves reachability but does not prevent passive same-LAN theft of later pairing traffic. The
verification page must use the selected concrete LAN address and complete health/WebSocket proof.

## Failure, cancellation, and rollback

- Failure before desktop confirmation creates no setup code.
- Abandoning remote setup leaves CozyGateway on loopback; it never falls back to LAN.
- If CozyGateway installed Tailscale, a later failure leaves it installed because it may contain
  user-owned state. Windows Apps provides explicit removal.
- CozyGateway never logs out, switches account, disables tailnet HTTPS, changes key expiry, rewrites
  ACLs, resets Serve, or alters unrelated mappings.
- Rollback is conditional on the live value matching a wizard-created value. Concurrent changes
  stop recovery rather than being overwritten.
- Authentication, HTTPS consent, UAC, device approval, phone installation, VPN enablement, and
  reboot are resumable pauses rather than generic failures.
- Required diagnostics live in `cozygateway status`; a new `doctor` command is deferred.

## CLI and installer integration

- Add `cozygateway setup` as the resumable Windows network wizard.
- Replace only the Windows installer's unconditional pairing finale with `cozygateway setup`.
- The TUI routes incomplete or changed network posture through setup before pairing.
- Explicit `--bind-host` and `--public-url` remain advanced intent, but new Windows onboarding must
  verify the resulting final origin before automatic pairing.
- Noninteractive fresh Windows installs finish healthy on loopback, emit no pairing material, and
  print `cozygateway setup` as the next step.
- Updates preserve a matching completed posture and never repeat account/LAN choice.
- Status reports onboarding stage, endpoint health, Tailscale health, and exact owned-state repair
  guidance without exposing capabilities or identities.

The final CozyChat payload remains exactly `{"gatewayUrl": ..., "setupCode": ...}`.

## Component boundaries

- `NetworkOnboarding`: small `run`, `resume`, and `status` orchestration interface.
- `LanModeAdapter`: inspect, prepare, verify, and conditionally roll back LAN state.
- `TailscaleModeAdapter`: inspect, prepare, verify, and conditionally roll back user-owned Tailscale
  state through the fixed Windows helper.
- `PhoneVerification`: challenge lifecycle, HTTP/WS ingress, matching phrase, and atomic finalize.
- SQLite storage: sole security-state and setup-code authority.
- `cli.ts`: command routing and buffered final output only.
- `install.ps1`: bootstrap and checksum-verified helper installation.
- `agent-install.sh`: install/service orchestration and Windows handoff to setup.

## Automated tests

Tests must prove:

- zero setup-code rows and zero final pairing output before phone and affirmative desktop proof;
- GET/HEAD/OPTIONS/prefetch, failed WS, phone POST without desktop yes, desktop yes without phone,
  wrong phrase, Enter/default No, malformed/expired/replayed capability, and QR/output failure;
- SQLite races across POSTs, confirmations, two processes, expiry, restart, config/account/mapping
  changes, and exactly one winning setup code;
- exact Host/Origin, CSRF, iframe/cache controls, path redaction, body/echo/connection limits, startup
  invalidation, and trusted-local-process threat boundary;
- unsigned/path-spoofed Tailscale, custom control server, old version, malformed/huge/hanging JSON,
  stopped daemon, UAC cancel, reboot, login cancel, machine approval, managed policy, and resume;
- existing account accepted/rejected, targeted unattended/incoming changes, no whole-config fallback,
  and no logged browser URL or identity;
- exact TLS-terminated mapping reuse/creation/removal, port-443 conflicts, Funnel conflict, temporary
  consent cleanup, no PROXY, no reset, concurrent external changes, and failure after each mutation;
- `.ts.net.evil`, Unicode/confusable DNS, trailing dot, wrong SAN, TLS bypass, redirect, `h2`
  negotiation, final health loss, and broken/short-lived WebSocket;
- LAN adapter ambiguity, public/link-local/Tailscale/VM exclusions, DHCP change, plaintext warning,
  health loss, and rollback;
- legacy upgrades, saved listener/public origin preservation, App Review/Docker/headless compatibility,
  fresh pending-marker enforcement, noninteractive behavior, repeat setup, and uninstall ownership;
- full build, typecheck, package/contract/conformance/attach tests, Windows bootstrap, installer
  harness, bundle/release assets, package lint, and diff checks.

## Native release gate

Before full implementation depends on this transport, run a focused native Windows/personal-tailnet
spike against both the minimum supported and current stable Tailscale clients. Then repeat on the
real Gateway before release.

Acceptance requires:

- exact TLS-terminated TCP mapping with no PROXY and captured machine-readable fixtures;
- certificate-valid Safari/Chrome page load from real iOS and Android phones;
- TLS ALPN equal to none or `http/1.1`, never `h2`;
- HTTP health and challenge WebSocket on the final origin;
- at least a 15-minute bidirectional WSS soak, background/foreground, reconnects, VPN off/on,
  Tailscale daemon restart, Windows logout/reboot, direct and DERP paths;
- actual CozyChat pairing, roster load, streamed reply, and media delivery;
- proof that disabling phone Tailscale breaks reachability and re-enabling restores it;
- proof that Funnel is not publicly reachable;
- conditional rollback and uninstall preserving all unowned Tailscale state; and
- no pairing QR/setup code until the phone proof and desktop Yes.

If TLS-terminated TCP negotiates `h2`, breaks WSS, or fails persistence, remote automation is not
released. The installer continues offering Wi-Fi/later; it does not silently use L7 Serve or add
Gateway-managed certificate renewal. Raw TCP plus a second native TLS listener is a separately
designed fallback, not an automatic downgrade.

An independent GPT-5.6-Sol/high adversarial review repeats after implementation. Any Critical or
Important finding blocks merge. CI billing failure does not replace local evidence.

## Documentation and release boundary

Repository docs cover the flow, privacy disclosure, trusted-LAN warning, user-owned Tailscale,
limitations, recovery, and advanced configuration. The CozyGateway task does not edit the website.
After release, update the existing website handoff issue with the exact tag, commit, one-line
command, screenshots needed, and field-validation checklist.

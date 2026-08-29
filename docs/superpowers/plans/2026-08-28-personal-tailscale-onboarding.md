# Personal Tailscale Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Windows-first flow that lets a non-technical user choose personal Tailscale remote access, trusted-LAN access, or setup later; proves the chosen path from the phone with exactly one connectivity QR scan; and creates the CozyChat setup code and pairing QR only after the desktop user confirms the matching phone phrase.

**Architecture:** SQLite owns setup sessions, challenges, deployment posture, mapping ownership, and setup-code publication. Network adapters prepare and re-inspect either loopback-only Tailscale TLS-terminated TCP or a narrowly selected physical LAN interface. A capability page automatically runs health, WebSocket echo, and POST after one scan. The desktop performs the only human confirmation. Pairing output is rendered in memory before an atomic transaction inserts an unavailable `pending_output` code; one terminal write is followed by activation, while failure revokes it. The Windows installer hands off to the same `cozygateway setup` orchestration used by the TUI.

**Tech Stack:** Node.js 24, TypeScript, Hono, `ws`, better-sqlite3, Vitest, PowerShell 5.1, Bash, pnpm 10, Tailscale CLI 1.102.1+.

**Global Constraints:**

- [ ] Keep CozyGateway uninstalled on this development host. Use repository binaries, temporary databases, fake CLIs, and a disposable loopback probe.
- [ ] Use personal user-owned Tailscale accounts only: no Cozy-managed tailnet, OAuth app, auth key, reusable credential, partner API, Funnel, or special enrollment.
- [ ] The phone performs one connectivity QR scan and no tap/button. Executed page JavaScript automatically runs health -> WSS echo -> POST. The desktop phrase plus `Is this your phone? [y/N]` is the only human gate before pairing material exists.
- [ ] Never mint, persist, print, log, or return a setup code before automatic phone proof and exact desktop affirmative confirmation.
- [ ] In Tailscale mode Gateway and Hermes remain loopback-only. Use `tailscale serve --bg --tls-terminated-tcp=443 tcp://127.0.0.1:<port>`; never L7 HTTPS Serve, Funnel, PROXY protocol, or identity headers.
- [ ] Never reset Serve, logout/uninstall Tailscale, broadly rewrite `tailscale up` preferences, or overwrite unrelated Serve/Funnel state.
- [ ] Preserve App Review, Docker/headless, legacy pairing, explicit public URL, non-Windows, and POSIX installer behavior.
- [ ] Do not edit the website. After release, update the existing website handoff issue.
- [ ] A failed native transport/mobile gate blocks remote automation and release; it never silently falls back to LAN.

## Task 1: Prove the transport before depending on it

**Files:**

- Create: `scripts/native/tailscale-transport-probe.mjs`
- Create: `scripts/native/windows-tailscale-transport-spike.ps1`
- Create: `scripts/test/windows-tailscale-transport-spike.test.ps1`
- Create: `docs/test-plans/windows-tailscale-transport-acceptance.md`

- [ ] RED: fake-CLI PowerShell tests prove inspection-only default, occupied/conflicting/Funnel 443 rejection, exact mutation argv, and conditional exact cleanup.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-tailscale-transport-spike.test.ps1
```

Expected: missing spike script.

- [ ] GREEN: add a disposable Node loopback health/WSS probe and an explicit `-Apply` spike. Before mutation inspect complete Serve/Funnel JSON, authenticated personal-tailnet state, valid `.ts.net` cert domain, and explicit operator confirmation. After mutation verify trust/SAN, ALPN empty/false/`http/1.1` but never `h2`, bounded health, and bidirectional WSS.
- [ ] Cleanup re-reads full state and removes only an exact spike-owned mapping. Never touch unrelated mappings.
- [ ] Document the live matrix: Tailscale 1.102.1 and release-time stable, iOS/Android, direct/DERP, 15-minute WSS, daemon restart, VPN toggle, logout/reboot, and cleanup.

```powershell
git add scripts/native scripts/test/windows-tailscale-transport-spike.test.ps1 docs/test-plans/windows-tailscale-transport-acceptance.md
git commit -m "test: add Windows Tailscale transport gate"
```

## Task 2: Add SQLite onboarding authority

**Files:**

- Modify: `packages/gateway/src/storage.ts`
- Create: `packages/gateway/test/onboarding-storage.test.ts`
- Create: `packages/gateway/test/support/onboarding-race-worker.ts`

**Interfaces:**

```ts
type OnboardingMode = "tailscale" | "lan" | "advanced";
type ChallengeState = "active" | "ws_probed" | "phone_confirmed" | "consumed";
beginGatewayBoot(input: GatewayBoot): void;
beginSetupSession(input: SetupSessionInput): SetupSessionResult;
createVerificationChallenge(input: VerificationChallengeInput): ChallengeResult;
recordVerificationProbe(input: CapabilityTransition): TransitionResult;
recordPhoneConfirmation(input: CapabilityTransition): TransitionResult;
finalizeVerifiedSetupCode(input: FinalizeInput): FinalizeResult;
activatePendingSetupCode(input: PublishedCode): TransitionResult;
revokePendingSetupCode(input: PublishedCode): TransitionResult;
```

New transitions return discriminated results, never ambiguous booleans.

- [ ] RED: fresh and hand-built legacy schema tests; migrated legacy codes remain consumable; one active session; one live challenge; hash-only capability storage; exact expiry; POST-before-WSS; legal state transitions.
- [ ] GREEN: add `STRICT` runtime/session/challenge/ownership tables. Add nullable unique `challenge_id` and checked `output_state = pending_output|active|revoked` to `setup_codes`. Create new-column indexes only after additive legacy migration. Require active output in `consumeSetupCode()`.
- [ ] RED: two connections and two barrier-released processes finalize one challenge. Assert zero setup codes before finalization and exactly one after.
- [ ] GREEN: use conditional SQL inside explicit `BEGIN IMMEDIATE`. Finalize atomically re-checks origin, durable fingerprint, verification epoch, boot generation, expiry, and `phone_confirmed`; it consumes the challenge and inserts one `pending_output` code.
- [ ] RED/GREEN: a new boot revokes abandoned pending output and incomplete challenges but preserves completed matching posture. Call `beginGatewayBoot()` only from `startGateway()`, never `openStorage()`.

```powershell
pnpm --filter cozygateway exec vitest run test/onboarding-storage.test.ts test/storage.test.ts test/pairing.test.ts
pnpm --filter cozygateway typecheck
git add packages/gateway/src/storage.ts packages/gateway/test/onboarding-storage.test.ts packages/gateway/test/support/onboarding-race-worker.ts
git commit -m "feat: add authoritative onboarding state"
```

## Task 3: Buffer pairing output before publication

**Files:**

- Create: `packages/gateway/src/pairing-output.ts`
- Create: `packages/gateway/test/pairing-output.test.ts`
- Modify: `packages/gateway/src/cli.ts`
- Modify: `packages/gateway/test/cli.test.ts`

```ts
interface PreparedPairingOutput {
  setupCode: string;
  payloadJson: string;
  terminalOutput: string;
}
preparePairingOutput(input: {
  gatewayUrl: string; setupCode: string; ttlMs: number;
  color: boolean; strictQr: boolean;
}): PreparedPairingOutput;
```

- [ ] RED/GREEN: preserve exact CozyChat payload `{gatewayUrl, setupCode}`, TTL copy, legacy QR-capacity fallback, and one complete buffered string. Onboarding uses strict QR rendering.
- [ ] With injected code factory, renderer, and writer prove: phone proof alone calls none; blank/`n`/`no` calls none; premature `y` calls none; confirmed `y` creates one; write failure revokes; success writes once then activates.

```powershell
pnpm --filter cozygateway exec vitest run test/pairing-output.test.ts test/cli.test.ts test/qr.test.ts
git add packages/gateway/src/pairing-output.ts packages/gateway/test/pairing-output.test.ts packages/gateway/src/cli.ts packages/gateway/test/cli.test.ts
git commit -m "refactor: buffer pairing output before publication"
```

## Task 4: Add safe dynamic WebSocket dispatch

**Files:** Modify `packages/gateway/src/upgrade-dispatcher.ts` and `packages/gateway/test/upgrade-dispatcher.test.ts`.

```ts
type UpgradeResolver = (pathname: string) => UpgradeHandler | undefined;
createUpgradeDispatcher(
  exactRoutes: ReadonlyMap<string, UpgradeHandler>,
  dynamicResolver?: UpgradeResolver,
): UpgradeHandler;
```

- [ ] RED: exact `/ws` and `/attach/v1` win; resolver sees pathname only; matching probe dispatches once; resolver cannot shadow; malformed/unmatched stays clean 404.
- [ ] GREEN: consult the optional resolver only after exact lookup.

```powershell
pnpm --filter cozygateway exec vitest run test/upgrade-dispatcher.test.ts
git add packages/gateway/src/upgrade-dispatcher.ts packages/gateway/test/upgrade-dispatcher.test.ts
git commit -m "feat: dispatch private onboarding probes"
```

## Task 5: Implement one-scan phone verification

**Files:**

- Create: `packages/gateway/src/phone-verification.ts`
- Create: `packages/gateway/src/phone-verification-page.ts`
- Create: `packages/gateway/test/phone-verification-http.test.ts`
- Create: `packages/gateway/test/phone-verification-ws.test.ts`
- Create: `packages/gateway/test/phone-verification-abuse.test.ts`
- Modify: `packages/gateway/src/http.ts`, `packages/gateway/src/server.ts`, `packages/gateway/test/server.test.ts`, `contract/v1.md`, `packages/conformance/src/suite.ts`

```text
GET  /cozy/onboarding/<43-char-base64url-capability>
WS   /cozy/onboarding/<capability>/probe
POST /cozy/onboarding/<capability>/confirm
```

```ts
runPhoneProof(deps: {
  health(): Promise<void>;
  openProbe(): Promise<void>;
  confirm(): Promise<{ phrase: string }>;
  showPhrase(phrase: string): void;
}): Promise<"confirmed" | "failed">;
```

- [ ] RED: connectivity QR contains only verification URL—never setup code, device token, phrase, identity, or persistent credential.
- [ ] RED: one page execution calls health -> WSS echo -> POST exactly once; no button/second action; failed health prevents WSS; failed WSS prevents POST; success displays POST phrase; reload/replay cannot advance twice.
- [ ] GREEN: self-contained page, no third-party resources, no-store, no-referrer, strict CSP, nosniff, and immediate `history.replaceState`. Plain GET/HEAD/OPTIONS/prefetch remains inert because only executed JS performs WSS and POST.
- [ ] RED: real-`ws` tests for canonical Host/Origin and default ports; missing/duplicate/trailing-dot authority; strict capability; challenge echo; 256-byte frame; one frame; four global sockets; five-second auth; sixty-second lifetime; expiry/replay.
- [ ] GREEN: 256-bit base64url capability, hash-only storage, `ws_probed` only after echo send, and POST-only `ws_probed -> phone_confirmed`. POST returns the authoritative phrase.
- [ ] RED/GREEN abuse: declared/chunked 257-byte bodies, five confirms/minute plus global ceiling, identical 404 for malformed/unknown/expired/replayed/wrong-authority, and capability redaction from logs/traces/errors.
- [ ] Wire one verifier into Gateway HTTP/upgrades/lifecycle. Document the additive low-authority route exception without weakening `/pair`.

```powershell
pnpm --filter cozygateway exec vitest run test/phone-verification-http.test.ts test/phone-verification-ws.test.ts test/phone-verification-abuse.test.ts test/server.test.ts test/pairing.test.ts test/ws-hub.test.ts
pnpm --filter cozygateway-contract exec vitest run
pnpm --filter cozygateway-conformance exec vitest run
git add packages/gateway/src packages/gateway/test contract/v1.md packages/conformance/src/suite.ts
git commit -m "feat: verify phone reachability before pairing"
```

## Task 6: Add posture state and orchestration

**Files:**

- Create: `packages/gateway/src/onboarding-state.ts`
- Create: `packages/gateway/src/network-onboarding.ts`
- Create: `packages/gateway/test/onboarding-state.test.ts`
- Create: `packages/gateway/test/network-onboarding.test.ts`

```ts
interface NetworkModeAdapter {
  readonly mode: "tailscale" | "lan" | "advanced";
  prepare(signal?: AbortSignal): Promise<PreparedEndpoint>;
  inspect(signal?: AbortSignal): Promise<PreparedEndpoint>;
  rollbackOwned(endpoint: PreparedEndpoint, signal?: AbortSignal): Promise<void>;
}
class NetworkOnboarding {
  run(io: OnboardingIo, signal?: AbortSignal): Promise<OnboardingOutcome>;
  resume(io: OnboardingIo, signal?: AbortSignal): Promise<OnboardingOutcome>;
  status(signal?: AbortSignal): Promise<NetworkOnboardingStatus>;
}
```

- [ ] RED/GREEN sidecar: sibling temp + flush/close + atomic rename, explicit Windows ACL request, bounded schema, no raw capability/identity/secret, reject reparse/out-of-root. It is resume projection only; SQLite wins.
- [ ] RED/GREEN orchestration: choice precedes challenge; later/cancel/readiness/rollback failure emits no pairing material; automatic phone proof emits none; desktop default No emits none; exact `y` after matching phrase finalizes once.
- [ ] Re-inspect immediately before finalization. Changed origin, binding, account/tailnet hash, physical adapter/DHCP, Serve mapping, or verification epoch invalidates proof.
- [ ] Render before transaction; write once; activate after success; revoke after failure; persist complete posture. Resume derives from SQLite plus live adapter inspection. Two orchestrators yield one winner.

```powershell
pnpm --filter cozygateway exec vitest run test/onboarding-state.test.ts test/network-onboarding.test.ts test/onboarding-storage.test.ts
git add packages/gateway/src/onboarding-state.ts packages/gateway/src/network-onboarding.ts packages/gateway/test/onboarding-state.test.ts packages/gateway/test/network-onboarding.test.ts
git commit -m "feat: orchestrate network-gated onboarding"
```

## Task 7: Implement strict physical-LAN mode

**Files:** Modify `packages/gateway/src/lan.ts`, `packages/gateway/test/lan.test.ts`; create `packages/gateway/src/lan-mode.ts`, `packages/gateway/test/lan-mode.test.ts`.

- [ ] RED: accept exactly one Up physical Ethernet/Wi-Fi RFC1918 IPv4. Reject loopback, public, link-local, Tailscale 100.64/10, Hyper-V, WSL, VM/container, disconnected/software adapters. Two valid candidates pauses as ambiguous.
- [ ] GREEN: consume fixed Windows-helper inventory; do not infer physical type from `os.networkInterfaces()` alone.
- [ ] RED/GREEN: wildcard disclosure names other exposed interfaces; health/WSS loss rolls back expected listener/Hermes target only; concurrent listener edits survive; DHCP change invalidates posture before pairing.

```powershell
pnpm --filter cozygateway exec vitest run test/lan.test.ts test/lan-mode.test.ts
git add packages/gateway/src/lan.ts packages/gateway/src/lan-mode.ts packages/gateway/test/lan.test.ts packages/gateway/test/lan-mode.test.ts
git commit -m "feat: verify trusted LAN onboarding"
```

## Task 8: Ship a fixed verified Windows helper

**Files:**

- Create: `scripts/cozygateway-windows-helper.ps1`, `scripts/test/windows-helper.test.ps1`, `packages/gateway/src/windows-helper.ts`, `packages/gateway/test/windows-helper-client.test.ts`
- Modify: `scripts/build-bundle.mjs`, `packages/gateway/test/release-assets.test.ts`, `scripts/install.ps1`, `scripts/test/windows-bootstrap.test.ps1`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`

Fixed commands: `discover-tailscale`, `install-tailscale`, `set-preference` for unattended/shields-up only, `open-browser` for login/HTTPS-consent only, `initialize-pending`, `protect-path`, and `adapter-inventory`.

- [ ] RED/GREEN helper envelope: exactly one UTF-8 JSON object, 64 KiB cap, fixed parsing, URL via stdin, path containment/reparse refusal, secret-safe errors.
- [ ] RED/GREEN discovery: service and CLI under the same resolved `%ProgramFiles%\\Tailscale`; `tailscaled.exe`; valid Authenticode; organization `Tailscale Inc.`; no PATH trust. Legacy `tailscale-ipn.exe` is manual/unsupported.
- [ ] RED/GREEN installer: hardcoded official stable HTTPS URL; same-origin/max-three redirects; 256 MiB cap; timeouts/private temp; valid signature; one interactive UAC launch without silent flags; 1223 is cancellation.
- [ ] RED/GREEN preferences/browser: only targeted `set` plus `get --json`; exact approved HTTPS hosts/default port/no credentials/fragments.
- [ ] TypeScript client uses absolute helper path, `shell:false`, hidden window, bounds, strict schema. Bundle helper + checksum; bootstrap verifies before invocation and installs beside the Gateway bundle.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-helper.test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1
pnpm --filter cozygateway exec vitest run test/windows-helper-client.test.ts test/release-assets.test.ts
pnpm bundle
git add scripts packages/gateway/src/windows-helper.ts packages/gateway/test/windows-helper-client.test.ts packages/gateway/test/release-assets.test.ts .github/workflows
git commit -m "feat: ship verified Windows onboarding helper"
```

## Task 9: Implement personal-Tailscale mode

**Files:** Create `packages/gateway/src/tailscale-cli.ts`, `packages/gateway/src/tailscale-mode.ts`, their tests, and sanitized fixtures under `packages/gateway/test/fixtures/tailscale/`.

- [ ] Build captured/synthetic labeled fixtures for login/running/machine-auth/cert/unverifiable states, preferences, empty/compatible/conflicting Serve/Funnel, and incremental/malformed/oversized login output.
- [ ] RED/GREEN trusted runner: helper-returned absolute executable, literal argv, `shell:false`, bounds, incremental 64 KiB objects/256 KiB total, status polling, validated AuthURL, redaction.
- [ ] Require 1.102.1+, lowercase ASCII exact `.ts.net` boundary, matching trimmed Self.DNSName, and CertDomains membership. Conservatively reject custom/unverifiable state; never use undocumented debug prefs.
- [ ] RED/GREEN account/preferences: install offer/cancel; explicit existing-account confirmation; no switching; login resume; machine-auth pause; targeted unattended/shields-up consent; managed-policy refusal; never logout/broad `up`.
- [ ] RED/GREEN mapping: inspect all Serve/Funnel state; reuse exact no-PROXY mapping as unowned; refuse all other 443 uses; if needed, use/remove only a checked temporary HTTPS text consent mapping on an approved unused port.
- [ ] Create only exact L4 mapping. Re-inspect; verify trust/SAN/no redirect/bounded health/non-h2 ALPN/short WSS; record ownership in SQLite. Roll back only exact wizard-owned live state. Inject failure after every mutation/probe/write boundary.

```powershell
pnpm --filter cozygateway exec vitest run test/tailscale-cli.test.ts test/tailscale-mode.test.ts
pnpm --filter cozygateway typecheck
git add packages/gateway/src/tailscale-cli.ts packages/gateway/src/tailscale-mode.ts packages/gateway/test/tailscale-cli.test.ts packages/gateway/test/tailscale-mode.test.ts packages/gateway/test/fixtures/tailscale
git commit -m "feat: automate personal Tailscale access"
```

## Task 10: Wire the TUI and Windows installer

**Files:** Modify `packages/gateway/src/cli.ts`, its tests, `packages/gateway/src/configure.ts`, its tests, `scripts/agent-install.sh`, `scripts/test/hermes-installer.test.sh`, `scripts/install.ps1`, and `scripts/test/windows-bootstrap.test.ps1`.

- [ ] RED: interactive `setup` offers Remote with Tailscale, Same Wi-Fi, Set up later, and advanced settings. Noninteractive setup emits no QR/code and prints one resume command.
- [ ] RED: fresh pending marker blocks `pair`; complete matching posture permits later pair; changed posture routes to setup; existing installs become `legacy_unreviewed` with explicit pairing compatible; App Review, Docker/headless, POSIX, public URL, and TTL behavior stay unchanged.
- [ ] GREEN: TUI shows mode/readiness/expiry/resume status; no separate doctor command. Ensure Hermes model selection happens before Gateway preparation if provider/model is not configured.
- [ ] RED/GREEN installer: pending marker before config; Windows invokes `cozygateway setup` in original PowerShell and never unconditional pair; cancellation never falls back; resume does not repeat completed steps. Noninteractive Windows finishes healthy loopback install, prints setup command, and emits no pairing material. POSIX finale stays unchanged.

```powershell
pnpm --filter cozygateway exec vitest run test/cli.test.ts test/configure.test.ts test/network-onboarding.test.ts test/tailscale-mode.test.ts test/lan-mode.test.ts
& 'C:\\Program Files\\Git\\bin\\bash.exe' scripts/test/hermes-installer.test.sh
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1
git add packages/gateway/src/cli.ts packages/gateway/test/cli.test.ts packages/gateway/src/configure.ts packages/gateway/test/configure.test.ts scripts/agent-install.sh scripts/test/hermes-installer.test.sh scripts/install.ps1 scripts/test/windows-bootstrap.test.ps1
git commit -m "feat: guide Windows network onboarding"
```

## Task 11: Adversarial and native release gates

- [ ] Focused abuse gate:

```powershell
pnpm --filter cozygateway exec vitest run test/onboarding-storage.test.ts test/phone-verification-http.test.ts test/phone-verification-ws.test.ts test/phone-verification-abuse.test.ts test/network-onboarding.test.ts test/tailscale-cli.test.ts test/tailscale-mode.test.ts test/lan-mode.test.ts
```

- [ ] Full local gate:

```powershell
pnpm build
pnpm typecheck
pnpm --filter cozygateway exec vitest run
pnpm --filter cozygateway-contract exec vitest run
pnpm --filter cozygateway-conformance exec vitest run
pnpm bundle
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-helper.test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-tailscale-transport-spike.test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1
& 'C:\\Program Files\\Git\\bin\\bash.exe' scripts/test/hermes-installer.test.sh
pnpm --filter cozygateway-contract lint:package
git diff --check
```

- [ ] Run independent GPT-5.6-Sol/high spec/compatibility and adversarial/security reviews. Resolve every Critical/Important finding with a regression test; rerun the full gate.
- [ ] With explicit host permission, run the live disposable transport spike—never a managed CozyGateway install—on 1.102.1 and release-time stable. Save sanitized versions, full state before/after, cert/SAN/ALPN, soak, and cleanup evidence to `docs/research/2026-08-28-windows-tailscale-transport-evidence.md`.
- [ ] Run real iOS/Android: one connectivity QR scan, zero phone taps, matching phrase, default-deny desktop prompt, final CozyChat pairing QR, roster/stream/media, direct/DERP, background/reconnect/VPN/daemon/logout/reboot, non-tailnet/Funnel negatives. Disabling phone Tailscale must break reachability.
- [ ] Confirm CozyGateway remains uninstalled on this development host.

## Task 12: Version, merge, release, and hand off the website

**Files:** Modify `packages/gateway/package.json` and `pnpm-lock.yaml`; update the existing GitHub website handoff issue only.

- [ ] Choose version from repository release policy/history after compatibility is known; update package and lock together.
- [ ] Rebuild and verify all assets, including the Windows helper and checksum.
- [ ] Rerun Task 11 against the release commit; require clean `git status --short`.
- [ ] Merge via established process. CI billing failure may be documented; no product/test failure is waived.
- [ ] Create/verify tag, GitHub release, checksums, and public setup bootstrap for the released tag without website edits.
- [ ] Update the existing website handoff issue with release tag/commit, exact one-line Windows install command, choices, personal-account/no-partnership copy, one-scan proof and pairing gate, assets/checksums, evidence, screenshots/copy needs, and limitations.
- [ ] Mark the goal complete only after release assets and handoff issue are externally verifiable.

```powershell
git status --short
git log -1 --oneline
$releaseTag = "v$((Get-Content packages/gateway/package.json -Raw | ConvertFrom-Json).version)"
gh release view $releaseTag --json tagName,targetCommitish,assets,url
gh issue view 261 --json number,title,state,url,body
```

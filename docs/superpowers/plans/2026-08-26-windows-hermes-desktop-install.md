# Windows Hermes Desktop Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a PowerShell 5.1-compatible, checksum-verified Windows installer that configures CozyGateway beside Hermes Desktop, persists it without elevation, and finishes with a live QR and pairing code.

**Architecture:** `scripts/install.ps1` is a thin native bootstrap that verifies release assets and locates Git Bash. It hands off to the existing shared `agent-install.sh`, whose Windows branch normalizes paths and manages an `ONLOGON` Scheduled Task with a hidden Startup-folder fallback. Release packaging and CI ship and exercise both entry points.

**Tech Stack:** Windows PowerShell 5.1, Git Bash, Node.js 24+, shell test harnesses, Scheduled Tasks, VBScript hidden launcher, GitHub Actions.

## Global Constraints

- Support Windows PowerShell 5.1 and newer.
- Require no administrator prompt and register only current-user persistence.
- Reuse Hermes Desktop's Hermes CLI, Node 24+, and Git Bash when present.
- If Hermes is absent, invoke the official tagged NousResearch Hermes Windows installer and its normal setup wizard, then continue in the same PowerShell session.
- Verify every downloaded executable artifact against its release SHA-256 sidecar before use.
- Preserve existing Hermes profiles and Hermes-owned services.
- Keep the Windows gateway isolated under `%LOCALAPPDATA%\cozygateway` by default.
- End every successful install or reinstall with a fresh terminal QR and plain-text pairing code.
- Do not modify the website repository; create a follow-up GitHub issue with the publishing handoff.
- Phone-created bot auto-provisioning on Windows is out of scope.

## File map

- Create `scripts/install.ps1`: Windows release bootstrap only.
- Create `scripts/test/windows-bootstrap.test.ps1`: dependency-free PowerShell bootstrap tests.
- Modify `scripts/agent-install.sh`: Windows paths, launcher, task/startup persistence, status, uninstall.
- Modify `scripts/test/hermes-installer.test.sh`: Windows shared-installer tests with fake native tools.
- Modify `scripts/build-bundle.mjs`: copy and checksum `install.ps1` into release output.
- Modify `.github/workflows/ci.yml`: run the PowerShell test on Windows.
- Modify `.github/workflows/release.yml`: upload `install.ps1` and its checksum.
- Modify `package.json`: expose the Windows bootstrap test command.
- Modify `README.md`, `docs/agent-install.md`, and `docs/install-service.md`: Windows usage and operations.
- Create `docs/handoffs/2026-08-26-publish-windows-installer.md`: website publishing handoff used as the follow-up issue body.

---

### Task 1: Checksum-verified PowerShell bootstrap

**Files:**
- Create: `scripts/install.ps1`
- Create: `scripts/test/windows-bootstrap.test.ps1`
- Modify: `package.json`

**Interfaces:**
- Consumes environment overrides `COZYGATEWAY_INSTALL_REPO`, `COZYGATEWAY_INSTALL_TAG`, `COZYGATEWAY_INSTALL_ASSET_BASE`, `COZYGATEWAY_HOME`, `COZYGATEWAY_GIT_BASH`, `COZYGATEWAY_HERMES_INSTALL_URL` (test override), and `COZYGATEWAY_INSTALL_DRYRUN`.
- Produces a call to Git Bash with verified `cozygateway-installer.sh`, `--service-platform Windows`, `--gateway-dir`, `--bundle`, and `--plugin-archive` arguments.

- [ ] **Step 1: Write failing bootstrap tests**

Create a dependency-free PowerShell test that starts a loopback `HttpListener`, serves fixtures and SHA-256 sidecars, sets `COZYGATEWAY_GIT_BASH` to a fake `.cmd` recorder, dot-invokes `scripts/install.ps1`, and asserts the recorder received all absolute paths plus `--service-platform Windows`. Add separate cases proving an existing Hermes CLI is reused, a missing Hermes CLI invokes the fake official installer and continues after its fake CLI/profile appear, incomplete Hermes setup fails clearly, checksum mismatch exits nonzero, paths containing spaces survive, dry-run never invokes Bash, and Windows' `System32\bash.exe` is not accepted as a fallback.

```powershell
$env:COZYGATEWAY_INSTALL_ASSET_BASE = $server.BaseUrl
$env:COZYGATEWAY_HOME = Join-Path $temp 'Cozy Gateway'
$env:COZYGATEWAY_GIT_BASH = $fakeBash
& $installer
Assert-True (Select-String -LiteralPath $record -SimpleMatch '--service-platform Windows')
Assert-True (Select-String -LiteralPath $record -SimpleMatch 'cozygateway-installer.sh')
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1
```

Expected: nonzero exit because `scripts/install.ps1` does not exist.

- [ ] **Step 3: Implement the PowerShell 5.1 bootstrap**

Implement explicit functions with these signatures:

```powershell
function Resolve-InstallHome { param([string] $RequestedHome) }
function Resolve-Hermes { param([string] $InstallerUri) }
function Refresh-HermesEnvironment { param([string] $HermesHome) }
function Get-LatestTag { param([string] $Repository) }
function Get-VerifiedAsset { param([string] $Name, [string] $Destination, [string] $BaseUri) }
function Resolve-GitBash { param([string] $ExplicitPath) }
function Invoke-CozyGatewayInstaller { param([string] $BashPath, [string] $InstallerPath, [string[]] $ForwardedArguments) }
```

Use `Invoke-WebRequest -UseBasicParsing`, `Get-FileHash -Algorithm SHA256`, atomic `.new` files, and `[Environment]::GetEnvironmentVariable('HERMES_GIT_BASH_PATH','User')`. `Resolve-Hermes` first probes the command and `%LOCALAPPDATA%\hermes\bin\hermes.exe`; when absent it resolves the latest `NousResearch/hermes-agent` release tag, downloads that tag's `scripts/install.ps1`, executes its normal setup wizard, refreshes `HERMES_HOME`, User PATH, and `HERMES_GIT_BASH_PATH`, then requires `hermes -p default config path` to name an existing file. Search Bash overrides first, then Hermes-managed `bin`/`usr\bin`, Git's install root, Program Files, and LocalAppData. Invoke the verified CozyGateway shell installer only after all CozyGateway assets pass. Default the install home to `$env:LOCALAPPDATA\cozygateway`.

- [ ] **Step 4: Run the bootstrap tests and verify GREEN**

Run the command from Step 2.

Expected: exit 0 and `windows bootstrap tests passed`; the checksum-negative child process must fail with `checksum mismatch`.

- [ ] **Step 5: Commit Task 1**

```powershell
git add scripts/install.ps1 scripts/test/windows-bootstrap.test.ps1 package.json
git commit -m "feat: add verified Windows PowerShell bootstrap"
```

### Task 2: Windows path and platform support in the shared installer

**Files:**
- Modify: `scripts/agent-install.sh`
- Modify: `scripts/test/hermes-installer.test.sh`

**Interfaces:**
- Consumes native Windows paths emitted by `hermes -p <profile> config path` and bootstrap-provided `COZYGATEWAY_GIT_BASH`.
- Produces normalized POSIX paths for shell file operations and native paths for Windows launchers through `to_posix_path()` and `to_windows_path()`.

- [ ] **Step 1: Add failing Windows platform/path tests**

Extend the installer harness with a fake `cygpath` and fake Hermes output such as `C:\Users\Cozy User\AppData\Local\hermes\config.yaml`. Assert that `COZYGATEWAY_SERVICE_PLATFORM=Windows --dry-run` succeeds, detects profiles, chooses the Windows service branch, and never embeds CRLF in generated shell/config content. Add automatic detection cases for `MINGW64_NT-*`, `MSYS_NT-*`, and `CYGWIN_NT-*` by overriding a fake `uname`.

```bash
grep -q 'one CozyGateway Windows service' <<<"$output"
grep -q 'Profiles: default active ops' <<<"$output"
```

- [ ] **Step 2: Run the installer tests and verify RED**

Run:

```powershell
& 'C:\Program Files\Git\bin\bash.exe' scripts/test/hermes-installer.test.sh
```

Expected: failure at `resolve_platform` with the current macOS/Linux-only message.

- [ ] **Step 3: Implement platform and path normalization**

Add:

```bash
is_windows_platform() { case "$SERVICE_PLATFORM" in Windows|MINGW*|MSYS*|CYGWIN*) return 0 ;; *) return 1 ;; esac; }
to_posix_path() { is_windows_platform && cygpath -u "$1" || printf '%s' "$1"; }
to_windows_path() { is_windows_platform && cygpath -w "$1" || printf '%s' "$1"; }
```

Normalize Hermes config output before `-f`, `dirname`, `cd`, plugin, env, and spool operations. Permit spaces in the Windows gateway path while retaining the current conservative POSIX validation. Canonicalize `Windows`, `MINGW*`, `MSYS*`, and `CYGWIN*` to `SERVICE_PLATFORM=Windows`.

- [ ] **Step 4: Run tests and verify GREEN**

Run the command from Step 2 and `git diff --check`.

Expected: installer harness exits 0 and prints `hermes installer dry-run tests passed`.

- [ ] **Step 5: Commit Task 2**

```powershell
git add scripts/agent-install.sh scripts/test/hermes-installer.test.sh
git commit -m "feat: normalize Hermes paths on Windows"
```

### Task 3: Scheduled Task, Startup fallback, status, and uninstall

**Files:**
- Modify: `scripts/agent-install.sh`
- Modify: `scripts/test/hermes-installer.test.sh`

**Interfaces:**
- Produces `%LOCALAPPDATA%\cozygateway\local\run-gateway.vbs`, task name `CozyGateway`, Startup fallback `CozyGateway.vbs`, and installer option `--status`.
- Status reports persistence (`Scheduled Task`, `Startup`, or `absent`) and liveness (`healthy` or `not responding`) without printing secrets.

- [ ] **Step 1: Write failing Windows service tests**

Add fake `schtasks.exe`, `wscript.exe`, and `curl` commands that record argv. Cover successful `/Create /SC ONLOGON /RL LIMITED /TN CozyGateway`, immediate hidden launch, idempotent rerun, `/Query` plus health status, `/Delete /F`, and access-denied fallback to `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\CozyGateway.vbs`. Assert task arguments and VBS content retain paths with spaces.

```bash
grep -Fq '/Create /SC ONLOGON /RL LIMITED /TN CozyGateway' "$system_log"
grep -Fq 'wscript.exe' "$gateway/local/run-gateway.vbs"
test -f "$appdata/Microsoft/Windows/Start Menu/Programs/Startup/CozyGateway.vbs"
```

- [ ] **Step 2: Run tests and verify RED**

Run the Git Bash command from Task 2.

Expected: failure because the Windows service branch and `--status` do not exist.

- [ ] **Step 3: Generate the hidden launcher**

Write `run-gateway.vbs` with CRLF endings. It must set `HERMES_HOME`, load no secrets itself, and run the existing mode-700 `run-gateway.sh` through the resolved Git Bash using `WScript.Shell.Run command, 0, False`. Escape embedded VBScript quotes by doubling them and reject CR/LF in every interpolated path.

- [ ] **Step 4: Implement Windows install and fallback**

On install, delete an existing `CozyGateway` task, call:

```text
schtasks.exe /Create /F /SC ONLOGON /RL LIMITED /TN CozyGateway /TR "wscript.exe <native-vbs-path>"
```

Then start the launcher immediately. If task creation output is access-denied/policy-blocked, atomically place the same VBS launcher in the current user's Startup directory. Unexpected errors remain fatal.

- [ ] **Step 5: Implement status and uninstall**

Add `--status` as an early action that reads install state, queries task and Startup registration, probes `http://127.0.0.1:<port>/health`, and returns nonzero when persistence or liveness is absent. Uninstall deletes both task and Startup entry before removing the dedicated gateway directory; dry-run prints every intended action and changes nothing.

- [ ] **Step 6: Run Windows service tests and verify GREEN**

Run the Git Bash command from Task 2.

Expected: exit 0, all task/fallback/status/uninstall assertions pass, and the final line remains `hermes installer dry-run tests passed`.

- [ ] **Step 7: Commit Task 3**

```powershell
git add scripts/agent-install.sh scripts/test/hermes-installer.test.sh
git commit -m "feat: manage CozyGateway login service on Windows"
```

### Task 4: Release assets, CI, and operator documentation

**Files:**
- Modify: `scripts/build-bundle.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `README.md`
- Modify: `docs/agent-install.md`
- Modify: `docs/install-service.md`

**Interfaces:**
- Produces release assets `install.ps1` and `install.ps1.sha256`.
- Produces package script `test:installer:windows` and a Windows CI job using Node 24.

- [ ] **Step 1: Add failing release-asset assertions**

Extend the PowerShell test to run `pnpm bundle` when built output exists and assert `dist-bundle/install.ps1` is byte-identical to `scripts/install.ps1` and its sidecar hash matches `Get-FileHash`.

- [ ] **Step 2: Update build and release workflows**

Copy `scripts/install.ps1` to `dist-bundle/install.ps1`, hash it with the existing Node SHA-256 path, and add both files to the GitHub release upload list. Add a `windows-installer` CI job on `windows-latest` that installs Node 24 and runs:

```yaml
- run: powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1
```

- [ ] **Step 3: Update human documentation**

Document the eventual `irm https://cozylabs.ai/install.ps1 | iex` command, automatic official Hermes installation and setup when absent, reuse when present, checkout/release testing before website publication, `%LOCALAPPDATA%\cozygateway`, `--status`, logs, rerun semantics, uninstall, Scheduled Task/Startup behavior, pairing-code expiry, and the explicit absence of Windows bot auto-provisioning.

- [ ] **Step 4: Verify release and docs**

Run:

```powershell
pnpm build
pnpm bundle
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1
& 'C:\Program Files\Git\bin\bash.exe' scripts/test/hermes-installer.test.sh
git diff --check
```

Expected: all commands exit 0; `dist-bundle/install.ps1.sha256` matches the asset.

- [ ] **Step 5: Commit Task 4**

```powershell
git add scripts/build-bundle.mjs .github/workflows/ci.yml .github/workflows/release.yml README.md docs/agent-install.md docs/install-service.md package.json
git commit -m "docs: publish Windows install and service workflow"
```

### Task 5: Live Windows installation and pairing acceptance

**Files:**
- Create: `docs/handoffs/2026-08-26-publish-windows-installer.md`
- Modify only if live evidence exposes a defect: files from Tasks 1-4 plus the matching tests.

**Interfaces:**
- Consumes the locally built release assets and installed Hermes Desktop.
- Produces a running isolated CozyGateway, a fresh QR/setup code shown only in the terminal, and a website follow-up issue.

- [ ] **Step 1: Capture the live baseline with exit codes**

Run `hermes --version`, print redacted `LOCALAPPDATA`/`HERMES_HOME`, run `hermes -p default config path`, resolve Git Bash, run `node --version`, and run `hermes gateway status`. Label results `VERIFIED CURRENT` and do not copy `.env` contents.

- [ ] **Step 2: Install from local release assets**

Run the PowerShell bootstrap against `dist-bundle` through a temporary loopback HTTP server or a tagged release asset base. Capture the command, output, and exit code while redacting tokens. The installer must finish by displaying the live QR and setup code in the user's current terminal.

- [ ] **Step 3: Verify runtime and idempotency**

Run installer `--status`, query `schtasks /Query /TN CozyGateway /V /FO LIST`, request `/health`, verify `attach.online == attach.configured` and zero dead letters, then rerun the installer and confirm it preserves attach tokens while minting a new setup code. Do not print the token values or record the still-valid setup code in a file.

- [ ] **Step 4: User pairing acceptance**

Pause only after a QR and pairing code are visible. Ask the user to pair CozyChat on the same LAN, then verify roster load, streamed message/reply, and media delivery from observed runtime evidence.

- [ ] **Step 5: Write the website publishing handoff**

Record the exact release asset names, SHA sidecar, desired `/install.ps1` route, `text/plain; charset=utf-8`, conservative cache behavior, public command, smoke test, rollback, current release/tag assumptions, and Windows evidence. State that website deployment and DNS/CDN changes remain out of scope.

- [ ] **Step 6: Create the follow-up GitHub issue**

Run:

```powershell
gh issue create --repo shiftedx/cozygateway --title "Website: publish the verified Windows installer at /install.ps1" --body-file docs/handoffs/2026-08-26-publish-windows-installer.md
```

Expected: a new issue URL. Add that URL to the final report.

- [ ] **Step 7: Run the complete verification suite**

Run:

```powershell
pnpm check
pnpm test:installer
pnpm test:installer:windows
git status --short
```

Expected: all test commands exit 0; status contains only intentional handoff/evidence changes, if any.

- [ ] **Step 8: Commit the handoff and any evidence-driven fixes**

```powershell
git add docs/handoffs/2026-08-26-publish-windows-installer.md
git commit -m "docs: hand off Windows installer website publication"
```

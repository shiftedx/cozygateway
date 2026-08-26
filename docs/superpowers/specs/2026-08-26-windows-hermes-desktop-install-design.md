# Windows Hermes Desktop installer design

## Goal

A Hermes Desktop user on Windows can paste one PowerShell command, install a
secondary CozyGateway instance without administrator rights, and finish with a
scannable QR code plus a plain-text pairing code for CozyChat.

The Windows host is independent of any CozyGateway already paired with the app.
It owns its own database, tokens, Hermes profile wiring, service registration,
and pairing credentials.

## User experience

The eventual public command is:

```powershell
irm https://cozylabs.ai/install.ps1 | iex
```

This repository supplies and tests `scripts/install.ps1`. Publishing it at the
short URL is a separate website task. Until that task ships, the script can be
run from a checkout or a versioned GitHub release URL.

The installer supports built-in Windows PowerShell 5.1, runs without elevation,
uses an existing Hermes Desktop installation when present, installs Hermes Agent
through its official Windows installer when absent, and ends by printing:

- a terminal QR containing the gateway URL and setup code;
- the gateway URL in plain text;
- the setup code in plain text; and
- the command for minting another code after the ten-minute expiry.

Re-running the command updates the verified artifacts, preserves existing
attach tokens, repairs service registration if needed, and mints a new pairing
code.

## Architecture

### PowerShell bootstrap

`scripts/install.ps1` is a small bootstrap equivalent to `scripts/install.sh`.
It:

1. Requires PowerShell 5.1 or newer and enables TLS 1.2 where necessary.
2. Resolves Hermes first. If `hermes.exe` and a default profile are already
   usable, it leaves them untouched. Otherwise it downloads the official Hermes
   Windows installer from the latest tagged NousResearch/hermes-agent release,
   runs its normal interactive setup, refreshes the current process environment,
   and verifies the resulting CLI and default profile before continuing. A test
   override permits a local fake installer; production does not silently use a
   fork or mirror.
3. Runs `hermes model` interactively on every install or reinstall, after Hermes
   exists and before any CozyGateway state is changed. The user explicitly
   selects or confirms the inference provider and default model. The bootstrap
   then verifies that Hermes reports an active provider and current model; a
   cancelled or incomplete selection stops the run.
4. Resolves the requested CozyGateway release tag or the repository's latest release.
5. Downloads the gateway bundle, attach-plugin archive, and shared installer,
   plus each asset's SHA-256 sidecar.
6. Verifies every CozyGateway artifact with `Get-FileHash` before replacing an installed
   copy or executing code.
7. Locates Git Bash in Hermes' documented order: `HERMES_GIT_BASH_PATH`,
   Hermes-managed PortableGit layouts, Git associated with `git.exe`, standard
   Program Files locations, and the per-user Git location. It never mistakes
   Windows' WSL `bash.exe` shim for Git Bash.
8. Invokes the verified shared installer with explicit Windows paths and
   `--service-platform Windows`.

Uninstall takes a recovery-only path before Hermes discovery, model selection,
downloads, Node checks, or listener parsing and still removes owned files when
the recorded Hermes executable is gone. Dry runs do not install Hermes,
download into the managed directory, edit PATH, or remove an installation.

The bootstrap does not independently install Node, Git, or WSL. When Hermes is
absent, Hermes' own installer owns those prerequisites and its setup wizard. If
the user cancels Hermes setup or no default profile exists afterward, the run
stops with an instruction to finish Hermes setup and paste the same CozyGateway
command again.

### Shared installer Windows support

`scripts/agent-install.sh` remains the source of truth for profile discovery,
plugin installation, credential ownership, gateway configuration, Hermes
gateway lifecycle, uninstall, idempotency, and the pairing finale.

The Windows branch:

- recognizes `Windows`, `MINGW*`, `MSYS*`, and `CYGWIN*`;
- normalizes Windows paths returned by Hermes into Git Bash paths before POSIX
  filesystem operations, while preserving native Windows spellings for native
  launchers;
- generates runtime files with intentional line endings and quotes paths that
  contain spaces;
- writes a Windows launcher that starts the Node gateway with its installer-owned
  environment and local Hermes Dashboard control plane;
- registers a current-user `CozyGateway` Scheduled Task with an `ONLOGON`,
  limited-privilege trigger;
- starts the gateway immediately after installation;
- falls back to a hidden Startup-folder launcher if task creation is blocked by
  policy; and
- removes both persistence forms during uninstall.
- identifies a running managed gateway by its exact config path before stopping
  it, including when an update changes the listener port.
- validates a stubborn Dashboard listener against either the resolved Hermes
  executable or Hermes' root launcher before stopping its Python child.

The Scheduled Task and Startup fallback are login persistence mechanisms. Live
status also verifies the CozyGateway process or health endpoint so a registered
but dead task is not reported as healthy.

## Data and ownership boundaries

The Windows install uses a dedicated CozyGateway directory under the user's
local application data. It does not share state with the user's Mac Studio
gateway or modify any remote gateway.

Hermes continues to own its profile directories and Hermes gateway services.
CozyGateway owns only:

- its gateway bundle, installer, launchers, config, database, logs, and state;
- its Scheduled Task or Startup entry;
- its checked attach-plugin copies;
- the four installer-marked profile environment keys; and
- its generated attach and dashboard credentials.

Uninstall reverses only installer-recorded CozyGateway work. Phone-created bot
auto-provisioning on Windows remains out of scope.

## Failure handling

The bootstrap stops before execution on download or checksum failure. The
shared installer fails loudly when Hermes, Node 24+, Git Bash, a safe install
directory, or a required profile cannot be resolved. Secrets and active pairing
codes are never written to diagnostic logs or test fixtures.

Task creation failure falls back only for policy/access-denied-style failures.
Unexpected task errors remain visible instead of silently degrading. A failed
gateway start prevents the installer from claiming success or printing a
pairing code for an unreachable service.

## Verification

Automated coverage will exercise:

- PowerShell 5.1-compatible syntax and checksum success/failure;
- reuse of an existing Hermes install, official Hermes bootstrap when missing,
  environment refresh, and a cancelled/incomplete Hermes setup failure;
- mandatory `hermes model` invocation and rejection of a missing active provider
  or default model before CozyGateway mutation;
- Git Bash discovery, including paths with spaces and rejection of WSL Bash;
- Windows platform detection and path conversion;
- Scheduled Task creation, idempotent replacement, status, and uninstall;
- Startup-folder fallback and uninstall;
- CRLF/LF expectations and launcher quoting;
- dry-run non-mutation; and
- the final QR/pair-code output.

Live verification on the Windows Hermes Desktop host will record exit codes for
the Hermes/Node baseline, install, service state, health, idempotent rerun, and
pairing. The final acceptance check is CozyChat pairing to this separate host,
roster load, streamed message/reply, and media delivery. Logout/login persistence
is reported separately because it requires an interactive user session cycle.

## Website handoff

After the repository implementation is verified, create a new GitHub issue for
the website agent. The issue must identify the exact release asset, desired
`/install.ps1` route and content type, cache behavior, public one-liner,
verification commands, rollback, and the evidence already gathered on Windows.
No website repository is modified in this cycle.

# Windows Hermes session-token release design

## Goal

Ship the first public Windows CozyGateway installer using Hermes' loopback
session-token authentication, validate a fresh installation on a real Windows
host against the local vLLM provider, and publish the next available release
(expected to be v0.3.9).

Existing Windows CozyGateway upgrades are out of scope because no Windows
installations have been deployed. Hermes itself may already be installed and
configured; the installer must reuse it without rewriting its model provider.

## Chosen approach

Keep `scripts/install.ps1` as a small PowerShell 5.1-compatible bootstrap and
keep all Dashboard authentication in `scripts/agent-install.sh`. This is the
same shared path used by macOS, Linux, and Windows. PR 266 already changed that
path to mint one installer-owned `DASHBOARD_SESSION_TOKEN`, launch Hermes with
`HERMES_DASHBOARD_SESSION_TOKEN`, probe `/api/config` with
`X-Hermes-Session-Token`, and configure CozyGateway with `authMode: "token"`
and `COZYGATEWAY_HERMES_TOKEN`.

Do not duplicate session-token logic in PowerShell and do not add a separate
Windows runtime. Production code changes are required only if an automated or
live-host test exposes a Windows-specific defect.

Alternatives rejected:

- Reimplement Dashboard startup and authentication in PowerShell. This would
  create a second credential lifecycle and allow platform behavior to drift.
- Replace the Git Bash handoff with a Windows-native installer rewrite. This is
  much larger than the auth change and would duplicate established lifecycle,
  profile, service, and uninstall behavior.

## Fresh-install behavior

1. `install.ps1` reuses a configured Hermes CLI and model when available.
2. It checksum-verifies the bundle, attach plugin, and shared installer release
   assets before executing them.
3. It invokes the shared installer with `--service-platform Windows`.
4. The shared installer creates a private session token, starts the loopback
   Hermes Dashboard with that token, verifies authenticated `/api/config`
   access, and starts CozyGateway with the same token supplied only through its
   protected environment file.
5. The installer must not enable Hermes' basic-auth plugin, call
   `/auth/password-login`, or write Dashboard username/password keys.
6. The Windows login persistence mechanism must start the same generated
   supervisor and preserve the session-token environment on restart.

## Validation

Automated gates:

- Windows PowerShell bootstrap tests.
- Shared installer tests under Git Bash, including the Windows branch and
  wrong-token restart behavior.
- Build, typecheck, package tests, and bundle generation.
- Inspection of release assets and checksums.

Live-host gate:

- Remove any test CozyGateway installation while preserving Hermes.
- Build local release assets and install from those checksum-verified assets.
- Use the configured local vLLM endpoint at `http://127.0.0.1:8888/v1` and
  model `qwen38-nvfp4`.
- Verify protected token files, token-mode gateway config, Dashboard
  authenticated access, CozyGateway health/status, Hermes plugin connection,
  one real model turn, idempotent status/start behavior, and uninstall.
- Repeat the install from the published release assets before declaring the
  release validated.

Secrets, pairing codes, and session tokens must never be printed in logs or
release notes.

## Release

Fetch immediately before versioning. If v0.3.8 exists, bump the three release
version sources to `0.3.9`; otherwise do not consume a version reserved by work
already in flight. Push through a pull request, wait for CI, merge, then create
and push the matching tag. The tag-triggered release workflow must publish the
bundle, plugin archive, POSIX installer, Windows installer, and all checksum
sidecars. Validate the final Windows install from those published assets.

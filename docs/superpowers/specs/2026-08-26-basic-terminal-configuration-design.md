# Basic Terminal Configuration Design

## Goal

An installed user can type `cozygateway` in a terminal and use a small, reliable menu to inspect the gateway, pair a device, or change the listener address and port. Existing installs keep the current `0.0.0.0:8787` behavior until a user explicitly changes it.

## Interface

Running `cozygateway` on an interactive terminal opens a numbered menu. It shows the configured listener and live health, then offers:

1. Pair a device
2. Configure listener
3. Refresh status
4. Exit

`cozygateway pair`, `cozygateway serve`, and the other existing explicit commands remain scriptable and unchanged. `cozygateway status --config PATH` prints status without opening the menu. `cozygateway configure --config PATH` opens the two-field configuration flow directly.

The configuration flow prompts for bind address and port with current values as defaults. Empty input keeps the current value. The port must be a whole number from 1 through 65535; the bind address must be non-empty and must not contain whitespace or URL syntax. Invalid input is explained and does not modify the file.

## Architecture

The existing CLI owns the menu, status request, validation, and atomic JSON update. It uses Node's built-in `readline/promises`; no terminal dependency is added. Input/output is represented by a small injectable interface so tests can drive the real menu state machine without a pseudo-terminal.

The installed service runner watches the configuration file. A successful atomic replacement causes it to stop the current gateway child and start a new child with the new listener settings. The supervisor stays alive, so this works with the Windows Startup fallback as well as launchd and systemd. The same configuration operation updates only the installer-owned `COZYGATEWAY_URL` line in every managed Hermes profile and restarts those Hermes gateways so attach follows a changed port.

The Windows installer writes `cozygateway.cmd` beside the existing Git Bash wrapper and adds that bin directory to the current process and the user's PATH idempotently. macOS and Linux expose the same managed wrapper through `~/.local/bin` and their login profile. Plain `cozygateway` therefore finds the installed configuration without a global package or extra dependency.

## Data Safety and Failure Handling

Configuration changes parse and validate the entire existing config before mutation, preserve unknown and unrelated keys, write sibling temporary files, and atomically rename them over the originals. Hermes environment files retain all secret lines byte-for-byte; only the non-secret local gateway URL changes.

The menu reports an offline health endpoint without failing to open. A managed listener change is accepted only after every configured Hermes attach is online with zero dead letters; a failed replacement atomically restores the previous listener and Hermes target. IPv6 URLs are bracketed. TLS changes preserve an existing HTTPS hostname for certificate validation instead of substituting the local bind address.

## Testing

CLI tests cover the default menu, pairing dispatch, unchanged defaults, valid persistence, invalid port and host rejection, status output, and preservation of unrelated config. Installer tests cover the native Windows command wrapper and idempotent PATH registration. Runner tests assert that the generated supervisor watches the configuration and respawns the gateway child. The full monorepo check and both installer harnesses remain required.

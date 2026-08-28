# Installer LAN choice design

## Goal

Let an average user make a new CozyGateway reachable from CozyChat on the same LAN during the one-line install, without making network exposure the silent default. Keep the existing Tailscale flow as the recommended durable remote-access setup.

## Interaction

On a fresh interactive install with no explicit listener or public URL, ask:

`Allow devices on your local network to connect? [y/N]`

Enter or `n` keeps the existing `127.0.0.1` default. `y` selects `0.0.0.0`; the existing pairing command then advertises the machine's detected LAN address in its QR code. Invalid input repeats the question with a short explanation.

The installer must not prompt during upgrades, redirected/noninteractive execution, dry runs, or when `--bind-host`, `--public-url`, or a saved listener already expresses the user's intent. Existing installs retain their saved network posture.

## Safety and handoff

LAN mode does not change Windows Firewall, router settings, DNS, TLS, or Tailscale. Completion output states that LAN access is plaintext and intended only for a trusted private network. It links to the existing access documentation and identifies Tailscale as the next step for remote access.

## Implementation

Keep the decision inside `scripts/agent-install.sh` next to saved-listener loading and validation. Use terminal detection so the website's piped one-line bootstrap cannot block when standard input is unavailable. Preserve the existing `--bind-host 0.0.0.0` power-user path.

## Tests

The installer harness covers the default answer, affirmative answer, invalid-answer retry, explicit-option bypass, noninteractive bypass, upgrade preservation, and LAN completion guidance. Existing Windows bootstrap, installer, build, typecheck, and package suites remain release gates.

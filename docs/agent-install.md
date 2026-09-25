# CozyGateway Hermes install

Use the human-facing one-paste installer on a new or existing machine:

Windows PowerShell 5.1+:

```powershell
irm https://cozylabs.ai/install.ps1 | iex
```

The Windows bootstrap checksum-verifies the Gateway release assets, installs or
updates Hermes Agent, and opens model selection only when configuration is
incomplete. The official NousResearch Windows installer runs when Hermes is
missing. The Gateway payload runs through Git Bash; when Bash is missing, setup
installs a checksum-verified private Portable Git under the Gateway home. An
elevated terminal hands setup to the same account's normal desktop context in a
new PowerShell window. An account mismatch or unavailable normal desktop stops
before product changes.

The one-liner verifies Gateway readiness and its selected Hermes attachments. A
failed component leaves the existing pairing and model files in place for the
next run.

macOS/Linux:

```sh
curl -fsSL https://cozylabs.ai/install.sh | bash
```

## Hermes Agent

The installer discovers Hermes Agent with `hermes -p <profile> config path`.
When Hermes is absent, it verifies and runs the official Hermes installer before
resuming. Each run keeps the configured Hermes profile scope unless an explicit
`--profiles` value replaces it. `--uninstall` removes only CozyGateway-owned
service registration, plugins, environment keys, spools, and state. `--no-qr`
never prints a pairing QR. The installer refuses to run as root.

An existing install record marked `cozyagents` or `both` is preserved and the
installer stops without changing it. Use the [CozyAgents bundled gateway](https://github.com/shiftedx/cozyagents)
for that product, or install this Hermes gateway in a new gateway directory.

If Node.js 24+ is unavailable, the Windows/macOS/Linux installer downloads the current
Node.js 24 archive from nodejs.org, verifies it against that release's official
`SHASUMS256.txt`, and installs it privately under
the CozyGateway home's `runtime/node` directory. It does not use elevation,
replace the system Node,
or change the shell PATH. If Hermes is unavailable, it verifies and runs the
official installer from the latest tagged NousResearch/hermes-agent release,
then resumes automatically. Every run gives `hermes model` control of the
terminal and requires an active provider and model before CozyGateway changes.

It discovers Hermes with `hermes -p <profile> config path`, then uses that
evidence to find the default home and named profile homes. Every discovered
profile with a `config.yaml` is configured by default. That default remains a
dynamic `all` scope, so update and repair runs automatically provision profiles
created after the first install. A profile created from the phone inherits the
launch profile's `.env` from Hermes, CozyGateway keys included, so the installer
mints it its own attach token and spool rather than reusing the copied ones.
Narrow the scope with `--profiles default,ops` only when that isolation is
intentional.

## Re-homing an install to a different Gateway

A machine whose Hermes profiles already point at another CozyGateway is not
adopted by accident. An ordinary run refuses each profile that carries a
CozyGateway URL it does not own, and the refusal names both ways forward:
`--runtime-only` keeps the existing attachment and updates only the runtime,
and `--replace-gateway` moves those profiles to the Gateway being installed.

`--replace-gateway` does that per selected profile: it stops the profile's
Hermes gateway, copies the five `COZYGATEWAY_*` keys out of its `.env` and the
whole `plugins/cozygateway` folder into
`~/.cozygateway/local/backups/<timestamp>/profiles/<profile>/`, removes both,
and continues with an ordinary install. Nothing else in the profile is read or
moved, and the backup stays until someone deletes it. It cannot be combined
with `--uninstall` or `--runtime-only`.

A loaded Hermes gateway holds its attach target in memory and writes it back
over its profile `.env`, so an edit made while it runs is undone seconds later.
The installer stops a profile before changing its CozyGateway keys, reads the
file back afterwards, and stops with a named failure when the write did not
survive — a dev-box provisioner that re-attaches profiles is the usual cause,
and it has to be unloaded first. A profile whose keys are already correct is
never stopped.

A `plugins/cozygateway` folder with no ownership marker is adopted when its
`plugin.yaml` is byte-identical to the shipped archive's: that is this release
installed before the marker existed. Any other unowned folder still fails
closed and says that `--replace-gateway` is what moves it aside.

Before a profile that is already running is left alone, the installer compares
the attach target in its gateway log with the Gateway being configured, and
restarts it when they differ. A profile whose process is still serving the old
Gateway looks perfectly healthy in every file on disk.

On a machine with an `active_profile`, a plain `hermes gateway run` means that
profile rather than `default`, so a `default` profile gateway would be a second
gateway for the active profile. The installer resolves `default` through
`hermes config path` and skips it when it aliases a profile already selected;
it never starts a profile gateway without naming the profile.

The release bootstrap downloads and SHA-256 verifies three versioned release
assets before execution: the gateway bundle, the complete Hermes attach plugin
archive, and the installer payload. It never executes the mutable raw installer
after that handoff. The checksum detects incomplete or corrupted downloads;
release authenticity still relies on GitHub Releases over TLS. Node archives
rely on nodejs.org TLS plus the release checksum manifest. The Hermes bootstrap
matches the tagged script's Git blob identity from the GitHub Contents API
before execution; downloads performed by that official installer remain under
the NousResearch installer trust boundary.

The public one-line bootstrap relies on HTTPS delivery until a release-attestation-aware bootstrap
is available; release workflows publish GitHub build attestations that operators can verify with
`gh attestation verify` before using downloaded artifacts.

For each selected profile it installs and enables the archive, writes only the
four CozyGateway variables to that profile's mode-600 `.env`, creates a distinct
attach token and persistent spool, and restarts the profile's existing Hermes
gateway service when running, starts it when stopped, or installs it with
Hermes when absent. Hermes still owns those services: uninstall removes only a
service this installer installed or stops one this installer started; it never
removes a pre-existing service.

The generated gateway config keeps the local Hermes Dashboard URL and password
environment-variable name for its control/read plane, plus
`hermes.profiles.<profile>.tokenEnv` names for native attach. Tokens and the
local Dashboard password are in mode-600 environment files, never JSON argv,
service definitions, or installer output. One CozyGateway service is installed
for the shared gateway process; it starts or reuses the local Dashboard without
replacing any Hermes profile gateway service.

```sh
# Re-run to update the verified assets and retain existing profile tokens.
curl -fsSL https://cozylabs.ai/install.sh | bash

# The installed command performs the same verified update-and-repair flow.
cozygateway repair

# Remove only files and env keys owned by CozyGateway.
bash ~/.cozygateway/bin/agent-install.sh --uninstall --gateway-dir ~/.cozygateway
```

Install and repair also run the ownership-checked [hygiene protocol](install-hygiene.md), including safe migration of older recorded scopes and preservation of unrelated environment settings.

`cozygateway update` is an alias for `repair`. Both commands use the persisted,
checksummed release bootstrap and fetch one current matched release; they never
treat the installed bundle or a checkout as an update source. A repair retains
an explicitly narrowed profile selection; the default `all` scope re-discovers
and provisions every current Hermes profile. It also retains the listener and
public origin, device/message database, attach tokens and spools, plus supported
operator-owned configuration such as TLS. An explicit `--profiles` on the
one-line installer remains the way to narrow profile scope.

Near the end of a fresh interactive install, the installer asks one networking question:
`Allow CozyChat to access this Gateway over your local network? [y/N]`. Yes binds CozyGateway to
all local interfaces and makes the pairing QR advertise the machine's detected LAN address. No,
an empty answer, or a non-interactive install keeps the listener on `127.0.0.1`. An explicit
`--bind-host` skips the question, and updates preserve the listener already saved in the config.

The install (and every re-run) then finishes by minting a pairing code and printing a terminal QR
plus the gateway URL and setup code in plain text, so a fresh device goes install, scan, chatting
with no further commands when the selected listener is reachable from that device. The QR encodes
the `{"gatewayUrl":...,"setupCode":...}` payload from contract section 4; the
URL uses the configured listener unless `publicUrl` records a user-managed HTTPS origin. Codes
expire after 10 minutes; mint another with `~/.cozygateway/bin/cozygateway pair`. A configured
public origin is authoritative; `pair --url` may only repeat the same canonical origin.
IPv6 listener addresses are bracketed in generated URLs. With gateway-native
TLS, configuration keeps the existing HTTPS hostname so Hermes validates the
certificate name; private certificate authorities still use
`COZYGATEWAY_CA_FILE`.
Local CLI health checks also pin the configured leaf certificate while allowing
the bind address to differ from its DNS name.

LAN mode is plaintext and is appropriate only on a trusted private network. Explicit
listener/public URL options, saved installs, dry runs, and noninteractive installs bypass the
question; power users can still choose directly with `--bind-host`.
For a tunnel, pass `--public-url https://gateway.example.com`; the installer persists the canonical
origin and requires/sets loopback. Network reachability outside the machine is deliberately not
automated; see `docs/connectivity.md`.

To retire that public origin and return an existing install to LAN access, rerun the installer with
`--clear-public-url --bind-host 0.0.0.0`. Clearing is explicit so an ordinary update cannot silently
replace a saved HTTPS pairing origin; `--clear-public-url` and `--public-url` are mutually exclusive.

After installation, open a new terminal and run `cozygateway` for the basic
terminal menu. It shows live status, prints a fresh pairing QR, and lets a power
user change only the bind address and port. Press Enter at either configuration
prompt to retain the current value. A saved listener change atomically preserves
the rest of the config, updates the local target for every installer-managed
Hermes profile without changing its token, and restarts the gateway and those
Hermes profiles automatically. Rerunning the installer also preserves a saved
custom listener unless an explicit installer host or port option replaces it.
LAN-only bind addresses are used consistently for local Hermes attachment and
health checks. If a managed listener replacement cannot become ready, the CLI
restores the previous working listener automatically.
Readiness requires at least one configured attach profile, every configured
profile online, and zero dead letters. Pairing material is not printed first.
The non-interactive `cozygateway status`, `cozygateway pair`,
`cozygateway configure`, and `cozygateway repair` commands expose the same
focused operations directly. Status distinguishes an unreachable gateway from
an attach connection that needs attention without printing profile identities
or raw errors.

## Bots stream by default

A bot created from the phone types its answer in front of you rather than going
quiet and then pasting a finished message. Hermes decides that per profile and
its own default is off, so the gateway writes two keys into a new profile's
`config.yaml` when it creates it:

```yaml
display:
  streaming: true
  platforms:
    cozygateway:
      streaming: true
```

`display.platforms.cozygateway.streaming` is the one a phone turn resolves;
`display.streaming` is the same choice for a terminal session on that profile.

Profiles created before this default existed are repaired in place: an installer
rerun writes whichever of the two keys is absent, through Hermes' own
`config set`, and restarts that profile's Hermes gateway once so it takes. On a
multiplexed host (`gateway.multiplex_profiles: true`) a served profile has no
gateway of its own, so it is the host that restarts, once for the whole run.
Nothing else about the profile is touched.

To turn streaming off for one bot, say so explicitly and neither the seed nor a
later installer rerun will overrule it:

```sh
hermes -p <profile> config set display.platforms.cozygateway.streaming false
hermes -p <profile> config set display.streaming false
hermes -p <profile> gateway restart
```

On a multiplexed host, restart the host instead: `hermes -p default gateway restart`.

An explicit `false` is a decision. Only an ABSENT key is ever written.

The live thinking preview follows the same rule. Hermes hands the attach
plugin a reasoning model's thinking only when the profile opts in, so the seed
and the installer repair also write:

```yaml
plugins:
  stream_reasoning_deltas: true
```

The plugin shows a short, redacted preview of it while the bot thinks. Hermes
reads the key from each profile's own `config.yaml` on every reply, including
under a multiplexed host gateway, so the host's config does not decide it for
the profiles it serves. Because it is read on every reply, writing it takes
effect without a restart, and the repair does not restart anything for it.

The key is profile-wide, not specific to this plugin: any other plugin in that
profile that registers `on_stream_delta` receives the reasoning deltas too.

To turn the preview off for one bot:

```sh
hermes -p <profile> config set plugins.stream_reasoning_deltas false
```

On Windows, state is under `%LOCALAPPDATA%\cozygateway`. Persistence uses the
current-user `CozyGateway` Scheduled Task with a hidden Startup-folder fallback
when policy blocks task registration. Phone-created bot auto-provisioning is not
part of the Windows installer. The installed supervisor restarts an unexpectedly
exited gateway child, including after the login task has already run.

Uninstall is deliberately independent of model selection, downloads, Node,
listener-config parsing, and the continued presence of Hermes, so a damaged
install remains removable. On macOS and
Linux the installer also exposes `cozygateway` through `~/.local/bin` in new
terminal sessions; uninstall removes only its own command entry and profile line.
Linux service units honor `XDG_CONFIG_HOME` and otherwise use
`~/.config/systemd/user`. An environment without a running systemd user manager,
such as a container or WSL instance without systemd, fails before installation
with an actionable message.

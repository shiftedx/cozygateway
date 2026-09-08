# Automatic install and repair hygiene

Protocol version 1 reconciles known installer-owned live state as part of a
supported install, upgrade, or repair. Success adds no hygiene prompt or secret
output. It does not discover deletion candidates by database inference, claim
unknown bot identities, clean shared rooms, or erase history, backups, or
quarantines.

## Native Gateway installs

The actual call chain is:

1. The supported one-line installer runs `scripts/install.sh`.
2. The bootstrap verifies one matched set of release assets, saves its existing
   runtime/config/service transaction, and invokes the downloaded
   `agent-install.sh`.
3. The Hermes installer resolves the real Hermes root and hydrates its recorded
   profile scope. A saved `all` scope continues to reconcile current profiles.
   A saved narrow scope can now discard only names whose profile directories
   are absent, after validating the recorded Hermes root, unique state fields,
   the existing single-endpoint map, and that each removed identity has the
   exact generated token-variable mapping. Symlinks, partial directories,
   unrecorded mappings, and ambiguous ownership fail closed.
4. Existing reconciliation writes the current managed token/config map,
   compares and updates owned plugin payloads, and replaces the verified owned
   service definition. Removed generated token lines disappear; unrelated
   environment lines and custom/shared keys are retained. Live profile tokens
   stay stable. Existing config merging preserves unrelated operator fields.
5. The old ownership inventory remains until environment reconciliation
   succeeds; the current state records `install_hygiene_version=1`. Gateway and
   attach health checks finish before the bootstrap commits. Failure restores
   the existing bootstrap transaction; a retry uses the retained inventory.

The current installed `cozygateway repair` and `cozygateway update` commands
validate their recorded bootstrap checksum and invoke that same verified flow.
They let the installer hydrate recorded scope instead of converting metadata
into an explicit `--profiles` request. They use the recorded verified release
source, never an arbitrary checkout or an installed executable as an update
source.

**Legacy-wrapper limit:** some older installed CLI wrappers pass their saved
narrow list as explicit `--profiles`. The new installer cannot distinguish that
from a human explicitly requesting those names, so it does not silently change
that request. If a listed profile has disappeared, the diagnostic directs the
user to run the standard one-line update once:

```sh
curl -fsSL https://cozylabs.ai/install.sh | bash
```

That update automatically repairs a provable saved scope and installs the new
wrapper. If no recorded profiles survive, state remains intact and the user
must choose an explicit live scope or `--runtime-only`; the installer never
falls back to `all` and adopts other identities.

## Split Mac/Hermes and box/Gateway installs

This deployment uses `scripts/install-bot-provisioner.sh` from the chosen
release. It is separate from the native installer; the native installer does
not claim a remote box or install this Mac-specific service.

Every staged install/upgrade now validates the existing `current` release and
LaunchAgent against the recorded `STAGED_FROM`, exact script paths, expected
label/argv/working directory, ordinary files, and current-user ownership. The
recognized older payload may lack `deprovision-bot.sh`; that omission is repaired
by staging the complete current payload. Unknown services, redirected paths,
and unverifiable release targets are preserved with an actionable diagnostic.

The installer validates the new plist before replacing `current`, loads the
LaunchAgent, and checks registration. Launchd's existing `RunAtLoad` and
30-second interval automatically invoke the staged watcher. That watcher performs
the existing orphan and pending-cleanup reconciliation, including obsolete
custom credential keys after same-name recreation. It protects current profile
references and never treats a live profile as an orphan. See
[automatic deletion cleanup](attach-v1-operations.md#automatic-deletion-cleanup).

Activation failure restores the previously verified pointer/plist when present
and retains both payloads for retry. The installer uses an OS advisory lock;
legacy mkdir locks cannot permanently disable repair. Retired release directories
remain recovery copies and are no longer deleted by a broad directory glob.
User backups, unproven stage directories, and profile histories are untouched.
Per-profile services also require a regular, current-user-owned plist with the
exact profile home, working directory, and recognized Hermes interpreter/module
arguments before removal; a `Program` override must name the same interpreter.
An ambiguous or definition-less loaded job is retained
for inspection. Line-based credential cleanup refuses ambiguous multiline dotenv
values; native profile repair refuses them before editing profile environments.
Native Gateway repair also verifies every retained parsed value before replacing
the file. These failures preserve the original environment and remain actionable
rather than silently changing user content.
The new staged origin records `INSTALL_HYGIENE_PROTOCOL=1`.

## Validation and Windows handoff

Run the focused disposable migration fixture with Node.js 24 on PATH:

```sh
python3 scripts/test/install-hygiene.test.py
```

It exercises real checksummed `file://` bootstrap assets and the generated
repair/update wrapper, with fake Hermes/service/readiness endpoints; no production
service is contacted. It also migrates an old staged payload missing its helper,
runs the loaded watcher's cleanup, proves repeat safety, preserves recovery
copies, and checks activation rollback and ambiguous-service refusal. It is part
of `pnpm test:installer`.

Native scope/env changes are in the common shell installer, but this fixture
validates its macOS service path. Windows Scheduled Task/PowerShell behavior has
not been validated by this change. Before claiming Windows support for these
new cases, the Windows validation agent should run the normal verified upgrade
with a recorded narrow scope containing one keeper and one absent profile,
verify only the generated obsolete credential disappears, repeat repair/update,
and verify empty/ambiguous scopes retain state. Inspect whether an older Windows
wrapper supplies explicit profile arguments; apply the same safe diagnostic
rather than reinterpreting the user's explicit scope. Existing Windows ownership
and rollback checks remain authoritative.

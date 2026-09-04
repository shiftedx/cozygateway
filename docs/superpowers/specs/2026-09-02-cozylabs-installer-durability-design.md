# COZYLABS installer durability design

## Status

Approved product direction, revised with a Ponytail full audit of CozyGateway
`main` at `7bd5159`, merged durability PR #298, and CozyAgents `main` at
`2cc0cc6`.

This revision cuts the shared installer framework, resident cross-product
updater, generic component graph, and composite rollback engine from the
original durability proposal. It keeps the recovery guarantees.

## Goal

A casual Windows user can paste one PowerShell command, make one clear product
choice, and thereafter manage the local CozyGateway installation from CozyChat.
Routine Hermes updates, process crashes, interrupted product updates, and
partially damaged installer-owned state must not require a reinstall.

When a connection fails, CozyChat must either say that the COZYLABS components
are working or identify the exact COZYLABS component that needs attention.
Hermes problems remain distinguishable from CozyGateway problems.

## Product language

- **COZYLABS** is the parent brand shown by the installer.
- **CozyGateway** is the required connection layer between CozyChat and local
  harnesses.
- **CozyAgents** is an optional, separately owned local harness product.
- **CozyChat** is the user-facing control surface.
- **Hermes** is a third-party harness with its own update and repair behavior.

CozyGateway and CozyAgents work together but do not share an installation,
state store, service identity, credentials, updater implementation, or
uninstaller.

## Existing foundation

The implementation must extend current upstream rather than reconstruct it.

Current CozyGateway provides a checksum-verified one-line bootstrap, staged
release assets, exact Hermes profile discovery and repair, per-user persistence,
ownership-aware uninstall, `cozygateway repair`, `cozygateway update`, Windows
process ownership checks, an authenticated maintenance API, durable SQLite
request receipts, and durable Hermes update correlation.

Current CozyAgents provides checksum-verified installers, a private Node
runtime, preserved pairing state, native user-service registration, exact PATH
and service cleanup, staged bundle replacement, a `.previous` bundle, service
restart verification, and durable runner operation receipts.

Current CozyChat provides Gateway maintenance controls, a durable Hermes update
state-machine pattern, and a Computers roster suitable for per-runner controls.

## Installer experience

The public Windows entry point remains one command:

```powershell
irm https://cozylabs.ai/install.ps1 | iex
```

The script supports Windows PowerShell 5.1 and PowerShell 7 without requiring
administrator rights. It downloads a small, versioned COZYLABS bootstrap and
verifies the release manifest and every executable asset before running them.

The bootstrap displays the approved, browser-validated v1 terminal composition:

```text
C O Z Y L A B S
local AI, made simple

     .-""-.                                               +-------------+
   .'      '.              +--------------------+         |  COZYCHAT   |
  /  o    o  \             |                    |         |-------------|
 |            |    ----->  |    COZYGATEWAY     |  -----> |             |
 |    \__/    |            |                    |         |    Hello    |
  \          /             +--------------------+         |             |
   '._    _.'                                             |     [ ]     |
      '---'                                               +-------------+

   CozyAgents               required connection              your phone
```

The production drawing is one fixed-width block so the blobatar, arrows,
gateway, and phone cannot drift into separate layout fragments. CozyAgents is
the only blobatar. CozyChat is an intact cellphone. The layout is decorative;
all choices and status remain readable as ordinary terminal text.

### Selection rules

CozyGateway is always installed.

- When a usable Hermes installation is detected, keep Hermes and default to
  **CozyGateway only**. CozyAgents appears as an explicit optional choice.
- When Hermes is absent, default to **CozyGateway + CozyAgents (recommended)**.
- The user may explicitly choose Gateway plus both harnesses.
- Detection never silently replaces or removes an existing harness.
- Non-interactive flags express the same choices for managed environments.

The COZYLABS bootstrap delegates each product installation to that product's
verified installer. It does not copy product files, credentials, or state
itself.

## Lean lifecycle contract

The products share only a written contract and black-box test vectors. Each
product must satisfy these invariants:

1. Use a dedicated per-user install root and stable service identity.
2. Reject unsafe, redirected, foreign-owned, or ambiguous targets.
3. Bind a release tag to exact asset names, sizes, and SHA-256 digests.
4. Download into same-volume staging and verify before promotion.
5. Persist a small, atomic, non-secret ownership record sufficient for repair
   and uninstall.
6. Keep credentials outside logs and outside the ownership record.
7. Let the native service manager supervise the long-running process where it
   can do so correctly.
8. Prove live readiness separately from persisted service registration.
9. Preserve exactly one last-known-good product release where automatic
   recovery needs it.
10. Make repair idempotent and uninstall reverse only installer-owned work.
11. Report one safe next action for every terminal failure.

Schemas and implementations remain product-local because Gateway's Hermes
profile ownership and Agents' runner/bot ownership are not interchangeable.

## Supervision

### macOS and Linux

`launchd` and `systemd --user` remain the supervisors. Product wrappers should
not duplicate crash loops already provided by those managers. A process closes,
the native manager applies its restart policy, and the product's health check
proves the restarted instance is ready.

Gateway should generate one shared gateway launch body for Hermes and
CozyAgents modes, with only the optional Hermes Dashboard prelude varying.

### Windows

The installer creates one per-user persistence registration per product. The
Scheduled Task action stays attached to the supervised process so Task
Scheduler observes its exit and can apply a bounded restart policy; it must not
launch through a helper that detaches and immediately reports success.

Gateway's task directly tracks its existing Node supervisor wrapper. The two
currently generated supervisor bodies collapse into that one implementation.
CozyAgents' task directly tracks its runner process and relies on Task
Scheduler's restart policy. When policy blocks task registration, the
Startup-folder fallback uses a small product-local hidden wrapper with the same
bounded restart behavior.

CozyAgents derives its service identity from the canonical install home rather
than reverse-parsing service files to determine which installation it controls.

Do not add a shared COZYLABS supervisor or an always-running update daemon.

## Repair and self-healing

`repair` is the canonical reconciliation operation. It:

- validates the install root and ownership record;
- verifies installed product bytes against recorded release metadata;
- repairs product-owned service registration and launchers;
- starts or restarts the product when needed;
- proves product readiness; and
- for Gateway, reconciles only the persisted, exact Hermes profiles and
  installer-owned plugin/config keys.

Gateway may automatically repair Gateway-owned bytes, launchers, service state,
and previously installed verified attach-plugin copies. A proposed change to
Hermes-owned state is reported in CozyChat and requires confirmation. The user
is directed to Hermes' own repair flow when the failure is outside the narrow
integration surface Gateway can safely restore.

A verified cached bootstrap and the last selected profile scope allow repair to
continue when the active runtime bundle is damaged. Offline repair is limited
to already verified cached assets; it never treats unverified bytes as a
fallback.

`update` may remain a product-language alias for repair-to-latest. It must not
grow a second implementation.

## Update flow

The paired Gateway maintenance endpoint is the single app-facing entry point.
It writes one durable operation receipt before starting work and returns the
operation ID. A short-lived, product-owned worker outside the runtime bundle
performs the update and exits; it is not a daemon.

For **Update Gateway** on the Gateway computer:

1. Return the existing active receipt when the same idempotency key is retried.
2. If CozyAgents is installed on that computer, invoke its own verified upgrade
   command and wait for its product-level readiness result.
3. Invoke Gateway's own verified update/repair command.
4. Let each product's service registration restart its process.
5. Prove Gateway HTTP readiness and the expected local harness attachment.
6. Persist `succeeded`, `rolled_back`, or `failed` with installed versions and a
   safe failure code.

Updates are sequential but not one cross-product transaction. A successful
CozyAgents update is not rolled back merely because a later Gateway update
fails. Each product owns its own last-known-good artifact and rolls back only
its own failed promotion. This keeps recovery local and makes partial outcomes
truthful.

The operation record needs only:

- operation ID and idempotency key;
- requested action;
- current step (`agents`, `gateway`, or `postflight`);
- status (`pending`, `running`, `succeeded`, `rolled_back`, or `failed`);
- prior and resulting versions;
- timestamps; and
- a stable, non-secret failure code plus short display message.

Limit this record to maintenance operations.

Keep the existing paired routes:

- `GET /gateway/maintenance`
- `POST /gateway/maintenance/restart`
- `POST /gateway/maintenance/update`

Add one paired polling route:

- `GET /gateway/maintenance/operations/:operationId`

The polling route returns only the operation record above. It does not stream
logs or expose the worker's command line.

Hermes keeps its separate **Update Hermes** action and existing durable Hermes
receipt flow. CozyChat may trigger Hermes' default supported updater. Keep
Hermes updates outside **Update Gateway**.

## CozyChat status and controls

The default Gateway screen shows one calm result:

```text
Everything is working
```

It shows component detail only while an update is running or attention is
needed. The minimal component projection is:

- CozyChat can reach Gateway;
- Gateway process/update state;
- selected local harness attached or needs attention; and
- co-located CozyAgents state when installed.

Expose only this small status projection. Do not add a generic dependency
graph. A dead or unreachable Gateway cannot accept remote repair commands; the
app says it is unreachable while the local supervisor attempts recovery.

CozyChat persists the returned operation ID and polls authoritative status. A
disconnect followed by reconnect does not prove success. Ambiguous POST
responses switch to status-only polling, following the existing Hermes updater
pattern.

Additional CozyAgents computers appear under **Computers** with independent
update and diagnostic controls. A powered-off secondary computer is
`offline/not checked`; it does not make the main Gateway status unhealthy.
Gateway sends a narrowly scoped runner update operation through the existing
runner lane and projects its durable runner receipt. The implementation adds no
second maintenance protocol.

## State and ownership

Keep existing product paths for v1 unless a concrete migration requires a
change. Each product owns its own:

- release bytes and one previous verified release;
- service registration and launcher;
- atomic non-secret install record;
- credentials;
- operational state and receipts;
- bounded logs; and
- uninstall behavior.

For CozyAgents, `runner.env` remains the authority for pairing identity and
Gateway address. Duplicate `runnerId`, `gateway`, and unused service facts
should be removed from `install.json`; that file retains only facts needed to
repair the installation and update its bundle.

Gateway's install state retains only selected Hermes profiles and the exact
plugin/config/service actions it owns. Keep runner inventory elsewhere.

## Diagnostics

Each product exposes one machine-readable local status command used by the
Gateway projection and human-readable `doctor` output derived from the same
checks. Checks are bounded and side-effect free:

- ownership and recorded release;
- service registration;
- process/readiness;
- last update or rollback result;
- log location; and
- product-specific connectivity.

The status projection redacts raw exceptions, tokens, pairing codes,
environment values, and full process command lines. Stable failure codes select
the next safe action: wait, retry update, run repair, confirm narrow Hermes
repair, or use Hermes' own repair.

## Uninstall

Uninstall first resolves the exact product home and service identity, then
removes only recorded product-owned resources. It works when the bundle,
launcher, or part of the install record is missing by using conservative
product-specific recovery rules.

Removing Gateway does not remove Hermes or CozyAgents. Removing CozyAgents
preserves user bot data unless the user explicitly requests a purge. The
COZYLABS bootstrap does not implement another uninstall engine.

## Security boundaries

The following complexity is required and must not be ponytailed away:

- checksum and manifest validation before execution;
- same-volume staging and atomic replacement;
- root/elevation refusal where ownership would become ambiguous;
- symlink, reparse-point, unsafe-path, and foreign-file rejection;
- exact process and service ownership checks;
- locked-down credentials, workers, launchers, and IPC;
- paired authentication and idempotency for maintenance actions;
- bounded command execution and output;
- rollback evidence and failure receipts; and
- secret redaction in logs, status, and tests.

Same-origin SHA-256 sidecars detect corruption. They cannot detect a compromised
publisher. Stronger release signing requires a separate trust-root decision.

## Explicit Ponytail cuts

Do not build:

- a shared `cozy-installer` package;
- a shared Gateway/Agents state schema;
- a generic service or ownership registry;
- a resident cross-product supervisor or updater;
- a cross-product rollback transaction;
- a generic job, event, or component-graph framework;
- a tray application or native Windows notification UI;
- automatic Hermes repair outside Gateway's narrow owned integration surface;
- fleet scheduling, multi-host failover, or automatic updates for offline
  secondary computers; or
- a second implementation behind the `update` command.

Prefer deletion and consolidation already identified by the audit:

- one Gateway supervisor body across harness choices;
- native POSIX restart policies instead of in-process POSIX restart races;
- one product-local atomic replacement primitive in CozyAgents;
- install-home-derived CozyAgents service identity;
- one authoritative pairing source (`runner.env`);
- truthful nonzero service restart failures without optional flags; and
- shared test fixtures only where they remove literal duplication.

## Verification

### Automated product tests

Keep the smallest tests that prove the lifecycle invariants:

- canonical manifest, asset name, size, and checksum validation;
- no promotion after any failed verification;
- atomic state and credential writes;
- exact service identity and foreign-install refusal;
- idempotent install, repair, update, and uninstall;
- product-local rollback after failed readiness;
- durable operation receipt recovery after Gateway or Agents restarts;
- exact Hermes profile reconciliation;
- ambiguous app request followed by status-only polling;
- remote offline Agents computers excluded from global failure; and
- secret-free status, logs, and receipts.

Tests may share small fixtures and test vectors, but production lifecycle code
remains product-local.

### Native Windows acceptance

Run on a disposable Windows 11 host under both Windows PowerShell 5.1 and
PowerShell 7 where applicable:

1. Clean install with Hermes absent: Gateway plus CozyAgents is recommended.
2. Clean install with Hermes present: Gateway only is selected by default.
3. Explicit installation of both harnesses.
4. Idempotent rerun preserving pairing and selected profiles.
5. Gateway and Agents child-process crash recovery.
6. Logoff/logon and reboot recovery.
7. Verified product update from CozyChat with operation polling.
8. Gateway restart during its own update receipt.
9. Corrupt download and manifest mismatch with no promotion.
10. Interrupted or locked-file promotion followed by repair or rollback.
11. Hermes update followed by exact profile/plugin reconciliation.
12. Partial-install and missing-state uninstall.
13. A secondary Agents computer offline during local Gateway update.
14. End-to-end CozyChat pairing, roster, message, streamed reply, and media.

Record commands, versions, exit codes, service state, relevant redacted logs,
and pass/fail evidence. Native reboot/logon evidence is required. Mocked
Scheduled Task tests cannot replace it.

### POSIX regression

macOS and Linux need targeted regression coverage for native service restart,
verified repair/update, retained profile scope, product ownership, and
uninstall. They do not need a parallel custom supervisor implementation.

## Cross-repository delivery

Implementation is split by existing ownership:

- **CozyGateway:** consolidated supervisor generation, local worker and durable
  operation status, simple component projection, exact repair/rollback, Windows
  native acceptance.
- **CozyAgents:** canonical service identity, atomic write consolidation,
  truthful service outcomes, remotely invokable product-owned upgrade/status,
  installer publication.
- **CozyChat:** persisted Gateway operation polling, calm status/failure detail,
  and per-computer Agents controls using existing updater and roster patterns.
- **CozyLabs website:** publish the verified COZYLABS bootstrap and real
  CozyAgents manifest/assets through the existing atomic mirror process.

Contracts should land before UI and release work. Product implementations may
proceed in parallel after the receipt/status shapes and service identity rules
are fixed.

## Effort

The ponytailed design is expected to require roughly 40–60 focused engineer
days. Two engineers can overlap Gateway/Windows work with Agents/CozyChat work,
but native Windows reboot, rollback, and release qualification remain a serial
critical path.

The target is lean code, not fewer guarantees: reuse current repair and receipt
paths, delete duplicated supervision and state, and spend the saved effort on
native failure evidence.

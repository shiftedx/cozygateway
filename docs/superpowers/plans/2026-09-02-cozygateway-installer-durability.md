# CozyGateway Installer Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing per-user CozyGateway installation natively supervised, exactly repairable and locally rollback-safe, while exposing a durable, pollable maintenance operation and a small app-facing health projection.

**Architecture:** Keep lifecycle ownership inside CozyGateway. One generated Node supervisor body launches the optional Hermes Dashboard prelude and the Gateway; POSIX exits with the Gateway so `launchd`/`systemd --user` own restart, while Windows retains the existing bounded child supervision and Task Scheduler tracks the supervisor process directly. The paired API writes the operation to existing Gateway SQLite before IPC; a shipped, short-lived Node 24 worker outside `cozygateway.mjs` resumes idempotent product steps and writes terminal state to the same database. The bootstraps own manifest verification, same-volume promotion, one verified `.previous` snapshot, and Gateway-only rollback.

**Tech stack:** Node.js 24 (`node:sqlite`, `node:child_process`, `node:fs`, `node:http`), TypeScript, TypeBox, Hono, Vitest, Bash, Windows PowerShell 5.1/7, `launchd`, `systemd --user`, Windows Task Scheduler.

## Global constraints

- Extend `7bd5159`; do not create a shared COZYLABS installer, schema, supervisor, updater, registry, job framework, event framework, or component graph.
- `update` remains an alias for the same repair-to-latest bootstrap path; no second update implementation.
- The long-running process is supervised by `launchd` or `systemd --user` on POSIX and by one per-user Scheduled Task on Windows.
- Windows Task Scheduler must remain attached to the Node supervisor and use a bounded restart policy; the Startup fallback alone uses a hidden product-local wrapper with the same bound.
- The maintenance worker is short-lived, Gateway-owned, outside the replaceable runtime bundle, and carries no credential or command supplied by CozyChat.
- Gateway and CozyAgents update sequentially, but rollback remains product-local. A completed CozyAgents update is never reversed because Gateway later fails.
- Gateway repair changes only Gateway-owned bytes, launchers, registration, exact persisted Hermes profiles, and already-owned verified plugin/config keys. Unowned Hermes state is reported, never silently changed.
- Downloads stage on the install volume; every manifest name, byte size, and SHA-256 digest is verified before the first live-file move.
- Preserve exactly one verified prior Gateway release. Never promote or roll back to unverified bytes.
- Reject elevation/root, symlinks/reparse points, unsafe paths, foreign files, ambiguous services, and foreign processes as the current installers already do.
- Public status, receipts, logs, tests, and process arguments contain no tokens, pairing codes, environment values, raw exceptions, or full child command lines.
- Every terminal failure stores one stable failure code, one short display message, and one safe next action.

## File map and deliberately skipped abstractions

| File | Responsibility after this work |
| --- | --- |
| `packages/contract/src/gateway-maintenance.ts` | Version-2 maintenance request, receipt, operation, and fixed health projection schemas. |
| `packages/contract/test/gateway-maintenance.test.ts` (new) | Wire-shape and redaction tests for the version-2 contract. |
| `packages/gateway/src/storage.ts` | One `gateway_maintenance_operations` table and typed atomic operation transitions. |
| `packages/gateway/src/gateway-maintenance.ts` | Paired policy, idempotent acceptance, polling, supervisor IPC, and runtime health projection. |
| `packages/gateway/src/http.ts` | Existing three paired routes plus `GET /gateway/maintenance/operations/:operationId`. |
| `packages/gateway/src/server.ts` | Wire live attach state and only the co-located runner state into maintenance health. |
| `packages/gateway/src/runner/protocol.ts`, `packages/gateway/src/runner/lane.ts` | Carry one purpose-built remote runner update command and its durable maintenance receipt over the existing authenticated runner socket. |
| `packages/gateway/src/cli.ts` | Human and `--json` local status from the same bounded checks. |
| `scripts/gateway-supervisor.cjs` (new) | Single shipped supervisor implementation for both harness modes and all desktop platforms. |
| `scripts/gateway-maintenance-worker.cjs` (new) | Resume one accepted restart/update, call product-owned commands, postflight, persist terminal result, exit. |
| `scripts/agent-install.sh` | Generate only argument launchers; register native services; atomically record exact owned resources; install local supervisor/worker. |
| `scripts/install.sh`, `scripts/install.ps1` | Verify canonical release manifest, snapshot one prior verified Gateway release, promote, repair, and exact rollback. |
| `scripts/build-bundle.mjs`, `.github/workflows/release.yml` | Build and publish supervisor, worker, canonical manifest, and sidecars. |
| Existing installer/maintenance/CLI tests | Prove consolidation, native restart policy, durable recovery, rollback, redaction, and Windows behavior. |

Ponytail cuts: do not make `MaintenanceOperation` a generic job type; do not put runner maintenance in bot-keyed `runner_operations`; do not put worker logic in the replaceable bundle; do not add an updater daemon; do not parse arbitrary service files into a registry; do not add a second health endpoint. The existing `gateway_maintenance_requests` table can remain unread for one release and then be removed; new behavior uses purpose-built Gateway and runner maintenance tables rather than a compatibility abstraction.

## Fixed interfaces

### Public maintenance v2 contract

Increase `GATEWAY_MAINTENANCE_CAPABILITY_VERSION` from `1` to `2`. Preserve request field `requestId` as the wire idempotency key so existing clients continue to POST successfully.

```ts
export type GatewayMaintenanceAction = "restart" | "update";
export type GatewayMaintenanceStep = "agents" | "gateway" | "postflight";
export type GatewayMaintenanceOperationStatus =
  | "pending" | "running" | "succeeded" | "rolled_back" | "failed";
export type GatewayMaintenanceNextAction =
  | "wait" | "retry_update" | "run_repair"
  | "confirm_hermes_repair" | "use_hermes_repair";

export interface GatewayMaintenanceVersions {
  gateway: string;
  cozyAgents?: string;
}

export interface GatewayMaintenanceOperation {
  operationId: string;
  idempotencyKey: string;
  action: GatewayMaintenanceAction;
  step: GatewayMaintenanceStep;
  status: GatewayMaintenanceOperationStatus;
  priorVersions: GatewayMaintenanceVersions;
  resultingVersions: Partial<GatewayMaintenanceVersions>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  failureCode?: string;       // safe `[a-z0-9_]{1,64}` only
  message?: string;           // 240 characters, fixed/censored worker copy
  nextAction: GatewayMaintenanceNextAction;
}

export interface GatewayMaintenanceHealth {
  state: "working" | "updating" | "needs_attention";
  gateway: {
    state: "working" | "updating" | "needs_attention";
    version: string;
    operationId?: string;
  };
  harness: {
    product: "hermes" | "cozyagents";
    state: "attached" | "needs_attention";
    failureCode?: string;
    message?: string;
    nextAction?: GatewayMaintenanceNextAction;
  };
  cozyAgents?: {
    state: "working" | "updating" | "needs_attention";
    version?: string;
    failureCode?: string;
    message?: string;
    nextAction?: GatewayMaintenanceNextAction;
  };
}

export interface GatewayMaintenanceStatus {
  currentVersion: string;
  restartSupported: boolean;
  update: GatewayMaintenanceUpdate;
  health: GatewayMaintenanceHealth;
}

export interface GatewayMaintenanceReceipt {
  operationId: string;
  acceptedAt: number;
}
```

`GET /gateway/maintenance/operations/:operationId` returns `GatewayMaintenanceOperation` with 200, the ordinary paired 401, or `{ error: { code: "operation_not_found", message: "Gateway maintenance operation was not found." } }` with 404. It never returns worker argv or logs.

### Internal supervisor IPC

Keep newline-delimited JSON and the current 2 KiB input ceiling. Extend the existing interface rather than introduce a bus:

```ts
export interface GatewayMaintenanceSupervisor {
  status(): Promise<GatewayMaintenanceHostStatus>;
  start(operationId: string): Promise<void>;
}

export type SupervisorRequest =
  | { action: "status" }
  | { action: "start"; operationId: string };

export type SupervisorResponse =
  | { ok: true; status: GatewayMaintenanceHostStatus }
  | { ok: true }
  | { ok: false; code?: string };
```

The Gateway owns the requested action in SQLite. The supervisor accepts only a validated `maintenance_[a-f0-9]{32}` identifier and launches the fixed installed worker with that identifier; it does not accept target versions, executable paths, URLs, or commands from HTTP.

```ts
export interface GatewayMaintenanceHostStatus {
  currentVersion: string;
  restartSupported: boolean;
  update: GatewayMaintenanceUpdate;
  cozyAgents?: { installed: true; version?: string; ready: boolean; failureCode?: string };
}
```

### SQLite operation seam

Create a new strict table rather than weakening the existing table's `pending|handed_off` CHECK:

```sql
CREATE TABLE IF NOT EXISTS gateway_maintenance_operations (
  operation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('restart','update')),
  step TEXT NOT NULL CHECK (step IN ('agents','gateway','postflight')),
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','rolled_back','failed')),
  prior_versions_json TEXT NOT NULL,
  resulting_versions_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  failure_code TEXT,
  message TEXT,
  next_action TEXT NOT NULL CHECK (next_action IN ('wait','retry_update','run_repair','confirm_hermes_repair','use_hermes_repair'))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS gateway_maintenance_one_active
ON gateway_maintenance_operations ((1))
WHERE status IN ('pending','running');
```

Add these exact `Storage` methods and keep SQL transitions compare-and-set:

```ts
createGatewayMaintenanceOperation(input: {
  operationId: string; idempotencyKey: string; fingerprint: string;
  action: GatewayMaintenanceAction; step: GatewayMaintenanceStep;
  priorVersions: GatewayMaintenanceVersions; now: number;
}): GatewayMaintenanceOperation;
gatewayMaintenanceOperation(operationId: string): GatewayMaintenanceOperation | undefined;
gatewayMaintenanceOperationByKey(idempotencyKey: string):
  (GatewayMaintenanceOperation & { fingerprint: string }) | undefined;
activeGatewayMaintenanceOperation(): GatewayMaintenanceOperation | undefined;
advanceGatewayMaintenanceOperation(input: {
  operationId: string;
  from: { status: GatewayMaintenanceOperationStatus; step: GatewayMaintenanceStep };
  to: {
    status: GatewayMaintenanceOperationStatus; step: GatewayMaintenanceStep;
    resultingVersions?: Partial<GatewayMaintenanceVersions>;
    completedAt?: number; failureCode?: string; message?: string;
    nextAction: GatewayMaintenanceNextAction;
  };
  now: number;
}): boolean;
```

The existing `gateway_maintenance_requests` methods are deleted after tests no longer call them. No expiry is applied to the latest maintenance operation: it is diagnostic history. Limit history with `pruneGatewayMaintenanceOperations(keep = 100)` after a terminal write, never deleting active rows.

## Task 1: Freeze the maintenance v2 wire contract

**Files:**

- Modify: `packages/contract/src/gateway-maintenance.ts`
- Create: `packages/contract/test/gateway-maintenance.test.ts`
- Modify: `packages/gateway/test/gateway-maintenance.test.ts`

- [ ] Add TypeBox schemas matching the public interfaces above, including the fixed `health` object; export all static types from the same file and bump capability version to 2.
- [ ] Add contract tests named `accepts the complete durable Gateway operation shape`, `rejects worker commands logs and unknown fields`, `requires one fixed health projection rather than a component graph`, and `keeps requestId as the POST idempotency key`.
- [ ] Change the Gateway fake supervisor's status fixture to include a healthy Hermes projection only through Gateway's runtime projection input; do not let the fake supervisor invent attach health.
- [ ] Run `pnpm --filter cozygateway-contract test -- gateway-maintenance.test.ts`; first observe schema/import failures, then make it pass.
- [ ] Run `pnpm --filter cozygateway-contract typecheck` and `pnpm --filter cozygateway test -- gateway-maintenance.test.ts`.
- [ ] Commit: `feat(contract): add durable gateway maintenance status`.

## Task 2: Replace handoff receipts with durable operation rows

**Files:**

- Modify: `packages/gateway/src/storage.ts`
- Modify: `packages/gateway/test/storage.test.ts`
- Modify: `packages/gateway/src/gateway-maintenance.ts`
- Modify: `packages/gateway/test/gateway-maintenance.test.ts`

- [ ] Add the strict table, unique active-row index, row mapper, and exact `Storage` signatures above.
- [ ] Add storage tests named `persists one maintenance operation across reopen`, `returns an existing operation for the same idempotency key`, `refuses two active maintenance operations`, `compare-and-set prevents a stale worker transition`, `terminal maintenance receipts retain only the newest 100`, and `operation JSON never contains fixture secrets`.
- [ ] Change `GatewayMaintenance.restart()` and `.update()` to call one private `accept(action, requestId, fingerprint, priorVersions)` method. In one synchronous SQLite write it must either return the same operation for the same key/fingerprint, throw `stale_version` for the same key/different fingerprint, throw `operation_in_progress` when the partial unique index rejects a different active request, or create `pending/gateway` (`restart`) / `pending/agents` (`update` when local Agents is installed) with `nextAction: "wait"`.
- [ ] Replace `restart()`/`update()` IPC calls with `supervisor.start(operation.operationId)`. On pre-ACK IPC failure atomically settle the row as `failed`, `failureCode: "maintenance_handoff_failed"`, fixed message `"Gateway maintenance could not start."`, `nextAction: "retry_update"`; a retry with the same idempotency key returns that authoritative terminal record's receipt and does not create a second operation.
- [ ] Add `GatewayMaintenance.operation(operationId)` and route-ready `GatewayMaintenanceNotFound` behavior.
- [ ] Delete `#active`, `#inFlight`, `StoredReceipt`, `rememberGatewayMaintenanceRequest`, `gatewayMaintenanceRequest`, and `markGatewayMaintenanceHandedOff`; SQLite is the only concurrency/idempotency authority.
- [ ] Run `pnpm --filter cozygateway test -- storage.test.ts gateway-maintenance.test.ts`; verify a deliberate duplicate-active test fails before the index/methods exist, then passes.
- [ ] Commit: `feat(gateway): persist maintenance operation state`.

## Task 3: Add authoritative polling and the small health projection

**Files:**

- Modify: `packages/gateway/src/gateway-maintenance.ts`
- Modify: `packages/gateway/src/http.ts`
- Modify: `packages/gateway/src/server.ts`
- Modify: `packages/gateway/test/gateway-maintenance.test.ts`
- Modify: `packages/gateway/test/server.test.ts`

**Runtime input:**

```ts
export interface GatewayMaintenanceRuntimeHealth {
  harness: "hermes" | "cozyagents";
  attach?: { configured: number; online: number; deadLetters: number };
  localRunnerAttached?: boolean;
}

discoverGatewayMaintenance(
  environment: NodeJS.ProcessEnv,
  storage: Storage,
  currentVersion: string,
  runtimeHealth: () => GatewayMaintenanceRuntimeHealth,
  now: () => number,
): Promise<GatewayMaintenance | undefined>;
```

- [ ] Register `GET /gateway/maintenance/operations/:operationId` under `requireDevice`; test 401, 404, and exact contract-valid 200 bodies.
- [ ] Derive `health.state`, `health.gateway`, and `health.harness` in `GatewayMaintenance.status()` from the active SQLite operation plus `runtimeHealth()`. Hermes is attached only when `configured > 0`, `online === configured`, and `deadLetters === 0`; CozyAgents is attached only when the specifically co-located runner is live. Do not scan remote runners.
- [ ] Obtain the co-located runner identifier from the host status emitted by the installed worker/status command, not from `RunnerRoster.list()`. Add `runnerId?: string` to the internal `cozyAgents` host object only; do not add it to the public fixed projection. In `server.ts`, resolve only that id through `runnerLane.connectedRunners().includes(id)`.
- [ ] Project optional `cozyAgents` only when host status says it is installed. An offline secondary runner never participates in this object and therefore cannot make `health.state` unhealthy.
- [ ] Map active operation to `gateway.state = "updating"`, operation id, and overall `updating`; map attach/local-runner failure to `needs_attention` with fixed codes `hermes_attach_not_ready`/`cozyagents_not_attached`, fixed display messages, and `run_repair`; otherwise return `working`.
- [ ] Add tests named `polls the persisted operation after a Gateway restart`, `projects one calm working result`, `shows only the selected harness when attachment needs attention`, `projects only the co-located CozyAgents runner`, `ignores an offline secondary runner`, and `redacts thrown supervisor and attach errors`.
- [ ] Run `pnpm --filter cozygateway test -- gateway-maintenance.test.ts server.test.ts` and `pnpm --filter cozygateway typecheck`.
- [ ] Commit: `feat(gateway): expose maintenance polling and health`.

## Task 4: Ship one supervisor body and let POSIX managers restart it

**Files:**

- Create: `scripts/gateway-supervisor.cjs`
- Modify: `scripts/agent-install.sh`
- Modify: `scripts/test/hermes-installer.test.sh`
- Modify: `packages/gateway/test/release-assets.test.ts`

**Installed launch signature:**

```text
node gateway-supervisor.cjs
  --platform Darwin|Linux|Windows
  --gateway-env <file> --bundle <file> --config <file>
  --maintenance-socket <unix-socket-or-named-pipe>
  --maintenance-worker <file> --database <file>
  [--dashboard-env <file> --hermes-root <dir> --hermes <file>
   --hermes-launcher <file> --owner-helper <file> --dashboard-port <port>
   --windows-dashboard-profile]
```

- [ ] Move the existing generated Node body into `scripts/gateway-supervisor.cjs`. Keep one `startDashboardIfNeeded(options)` prelude used only when dashboard arguments are present. Keep the current authenticated `/api/config` readiness check and exact Windows Dashboard ownership cleanup.
- [ ] Implement `runGatewayOnce()` for Darwin/Linux: spawn the Gateway with inherited stdio, forward SIGINT/SIGTERM, and exit with the child's exit result. No `watchFile`, `restartAfterCrash`, timer, or POSIX respawn branch remains.
- [ ] Implement `superviseGatewayOnWindows()` from the current shared child logic with a three-restarts-per-five-minutes bound. A config byte change triggers a deliberate child restart and does not spend the crash budget. When the budget is exhausted, exit nonzero so Task Scheduler applies its own bounded policy.
- [ ] Make `write_wrapper()` emit only a quoted `exec node gateway-supervisor.cjs ...` shell launcher. Delete `write_cozyagents_wrapper()` and both embedded heredoc copies. Harness choice changes only whether Dashboard arguments are appended.
- [ ] Install the source file byte-for-byte as `local/gateway-supervisor.cjs` mode 0700/owner-only ACL; record that exact path in `install-state` for repair/uninstall ownership.
- [ ] Change launchd `ProgramArguments` and systemd `ExecStart` to execute the installed Node supervisor directly, not `/bin/bash run-gateway.sh`. Keep `KeepAlive=true`/`ThrottleInterval=10` and `Restart=always`/`RestartSec=5`.
- [ ] Replace old source-string tests with behavior tests named `one supervisor starts Gateway in both harness modes`, `POSIX exits once and relies on the native service restart`, `Windows bounds child restarts`, `config change restarts without spending crash budget`, and `Hermes prelude cleans up only its owned Dashboard on failure`.
- [ ] Run `bash scripts/test/hermes-installer.test.sh` and `pnpm --filter cozygateway test -- release-assets.test.ts`.
- [ ] Commit: `refactor(installer): consolidate gateway supervision`.

## Task 5: Attach Windows Task Scheduler to the supervisor

**Files:**

- Modify: `scripts/agent-install.sh`
- Modify: `scripts/test/hermes-installer.test.sh`
- Modify: `scripts/test/windows-bootstrap.test.ps1`
- Modify: `.github/workflows/ci.yml` only if a new PowerShell test file is split out

- [ ] Replace the Scheduled Task `/TR wscript.exe run-gateway.vbs` registration with a generated owner-only `local/cozygateway-task.xml`. Its `<Exec>` command is the exact installed Node executable and its arguments begin with the exact installed `gateway-supervisor.cjs`; use `<LogonType>InteractiveToken</LogonType>`, `<RunLevel>LeastPrivilege</RunLevel>`, `<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`, and `<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>`.
- [ ] Register with `schtasks.exe /Create /F /TN CozyGateway /XML <exact-native-path>` and start with `schtasks.exe /Run /TN CozyGateway`. Do not invoke `wscript.exe` on the success path.
- [ ] Keep `local/run-gateway.vbs` only for Startup fallback. Change it to `shell.Run(command, 0, True)` and a literal loop of at most three retries separated by 60 seconds; the wait flag must be `True`, so the wrapper remains attached to the supervisor.
- [ ] Update `windows_startup_entry_uses_current_wrapper()` and partial uninstall ownership recovery to validate either the exact recorded task XML action or the exact fallback body before removal. Foreign task XML and foreign Startup files remain untouched.
- [ ] Update `load_windows_wrapper_identity()`/`stop_owned_windows_gateway()` to identify the fixed supervisor script argv rather than parsing a generated heredoc line. Keep exact Node/bundle/config matching for the child and preserve the foreign-port refusal.
- [ ] Extend fake `schtasks.exe` assertions and the native PowerShell suite with tests named `task action directly tracks the Node supervisor`, `task has bounded restart policy`, `successful registration never launches detaching VBScript`, `Startup fallback waits and retries only three times`, and `repair replaces only an owned task action`.
- [ ] Run `bash scripts/test/hermes-installer.test.sh`, `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1`, and `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-dashboard-owner.test.ps1`.
- [ ] Commit: `fix(installer): attach Windows task to gateway supervisor`.

## Task 6: Add the short-lived local maintenance worker

**Files:**

- Create: `scripts/gateway-maintenance-worker.cjs`
- Modify: `scripts/gateway-supervisor.cjs`
- Modify: `scripts/agent-install.sh`
- Create: `packages/gateway/test/gateway-maintenance-worker.test.ts`
- Modify: `packages/gateway/test/release-assets.test.ts`

**Worker invocation:**

```text
node gateway-maintenance-worker.cjs
  --database <exact-config-db-path>
  --operation-id maintenance_<32 lowercase hex>
  --gateway-home <canonical-install-home>
```

- [ ] The supervisor's IPC listener accepts only `status` and `start`. For `start`, validate the id, ACK after `spawn` succeeds, then detach/unref the fixed worker. On every supervisor boot, query the database for the one `pending|running` operation and launch the same worker to resume it.
- [ ] In the worker, parse only those three fixed flags; canonicalize and prove that the database/config, worker, bootstrap, CLI, install state, and optional CozyAgents executable belong under the recorded install homes. Use `execFile`/`spawn` with literal argument arrays, `shell: false`, bounded output (64 KiB), and 10-minute per-product timeout.
- [ ] Resume by recorded `step`. For update: (1) `agents` invokes the exact co-located product command `cozyagents upgrade --json` and then `cozyagents status --json`; on success record its resulting version and advance to `gateway`; (2) `gateway` invokes the installed `cozygateway repair` alias once and advances to `postflight`; (3) `postflight` polls Gateway `/health` for 60 seconds and requires the selected harness attachment. Restart skips directly to `gateway`, invokes the product service restart command recorded in install state, then runs postflight.
- [ ] Never roll back CozyAgents. Map an Agents failure to `failed/agents_update_failed/retry_update`; map unready Agents to `failed/agents_not_ready/run_repair`; preserve any already-written Agents resulting version.
- [ ] Interpret Gateway bootstrap exit/result: successful rollback is `rolled_back` with `gateway_update_rolled_back` and `run_repair`; failed rollback is `failed/gateway_rollback_failed/run_repair`; a non-promoting verification failure is `failed/gateway_verification_failed/retry_update`; postflight failure after a successfully restored old release remains `rolled_back`, not succeeded.
- [ ] On terminal write, store only fixed messages selected by failure code, close SQLite, and exit. Do not persist captured stdout/stderr. Tests pass fixture secrets through child stderr and assert none reaches the operation row or test log.
- [ ] Add tests named `resumes a pending operation after supervisor restart`, `does not rerun completed Agents when Gateway resumes`, `runs products sequentially`, `keeps successful Agents after Gateway rollback`, `postflight requires Gateway and selected harness readiness`, `bounds commands output and time`, and `stores no command line environment or secret output`.
- [ ] Run `pnpm --filter cozygateway test -- gateway-maintenance-worker.test.ts gateway-maintenance.test.ts`.
- [ ] Commit: `feat(installer): run durable local maintenance worker`.

## Task 7: Bind releases to a canonical manifest and one verified previous release

**Files:**

- Modify: `scripts/build-bundle.mjs`
- Modify: `scripts/install.sh`
- Modify: `scripts/install.ps1`
- Modify: `scripts/agent-install.sh`
- Modify: `packages/gateway/test/release-assets.test.ts`
- Modify: `scripts/test/hermes-installer.test.sh`
- Modify: `scripts/test/windows-bootstrap.test.ps1`
- Modify: `scripts/test/windows-agents-bootstrap.test.ps1`
- Modify: `.github/workflows/release.yml`

**Manifest:** publish `cozygateway-release.json` plus `.sha256`. Generate its
exact names, byte lengths, and lowercase SHA-256 values from the built files:

```ts
const releaseAssets = [
  "cozygateway.mjs",
  "cozygateway-hermes-attach-plugin.tar.gz",
  "cozygateway-installer.sh",
  "gateway-supervisor.cjs",
  "gateway-maintenance-worker.cjs",
  "install.ps1",
  "install.sh",
] as const;
const manifest = {
  schema: 1,
  tag: `v${gatewayPackage.version}`,
  assets: Object.fromEntries(releaseAssets.sort().map((name) => {
    const bytes = readFileSync(join(outputDirectory, name));
    return [name, {
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }];
  })),
};
```

- [ ] Have `build-bundle.mjs` copy/checksum the two new scripts, build the asset map from exact generated bytes, sort asset keys, and derive `tag` from package version as `v${version}`. Tests compare manifest names, sizes, hashes, and release upload entries exactly; unexpected/missing assets fail.
- [ ] Both bootstraps first verify `cozygateway-release.json.sha256`, validate schema/tag/exact allowlisted asset names, and then download every needed asset into a same-volume staging directory. Reject duplicate/unknown names, non-integer sizes, wrong sizes, uppercase/non-64-hex hashes, and a manifest tag different from the explicitly resolved release tag.
- [ ] Before promotion, validate every currently recorded live asset against `install-state`. If all verify, replace `<home>/.previous` atomically with one snapshot containing the prior assets, sidecars, and prior ownership record. If live bytes are damaged, keep the existing verified `.previous`; never bless damaged bytes as rollback material.
- [ ] Promote only after all staged bytes validate. Use same-directory temporary names plus atomic rename/`Move-Item`; on Windows retry boundedly for locked files. Do not delete `.previous` until a newer verified live release is ready to replace it.
- [ ] Pass `--release-tag <tag>` and `--release-manifest <installed manifest>` into `agent-install.sh`. Extend both `write_state()` variants to atomically write the selected harness/profile actions plus exact Gateway asset name/size/hash, supervisor/worker paths, service identity, and `last_result` fields. Write to `install-state.new`, flush through Node 24, then rename; never truncate live state in place.
- [ ] Tests: `rejects manifest checksum tag name size and digest mismatches before promotion`, `keeps live bytes when any staged asset fails`, `snapshots only a fully verified current release`, `preserves one previous release`, `does not replace previous with damaged live bytes`, `writes ownership state atomically`, and `records no secret values` on POSIX and Windows.
- [ ] Run `pnpm build`, `pnpm bundle`, `pnpm --filter cozygateway test -- release-assets.test.ts`, `bash scripts/test/hermes-installer.test.sh`, both existing Windows bootstrap suites, and `git diff --check`.
- [ ] Commit: `feat(installer): verify release manifests before promotion`.

## Task 8: Make repair exact and rollback only Gateway

**Files:**

- Modify: `scripts/install.sh`
- Modify: `scripts/install.ps1`
- Modify: `scripts/agent-install.sh`
- Modify: `scripts/test/hermes-installer.test.sh`
- Modify: `scripts/test/windows-bootstrap.test.ps1`
- Modify: `scripts/test/windows-agents-bootstrap.test.ps1`

- [ ] Add bootstrap-internal `Restore-PreviousGatewayRelease` / `restore_previous_gateway_release()` that first re-verifies `.previous` against its manifest/state, restores only Gateway assets and sidecars, invokes the restored installer in `--repair` mode with the exact persisted harness/profile scope, and requires live readiness. It never invokes CozyAgents rollback or Hermes-wide repair.
- [ ] On failed promoted release readiness, call that helper once. Persist `last_result=rolled_back`, prior/resulting Gateway version, and `last_failure_code=gateway_update_rolled_back` only after restored readiness succeeds. If verification/restoration/readiness fails, persist `last_result=failed` and `last_failure_code=gateway_rollback_failed`, leave evidence/log paths, and print `Run cozygateway repair; if it still fails, reinstall from https://cozylabs.ai/install.ps1`.
- [ ] In `agent-install.sh --repair`, validate canonical home and ownership record first; verify installed asset bytes; rewrite only the recorded supervisor/worker/wrapper/task/unit/plist; restart the Gateway; then reconcile only `profiles`/`profile_scope`, each recorded `service_<profile>` action, installer-owned plugin marker, and installer-owned env keys. A foreign plugin/key/service becomes `hermes_confirmation_required` and exits without mutation; an unrelated Hermes failure becomes `hermes_external_failure` with Hermes' own repair as the next action.
- [ ] Make partial-state uninstall recover only an exact task/unit/plist action that points under the canonical Gateway home plus exact marker-owned plugin/config keys. Missing bundle, worker, wrapper, or part of state cannot expand deletion scope. Keep foreign registrations/files and report them.
- [ ] Add POSIX and Windows tests named `repair restores a damaged Gateway asset from verified cache`, `repair rejects an unverified cached asset`, `failed readiness restores exactly the prior Gateway release`, `Gateway rollback leaves upgraded CozyAgents untouched`, `repair retains exact profile scope`, `repair reports unowned Hermes drift without changing it`, `repair is idempotent after interruption`, `uninstall recovers exact owned resources with missing bundle and state`, and `uninstall leaves foreign registrations and Hermes state`.
- [ ] Run `bash scripts/test/hermes-installer.test.sh`, `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1`, `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-agents-bootstrap.test.ps1`, and `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-dashboard-owner.test.ps1`.
- [ ] Commit: `feat(installer): repair and roll back Gateway exactly`.

## Task 9: Derive local status and doctor output from the same checks

**Files:**

- Modify: `scripts/agent-install.sh`
- Modify: `packages/gateway/src/cli.ts`
- Modify: `packages/gateway/test/cli.test.ts`
- Modify: `scripts/test/hermes-installer.test.sh`
- Modify: `docs/agent-install.md`
- Modify: `docs/gateway-maintenance.md`

- [ ] Add `agent-install.sh --status-json`, producing exactly one JSON object with `ownership`, `release`, `service`, `readiness`, `lastOperation`, `log`, and selected `harness`; each check is bounded and side-effect free. Values are `working|needs_attention|not_checked`; failures use only stable codes and next-action enum values. No raw error/command/env data is included.
- [ ] Let installed `cozygateway status --json` route to that verified installer/status path even when `cozygateway.mjs` is damaged. Human `cozygateway status`/`doctor` formats that same object; retain the current calm healthy text and `Run cozygateway repair` guidance.
- [ ] Add CLI tests named `prints machine status as one redacted JSON object`, `human doctor derives from the same checks`, `status works with a damaged runtime bundle`, and `status bounds unreachable service and harness probes`.
- [ ] Update docs with the operation polling payload, health meanings, worker location/lifetime, `.previous` behavior, exact repair scope, stable next actions, and explicit statement that Hermes external failures require Hermes repair.
- [ ] Run `pnpm --filter cozygateway test -- cli.test.ts gateway-maintenance.test.ts`, `bash scripts/test/hermes-installer.test.sh`, and `pnpm --filter cozygateway typecheck`.
- [ ] Commit: `feat(gateway): report bounded local health`.

## Task 10: Update a remote CozyAgents computer over the existing runner lane

**Files:**

- Modify: `packages/contract/src/ext-bots.ts`
- Modify: `packages/contract/test/ext-bots.test.ts`
- Modify: `contract/runner-v1.md`
- Modify: `packages/gateway/src/storage.ts`
- Modify: `packages/gateway/src/runner/protocol.ts`
- Modify: `packages/gateway/src/runner/lane.ts`
- Modify: `packages/gateway/src/http.ts`
- Modify: `packages/gateway/src/server.ts`
- Modify: `packages/gateway/test/storage.test.ts`
- Modify: `packages/gateway/test/runner-lane.test.ts`
- Create: `packages/gateway/test/runner-maintenance.test.ts`

**Public paired API:**

```ts
export interface RunnerUpdateRequest {
  requestId: string; // 1..128 characters; idempotency is scoped to the runner id
}

export interface RunnerMaintenanceAccepted {
  operationId: string; // runner_maintenance_<32 lowercase hex>
  requestedAt: number;
}

export interface RunnerMaintenanceOperation {
  operationId: string;
  runnerId: string;
  requestId: string;
  action: "update";
  status: "pending" | "running" | "succeeded" | "rolled_back" | "failed";
  step: "download" | "promote" | "restart" | "readiness";
  priorVersion: string | null;
  resultingVersion: string | null;
  requestedAt: number;
  updatedAt: number;
  code?: string;
  message?: string;
}
```

`POST /runners/:id/update` requires paired-device auth and body `{ requestId }`. It returns `RunnerMaintenanceAccepted` with 202 after the SQLite row exists, whether the named runner is online or offline. `GET /runners/:id/maintenance/:operationId` requires paired-device auth and returns the exact `RunnerMaintenanceOperation` with 200. A missing runner or an operation not owned by that route's runner id returns the existing redacted 404 shape; neither response reveals whether another runner owns the operation.

**Existing runner WebSocket extension, locked to the CozyAgents plan:**

```ts
export interface RunnerUpdateCommand {
  kind: "command";
  command: "update_runner";
  payload: { operationId: string };
}

export interface RunnerMaintenanceReceipt {
  kind: "runner_maintenance_receipt";
  operationId: string;
  action: "update";
  status: "pending" | "running" | "succeeded" | "rolled_back" | "failed";
  step: "download" | "promote" | "restart" | "readiness";
  priorVersion: string | null;
  resultingVersion: string | null;
  requestedAt: number;
  updatedAt: number;
  code?: string;
  message?: string;
}
```

Only terminal receipts may carry one of these stable codes: `manifest_unreachable`, `manifest_invalid`, `asset_unreachable`, `asset_size_mismatch`, `asset_checksum_mismatch`, `promotion_failed`, `service_failed`, `readiness_timeout`, or `rollback_failed`. `message` is optional, bounded to 240 characters, and must pass the same secret/path/command-line redaction rule as local maintenance. The command contains no version, URL, executable, credential, or free-form command; the runner's own verified updater chooses and validates its release.

**Dedicated durable table:**

```sql
CREATE TABLE IF NOT EXISTS runner_maintenance_operations (
  operation_id TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action = 'update'),
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','rolled_back','failed')),
  step TEXT NOT NULL CHECK (step IN ('download','promote','restart','readiness')),
  prior_version TEXT,
  resulting_version TEXT,
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  code TEXT,
  message TEXT,
  sent_at INTEGER,
  UNIQUE (runner_id, request_id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS runner_maintenance_one_active_per_runner
ON runner_maintenance_operations (runner_id)
WHERE status IN ('pending','running');
```

Do not add these columns to `runner_operations`: that table requires `bot`, `kind`, and `spec_generation`, while a runner update belongs to the computer and must not invent a bot. Do not add a foreign key to `runners`; a terminal receipt stays pollable after runner removal, and a pending operation removed with its runner is settled explicitly rather than cascaded away.

**Storage and lane interfaces:**

```ts
createRunnerMaintenanceOperation(input: {
  operationId: string; runnerId: string; requestId: string; now: number;
}): RunnerMaintenanceOperation;
runnerMaintenanceOperation(runnerId: string, operationId: string):
  RunnerMaintenanceOperation | undefined;
runnerMaintenanceOperationByRequest(runnerId: string, requestId: string):
  RunnerMaintenanceOperation | undefined;
unsentRunnerMaintenanceOperations(runnerId: string): RunnerMaintenanceOperation[];
markRunnerMaintenanceSent(operationId: string, runnerId: string, at: number): boolean;
resetUnfinishedRunnerMaintenanceSends(runnerId: string): void;
recordRunnerMaintenanceReceipt(
  runnerId: string,
  receipt: RunnerMaintenanceReceipt,
): "recorded" | "stale" | "unknown";

RunnerLane.requestRunnerUpdate(runnerId: string, requestId: string):
  RunnerMaintenanceAccepted;
RunnerLane.runnerMaintenance(runnerId: string, operationId: string):
  RunnerMaintenanceOperation | undefined;
```

- [ ] Add `RunnerUpdateRequestSchema`, `RunnerMaintenanceAcceptedSchema`, and `RunnerMaintenanceOperationSchema` beside the current runner schemas in `packages/contract/src/ext-bots.ts`. Reject unknown fields, unbounded ids/messages, invalid steps/statuses, and any token, URL, log, argv, or environment-shaped additions. Add contract tests named `accepts the runner update request and durable operation`, `rejects runner maintenance secrets and unknown fields`, and `accepts only the locked runner maintenance terminal codes`.
- [ ] Add `RunnerMaintenanceReceiptSchema` to `RunnerClientFrameSchema` and `runner_maintenance_receipt` to `RUNNER_CLIENT_FRAME_KINDS`. Add the exact `update_runner` member to `RunnerServerFrame`. Document both frames, the `runner_maintenance_<32 lowercase hex>` operation-id format, and their retry rules in `contract/runner-v1.md`; change the protocol capability/version only if the paired CozyAgents implementation uses the same negotiated value, never unilaterally.
- [ ] Add the dedicated strict table, row mapper, and exact storage methods above. `createRunnerMaintenanceOperation` returns the existing row for the same `(runnerId, requestId)`, returns no second row for concurrent retries, and maps the partial-index collision to `operation_in_progress`. Different runners may each own one active update concurrently.
- [ ] Define monotonic receipt ordering as status `pending < running < terminal` and step `download < promote < restart < readiness`. Ignore a receipt whose status/step regresses, whose `requestedAt` differs from the stored request, whose terminal code is not allowlisted, or whose operation belongs to a different authenticated runner. A second byte-equivalent terminal receipt is idempotent. Once terminal, no different receipt can change the row.
- [ ] Extend `RunnerLane.dispatchPending()` to send each attached runner's unsent runner-maintenance rows after its bot operations as `{ kind: "command", command: "update_runner", payload: { operationId } }`, then mark only that runner's row sent. The lane must never send one runner's update to the default runner or any other connection.
- [ ] On the same runner reconnect, call `resetUnfinishedRunnerMaintenanceSends(connection.key)` and resend the same `operationId` until a first receipt lands. The Agents side treats that id as idempotent and resumes/returns its durable receipt. A runner that is offline at POST time leaves the operation `pending/download`, `sent_at = NULL`; POST still returns 202 and the first authenticated hello dispatches it. A Gateway restart obtains the same behavior from SQLite without recreating the operation.
- [ ] Route `runner_maintenance_receipt` through `recordRunnerMaintenanceReceipt(connection.key, frame)`, update roster `lastSeenAt` like every valid runner frame, and call the existing receipt-change callback so connected apps refresh. Never write `message` to the diagnostic log; log only runner id, operation id, status, step, and stable code.
- [ ] Add `POST /runners/:id/update` and `GET /runners/:id/maintenance/:operationId` beside the current `PATCH`/`DELETE /runners/:id` routes under `requireDevice`. Validate that the runner exists before create. Return 409 `operation_in_progress` only for a different active request on that runner; return the same 202 receipt for any retry of the same request id, online or offline.
- [ ] When `DELETE /runners/:id` removes a runner with a pending/running maintenance row, settle it once as `failed/readiness/service_failed` with fixed message `"Runner was removed before its update completed."`; do not readdress it to the default runner. Keep the terminal row pollable by operation id until the ordinary bounded maintenance-history prune removes it.
- [ ] Add storage tests named `stores runner maintenance without inventing a bot`, `scopes request idempotency to one runner`, `allows different runners to update concurrently`, `permits only one active update per runner`, `rejects stale foreign and post-terminal receipts`, and `survives Gateway reopen with the same operation id`.
- [ ] Add lane tests named `queues update_runner while its runner is offline`, `dispatches update_runner only to the named runner`, `resends the same update_runner operation after reconnect`, `records the locked runner maintenance receipt shape`, `ignores another runner's maintenance receipt`, and `does not resend a terminal runner update`.
- [ ] Add HTTP tests named `requires paired auth for runner maintenance`, `returns the same receipt for an idempotent runner update`, `polls an offline runner update as pending`, `returns durable runner status after Gateway restart`, `blocks a different concurrent update only on the same runner`, `does not leak cross-runner operation ownership`, and `removing a runner fails rather than readdresses its update`.
- [ ] Run RED first: `pnpm --filter cozygateway-contract test -- ext-bots.test.ts` and `pnpm --filter cozygateway test -- storage.test.ts runner-lane.test.ts runner-maintenance.test.ts`; expect missing schemas/table/frame/routes. Implement the minimum additions above, then rerun both commands GREEN.
- [ ] Run `pnpm --filter cozygateway-contract typecheck`, `pnpm --filter cozygateway typecheck`, and `pnpm --filter cozygateway test -- runner-roster.test.ts runner-lane-server-e2e.test.ts` to prove existing runner pairing, roster, bot operations, and multi-runner isolation remain unchanged.
- [ ] Commit when implementing: `feat(gateway): add durable remote runner updates`.

## Task 11: Render the approved COZYLABS Windows onboarding TUI and choices

**Files:**

- Modify: `scripts/install.ps1`
- Modify: `scripts/test/windows-bootstrap.test.ps1`
- Modify: `scripts/test/windows-agents-bootstrap.test.ps1`

**Fixed-width artwork:** define one single-quoted here-string constant in
`scripts/install.ps1` and write it with one `Write-Host` call. The content between
the here-string delimiters is exactly this block; do not split the blobatar,
arrows, Gateway rectangle, or CozyChat cellphone across functions or output calls:

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

The block is decorative only. Immediately after it, ordinary terminal text must
state that CozyGateway is always installed and present the harness choices. Keep
the current `-Harness hermes|cozyagents` noninteractive contract and any existing
forwarded installer flags unchanged.

**Selection seam:** retain `Find-Hermes` and `Select-Harness` as the authorities,
but make the default explicit and testable:

```powershell
function Write-CozyLabsWelcome { param() }
function Select-Harness {
    param(
        [string] $RequestedHarness,
        [string] $StatePath,
        [string] $ConfigPath,
        [bool] $HermesDetected
    )
    # returns exactly 'hermes' or 'cozyagents'
}
```

- When `-Harness hermes` or `-Harness cozyagents` is supplied, return it without
  prompting and retain the current `(from -Harness)` status copy.
- When an already installed Gateway has a recorded harness, retain it without
  prompting and retain the current `(already installed here)` copy.
- On a clean interactive install with usable Hermes detected, show
  `1. CozyGateway only (use existing Hermes) [recommended]` and
  `2. CozyGateway + CozyAgents`; Enter selects `hermes`, while `2` explicitly opts
  into CozyAgents. No path removes or replaces Hermes silently.
- On a clean interactive install without usable Hermes, show
  `1. CozyGateway + CozyAgents [recommended]`,
  `2. CozyGateway + Hermes`, and
  `3. CozyGateway + CozyAgents + Hermes`; Enter selects `cozyagents`, `2` selects
  `hermes`, and `3` records explicit `both` onboarding intent while reusing the
  existing Gateway-plus-harness installers sequentially. CozyGateway is installed
  exactly once in every branch.
- `both` is onboarding intent, not a new long-lived harness enum, service identity,
  state schema, or supervisor. Persist the existing selected local attachment
  (`harness=hermes` or `harness=cozyagents`) plus the existing product-owned
  install facts; invoke the other product's verified installer without merging
  ownership. Do not add `both` to Gateway runtime configuration.

- [ ] Add `scripts/test/windows-bootstrap.test.ps1` assertions named in comments
  `approved COZYLABS artwork is one output block`, `artwork rows retain fixed
  widths and anchors`, `Hermes-present Enter defaults to Gateway only`,
  `Hermes-present explicit CozyAgents opt-in is honored`, and `explicit both
  installs Gateway once and both harness products`. Capture host output through
  the existing bootstrap harness and assert the artwork occurs contiguously once.
- [ ] In the artwork test, normalize only CRLF to LF, split the exact expected and
  actual blocks into rows, and assert equal row count and byte-for-byte row
  equality. Additionally assert the left blobatar, `----->`, Gateway rectangle,
  second `----->`, and intact phone borders occur on their approved rows; assert
  only the left figure is labeled `CozyAgents` and no blobatar glyph appears under
  CozyChat or CozyGateway. Do not `Trim()` rows or collapse spaces.
- [ ] Add `scripts/test/windows-agents-bootstrap.test.ps1` assertions named in
  comments `Hermes-absent Enter defaults to Gateway plus recommended CozyAgents`,
  `Hermes-absent explicit Hermes choice is honored`, `Hermes-absent explicit both
  choice is honored`, `recorded harness bypasses onboarding choice`, and
  `noninteractive Harness flags preserve existing behavior`. Use the current fake
  Hermes/Agents installers and command log to prove Gateway is invoked once and
  each explicitly selected product installer is invoked once.
- [ ] Add a source-compatibility assertion that the welcome block is a literal
  single-quoted PowerShell here-string and contains no interpolation, ANSI escape,
  Unicode box-drawing dependency, `??`, ternary operator, pipeline-chain operator,
  or other PowerShell 7-only syntax. Parse/run the full bootstrap under
  `powershell.exe` (Windows PowerShell 5.1), not only `pwsh`.
- [ ] Prove noninteractive behavior with `-Harness hermes` and `-Harness
  cozyagents` while stdin is closed: neither command calls `Read-Host`, both retain
  their current installer arguments, and both still print the ordinary statement
  that CozyGateway is required. Keep existing `-Repair`, uninstall, dry-run,
  listener, profile, and forwarded-argument assertions green.
- [ ] Run RED first:
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1`
  and
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-agents-bootstrap.test.ps1`;
  expect the missing contiguous artwork/default-choice assertions to fail. Add
  the minimum TUI/selection changes, then rerun both commands GREEN under Windows
  PowerShell 5.1. Also run both with `pwsh -NoProfile -File` when PowerShell 7 is
  installed to prove identical row/selection output.
- [ ] Run `bash scripts/test/harness-choice.test.sh` and `bash
  scripts/test/hermes-installer.test.sh` to prove POSIX selection and the shared
  product installer remain unchanged.
- [ ] Commit when implementing: `feat(installer): add COZYLABS Windows onboarding`.

## Task 12: Full regression and native Windows acceptance

**Files:**

- Modify: `.github/workflows/ci.yml` if commands/timeouts need updating
- Modify: `docs/agent-install.md`
- Create: `docs/acceptance/2026-09-02-gateway-installer-durability-windows.md`

- [ ] Run the repository gate: `pnpm check`, `pnpm bundle`, `pnpm test:installer`, `pnpm test:installer:windows`, `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-dashboard-owner.test.ps1`, and `git diff --check`.
- [ ] On a disposable Windows 11 user account, run the built/tagged assets under Windows PowerShell 5.1 and PowerShell 7. Record redacted commands, versions, exit codes, `schtasks /Query /TN CozyGateway /XML`, local status JSON, operation JSON, and log paths.
- [ ] Capture the clean-install onboarding under both shells and compare it to the approved fixed-width block without trimming spaces. Verify the left-to-right CozyAgents → CozyGateway → CozyChat flow, CozyAgents as the sole blobatar, the complete Gateway rectangle and CozyChat cellphone, and readable ordinary-text choices at the actual console width.
- [ ] With Hermes usable, press Enter and verify Gateway-only is the default; rerun clean and explicitly opt into CozyAgents. With Hermes absent, press Enter and verify Gateway plus recommended CozyAgents; rerun clean and explicitly choose Gateway plus Hermes and Gateway plus both harnesses. Verify every branch installs Gateway exactly once and never silently removes an existing harness.
- [ ] Repeat the Hermes and CozyAgents noninteractive `-Harness` invocations with stdin closed under Windows PowerShell 5.1 and PowerShell 7; verify no prompt occurs and all pre-existing flags/forwarded arguments retain their behavior.
- [ ] Exercise: Hermes absent recommendation, Hermes present default, explicit both-harness choice, idempotent rerun, Gateway and Agents child crashes, logoff/logon, reboot, CozyChat update with polling, Gateway restart during a running receipt, bad manifest/download with no promotion, interrupted/locked promotion and rollback/repair, exact Hermes reconciliation, missing-state uninstall, an offline secondary Agents computer, a remotely triggered update of that named secondary computer after it reconnects, and end-to-end pairing/message/stream/media.
- [ ] Verify Task Scheduler sees the supervisor exit and applies no more than its configured three retries; verify Startup fallback separately by forcing registration denial and observing the same bound.
- [ ] Verify ambiguous POST handling manually: interrupt CozyChat's update response after acceptance, reconnect, and observe only `GET /gateway/maintenance/operations/<same-id>` until terminal state. A reconnect alone must not display success.
- [ ] Verify remote runner polling independently: interrupt `POST /runners/<secondary>/update` after its durable 202, take the runner offline, reconnect both app and runner, and confirm the Gateway sends the same `update_runner` operation id, accepts its `runner_maintenance_receipt`, and serves the terminal record from `GET /runners/<secondary>/maintenance/<operation-id>`. Confirm another offline runner does not affect Gateway health and never receives the command.
- [ ] Record every case pass/fail with no credentials. Native reboot/logon evidence is mandatory; mocked Scheduler tests are not a substitute.
- [ ] Commit the evidence: `test(installer): record Windows durability acceptance`.

## Commit order and dependency gates

1. `feat(contract): add durable gateway maintenance status`
2. `feat(gateway): persist maintenance operation state`
3. `feat(gateway): expose maintenance polling and health`
4. `refactor(installer): consolidate gateway supervision`
5. `fix(installer): attach Windows task to gateway supervisor`
6. `feat(installer): run durable local maintenance worker`
7. `feat(installer): verify release manifests before promotion`
8. `feat(installer): repair and roll back Gateway exactly`
9. `feat(gateway): report bounded local health`
10. `feat(gateway): add durable remote runner updates`
11. `feat(installer): add COZYLABS Windows onboarding`
12. `test(installer): record Windows durability acceptance`

Do not start CozyChat integration until commits 1–3 fix the local polling/status contract and commit 10 fixes the per-runner polling contract. Task 6 may compile against a fixture CozyAgents command, but native cross-product acceptance waits for CozyAgents to provide the agreed product-owned `upgrade --json` and `status --json` commands. Task 10 likewise waits for CozyAgents' locked `update_runner`/`runner_maintenance_receipt` frames, but can land against a fake runner first. Tasks 4–8 must stay in order because worker durability assumes the final supervisor identity, and rollback assumes the manifest/previous-release layout.

## Final verification matrix

| Invariant | Smallest automated proof | Native proof |
| --- | --- | --- |
| One generated body | `hermes-installer.test.sh` executes both argument modes | Hermes-present and CozyAgents modes start |
| Native POSIX restart | wrapper exits once; unit/plist owns restart keys | targeted macOS/Linux smoke before release |
| Attached Windows supervision | task XML action + exit/restart fixture | child crash, logoff/logon, reboot |
| Durable acceptance/polling | SQLite reopen + Gateway restart route test | restart during update receipt |
| Short-lived worker | resume-by-step worker tests; no daemon process | process list settles after operation |
| Product-local rollback | Gateway failure preserves Agents result | locked/corrupt promotion |
| Exact Hermes repair | selected profiles/owned markers only | Hermes update then reconcile |
| Calm projection | fixed contract + offline-secondary test | CozyChat shows one working result |
| Remote runner update | dedicated table + reconnect/isolation route tests | named secondary computer updates after reconnect |
| Secret redaction | adversarial fixture values absent everywhere | inspect redacted logs/status/evidence |
| Conservative uninstall | missing-state and foreign-resource tests | partial install cleanup |

## Planning concerns

- CozyAgents' exact CLI contract is not present in this repository. Gateway should code only to an agreed `upgrade --json` / `status --json` product boundary; do not absorb Agents internals as a workaround.
- Task Scheduler retry semantics and whether a killed task tears down detached descendants must be proven on disposable Windows 11. The boot-time worker resume makes correctness independent of a detached worker surviving task termination, but the evidence is still required.
- POSIX maintenance needs the supervisor socket even though native managers own restart. The Node supervisor remains a thin attached launch/prelude/IPC process; it must not regain a POSIX crash loop.
- A worker writing the Gateway SQLite database while Gateway is live relies on Node 24 SQLite/WAL, already used by this codebase. Keep transitions short and compare-and-set; do not hold a transaction across a child command or readiness poll.
- Existing Docker maintenance is a separate host mode. Preserve its constrained restart support; do not claim local self-update for Docker until that host path gains its own verified promotion and rollback implementation.

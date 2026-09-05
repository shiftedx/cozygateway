# Auto-provision phone-created Hermes bots on native installs

Date: 2026-09-05. Branch: `fix/auto-provision-phone-created-bots`.

## The bug, as diagnosed

Creating a Hermes bot from CozyChat on a machine installed with `install.sh` (v0.7.3) hangs on the
incubation screen ("forming" for 90s, then "Still waking up") and the roster row then carries the
"gateway setup needed" badge forever.

Mechanism, confirmed against a live gateway and Hermes on 2026-09-05:

1. `POST /bots {name}` (Hermes runtime) calls Hermes `profiles.create`, seeds the profile (writes
   `plugins.enabled: [cozygateway]`), and answers `201` with `syncState: "setup_required"`
   (`native-data-plane.ts#syncState`: a profile absent from the config `profiles` attach map).
2. CozyChat polls `GET /bots/:name/readiness` every 2s (`BotsStore.beginReadinessTracking`);
   `setup_required` is never terminal, so it polls until the person leaves. Live check on this
   machine: `{"name":"snug-nimbus","status":"setup_required"}`.
3. Nothing on a client install ever moves the row forward. The config attach map is written only by
   `scripts/agent-install.sh` (`write_gateway_config`) at install/repair time. The design comment in
   `native-data-plane.ts` says "the installer adds them to gateway config, and the ensuing restart
   constructs the native plane" -- the thing that was supposed to run the installer is
   `scripts/bot-provisioner-watch.sh` + `scripts/provision-bot.sh`, which is a dev-box tool: it
   ssh's to `kmcdowell@192.168.99.106`, edits the docker box config, and targets
   `https://warm.cozylabs.ai`. `scripts/install.sh` / `agent-install.sh` never install it.
4. The documented manual recovery (`cozygateway repair`, default `--profiles all` scope) is also
   broken for such a profile: Hermes `profiles.create` copies the launch profile's `.env`
   wholesale into the new profile (`tui_gateway/methods_profiles.py::_mirror_launch_credentials`),
   so the new profile arrives carrying the DEFAULT profile's `COZYGATEWAY_TOKEN` and
   `COZYGATEWAY_SPOOL_PATH`. `write_gateway_env` reuses any `safe_secret` token it finds, then dies
   with "Hermes profiles must have distinct CozyGateway attach tokens".

Secondary latent bug (not fixed here, noted): `HermesBridge.createBot` ends with
`await this.refresh(...)` which swallows a `profiles.list` timeout, then throws `BotNotFound` ->
`404` for a bot that does exist. Seen once in the local log at 21:09 (`profiles.list timed out after
30000ms`). Live `profiles.list` measures ~180ms, so this is a transient, not the primary cause.

## Fix

### Part A -- installer: never inherit another profile's attach token

File: `scripts/agent-install.sh`, function `write_gateway_env`.

A profile's existing `COZYGATEWAY_TOKEN` is its own only when its `COZYGATEWAY_SPOOL_PATH` is the
spool path this installer would write for that profile (`<profile home>/plugin-data/cozygateway/
attach-v1.sqlite`, Windows-converted on Windows). Otherwise the token is an inherited copy and a
fresh one is minted. `env_put` already overwrites URL/TOKEN/SPOOL/HOME_CHANNEL, so the rest of the
profile `.env` is corrected by the existing code. The "distinct tokens" `die` stays as the safety net.

Regression test: append a case to `scripts/test/hermes-installer.test.sh` (at the END so the shared
fixtures used by earlier cases are untouched):
- After a configured install, create `$tmp/hermes/profiles/phone/config.yaml` and copy
  `$tmp/hermes/.env` (which now carries the default profile's CozyGateway keys) to
  `$tmp/hermes/profiles/phone/.env`.
- Rerun the installer (same invocation shape as the "configured update rerun" case).
- Assert: exit 0; `phone`'s token differs from `default`'s; `phone`'s `COZYGATEWAY_SPOOL_PATH`
  is inside `profiles/phone`; `gateway.env` has `COZYGATEWAY_ATTACH_TOKEN_PHONE` equal to
  `phone`'s `.env` token; the config `profiles` map names `phone`; `default`'s token is unchanged.
- Watch it fail before the fix (the die), pass after.

Docs: `docs/agent-install.md` -- one sentence next to the `all` scope paragraph.

### Part B -- gateway: start the provisioning run itself

New: `packages/gateway/src/hermes-bridge/profile-provisioner.ts`.

```ts
export interface ProfileProvisioner {
  /** Fire-and-forget. Never throws; never blocks the request that called it. */
  provision(event: { profile: string; change: "created" | "deleted" }): void;
}
export function createInstallerProvisioner(opts: {
  configPath: string;
  log: (line: string) => void;
  platform?: NodeJS.Platform;           // default process.platform
  spawn?: typeof import("node:child_process").spawn; // test seam
  env?: NodeJS.ProcessEnv;              // default process.env
  hasSystemdRun?: () => boolean;        // default: `systemd-run` on PATH
}): ProfileProvisioner | undefined;
```

`createInstallerProvisioner` reads `<dirname(configPath)>/install-state` (key=value lines written
by the installer's `write_state`). It returns `undefined` (and logs why, once) when any of these
hold: no state file; `harness` is not `hermes`; `profile_scope` is not `all` (the operator chose
isolation; honour it); `repair_mode=runtime-only`; platform is `win32` (documented gap, see
`docs/agent-install.md`); the installer or plugin archive is missing. Paths: `gatewayDir =
dirname(dirname(bundle_path))`, installer `= gatewayDir/bin/agent-install.sh`, archive
`= gatewayDir/bin/cozygateway-hermes-attach-plugin.tar.gz`.

`provision()`:
- Debounce 1s and coalesce: one run at a time; a trigger during a run marks `pending`, and the
  next run starts when the current one exits. A burst of creates costs one run.
- Command: `bash <installer> --gateway-dir <gatewayDir> --bundle <bundle_path> --plugin-archive
  <archive> --no-qr` with env `{...env, COZYGATEWAY_HERMES_BIN: hermes_bin}` (the installer honours
  `COZYGATEWAY_HERMES_BIN`). stdin `ignore`; stdout+stderr appended to `<local>/provision.log`
  (open the fd, pass it for both). `detached: true`, then `child.unref()`.
- Linux: when `systemd-run` is available, run instead
  `systemd-run --user --collect --quiet --unit cozygateway-provision-<ms> --setenv=HOME=...
  --setenv=PATH=... --setenv=COZYGATEWAY_HERMES_BIN=... bash <installer> ...` so the run lives in
  its own transient unit and survives `systemctl --user restart cozygateway.service`, which kills
  the whole service cgroup. Without `systemd-run`, still spawn detached (best effort) and log that.
- Log one line on start (`provisioning run started for <profile> (<change>); log: <path>`) and one
  on exit with the exit code. Never include token values anywhere.

Why spawn the installer: the installer already does every step correctly and idempotently
(plugin sync, `.env` claim, token mint, config `profiles` map, gateway env, service restart, Hermes
profile gateway install, attach wait), and its default `all` scope discovers the new profile. The
gateway restart is the mechanism the code already documents; CozyChat's readiness poll treats
transport errors as non-terminal for exactly this reason (`BotsStore.swift`: "a gateway restart is
part of today's provisioning path"). Deleting also triggers a run so `/ready` (every configured
profile online) is truthful again once the deleted profile leaves the config.

Wiring:
- `HermesBridgeOptions.onProfileChange?: (event: { profile: string; change: "created" | "deleted" }) => void`.
  Called in `createBot` after the roster row is found (just before `return`) and in `deleteBot`
  after `refresh` (just before `return`). Wrapped in try/catch; a throwing hook never fails the
  request.
- `server.ts`: `StartGatewayOptions.profileProvisioner?: ProfileProvisioner` (programmatic seam,
  like `notifierLog`). When omitted and `options.configPath` is set, build
  `createInstallerProvisioner({ configPath, log: console.error })`. Pass
  `onProfileChange: (e) => provisioner?.provision(e)` ONLY to the single non-namespaced Hermes
  member (the shape the installer writes); federated/namespaced members get none.

Tests (vitest, `packages/gateway/test`):
- `profile-provisioner.test.ts`: with a fake `spawn` and a temp dir holding `install-state` +
  `bin/agent-install.sh` + `bin/cozygateway-hermes-attach-plugin.tar.gz` + `local/config.json`:
  spawns bash with the exact args and `COZYGATEWAY_HERMES_BIN`; detached; coalesces a burst into
  one run and runs once more after exit when triggered mid-run; returns `undefined` for
  `profile_scope=default`, `repair_mode=runtime-only`, `harness=cozyagents`, `win32`, missing
  state; Linux + `hasSystemdRun` wraps with `systemd-run --user`.
- `bots-create-provisioning.test.ts` (model on `bots-create-blank-slate.test.ts`): `POST /bots`
  for a Hermes bot calls `onProfileChange` once with `{profile, change: "created"}` after the 201
  is produced; a `409` name collision calls nothing; `DELETE /bots/:name` calls it with `deleted`.
  Watch both fail before wiring, pass after.

Docs: `contract/ext-bots-v1.md` paragraph at "The installer's default dynamic `--profiles all`
scope re-discovers and provisions profiles on update/repair." -- add that a native install runs
that provisioning itself after a phone-created profile is created or deleted, that the run restarts
the gateway service, and that `setup_required` is therefore transient there. `docs/agent-install.md`
same, keep the Windows exception sentence.

## Verification

- `pnpm -r typecheck`
- `pnpm --filter cozygateway-gateway test -- profile-provisioner bots-create-provisioning bots-create-blank-slate bots-delete-routes`
- `bash scripts/test/hermes-installer.test.sh`
- Empirical: a detached grandchild survives `launchctl bootout` of its LaunchAgent on macOS
  (checked separately with a throwaway agent, result recorded in the PR).

---
status: accepted
---

# ADR 0087: Remove the remaining CozyAgents code from CozyGateway

CozyGateway is the connector for Hermes and, later, OpenClaw. A person who runs CozyAgents uses
the gateway that CozyAgents bundles. This ADR finishes what ADR 0086 started. It amends 0086 (which now
carries an "Amended by ADR 0087" note) and reverses no accepted decision.

## Context

ADR 0086 stopped CozyGateway from hosting CozyAgents bots. Release 0.8.6 removed the provisioning
and the config path. It left code behind on purpose, so that an older database would open and the
two gateways would stay the same code. That code has no caller now:

- Nothing writes a runtime-bot row. `runtime_bots` and `runner_operations` are read only by their
  own storage methods and by tests.
- The native data plane is handed no runtime bots and no lifecycle. Its runtime-bot branches,
  the history lane, and the CozyAgents harness adapter cannot run.
- The maintenance status keeps a CozyAgents section that no supervisor in this repository
  produces.
- Docs still describe CozyAgents behavior this gateway does not have.

The one thing that looks CozyAgents-specific and is not is the runner lane. It lets a paired
remote computer run a chat for an existing Hermes profile. The gateway side serves Hermes only
(`runner/lane.ts`, `chat-executions.ts`, `contract/runner-v1.md`). It stays.

## Decision

Remove every CozyAgents code path that has no Hermes or OpenClaw caller. Keep the pieces a Hermes
or OpenClaw connection needs, even when a CozyAgents name sits on them.

**Remove:**

- The runtime-bot lifecycle, projection and recovery hooks, the runtime-bot roster overlay, and
  the runtime member branches in rooms.
- The bot history lane and its five routes. Only a CozyAgents peer ever negotiated it.
- The CozyAgents harness adapter and its harness descriptor.
- The storage methods for runtime bots and runner operations, and the purge and startup-prune code
  that reads them.
- The CozyAgents host status and the `cozyagents` harness in the gateway maintenance producer.
- The stale docs and comments that describe CozyAgents as served here.

**Keep:**

- `POST /bots {"runtime": "cozyagents"}` answers `503 backend_unavailable`. The request schema
  does not forbid extra fields, so dropping the check would create a Hermes bot for a request
  that asked for another runtime. The refusal moves to the route layer.
- The config `bots` block is still dropped at load with a warning, as ADR 0086 says.
- `botRuntimes` stays in `/health`. A client reads it first and only then falls back to the
  `com.cozylabs.bots` version.
- The runner lane, the `runners` table, `com.cozylabs.runners`, `/runners`, and runner pairing.
  They serve Hermes remote computers.
- The `runner-v1` hello keeps accepting `"cozyagents"` in `chatExecutionHarnesses`. The CozyAgents
  runner is the program that runs on the remote computer, and it sends `["cozyagents", "hermes"]`
  when its Hermes executor is configured. The gateway offers a computer to a Hermes chat only when
  the list holds `hermes`.
- The `COZYAGENTS_*` environment names in the Hermes execution bootstrap. The runner sets them.
- The refusal of an install state marked `cozyagents` or `both`.
- The table definitions for `runtime_bots` and `runner_operations`, and the `chat_executions`
  `harness` default. An older database keeps opening, and a rollback to 0.9.1 stays safe.
- The wire shapes shared with CozyAgents' bundled gateway and with CozyChat: the optional
  `BotSummary.runtime`, the maintenance `product` union and `cozyAgents` fields, and the
  `agents` step. This gateway stops producing them. The shared contract does not shrink.
- The attach-v1 boundary, the `bot_config` lane, and the leader-assignment routes. A Hermes or
  OpenClaw peer uses them.

**Never do:** drop a table, delete a row, or delete a paired runner during an automatic upgrade.
ADR 0086 and the split showed what a destructive migration costs a shared database. Old
rows stay inert. An operator removes them with an explicit command in a later release, if ever.

## OpenClaw

No OpenClaw code exists in `packages/gateway/src`. Every mention is prose or a test comment. This
decision leaves these in place so a connector can sit beside the Hermes bridge: the generic
attach-v1 ingress and its credential map, the `hermes: "absent"` health state for a gateway with
no Hermes endpoint, the `botRuntimes` list, the unadvertised leader-assignment routes, and a
runner lane that already names its harness in the hello. A later ADR designs the connector.

## Consequences

- A CozyAgents feature goes to the CozyAgents repo. A feature here must serve Hermes or OpenClaw.
- The shared contract copy in this repository and the copy in CozyAgents' bundled gateway may
  drift. Capability numbers are still never reused (ADR 0086). Rows 45, 46, 49, 50, 51, 54, 61, 74 and 79
  stay in the table, marked as served by CozyAgents' bundled gateway only. Rows 52 and 55 (paired
  runners and rename) are served here for Hermes computers, apart from the runtime-bot `botCount`.
  Rows 47, 48 and 53 are general: the `bot_config` lane is kept.
- A database that holds CozyAgents rows opens unchanged. The rows are never attached, listed, or
  dispatched. A paired runner that cannot run Hermes still appears on `/runners` until a person
  revokes it.
- CozyChat needs no change. It already reads `botRuntimes` and the capability map, and it hides
  CozyAgents creation on a gateway that does not list that runtime.
- The remote computer program for Hermes chats is the CozyAgents runner today. That is a product
  dependency, not a code dependency. The docs slice of the removal states it in `docs/operators`.

## Owner answers, 2026-10-11

- Hermes remote computers keep using the CozyAgents runner. There is no separate runner.
- A 404 on the removed history routes is fine.
- The inert rows stay. There is no prune command for now.
- The release is 0.9.2. The owner wants 0.9.x patches on the way to 1.0, with no 0.10.
- The contract copies here and in CozyAgents' bundled gateway may drift.
- The `contract/ext-bots-v1.md` line that names a CozyAgents-repo ADR path is removed.
- The inventory and slice plan live in the pull request description, because repo rules forbid
  plan files.

"The split" means the 0.8.6 change described in ADR 0086, which moved CozyAgents bot hosting to
CozyAgents' bundled gateway and made the two gateways keep separate databases.

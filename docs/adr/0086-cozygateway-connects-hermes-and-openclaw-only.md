---
status: accepted
---

# ADR 0086: CozyGateway connects Hermes and OpenClaw only

CozyGateway connects Hermes (and, soon, OpenClaw) bots to CozyChat. CozyAgents bots use
CozyAgents' own bundled gateway.

## Context

CozyGateway once hosted CozyAgents runtime bots as well: config-declared `bots`, `POST /bots
{runtime: "cozyagents"}`, runner provisioning, and CozyAgents-only lanes. Commit `afb6c63e`
(2026-09-19, "restore Hermes-only public gateway", released as 0.8.6) removed them and pointed
CozyAgents users at CozyAgents' own gateway. Loose ends stayed: the config schema still accepted a
`bots` block that nothing read, and the contract still described runtime bots as this gateway's.

On 2026-09-24 the Leader bot (#471, #475) was built here by mistake. Live end-to-end tests on
2026-09-25 found that a CozyAgents leader cannot attach to this gateway, and a Hermes profile has
no team tools, so no bot here could lead. The Leader bot's gateway half now lives in CozyAgents'
bundled gateway.

## Decision

CozyGateway exists only to connect Hermes, and in future OpenClaw, to CozyChat, in a more elegant
way than direct connections: one pairing, a durable conversation store, push, and rooms.

It does not host CozyAgents bots. It has no CozyAgents runtime-bot provisioning, no CozyAgents
attach identities, no bot-settings lane, and no CozyAgents-specific lanes. CozyAgents bots attach
to CozyAgents' own bundled gateway: `cozyagents-gateway.mjs`, built from CozyAgents' `gateway/`
subtree and run by the CozyAgents runner service on port 8790.

## Consequences

- A feature for CozyAgents bots goes to CozyAgents' bundled gateway, not here.
- A feature here must serve Hermes or OpenClaw connectivity.
- A config naming CozyAgents runtime bots (a `bots` block) is refused at load, by name.
  `POST /bots {runtime: "cozyagents"}` answers `503 backend_unavailable`.
- `com.cozylabs.agent-inbox` is not advertised here, because no bot here can lead. CozyChat then
  hides the Agent Inbox, whose only threads are assignments, and the Team section. To match, a
  profile patch carrying `role` or `reports` is refused with `400`, and no profile read or roster
  row carries `role`. The leader-assignment routes stay, unadvertised, for a future Hermes or
  OpenClaw leader. This amends ADR 0082's supersession note.
- Capability rows stay shared with CozyAgents' bundled gateway, so neither gateway reuses the
  other's numbers. Row 79 stays reserved for CozyAgents bot settings. Contract sections about
  `runtime: "cozyagents"` bots describe that gateway, not this one.

# Hermes v0.21.0 Bot Mode and A2A: CozyGateway integration assessment

**Research date:** 2026-08-31
**Scope:** primary Hermes release/source/docs plus current CozyGateway contracts and ADRs, followed by a local deployment upgrade and compatibility validation. No CozyGateway runtime code was changed.

## Executive answer

Hermes's latest stable release is **Hermes Agent v0.21.0, tag
[`v2026.8.31`](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.31),
commit [`29112bef099274229cadff79cdff7bf7b99c4b77`](https://github.com/NousResearch/hermes-agent/commit/29112bef099274229cadff79cdff7bf7b99c4b77), published at 19:29 UTC on 2026-08-31. Before this review, the local CLI reported **v0.20.5 (2026.8.19)** and its source checkout was at `981101239a064c020a9d18fc3b1060ae306934ed` (described as `v2026.8.18-1132-g981101`). The CLI's separately reported upstream abbreviated commit (`6da0ae1c`) did not match that checkout, confirming stale installed metadata.

The local deployment is now **v0.21.0 (2026.8.31)** on the updater-selected `main` commit `8dbf07e950`, which includes the stable release plus eleven same-day state-database and gateway-startup fixes. `hermes update --check` reports it current. The official updater migrated configuration to v39, refreshed the web UI and bundled skills, and restarted all six previously running profile gateways. Their launchd definitions were then regenerated and verified against the current install. Bot Mode protocol injection is enabled; the bundled A2A v1.0 plugin validates successfully but remains disabled, with no peers registered.

The release adds two different capabilities that should not be conflated:

1. **Bot Mode** is the user-facing Hermes Desktop team experience: named profile-backed bots, canonical persistent Bot Chats, direct bot DMs, group rooms, routines, and cross-machine routing. It is the right upstream product surface for humans who want to inspect agents collaborating.
2. **A2A** is a separately enabled, standards-based network plugin. It provides A2A v1.0 JSON-RPC tasks, authenticated peers, contexts, streaming, task queries, push notifications, and local JSONL conversation history. It is a strong integration transport, not a unified end-user inbox.

### Agent Inbox decision

**No-go for restoring the withdrawn `com.cozylabs.agent-inbox` as the old “trustworthy, durable A2A inbox” today.** Hermes has materially improved the user experience, but it has not exposed the complete structured, durable, permissioned record that [ADR 0082](../adr/0082-agent-inbox-stays-hidden-until-hermes-proves-a2a-identity.md) requires.

**Go for a phased, explicitly limited “Bot Mode activity” view after upgrade and integration validation.** It may show canonical Bot Chats and Hermes group rooms as Hermes-owned conversation surfaces, with the raw Hermes session source and conservative access control. It must not claim a canonical delivery ledger, a verified reply edge, or complete immutable history. Do not resurrect the old heuristic that classified arbitrary transcript rows by text.

The generic A2A plugin gets closer on authenticated peer identity and task/context IDs, but its task store is in-process only and its persistent conversation record lacks complete sender/recipient/message identity. It does not, by itself, satisfy the ADR either.

## Local upgrade result

- Upgraded with the official git-install workflow from v0.20.5 to v0.21.0. `hermes update --check` now reports **Already up to date**.
- Created quick snapshot `20260831-205329-pre-update` and a full 2.5 GB rollback archive at `~/.hermes/backups/pre-update-2026-08-31-155332.zip`. The quick snapshot skipped the 1.1 GB `state.db` because it exceeded Hermes's 1 GB quick-snapshot cap; the full archive is the rollback artifact.
- Migrated the active config from v37 to v39 and sibling profiles from v38/v0 to v39. Removed two retired `holographic_memory` platform-toolset references while preserving the supported `memory` toolset/provider. Migrated five profiles from retired `MESSAGING_CWD` environment entries to `terminal.cwd` without changing the configured workspace.
- Refreshed launchd definitions and verified six gateways (`bayberry`, `breezy-rill`, `cleo`, `drowsy-lark`, `night-owl`, and `polished-satellite`) are supervised and running. `default` and `mtplx` remained stopped because they were stopped before the update.
- `hermes doctor --fix` completed successfully and installed/verified the stable macOS TCC interpreter anchor. An unrelated editable `coding-agent-session-extractor` package pointed Python startup into a TCC-protected `Documents` path and stalled launchd; reinstalling the same v0.2.0 package as a normal wheel preserved it while removing that startup dependency. The installed CozyGateway plugin remains enabled; Hermes's plugin doctor passed runtime discovery, manifest parsing, import, and registration. The complete CozyGateway attach-plugin suite passed **475 tests with one skip** against final commit `8dbf07e950`.
- Bot Mode's `agent.bot_mode_protocol` resolves to `true`. `a2a-platform` v1.0.0 is bundled and its five tools register in plugin validation, but it is not enabled and `hermes peer list` is empty. Enabling it was deliberately deferred because that creates a new agent-facing network/trust boundary and is not required to use Bot Mode.

## Capability matrix

| Need | Bot Mode DMs / rooms | Hermes A2A plugin | CozyGateway inbox verdict |
| --- | --- | --- | --- |
| Human-facing agent collaboration UI | Yes: Desktop roster, canonical chats, DMs, group rooms, unread/activity state. | No dedicated inbox UI. | Use Bot Mode concepts, not A2A as an inbox. |
| Sender identity | Local target is roster-validated; message text is server-prefixed `Message from …`. Cross-machine Desktop routes know connection/profile. | Per-peer bearer tokens can yield an authenticated peer name; shared token falls back to IP. | Bot Mode attribution is useful display metadata, but is not a message-record identity exposed to CozyGateway. A2A is stronger at transport authentication. |
| Recipient/addressing | Local profile handle; remote `handle@connection`; peer `peer/profile`. | Configured peer name or URL; message carries a `contextId`; served-agent routes may add profile/tenant scope. | Both are usable transport addressing, not a Gateway-facing mailbox API. |
| Message/body model | A DM is an injected human-style Bot Chat turn with a prefixed text body. Group rooms have typed actors/events internally. | A2A v1.0 Message has `messageId`, role, Parts, optional `contextId`; Task has id/status. | Do not derive a general inbox from Bot Chat prefix text. A2A semantics need a dedicated adapter. |
| Live state | Sender receives an acknowledgement; reply later arrives as a background completion notification. Group UI has active/needs-you state. | `message/stream` SSE, `tasks/get|list|subscribe|cancel`, and signed push callbacks. | A live view is feasible only if Gateway owns a new subscription/adapter and preserves event identity. |
| Durable history | Canonical Bot Chats persist as sessions; group shared mirror is bounded recent history, while full orchestration log is Desktop-local. | Conversation JSONL survives restarts/compaction; task query store does **not** survive process restart. | Neither offers a documented, complete Gateway replay API for every bot-to-bot event. |
| Delivery/reply correlation | `message_agent` is fire-and-forget. The generic tool exposes no durable delivery ID/reply-to relationship in the recipient message. | `taskId` and `contextId` correlate task lifecycle; callback/status are task-scoped. | Only A2A has a usable transport correlation model, but it is not durably queryable after restart. |
| Security | Tool is only injected into canonical Bot Chats on Bot-Mode-managed installs; targets are roster-validated. Peer route uses API-server credentials. | Localhost-safe default, bearer/per-peer auth, trust gate, injection filtering, outbound redaction, rate limit, anti-loop, HMAC+SSRF protection. | A2A has the better network security baseline; it still needs a CozyGateway permission model before exposing content. |
| Observable API/hook for CozyGateway | No documented structured Bot-DM event/replay hook found. Hermes Desktop owns its Bot Mode projections. | Standard A2A HTTP/JSON-RPC + Agent Card; no Gateway-native durable inbox feed. | Requires a purposeful integration contract, not session scraping. |

## What Bot Mode offers

### Runtime model and user features

Bot Mode is bundled in Hermes Desktop and is on by default. A bot is not a new agent runtime: it is an existing Hermes profile, retaining isolated config, memory, skills, credentials, and history under `~/.hermes/profiles/<name>/`. Each has one created-and-pinned canonical **Bot Chat**. The source documentation is explicit that this is a UI over profiles rather than an additional daemon or storage layer ([Bot Mode guide, lines 8-26](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/user-guide/bot-mode.md#L8-L26)).

The user-facing features relevant to CozyGateway are:

- named specialist agents with independent model/provider pins, SOUL, skills, toolsets, MCP enablement, and profile metadata ([lines 31-56](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/user-guide/bot-mode.md#L31-L56));
- an activity-ordered roster with latest preview, timestamp, active-now presence, unread state, and persistent canonical chats ([lines 18-26](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/user-guide/bot-mode.md#L18-L26));
- bot-owned cron routines whose outcomes land in the owning Bot Chat ([lines 70-74](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/user-guide/bot-mode.md#L70-L74));
- 2–6 member group chats: up to three serial rounds and ten messages per user send, persistent per-member `Group: <name>` sessions, explicit mention routing, and cross-machine members ([lines 76-91](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/user-guide/bot-mode.md#L76-L91)).

The group's shared metadata is durable and propagated across connected gateways, but the source deliberately calls its shared history a **bounded recent-history projection**; the full orchestration log remains in each Desktop's local store ([lines 78-82](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/user-guide/bot-mode.md#L78-L82)). This is valuable UX, not evidence of a general, complete inbox replay contract.

### Direct bot-to-bot DMs

The `message_agent(target, message)` tool is injected only into a Bot-Mode-managed profile's canonical Bot Chat. It validates a local target against the live roster; adds sender attribution itself; writes the received request into the target's Bot Chat; acknowledges immediately; and reports the reply later as a background completion notification. The public guide defines the behavior and its intentionally limited scope ([lines 93-110](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/user-guide/bot-mode.md#L93-L110)); the tool implementation confirms a 16,000-character body cap, title/managed-install execution gate, and roster validation ([`bot_mode_dm.py`, lines 1-180](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/tools/bot_mode_dm.py#L1-L180)).

Addressing supports:

- a local profile / bot handle;
- a connected-Desktop peer as `handle@connection` when names collide; and
- an always-on registered peer as `peer` or `peer/profile`.

Desktop-routed delivery requires a Desktop that knows both connections; it queues a relay envelope, invokes the target Bot Chat, and delivers the reply as a background completion. If the Desktop closes mid-delivery, Hermes reports the reply did not arrive rather than silently claiming success ([lines 120-126](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/user-guide/bot-mode.md#L120-L126)). `hermes peer` provides the no-Desktop path over an API-server URL plus `API_SERVER_KEY`; short synchronous DMs and durable asynchronous `peer run` with `run_id` and idempotency key are separate commands ([lines 128-153](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/user-guide/bot-mode.md#L128-L153)).

There are typed failure reasons for delivery failures (including `runtime_offline`, `delivery_timeout`, `target_busy`, and provider causes), and Hermes performs one selective retry. Those reasons arrive with the sender's completion notification rather than as a documented durable DM status ledger ([lines 112-118](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/user-guide/bot-mode.md#L112-L118)).

### Bot Mode limitations material to an Inbox

- A direct DM is persisted as a Bot Chat turn whose sender attribution is text (`Message from 🤖 …`), not as a documented immutable A2A message record with sender ID, recipient ID, message ID, delivery status, and reply-to ID. The implementation constructs that prefix and launches a background delivery process; it does not emit a structured durable DM event ([`bot_mode_dm.py`, lines 270-380](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/tools/bot_mode_dm.py#L270-L380)).
- The user docs explicitly say the receiver picks the delivery up per invocation and live interruption of a busy Bot is future work ([lines 108-110](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/user-guide/bot-mode.md#L108-L110)).
- Canonical chats survive as sessions, but that does not prove immutable full-message history or a replay cursor suitable for a third-party consumer. Group projection is explicitly bounded.
- The important security gates protect **who can invoke `message_agent`**; they do not turn a stored transcript line into a portable cryptographic provenance record. This is an inference from the implementation, not an upstream claim.

## What the A2A plugin offers

### Protocol, models, APIs, and lifecycle

The separate `plugins/platforms/a2a` plugin implements **A2A Protocol v1.0 JSON-RPC**, not Bot Mode. When enabled, it serves an Agent Card and accepts `message/send`, `message/stream` (SSE), `tasks/get`, `tasks/list`, `tasks/cancel`, `tasks/subscribe`, and push-notification configuration calls ([A2A README](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/plugins/platforms/a2a/README.md#L31-L70)). It is config-gated, so a Hermes upgrade alone does not expose it.

Outbound capabilities are `a2a_discover`, `a2a_call`, `a2a_list`, `a2a_history`, and `a2a_orchestrate`; the latter can fan out by advertised capability in `all`, `first`, or coarse `best` mode ([design, lines 17-41](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/plugins/platforms/a2a/DESIGN.md#L17-L41)).

The message/task model has the identifiers that Bot Mode DMs lack:

- A2A messages have a generated `messageId`, role (`ROLE_USER` or `ROLE_AGENT`), Parts, and optional `contextId` ([`protocol.py`, lines 226-281](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/plugins/platforms/a2a/protocol.py#L226-L281)).
- Inbound work creates a `taskId` and context. It progresses through submitted/working to completed, input-required, failed, cancelled, or rejected; streaming returns status/artifact events and closes at terminal state ([design, lines 51-90](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/plugins/platforms/a2a/DESIGN.md#L51-L90)).
- Inbound work is framed as untrusted peer input and injected through Hermes's live message path. It uses the A2A task ID as the incoming message ID and A2A context as the chat ID ([`adapter.py`, lines 698-798](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/plugins/platforms/a2a/adapter.py#L698-L798)).

### Security and authorization

This is a solid foundation for a future explicit CozyGateway A2A adapter: no token means loopback only; remote bind requires both credentials and an explicit host; individual bearer tokens map to authenticated peer names; optional trusted peers restrict access; inbound content is filtered and framed; outbound credentials are redacted; rate limits and per-context anti-loop caps apply; and push callbacks are HMAC signed and SSRF guarded ([security design, lines 95-117](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/plugins/platforms/a2a/DESIGN.md#L95-L117)).

The source implementation confirms that authenticated identity comes from the presented credential rather than the request body ([`security.py`, lines 34-132](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/plugins/platforms/a2a/security.py#L34-L132)), and that inbound text is always filtered and marked untrusted ([lines 194-222](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/plugins/platforms/a2a/security.py#L194-L222)).

### Persistence, observability, and hard limits

A2A persists each request and reply outside compaction in `~/.hermes/a2a_conversations/<context>.jsonl`, and `a2a_history` reads it. Each saved record contains only `ts`, `role`, `text`, and `task_id` ([`protocol.py`, lines 800-840](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/plugins/platforms/a2a/protocol.py#L800-L840)).

By contrast, its task state is **not durable**: `TaskStore` is an adapter-instance in-memory ordered dictionary and retains only the last 500 terminal tasks ([design, lines 119-132](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/plugins/platforms/a2a/DESIGN.md#L119-L132); [`protocol.py`, lines 580-780](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/plugins/platforms/a2a/protocol.py#L580-L780)). A2A metrics are module-global and explicitly not persisted. Its audit trail is append-only JSONL but only keeps a 500-character summary, not a full message/archive model ([`security.py`, lines 344-372](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/plugins/platforms/a2a/security.py#L344-L372)).

Finally, the source explicitly scopes current A2A out of gRPC and HTTP+JSON bindings, durable state-transition history, and true cancellation of an already-running agent turn ([design, lines 145-152](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/plugins/platforms/a2a/DESIGN.md#L145-L152)).

## ADR evidence check

### Current CozyGateway boundary

CozyGateway has already encoded the correct evidence bar. Its contract records capability 17 as withdrawn because session text cannot prove durable A2A identity/privacy, reserves `com.cozylabs.agent-inbox` with no version until upstream supplies structured identity, delivery/reply metadata, and bounded replay ([current contract](../../packages/contract/src/ext-bots.ts), [reserved capability](../../packages/contract/src/ext-bots.ts)). The attach-v1 capability list has no A2A/Bot-Mode-message event; it supports delegation but not inbox activity ([ingress](../../packages/gateway/src/adapters/attach/ingress-v1.ts)).

The existing attach integration remains appropriately conservative: it records an upstream `delegation_id` only from the parent tool's structured result and treats the lifecycle hook's batch/index data as local fallback state ([adapter](../../integrations/attach-plugin/cozygateway/adapter.py), [identity logic](../../integrations/attach-plugin/cozygateway/adapter.py)). This confirms that the new release should be treated as an upstream-capability reassessment, not a reason to weaken the contract by parsing transcript content.

### ADR 0081 — delegation identity: **not closed**

[ADR 0081](../adr/0081-delegation-identity-stays-local-until-hermes-exposes-it.md) asked upstream to include `delegation_id`, `task_index`, `task_count`, and `parent_tool_call_id` in both subagent lifecycle hooks, plus structured progress.

Hermes v0.21.0 has improved live delegation controls (list, steer, stop, output schemas and costs), but its documented lifecycle payload is still limited to parent/child session/subagent IDs, role/goal at start, and status/summary/duration/sanitized tool metadata at stop ([observability reference, lines 210-231](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/docs/observability/README.md#L210-L231)). The actual start hook invocation contains no delegation ID, task index/count, or parent tool-call ID ([`delegate_tool.py`, lines 2195-2208](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/tools/delegate_tool.py#L2195-L2208)); neither does the stop invocation ([lines 3665-3681](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/tools/delegate_tool.py#L3665-L3681)).

**Conclusion:** keep CozyGateway's existing opaque local `batchId` and optional result-derived alias. Do not replace it with a claim that upstream lifecycle identity is now durable or restart-joinable.

### ADR 0082 — Agent Inbox: **partially improved, still not closed**

[ADR 0082](../adr/0082-agent-inbox-stays-hidden-until-hermes-proves-a2a-identity.md) requires durable structured sender, delivery/reply, and conversation metadata with bounded replay before advertising the reserved `com.cozylabs.agent-inbox` capability.

What is now better:

- Bot Mode gives a real first-party human UI for agent DMs and groups; direct-message sender attribution is applied by the structured tool rather than only inferred by a CozyGateway regular expression.
- A2A gives authenticated peer identity, task/context correlation, streaming states, and on-disk request/reply conversation text.
- Bot groups have a more structured internal event log. The upstream state module describes an append-only event log and stores `seq`, `event_id`, `kind`, `actor_json`, payload, and time ([`hosted_rooms.py`, lines 1-46](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/gateway/hosted_rooms.py#L1-L46); [schema lines 440-469](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/gateway/hosted_rooms.py#L440-L469)).

What is still missing for CozyGateway's capability:

- one public, versioned, documented event/replay API for both Bot DMs and group/A2A activity;
- durable sender **and recipient** identities carried in each retained direct-message/A2A record;
- immutable message IDs and reply/delivery correlation for Bot Mode DMs;
- restart-safe delivery status/history (A2A task state is memory-only; Bot Mode completion notification is not a documented durable query surface);
- a documented authorization model for a third-party Gateway to enumerate and display private agent-to-agent content; and
- a bounded replay cursor and deletion/retention semantics suitable for synchronization.

**Conclusion:** do not advertise `com.cozylabs.agent-inbox` yet, and do not restore the old transcript-prefix classifier. The capability's evidence gate remains correct.

## Recommended integration plan

### Phase 0 — update and prove the upstream boundary

1. **Completed:** update local Hermes through the official source-install workflow, preserve rollback artifacts, migrate configuration, refresh services, and run post-update checks. The upstream guide is [here](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/getting-started/updating.md#L11-L32).
2. **Completed:** verify the v0.21.0 installed binary/source, Bot Mode setting, bundled A2A plugin, CozyGateway plugin import/registration, and the running profile fleet.
3. **Still required before a product surface:** exercise local DM, Desktop-relayed DM, peer DM/run, Bot group, and A2A against disposable profiles. Record whether any stable documented read endpoint emerges for Bot Mode's structured records. No such public contract was found in the tagged source or live CLI/plugin surfaces.

### Phase 1 — a safe, useful read-only surface

Create a separately named **Bot Mode activity** page/capability only if the live API proof above succeeds. It should:

- link to a specific Hermes canonical Bot Chat or group room; show the existing Hermes transcript rather than copying it into a second message system;
- label source and limitations (`Bot Chat`, `group room`, or `external A2A`), and show sender names as display attribution—not verified delivery provenance;
- use a user/device authorization gate at least as restrictive as the existing bot chat/session endpoints;
- omit claims/columns for `delivered`, `read`, `replyTo`, or complete history unless Hermes provides structured evidence;
- exclude ordinary human sessions completely; no regexp-based classification of arbitrary session text; and
- be opt-in and not advertise the reserved `com.cozylabs.agent-inbox` contract.

Minimum tests: Bot Chat filtering excludes non-Bot sessions; a false-positive/forged-prefix transcript is not relabelled A2A; only authorized devices can open it; per-profile/cross-endpoint identity stays disambiguated; compaction/reconnect/restart never duplicates or silently rewrites existing records; content redaction and retention policies are explicit.

### Phase 2 — a genuine Agent Inbox, only with an explicit adapter

When Hermes offers the missing source contract, add a versioned attach or Dashboard adapter that accepts an event shape conceptually equivalent to:

```text
eventId, occurredAt, transport, conversationId,
sender { stableId, displayName, endpointId },
recipient { stableId, displayName, endpointId },
message { id, content/ref, visibility },
delivery { state, attemptedAt, completedAt, reason },
replyToMessageId, correlationId, cursor
```

It needs monotonic/replayable cursors, restart-safe retention, a user/device authorization decision for each conversation, tombstone/deletion semantics, idempotency, and explicit content-size/redaction rules. Then CozyGateway can durably project events into its own store, expose paginated history and live updates, and advertise `com.cozylabs.agent-inbox` with contract tests for ordering, redelivery, permissions, retries, deletion, and reconnect.

If product value requires external A2A earlier, build a **separate external-A2A activity adapter** around the A2A task/context schema—not an implementation of Agent Inbox—and make its ephemeral task-status limit visible. It must own encrypted/durable event storage itself or wait for upstream to do so.

## Other v0.21.0 capabilities valuable to CozyGateway

- **Managed delegation:** live list/steer/stop, structured child-output validation, reported child costs, and higher defaults can improve the existing live delegation cards—without changing the ADR 0081 identity conclusion ([release notes](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.31)).
- **Cron continuity:** persistent memory, continuity across scheduled runs, durable notepads, and delivery into Bot Chats enable better long-running monitors/routines.
- **MCP command center:** Desktop catalog/import/health/usage UI may make gateway-managed tools easier to inspect, but it is not a new Gateway API contract.
- **First-party browser control and stronger security hardening:** useful to Hermes agents themselves; protected instructions, broad secret redaction, and approval coverage improve the environment in which CozyGateway's plugin runs.

## Commands and source trail

Research and validation commands used:

```text
hermes --version
hermes update --plan
hermes update --backup --yes
hermes update --check
hermes doctor
hermes gateway list / status / start
hermes peer list
hermes plugins show / doctor
git -C ~/.hermes/hermes-agent log -1 / describe --tags
gh api repos/NousResearch/hermes-agent/releases
gh api repos/NousResearch/hermes-agent/tags
gh api repos/NousResearch/hermes-agent/commits/main
git clone/check out NousResearch/hermes-agent at v2026.8.31
rg / sed / nl against the checked-out upstream source and current CozyGateway ADRs/contracts
```

Primary sources consulted: the official Hermes release, tagged source/docs linked inline, and the current CozyGateway [ADR 0081](../adr/0081-delegation-identity-stays-local-until-hermes-exposes-it.md), [ADR 0082](../adr/0082-agent-inbox-stays-hidden-until-hermes-proves-a2a-identity.md), attach delegation adapter, and reserved contract capability. No source was blocked. The pre-update CLI-vs-checkout metadata mismatch was resolved by the official update and reinstall.

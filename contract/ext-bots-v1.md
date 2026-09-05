# CozyGateway Bot Mode extension (`com.cozylabs.bots`)

Status: v1 extension, capability version 59. This extension is independent of the frozen core
`contract/v1.md`. A gateway advertises it in `GatewayInfo.capabilities`; clients that do not
recognize the capability ignore its routes and frames. The exact machine-readable shapes are in
[`packages/contract/src/ext-bots.ts`](../packages/contract/src/ext-bots.ts). Objects are open and
unions are closed, following the core contract.

## Ownership and boundaries

Bot Mode is split deliberately:

- Hermes Dashboard is the **control/read plane** for the profile roster, profile editing, model
  configuration, catalog, and routines.
- attach-v1 is the **Bot Mode chat data plane**. For every configured
  `hermes.profiles.<profile>` identity, CozyGateway owns the chat session ids, transcript,
  attachments, active-turn state, tool activity, approvals, and clarification state in its SQLite
  store. The gateway sends commands to that profile's attached Hermes plugin and commits its
  durable attach-v1 events back into this projection.
- Group rooms are gateway-owned attach-v1 conversations too. They are not Hermes Dashboard
  sessions.

Therefore Bot Mode chat must never be implemented with Dashboard `session.create`,
`session.resume`, or `prompt.submit`, nor with a Dashboard transcript as a fallback. A Dashboard
or Hermes outage can affect control-plane reads, but it does not change the ownership of a native
Bot Mode transcript.

CozyChat talks only to CozyGateway's existing HTTP, WebSocket, attachment, and push surfaces; it
does not connect to Hermes or attach-v1.

## Discovery and capability history

```
"capabilities": { "com.cozylabs.bots": 59 }
```

Versioned additions are additive and clients compare `>=`, never equality. Explicitly withdrawn or
corrected unsafe behavior is removed rather than retained as a fallback: version 17 below is the
sole historical withdrawal. A gateway that does not configure the extension omits the capability
and does not register `/bots` routes.

| Version | Added surface |
| --- | --- |
| 1 | Roster, presence, canonical chat, native session list/history. |
| 2 | Send text, `bot_chat`, and `bot_chat_state`. |
| 3 | Profile read/edit and catalog. |
| 4 | Routines and `bot_routines`. Current Hermes replies may additionally expose the optional output-only, bounded, path-redacted `lastDeliveryError`. |
| 5 | Gateway-hosted group rooms. |
| 6 | `bot_chat_delta` draft frames. |
| 7 | `GET /bots/:name/media` proxy. |
| 8 | Reset chat and `bot_chat_reset`. |
| 9 | Photo sends and attachment downloads. |
| 10 | Approval frames and approve/deny routes. |
| 11 | Empty-chat `suggestion`. |
| 12 | Tool activity frames and history. |
| 14 | `bot_chat_adopted` and manual session adoption. |
| 15 | Assistant attachment ingestion. |
| 16 | Native session history and manual restore. |
| 17 | Withdrawn. The heuristic A2A inbox leaked unaffiliated human rows and cannot recover durable identity/replay state. Its routes and frames are absent, roster previews make no A2A provenance claim, and transcript-like `Message from ...` text remains ordinary text even though the current bots scalar is numerically >= 17. |
| 18 | Per-bot model configuration. |
| 19 | Stop and start-new-chat actions. |
| 20 | Audio/video attachment playback with byte ranges. |
| 21 | Redacted tool-step details. |
| 22 | Durable native clarification events and resolution. |
| 23 | Exact native turn status/cause and durable queued-at metadata. |
| 24 | Common document attachment sends and file downloads. |
| 25 | Profile-local discovery of Hermes gateway-safe, plugin, and installed skill commands. |
| 26 | Searchable aggregate history of agent-sent attachments across native sessions. |
| 27 | Bounded current-state inbox for pending native approvals. |
| 28 | Requested-vs-confirmed native approval and clarification settlement. |
| 29 | Bounded pending clarifications and confirmed terminal settlement receipts on the recovery route. |
| 30 | Profile-local memory read and conditional write routes. |
| 31 | Durable delivery receipts: the displayed report, `BotChatMessage.marker`, and role `system`. |
| 32 | Inline media ordering: `BotChatMessage.attachments[].position`. |
| 33 | Create-time tool selection: optional `toolsets` / `mcpServers` on `POST /bots`, and `BotCreateResponse.warnings`. |
| 34 | Subagent visibility: `bot_delegation_activity` batch snapshots and a `delegations` array on chat history. Optional Hermes v0.21 synchronous-result enrichment adds bounded child cost/provenance, schema-validation state, and terminal duration without changing the scalar. |
| 35 | Live thinking preview: latest-only `bot_thinking_activity` frames (sanitized, <=280 chars, ephemeral). |
| 36 | Full provider visibility: optional `providers` summary and `unauthenticated` catalog markers on `BotModelConfig`. |
| 37 | Bot deletion: `DELETE /bots/:name`, the inverse of `POST /bots`. Removes the Hermes profile, purges gateway state, and revokes the attach identity. |
| 38 | Device status v2: normalized status purpose and the closed mobile-node v3 operational status result; no v1 fallback. |
| 39 | Capability leases and durable metadata-only receipts for phone-node sharing. |
| 40 | Bot readiness: `GET /bots/:name/readiness` distinguishes a created profile from an attached bot that can accept turns. |
| 41 | Transitional bot-scoped model-provider setup routes. Canonical ownership moved to `com.cozylabs.harness-settings` v1. |
| 42 | Truthful Bot Activity previews (no transcript-derived A2A sender) plus credential-free profile-local Hermes memory setup through the authenticated attached plugin. |
| 43 | The roster represents every Hermes profile and reports `syncState`; profiles not yet provisioned remain visible as `setup_required` instead of disappearing. |
| 44 | Per-profile CozyApps readiness on `BotSummary`, with a stable `restart_profile` repair when a connected plugin did not negotiate `cozyapps`. |
| 45 | Native runtime Bots: config-declared bots served by a non-Hermes attach peer appear on the roster with `runtime: "cozyagents"`, built from config and attach presence rather than the Dashboard; their Dashboard-backed routes answer 409 `unsupported_for_runtime`. |
| 46 | Runtime Bots in rooms: a `runtime: "cozyagents"` bot can be a full member of a group room, its membership answered from gateway config rather than `profiles.list`, and a room turn's live draft is published as `bot_chat_delta` carrying `room`. |
| 47 | Auditable ids: room and 1:1 transcript rows carry the identities the gateway already held at settlement. `BotGroupMessage` gains `messageId`, `turnId`, `epoch`, `cause`, and `attachTurn`; `BotGroupNote` gains `turnId`; `BotChatMessage` gains `turnId`, `authorBot`, and `inReplyToId`. Every field is optional, absent on rows written before 47, and never backfilled. |
| 48 | Bot config lane: a runtime bot serves its own profile, model config, and routines over the attach-v1 `bot_config` lane, so those routes answer for it instead of 409. Deletion and desktop-session transcripts keep the 409, as do the bot-scoped model-provider writes; the bot-scoped model-provider read answers the read-only `com.cozylabs.harness-settings` projection of the peer's `model.read` (see 41). |
| 49 | Runtime bots created from the app: `POST /bots` accepts `runtime: "cozyagents"` and creates a gateway-owned bot with no Hermes profile, minting its attach token and enqueueing a `create_runtime` operation for a CozyRunner. `GET /bots/:name/runtime` projects `{stage, specGeneration, observedGeneration, lastRunnerContactAt}`, and `DELETE /bots/:name` answers for a runtime bot instead of 409. |
| 50 | Bot history: a runtime bot checkpoints its own workspace into git and serves it over the attach-v1 `bot_history` lane. Five new runtime-bot-only routes carry the Changes list, a per-file diff, restore, the try/keep/discard experiment, and the per-file conflict choice. A Hermes bot answers 409 `unsupported_for_runtime`, and so does a runtime bot whose peer did not negotiate `bot_history`. Nothing content-shaped crosses the lane: summaries and counts, never files or patches. |
| 51 | Room turns can ask: a runtime member's approval and clarify events on a room turn land in the existing interaction inbox (`sessionId` is the `group:<room>:<member>` thread) and resolve through the existing `/bots/:member/approvals/...` and `/bots/:member/clarifications/...` routes unchanged; tool events project as ephemeral `bot_tool_activity` carrying `room`; `BotGroup` and `bot_group_state` gain the optional `pendingInteractions` pointer array. The room transcript gains nothing and Hermes members are unchanged. |
| 52 | Paired runners: `POST /pair {setupCode, deviceName, kind: "runner"}` mints a per-runner token instead of a device token, `GET /runners`, `PATCH /runners/:id {default}` (capability 55 extends this route with a person-set `name`) and `DELETE /runners/:id` manage the roster, `POST /runners/pair-code` mints a code from the app, `GET /runners/self` answers that one row under the runner's own bearer, and `/runner/v1` accepts any active per-runner token so two computers hold two sockets at once. The runner `hello` gains optional `name`, `platform` and `agentVersion`, recorded on its row on every hello that carries them, so a renamed computer renames its roster row. A gateway with no Hermes endpoint is a supported configuration; its roster answers from runtime bots and `/ready` reports the bridge as `absent`. |
| 53 | Routine run now: `POST /bots/:name/routines/:id/run` sends `routines.run` over the existing capability-48 `bot_config` lane and answers `BotRoutineRunResponse` (`{routine, startedAt}`), so a person or a check can force a runtime bot's routine to fire immediately. No new capability row; it is a route on the operation capability 48 already defined on the wire. RUNTIME BOTS ONLY, the same rule capability 50's history routes follow: a Hermes bot answers 409 `unsupported_for_runtime`, and so does a runtime bot whose peer did not negotiate `bot_config`. |
| 54 | A create picks a computer: `BotCreateRequest` gains optional `runnerId` naming the paired runner that should run the new bot. Absent, the gateway picks the account default, then the only paired runner, then answers `409 no_runner_paired` with none and `409 runner_choice_required` naming the candidates when there are several and no default; an id that names no paired runner is `400 invalid_request` naming the field. The chosen runner is recorded on the bot row and on every operation for it, so a create, a delete and a later upgrade all reach the same machine, and each connected runner is handed only the operations that name it. An operation written before 54 names no runner and goes to the account default. `BotSummary` and `BotRuntimeProjection` gain optional `runnerId` and `runnerName`, absent for a Hermes bot and for a runtime bot created before 54 and never backfilled; `Runner` gains optional `botCount`, which `DELETE /runners/:id` answers too, beside the `reassignedOperations` count for the not-yet-sent work that revoke re-addresses to the account default (or to nobody). The `409 runner_choice_required` body is `RunnerChoiceRequiredBody`, whose `runners` array carries the ids the chooser needs. |
| 55 | A person can rename a paired runner: `PATCH /runners/:id` gains optional `name`, a 1 to 64 character (code points, not UTF-16 units) display name after trimming, alongside the existing `default`; a body naming neither field, or a `name` that fails validation, is `400 invalid_request` naming the field. Only the literal `""` or `null` clears the name; a whitespace-only string is refused rather than treated as a clear. The trimmed value may carry no C0/C1 control character and no Unicode "Format" (Cf) code point either (zero-width space and joiners, the bidi override and isolate controls, the byte-order mark), because a name built from those renders invisible or reorders the surrounding text. A person-set name wins over whatever the runner reports on `hello` from then on: `hello` keeps updating the reported name in its own column exactly as before, but `GET /runners`, `GET /runners/self`, and every `runnerName` carried on a bot summary or runtime projection render the display name once one is set. `Runner` and `RunnerSelf` both gain `renamed`, true exactly when a display name is set. Setting `name` to `""` or `null` clears the display name and returns to whatever the runner itself reports. |
| 56 | An approval can name what it covers: `ApprovalEvent` on attach-v1 gains optional `detail`, a short sentence a runtime peer sends alongside an approval it raises (for example naming which Chrome and which profile `my_browser_open` would drive). The gateway trims it, refuses the same C0/C1 control and Unicode Format (Cf) family capability 55 checks on a runner name, and bounds the display value to 1-400 characters, truncating an overlong sentence at the last whole word and appending an ellipsis -- but unlike a runner name, a `detail` that fails any of this is sanitized rather than a reason to refuse the frame, so the approval it describes is never dropped over one presentation field. `BotApprovalPendingFrame` and the durable interaction record both carry the sanitized sentence when present and omit it otherwise, so a reconnecting app's rebroadcast of a still-pending approval matches the live frame. The approve/deny resolve path and `BotApprovalResolvedFrame` are unchanged. |
| 57 | Per-bot guardrails: `BotProfile` gains an optional `guardrailLevel` and `BotProfilePatch` an optional one too, one of `locked`, `guided`, `balanced`, `autonomous`, carried on the existing capability-48 `profile.read` and `profile.write` operations of the `bot_config` lane. No new route and no new lane. The gateway does not store or interpret the value: it validates the closed union at the boundary (a fifth name is `400 invalid_request` naming the field) and forwards the patch to the runtime peer unchanged, reading back exactly what the peer answers. Absent for a Hermes bot, because the field is not part of the `profiles.describe` / `profiles.configure` vocabulary this gateway translates for Hermes, and absent for a runtime peer that has not negotiated 57, and never backfilled in either case. A client below 57 sends no such field and its profile saves stay byte identical to the ones it sent before. |
| 58 | The operator's guardrail ceiling: `BotProfile` gains an optional `guardrailCeiling`, one of the same four literals as `guardrailLevel`, carried on the existing capability-57 `profile.read` operation of the `bot_config` lane. `BotProfilePatch` does NOT gain it: the ceiling is set on the runtime peer, not written through this gateway, so it is refused on the patch (`400 invalid_request` naming the field). The gateway does not store or interpret the value, only relays exactly what the peer answers on a read. It is the operator's own ceiling on that bot's `guardrailLevel`; a `profile.write` asking for a level above it is the runtime peer's own refusal to make, `400` naming the field and the ceiling it exceeds, so the app greys out every level above the ceiling it read rather than sending one the peer will refuse anyway. Absent for a Hermes bot and for a runtime peer that has not negotiated 58, and never backfilled, exactly as `guardrailLevel` reads. |
| 59 | A bot's whole skill and toolset catalogue, per bot: the capability-48 `profile.read` of the `bot_config` lane answers `skills` with a row per skill the bot HAS OR COULD HAVE (installed ones enabled unless `disabledSkills` names them, plus the peer's own vendored catalogue entries, present and switched off so a person can find one in a search) and `toolsets` with a row per toolset the peer's build ships plus every toolset name from another backend it has no equivalent for. `BotSkill` gains optional `installed` and optional `source` (`default`, `catalogue`, `installed`, `proposed`); `description` carries the row's one line summary. `BotToolset` gains optional `available` (absent means available) and `unavailableReason`, so a toolset a peer cannot offer is LISTED with its reason rather than silently missing. `BotProfilePatch` gains optional `enabledSkills`, the ON list: ADDITIVE, never replace-whole, it installs from the peer's vendored catalogue and clears each name from the stored OFF list, never uninstalls and never disables, and a name the peer neither has nor can install is named under optional `ignored.skills_enabled` while the rest of the patch applies. `applied.skills_enabled` remains true when the section was stored; `ignored` lets a client settle successful rows and offer refusal/retry UI only for the named rows. `PATCH /bots/:name/profile` accepts `enabledSkills` as one of the fields that make a body a request and relays additive `ignored` details from the runtime peer unchanged. `disabledSkills` is unchanged in shape and meaning. The gateway neither computes nor stores any of it and relays exactly what the peer answered, as it does for 57 and 58. Hermes bots are unchanged: `profiles.describe` carries no provenance, no installed flag and no availability, `profiles.configure` has no enable call, and none of it is invented for them. Additive: every read field and `ignored` are optional, so a peer below 59 and a client below 59 are byte identical to their pre-59 selves. A client below 59 reads the same two arrays it has read since capability 3 and can still switch a skill off through `disabledSkills`; it cannot switch one on, because it does not know the field. A client gates sending `enabledSkills`, and rendering rows that are not installed, on `>= 59`: a gateway below 59 answers `400 invalid_request` for an `enabledSkills`-only body, and a peer below 59 refuses a whole patch carrying a field it does not know. |
| 60 | Memory rows may carry optional closed `owner: person\|bot`; absence remains legacy/unknown and is never inferred. A Gateway-authenticated memory create is marked `person` internally, never from caller JSON; a CozyAgents model create is `bot`. `DELETE /bots/:name/sessions/:id` deletes only one inactive, non-selected gateway-owned direct session. When its attached peer negotiated `session_deletion`, the same storage transaction appends exactly one ordered replay-safe metadata-only `session_deleted { sessionSha, deletion: { id, revision, at } }` command; no raw session id, transcript, title, device, path, group, routine, or app-action identity is accepted or sent. |
| 61 | Exact runtime recovery: authenticated `POST /bots/:name/runtime/recover` accepts only a gateway-owned runtime bot whose latest `create_runtime` operation is terminal `needs_attention`. It atomically enqueues one fresh operation using the failed operation's exact stored payload, generation, and runner assignment while preserving the Bot identity and attach credential. A replay, concurrent request, nonterminal operation, deleted/config-owned bot, or revoked/mismatched runner is refused. |

Version 13 was never shipped. A client gates only the feature it renders; unknown optional fields
and unknown server frames are ignored.

`com.cozylabs.agent-inbox` is a reserved, dormant capability id and the sole future advertisement
for Agent Inbox. It has no advertised version: do not advertise it or expose an inbox page until
Hermes supplies durable structured A2A sender, delivery/reply, and conversation metadata plus
bounded replay. It is deliberately separate from `com.cozylabs.bots`: clients must not infer the
withdrawn capability-17 surface from any later `com.cozylabs.bots` version.

## Resources

The TypeBox schemas are normative. The names below identify complete shapes rather than maintaining
a second, hand-copied schema.

- `BotSummary` is one control-plane roster row. Its `chatSessionId`, `preview`, and
  `lastActiveAt` are overlaid from the configured bot's gateway-owned native chat, on every surface
  that serves a roster row. Profile metadata remains Hermes control-plane data.
- `BotChatMessage` is a durable native transcript row. `id` is the gateway/attach event message
  id, `at` is gateway-clock milliseconds (or `null` when unavailable), and `clientId` is an
  optional sender echo. Attachments are gateway-scoped opaque `fileId` values, never paths or URLs.
  Roles are `user` or `assistant` in the conversational projection, plus, from capability 31,
  `system` on gateway-authored rows that are not conversation. Roles are NOT an enum on this wire:
  a client renders an unfamiliar role rather than dropping the row.
  From capability 31 a row may also carry `marker`, a bounded label naming what a gateway-authored
  row IS. The only v1 value is `delivery.failed`. A client that does not know a marker renders the
  ordinary row it already renders.
  From capability 32 an attachment entry may also carry `position`; see "Inline media ordering".
  From capability 47 a row may carry `turnId` (the attach turn it belongs to: the user row that
  opened the turn and every assistant row that turn committed share it), `authorBot` (the bot that
  authored the row), and `inReplyToId` (the `id` of the user row an assistant row answers).
  `authorBot` is present on every non-user row written from 47 on, a desktop-imported assistant row
  included; a `user` row has no bot author and carries none. A steer shares the running turn's
  `turnId` and does NOT become a new `inReplyToId` target: the question a turn answers is the one
  that opened it, not a mid-turn nudge. `turnId` and `inReplyToId` are absent where no gateway turn
  produced the row, which is the `delivery.failed` system row and a desktop-imported row. All three
  are absent on every row written before 47. They are recorded, never inferred: a client must not
  derive causation from ordering when they are absent, because a scheduled or interim row can land
  between a question and its answer.
- `BotSessionSummary` is a durable native Bot Mode session. Current native Bot Mode sessions have
  `kind: "conversation"`; `startedAt` and `lastActiveAt` are milliseconds. They are not Hermes
  Dashboard session records.
- `BotProfile`, `BotCatalog`, `BotModelConfig`, and `BotRoutine` are Hermes control-plane
  resources. The profile source may report `runtimeInert` sections that Hermes stores but does not
  execute.
  From capability 36 `BotModelConfig` may carry `providers`: one summary row per provider Hermes
  reported, kept even when the provider currently contributes zero catalog entries or has lost its
  credential (`authenticated: false`), and a catalog entry from such a provider may carry
  `unauthenticated: true`. Hermes keeps an unauthenticated configured provider visible on purpose,
  so the picker can show the saved selection and a re-auth affordance; a client renders those
  entries disabled with a sign-in hint rather than hiding them, and a client below 36 ignores both
  fields.
  Capability 41's `BotModelProviderSetupCatalog` is the wider setup universe in the same order as
  `hermes model`. It is normalized live from Hermes; CozyGateway has no provider registry. A setup
  field reports only `isSet`, never a value or redacted suffix. A method is `fields`, Hermes-hosted
  `oauth`, or an honest `external` CLI handoff.
  For a `runtime: "cozyagents"` bot the gateway's `cozyagents` harness projects the same catalog
  read-only from the peer's `model.read` (`providers` and `catalog`, `methods: []`). Credential entry
  for its built-in providers is runtime-configured: the operator's environment owns the credentials,
  so the harness-settings field and OAuth writes on a CozyAgents scope answer `404 invalid_request`
  and the bot-scoped writes keep the 409 of capability 45.
- `BotGroup`, `BotGroupDetail`, and `BotGroupMessage` are gateway-owned room resources.
  From capability 51 a `BotGroup` may carry `pendingInteractions`, at most 32 pointers to the
  approvals and clarifications its members are currently blocked on; it is absent when there are
  none, and it is live state rather than history.
  From capability 47 a `BotGroupMessage` may carry `messageId` (the row's own durable, room-unique
  id: `seq` orders a room, `messageId` identifies a message across rooms, restarts, and a head
  trim), `turnId` (the member turn that produced it, the same id as the gateway's durable turn row
  and the attach `turn` command that asked for it; a user row has no turn), `epoch` (the room epoch
  the row belongs to, so one deliberation is distinguishable from the next when a second send
  superseded the first), `cause` (`{ kind, seq }`: the highest room seq the member had been shown
  when its turn STARTED, which is what it was answering, and NOT simply the preceding row), and
  `attachTurn` (`{ threadId, turnId }`: the gateway-owned member thread that carried the turn,
  never a Hermes Dashboard session). A `BotGroupNote` may carry `turnId` when a turn was actually
  started; a `capped` note and a member skipped because it is no longer a bot never got one and
  carry nothing. Every field is optional and absent on rows written before 47; a client renders
  such a row exactly as it does today.
- `BotSlashCommand` is one canonical command advertised by the authenticated profile plugin. Its
  slash-prefixed `name` is the exact invocation; `description`, optional `argsHint`, and optional
  `category` are presentation metadata. `BotSlashCommandCatalog` is the bounded ordered list.

- `BotAttachmentHistoryItem` identifies one assistant attachment in a durable native transcript,
  including its bot, session, message caption, timestamp, and ordinary opaque attachment block.
  `BotAttachmentHistory` is a newest-first bounded page with an optional next offset.
- `BotPendingApproval` is the safe metadata necessary to render one unresolved approval: bot,
  session/turn ids, tool-call id, rule display name, and its pending timestamp. It carries no tool
  arguments, commands, descriptions, results, or model reasoning. `BotPendingApprovals` is capped
  at 100 current records and excludes all terminal history.
- `BotPendingClarification` mirrors that recovery state for one unresolved option card. Its prompt
  and bounded option labels are the same display-safe values already sent in the pending frame.
- `BotInteractionSettlement` is compact terminal proof for one approval or clarification: stable
  bot/session/turn/interaction identifiers, the terminal outcome, optional selected option id, and
  gateway settlement time. It never includes an approval decision command, tool arguments/results,
  or an option label. The gateway retains only the newest 100 terminal receipts per bot.

### Bot Activity composition

A client composes Bot Activity from existing resources; there is no aggregate activity endpoint,
inbox, transcript copy, or second database:

- `GET /bots`, `bot_roster`, and `bot_presence` provide bot identity, display metadata, current
  activity, ordinary preview text, and the canonical Bot Chat session.
- Bot profile/model resources provide role, specialization, provider, and model detail; routine
  routes and `bot_routines` provide owned routines.
- `/bots/groups` provides room membership and room activity. Gateway-owned rooms remain the sole
  group-collaboration surface.
- Canonical Bot Chat/session/history routes remain the conversation surface.

The client may source-label activity and link each row to its canonical chat or room. It must not
claim delivery, read state, reply relationships, immutable history, or verified agent-to-agent
provenance. A preview beginning with `Message from ...` is ordinary display text, not A2A evidence.

Every profile returned by Hermes is exposed as a CozyChat bot. A configured profile reports
`syncState: "ready"` or `"starting"`; a discovered profile without an attach identity reports
`syncState: "setup_required"`, a null native chat id, and cannot accept native chat actions.
Profile lifecycle belongs to Hermes, and from capability 37 both ends of it are reachable from the
phone: `POST /bots` creates the profile and `DELETE /bots/:name` removes it. The installer's
default dynamic `--profiles all` scope re-discovers and provisions profiles on update/repair. On a
native install (one un-namespaced Hermes endpoint written by `agent-install.sh`) the gateway starts
that provisioning run itself, unattended and from the already-verified local assets, after a Hermes
profile is created or deleted through these routes, so `setup_required` is transient there: the row
moves through `starting` to `ready` with nobody at a terminal. The run restarts the gateway service
partway through; a client polling `GET /bots/:name/readiness` treats the transport errors of that
restart as non-terminal, exactly as it already did. Windows installs, narrowed `--profiles` scopes,
runtime-only repairs, and every gateway without installer state keep the manual repair path.

`POST /bots` creates the Hermes profile and then SEEDS it as a blank slate: the `file` + `terminal`
toolset floor on the `cozygateway` and `cli` platforms, `approvals.mode: manual`, inherited MCP
servers quieted, and the profile's whole skill catalog written into its `skills.disabled` OFF-list
so a new bot starts with no playbooks (skills have no enabled allowlist upstream, so a profile that
names nothing has every installed skill on). Operators keep named skills on with
`hermes.blankSlateSkillsOn`, default `[]`. A skill catalog that cannot be read leaves the key
unwritten and adds a warning rather than guessing at half of it. A fresh profile that is seeded with nothing does not get a small toolset, it
inherits Hermes' broad per-platform default, so the floor has to be written down to exist. The
capability-33 `toolsets` and `mcpServers` fields name what to grant ON TOP of that floor;
`file` and `terminal` are always included, and a name the backend does not report is skipped and
listed in `BotCreateResponse.warnings` rather than failing the create. The seed only ever writes
keys the profile does not already carry, and a seed that fails leaves the created bot in place with
a warning. Operators turn the whole behaviour off with `hermes.seedBlankSlateBots: false`; an
explicit selection is still honoured when they do, and the skills OFF-list stops exactly as the
toolset floor does. There is no create-time `skills` field: the app's post-create
`PATCH /bots/:name/profile disabledSkills` is replace-whole and lands after the seed, so a user's
explicit skill selection wins wholesale while an untouched create keeps the floor. See `docs/attach-v1-operations.md`.

### Bot deletion (capability 37)

`DELETE /bots/:name` is the inverse of `POST /bots`, and it is written to one promise: after it
returns, the Hermes host holds no trace of the bot. The order is deliberate and is part of the
contract, because each step is only safe once the one before it succeeded.

1. **The host first.** The gateway asks Hermes to delete the profile, which removes the whole
   profile directory: config, API keys, memories, sessions, skills, cron jobs, the synced
   `cozygateway` plugin and the `.env` holding its attach token. Hermes stops and uninstalls the
   profile's gateway service as part of the same delete. If Hermes refuses or cannot be reached,
   the route fails and NOTHING is purged: a gateway that dropped its own rows while the profile
   kept running on the host is the exact opposite of what this route promises. Hermes answering
   `404` is not a failure but the recovery half of the same promise, reported as
   `hermesProfile: "already_absent"`, and the purge proceeds.
2. **The identity next.** Before any row is dropped, the bot's attach identity is revoked in
   process: its token is removed from the map both public attach surfaces authenticate against,
   its live stream is closed, its capability grant and adapter are dropped. From this point the
   token authenticates nothing, so no in-flight connection can race the purge and write rows back
   in behind it. `tokenRevoked` reports whether an identity was held at all.
3. **The gateway state last.** Every durable row the bot owned is deleted in one transaction:
   the roster row, the native chat plane (active pointer, sessions, transcript, receipts, turn
   media bindings, interactions, turn terminals), tool steps, delegations, routine overrides, the
   attach journals (stream cursor, command outbox, event inbox, turn terminals, media blobs,
   scheduled deliveries), group-turn tombstones, Live Activity registrations, and the bot's half of
   the core thread surface. `purged` reports the row count per area, keyed by stable wire ids, with
   zero-row areas omitted; it is a report of what was removed, never an assertion that it was.

Group ROOMS are deliberately not deleted. A room is a user-owned resource that may name a departed
member, and the room surface already renders a missing member honestly.

A bot with a native turn in flight is refused with `409` and extension code `conflict`; the body
carries `turnId` so a client can name the work it is about to end in its confirmation copy.
`?force=1` overrides that one refusal and nothing else. A name neither Hermes nor this gateway
knows answers the ordinary not-found shape, so a repeated delete is a clean `404` rather than a
second success. Reserved profile names are refused with `400`.

`residue` is a bounded list of display-safe operator English naming what this gateway cannot remove
from where it runs: the box gateway config entry, the token line in the box `.env`, and the host
launchd service if it outlived the profile. None of it can authenticate, because the token was
already revoked in step 2. `scripts/deprovision-bot.sh <profile>` sweeps all of it and is
idempotent, so it is equally safe to run after this route or on its own.

### Runtime bots created from the app (capability 49)

`POST /bots {"name": "sage", "runtime": "cozyagents"}` creates a Bot this gateway owns outright.
Nothing about it touches Hermes: no profile is written, no dashboard is called, and the create does
not fail when Hermes is unreachable. The response is the same `201 {bot, warnings?}` a Hermes create
answers, with `bot.runtime: "cozyagents"`.

What the gateway does, in this order, before it answers:

1. Writes a durable `runtime_bots` row (id, display name, minted credential, `specGeneration: 1`).
   The config-file `bots` array remains a BOOTSTRAP source for the operator-declared runtime bots of
   capability 45; a storage row WINS on collision, because it is the one this gateway minted the
   credential for.
2. Mints the attach token itself, 32 bytes of CSPRNG. It is stored on that row and handed to the
   runner on exactly one frame. It is never logged, never in a receipt, and never on any app-facing
   response.
3. Registers the identity LIVE, with no restart: the attach token map both public attach surfaces
   authenticate against, the runtime and native sets, the agents row, and the roster. This is the
   exact inverse of the revocation `DELETE /bots/:name` performs.
4. Enqueues a durable `create_runtime` operation for a CozyRunner (`contract/runner-v1.md`).

The roster row reads `syncState: "starting"` until the new peer's attach `hello` arrives, exactly as
a freshly provisioned Hermes bot does. `toolsets` and `mcpServers` are Hermes seeding instructions
and are ignored for this kind; supplying them adds a warning rather than failing the create.

`GET /bots/:name/runtime` answers `BotRuntimeProjection`:

```json
{ "stage": "waiting_for_runner", "specGeneration": 1, "observedGeneration": null, "lastRunnerContactAt": null }
```

`stage` is the latest stage a runner receipted for this bot's newest operation. With no runner
connected it stays `waiting_for_runner`: the gateway durably accepted the desired state and says so
honestly rather than inventing progress, and the operation is handed over the moment a runner
attaches. A receipt that would walk the stage backwards along the provisioning progression is
ignored, so this value never regresses on screen.

`observedGeneration` is null until a runner receipts `ready`, and only a `ready` receipt advances
it: an in-progress stage says what is being attempted, never what is running.
`lastRunnerContactAt` is the last moment a runner said anything about this bot or answered the
gateway's heartbeat, and is null only while no runner has ever been in contact; a connected but
silent-about-this-bot runner still counts as contact, which is the point of the field.

`code` appears only when a receipt carried one and is a stable, safe identifier, never diagnostics.
A bot with no gateway-owned runtime answers `409 unsupported_for_runtime`, because it has no
runtime to project rather than being missing.

`DELETE /bots/:name` on a runtime bot answers instead of refusing with 409. It applies the same
refusals the capability-37 Hermes delete applies (a reserved name is `400`; a bot with a native turn
in flight is `409` extension code `conflict` carrying `turnId` unless `?force=1`), then revokes the
attach identity first, purges every durable gateway row exactly as that delete does, and enqueues
`delete_runtime` so the runner removes the container and the bot-exclusive volumes. `hermesProfile`
is `already_absent`, truthfully: there never was one. A config-declared runtime bot (capability 45)
still gets the 409, because removing it means editing the config file the operator wrote.

The bot is gone from the roster and its credential is dead the moment the delete returns, but the
cleanup stays watchable: `GET /bots/:name/runtime` answers `deletion_pending`, then `deleting` once
the runner starts, and finally `404` once the terminal `deleted` receipt lands and there is nothing
left to project.

Out of scope for 49, and deliberately not implied by it: pairing codes and short-lived runner
credentials, upgrades and migrations, restart backoff, drain windows, isolation policy, capacity
admission, archive and purge grace, multi-host, and reconciliation of unknown containers. See
`docs/adr/0002-gateway-reconciled-per-bot-runtime.md` in the CozyAgents repo.

### Recovering a failed runtime (capability 61)

`POST /bots/:name/runtime/recover` is the explicit operator retry for an existing gateway-owned
runtime Bot. It has no request body and returns `202 {operationId, runtime}`. The accepted operation
has a fresh id and `waiting_for_runner` projection, but reuses the failed create's stored runtime
spec, spec generation, runner assignment, Bot identity, and attach credential. It does not delete or
recreate the Bot, rotate its credential, reread current deployment defaults, or edit runner state.

Recovery is available only when the Bot's latest durable operation is `create_runtime` in terminal
`needs_attention`, and its recorded runner assignment still matches a paired runner. Missing,
deleted, config-declared, provisioning, ready, stopped, revoked-runner, and mismatched-placement
targets are refused. Acceptance is atomic and ordered by database insertion order rather than wall
clock time: after one request inserts the fresh operation, a replay or concurrent request sees that
new operation as current and receives `409 conflict` instead of enqueueing another retry.

### Placing a bot on a computer (capability 54)

`POST /bots {"name": "sage", "runtime": "cozyagents", "runnerId": "..."}` names which paired computer
(`GET /runners`) runs the new bot. The field is optional, so the create body a client below 54 sends
is accepted unchanged and answers the same `201 {bot, warnings?}`.

With no `runnerId` the gateway picks, in this order: the account default, then the only paired
runner. It never picks silently between several:

| Situation | Answer |
| --- | --- |
| No paired runner at all | `409` extension code `no_runner_paired`. The app says "Add a computer first". |
| Several paired runners and no default | `409` `RunnerChoiceRequiredBody`: extension code `runner_choice_required`, a message naming the candidates, and a `runners` array of `{id, name, isDefault}`. The app shows a chooser and sends one of those ids back as `runnerId`; the ids are in the array only, never in the message. |
| `runnerId` names no paired runner | `400 invalid_request` naming `runnerId`: a client bug, not a missing machine. |

The chosen runner is written on the bot's row and on every operation for that bot, so a create, a
delete and a later upgrade all reach the same machine. `/runner/v1` hands each connected runner only
the operations that name it. An operation written before 54 names no runner and goes to the account
default, which keeps an existing single-runner deployment moving with no migration step; with no
default and no legacy shared credential it keeps waiting rather than being sent to an arbitrary
machine.

On a gateway whose only computer is the operator-placed shared credential, a create is placed on the
`legacy` row and its bot carries `runnerId: "legacy"` with `runnerName: "legacy runner"`, the same
row and name `GET /runners` already renders. Unsetting `COZYGATEWAY_RUNNER_TOKEN` is how that row is
revoked, and it goes through no route, so nothing is re-addressed: those bots keep naming a
credential that no longer exists. Pair the real computer BEFORE unsetting the variable, and expect
to recreate the legacy-placed bots on it.

`BotSummary` and `BotRuntimeProjection` carry optional `runnerId` and `runnerName`. Both are absent
for a Hermes bot and for a runtime bot created before 54, and neither is ever backfilled: the
gateway never had the value rather than having discarded it. `runnerName` is absent on its own when
the named runner has since been revoked.

`Runner.botCount` is the number of runtime bots placed on that computer, and `DELETE /runners/:id`
answers `RunnerDeleteResponse`: `{"ok": true, "botCount": n, "reassignedOperations": m}`, plus
`"reassignedTo"` when there was somewhere to send the work. Revoking a computer revokes its token
and closes its socket. What happens to what was on it:

- The bots keep their rows, their credentials and the `runnerId` they were given. Capability 54 has
  no route that moves a bot to another computer, so those rows stay pointed at a machine that is
  gone until one is added; they are stranded, not deleted, and `botCount` is the warning.
- Operations that runner had NOT been handed yet are re-addressed, so a revoke never leaves work
  addressed to a credential nothing can present: to the account default when there is one, named in
  `reassignedTo`, and otherwise to nobody, which is the same unaddressed state a pre-54 row holds
  and is dispatched to whichever runner becomes the default later.
- An operation that runner had already been SENT is left addressed to it. It may well have been
  applied, and handing the same mutation to a second machine is what the single-writer rule exists
  to prevent.
- `DELETE /bots/:name` for a bot whose computer is gone still works, and its `delete_runtime` is
  addressed to nobody rather than to the revoked runner, so the cleanup is collectable by whichever
  computer holds the default.

### Bot history (capability 50)

A runtime bot checkpoints its own workspace into git and serves that history over the attach-v1
`bot_history` lane (see `contract/attach-v1.md`). Five routes carry the whole surface, and all five
are RUNTIME BOTS ONLY: a Hermes bot answers `409` extension code `unsupported_for_runtime`, because
a Hermes profile has no checkpointed workspace behind it and never did. That is not a `404`: the
bot exists and its chat lane works, so a client hides the section rather than treating the bot as
missing. A runtime bot whose peer did not negotiate `bot_history` gets the same `409` for the same
reason: the section is genuinely absent rather than temporarily unreachable, and a `503` there
would offer a retry that can never succeed. A peer that IS negotiated and simply offline answers `503
backend_unavailable`, which is a retry worth offering.

**Nothing content-shaped crosses this boundary, in either direction.** A checkpoint row carries a
one-line summary and the audit ids the turn already had. A diff row carries a path, a status, and
two line counts. A conflict row carries one bounded label per side. There is no field on this
extension that carries a file body, a patch, a hunk, or a preview of one, and adding one would be a
new capability rather than an enrichment: the workspace is where a change lives, and these routes
exist so a person can choose between changes without the changes being copied to a phone.

`BotHistoryCheckpoint.checks` is `passed`, `failed`, or `unavailable`, read from the checkpoint's
`Cozy-Checks` trailer. `unavailable` is its own answer and not a synonym for `failed`: a turn whose
checks could not run is not a turn whose checks failed. `turnId` and `messageId` come from the
`Cozy-Turn` and `Cozy-Message` trailers and are present only on a checkpoint a turn wrote; an "as
found" checkpoint, written when a human edited files outside the bot, has neither. `epoch` is the
policy Epoch the checkpoint was taken at. Checkpoint ids are OPAQUE: never infer a commit, a ref, a
branch, or a filesystem path from one.

The `try` route is one route with three actions rather than three routes, because `start`, `keep`
and `discard` are three states of one experiment: a client able to POST `keep` without having
POSTed `start` would be a second place that truth is kept. There is at most one experiment in
flight per bot and the peer owns which, so `keep` and `discard` name none.

**The one conflict.** `keep` after the working version moved answers `409` extension code
`conflict`, with `conflicts: [{path, ours, theirs}]` beside the ordinary error body. Nothing is
lost and nothing failed; a person has to choose per file, and `ours` and `theirs` are the bounded
labels naming the two sides. The client asks "Sage's version" or "the other change" and sends the
answer to `POST /bots/:name/history/resolve`. The word conflict is the wire's name for this case,
never the reader's.

`resolve` with no experiment waiting on a choice answers `404 not_found`, and the PEER performs
that check: the gateway holds no experiment state and never did, so the one side that knows
whether there is a question outstanding is the side being asked. `keep` and `discard` with no
experiment in flight answer the same `404` by the same route. `try.start` is the exception. A peer
answering `not_found` to a start is failing to do something it was asked to do rather than
reporting an absence a client can act on, so it maps to `503 backend_unavailable`, and `list` maps
the same way for the same reason: an empty history is an empty list, never a missing one.

### Slash commands

`GET /bots/:name/commands` returns the last catalog advertised by that profile's authenticated
attach plugin. It contains every Hermes command valid on a messaging gateway: enabled built-ins,
plugin commands, and installed skill commands. Client-local CLI/TUI commands are intentionally not
advertised because they cannot execute through Bot Mode.

Clients MUST require capability `>= 25` before calling the route. Selecting an item should insert
its canonical `name` into the ordinary composer so the user can edit arguments. Sending a command
uses `POST /bots/:name/chat/messages` unchanged; CozyGateway and clients do not duplicate Hermes
command parsing or execution. The most recently authenticated catalog remains readable while the
profile is temporarily disconnected, and an empty catalog is valid.

### Attachment history

`GET /bots/attachments` returns only attachments sent by configured agents in durable native Bot
Mode sessions. It accepts optional `q`, `kind` (`image`, `video`, `audio`, or `file`), `bot`,
millisecond `since`, `offset`, and `limit` query parameters. Search is case-insensitive across the
agent name, message caption, filename, and MIME type. Results are newest first; `limit` is bounded
to 100 and `nextOffset` is `null` when the page is complete.

Clients MUST require capability `>= 26`. This route indexes metadata only. Attachment bytes remain
behind the existing authenticated `GET /bots/:name/chat/attachments/:fileId` route, so clients can
preview, save, or share a result without the gateway duplicating media or exposing a path.

### Pending approvals

`GET /bots/approvals?state=pending` returns a bounded snapshot envelope with every currently
unresolved native approval (ordered oldest first), every unresolved clarification, and recent
confirmed terminal settlement receipts. `state` is optional only for a simpler initial client call;
when supplied it must be `pending`. The route is a recovery/read surface, not a second workflow:
the existing `POST /bots/:name/approvals/:toolCallId/approve` and `.../deny` routes settle the
same durable records, and expired records are absent as soon as their lifecycle timer settles them.
`resolutionRequestedAt`, when present, means the gateway durably appended one stable resolution
command; it is not an approval or denial result and exposes neither a command id nor a decision.

Clients MUST require capability `>= 27` before showing the global pending-requests menu or using
this route. A client that renders the requested-versus-terminal lifecycle or submits either native
resolution action MUST require capability `>= 28`; one that reads clarification recovery or terminal
settlements from this envelope MUST require `>= 29`. A client keeps an action in `awaiting
confirmation` after its POST until it observes the matching terminal receipt (or a terminal frame).
It must never derive a decision URL from push text or retain an old action after a fresh snapshot no
longer contains that `toolCallId`.

### Canonical native chat

Each configured bot always has one selected native session. `GET /bots/:name/chat` and
`GET /bots/:name/chat/messages` create its first empty local session when needed. The session id is
durable across gateway/plugin restart. It is not a Hermes session id and cannot be passed to a
Dashboard RPC.

`GET /bots/:name/sessions` returns that bot's local session history, newest first, and the selected
`activeSessionId`. `POST /bots/:name/sessions/:id/adopt` selects an existing session owned by the
same bot. `POST /bots/:name/sessions/new` selects a fresh empty session without deleting the
previous one. `POST /bots/:name/chat/reset` likewise selects a fresh empty session, interrupts a
running old turn when possible, and additionally sends the stronger `bot_chat_reset` notification.
Neither action deletes prior local history; clients may present reset as “start over”, not as
destructive erase.

### Native sends, events, and suggestions

`POST /bots/:name/chat/messages`, `POST /bots/:name/chat/photos`, and
`POST /bots/:name/chat/attachments` first admit a durable attach-v1
command, then append the user row to the native transcript and answer `202` with that row. If the
configured attach profile cannot accept the command, the request answers `503 backend_unavailable`
without storing transcript or media data. A text send during an active turn is admitted as a native
attach-v1 steer under that turn's id; a photo send during an active turn returns the same `503` so
the client can retry after the turn settles.
The attached plugin returns draft, commit, terminal, tool, approval, and clarification events.
Gateway projection of those durable events emits the corresponding server frames and updates the
same transcript read by `GET /bots/:name/chat/messages`.

There is no automatic greeting. When a selected transcript has no messages and
`hermes.chatSuggestion` is non-empty, history includes optional `suggestion`. It is presentation
text only: clients may offer it, but must not submit it automatically or display it as a transcript
row. Once any row exists, the field is absent.

`running` and `inflight` in history are the gateway's durable active-turn view. Live state frames
are the fresher source for a composing UI. `POST /bots/:name/chat/stop` sends attach-v1 interrupt
for that active native turn; follow-up text uses native attach-v1 steering, never Dashboard chat.

### Delivery receipts (capability 31)

`POST /bots/:name/chat/messages/displayed` carries 1 to 64 wire ids of transcript rows this device
actually put on screen, and answers `202 { "recorded": n }` with the number that became a NEW
receipt. It is the only signal in this contract that a HUMAN received a message: a durable
transcript row proves only that the gateway holds it, and push is fire-and-forget by construction.

Receipts are first-write-wins and never deleted. Ids that already have a receipt, and ids naming no
durable row for that bot, are both ignored and both count zero, so `recorded` is not an error
signal and a client MUST NOT retry a low count. Repeating a request is therefore free, which is
what makes a durable offline client queue safe to flush blindly on reconnect.

A client MUST gate the route on `com.cozylabs.bots >= 31` and MUST NOT send provisional
(client-side, not yet committed) ids. A version 30 gateway answers `404`, which means "this gateway
does not collect receipts", never "the message was lost".

When a receipt lands on a row that was a scheduled delivery, the gateway tells the plugin that
produced it over attach-v1 (`contract/attach-v1.md`, `delivery_receipt`). When a scheduled delivery
instead fails terminally, the gateway appends one `role: "system"`, `marker: "delivery.failed"` row
to that bot's current canonical chat: a quiet status row, not a bubble, and it raises no push.

### Attachments and media

Photo bytes are validated and stored by the gateway before the associated attach-v1 command is
sent. Plugin events refer to media by opaque ids; the gateway commits acceptable media into its own
store. `GET /bots/:name/chat/attachments/:fileId` serves only those gateway-owned bytes and
supports a single byte range for capability 20 playback. It never exposes a Hermes-host path.
Capability 24 additionally admits one 20 MiB document per turn: PDF; UTF-8 plain text, Markdown,
CSV, JSON, or RTF; legacy Office; OOXML; and OpenDocument files. The gateway checks the declared
allow-listed MIME against lightweight format bytes, stores the sanitized filename as metadata, and
serves every attachment with `Content-Disposition: attachment` and `nosniff`.

### Inline media ordering (capability 32)

An attachment entry on `BotChatMessage.attachments` may carry an optional `position`: the index in
that message's normalized block array BEFORE which the attachment renders. `0` renders it above
every block, `blocks.length` renders it below every block, and any value between renders it between
those two blocks. The point is that an image the agent wrote under a heading renders under that
heading rather than on a stack above the whole reply.

The rules, which both sides implement verbatim:

- Absent `position` is the legacy shape and means above-stack. Every row written before 32 has it,
  and any sender that cannot say where an attachment belongs keeps sending it. It is not an error
  and it is not a downgrade.
- A reader MUST clamp an out-of-range value into `0...blocks.length` rather than dropping the
  attachment. A sender that counts blocks differently than the reader degrades to a picture in a
  slightly wrong place; it never degrades to a lost picture.
- A message MAY mix the two. Positioned attachments render in flow at their index, unpositioned
  ones render above the message, and both are correct in the same bubble.
- Rendering is data driven, not version gated: a client renders in flow whenever positions are
  present. The EMITTING side is what gates on `>= 32`.

On the plugin side (`contract/attach-v1.md`), the `commit` and `scheduled` events carry an optional
`mediaPositions` array aligned index-for-index with `mediaIds`, and the gateway threads
`mediaPositions[i]` onto the attachment it builds from `mediaIds[i]`. That array is all or nothing:
when present it MUST have exactly the length of `mediaIds`, because a partial array would silently
claim index `0` for every attachment it omitted. A plugin that is not certain where its attachments
belong omits the field entirely. Message `text` is unaffected: `position` is the only new data.

### Canonical media allowlist

This table is the single reference for outbound media admission. The gateway upload route
(`POST /attach/v1/media/:mediaId`) accepts exactly these MIME types, and the attach plugin's
compatibility policy mirrors this table rather than keeping a second opinion. A type absent here is
refused at the gateway, so a plugin that offers one is guaranteed a 415.

| MIME | Extension | Family | Cap | Baseline |
| --- | --- | --- | --- | --- |
| `image/png` | png | image | 8 MiB | yes |
| `image/jpeg` | jpg | image | 8 MiB | yes |
| `image/webp` | webp | image | 8 MiB | yes |
| `image/gif` | gif | image | 8 MiB | yes |
| `video/mp4` | mp4 | video | 40 MiB | yes, H.264 video with AAC-LC audio |
| `video/quicktime` | mov | video | 40 MiB | beyond baseline, accepted for existing device uploads |
| `audio/mp4` | m4a | audio | 40 MiB | yes, AAC |
| `audio/mpeg` | mp3 | audio | 40 MiB | yes |
| `audio/wav`, `audio/x-wav` | wav | audio | 40 MiB | yes |
| `application/pdf` | pdf | file | 20 MiB | yes |
| `text/plain`, `text/markdown`, `text/csv`, `application/json`, `application/rtf`, `text/rtf` | txt, md, csv, json, rtf | file | 20 MiB | explicit document allowlist |
| `application/msword`, `application/vnd.ms-excel`, `application/vnd.ms-powerpoint` | doc, xls, ppt | file | 20 MiB | explicit document allowlist |
| OOXML `.docx`, `.xlsx`, `.pptx` | docx, xlsx, pptx | file | 20 MiB | explicit document allowlist |
| OpenDocument `.odt`, `.ods`, `.odp` | odt, ods, odp | file | 20 MiB | explicit document allowlist |
| `application/zip` | zip | file | 20 MiB | explicit file allowlist, delivered and shareable, never rendered inline |

The container MIME is what the gateway checks. Codec-level facts for MP4 (H.264 plus AAC-LC,
`yuv420p`, fast-start) are a plugin-side probe: this layer sees a container, not a stream.

`image/svg+xml`, `text/html`, and every other type are excluded on purpose. SVG and HTML carry
script and external references. Excluded means refused at upload, never silently transcoded.

`application/zip` is admitted as a FILE attachment, not a renderable one: it is delivered, stored,
and offered for download or share under the existing `mediaKind: "file"` shape from capability 24,
and no client is asked to render or expand it. It shares the 20 MiB document cap, the largest cap
any `file` type carries. The OOXML and OpenDocument packages above are ZIP containers on the wire,
so the DECLARED type is what separates them from a bare archive; the plugin-side probe tells them
apart by the uncompressed `[Content_Types].xml` entry an Office package stores first.

Declared type is a claim, so every accepted type is additionally checked against format magic bytes
before commit. Bytes that contradict an allowed declaration are refused exactly like a disallowed
type.

### Media rejection shapes

`POST /attach/v1/media/:mediaId` answers a refusal with core `ErrorBody` plus a machine-readable
`reason`, and never echoes any uploaded byte:

| Status | `reason` | Extra fields | Cause |
| --- | --- | --- | --- |
| `400` | `empty` | none | zero-byte upload |
| `413` | `too_large` | `limitBytes` | declared `Content-Length` or delivered bytes over that type's cap |
| `415` | `content_type` | `receivedContentType` | type not on the allowlist, or bytes that do not match the declared type |
| `422` | `digest` | none | `X-Attach-SHA256` missing or not matching the delivered bytes |
| `409` | none | none | media id already exists with different bytes, or a delete target is referenced |

`limitBytes` is the cap for the declared type, not the largest cap in the table. `receivedContentType`
is the request header reduced to MIME token characters and truncated, so it names what arrived
without reflecting attacker-chosen text. Error prose is gateway-authored in every branch; no message
from a layer that touched the payload is passed through.

This route is not rate limited today, so it never answers `429`. If that changes, the shape is the
one already used by `POST /bots/:name/chat/attachments`: status `429`, extension code `rate_limited`,
a `retryAfterMs` field, and a whole-second `Retry-After` header. A producer should treat `429` with
`Retry-After` as retryable whether or not this route emits it yet.

Every type this route accepts is downloadable through `GET /attach/v1/media/:mediaId`, which serves
the stored MIME with `nosniff`, `Content-Disposition: attachment`, and byte-range support. There is
no accept-but-never-serve type.

`GET /bots/:name/media?src=` is a separate HTTPS media proxy for a public source URL in bot output;
it is not a native attachment transport and it refuses unsafe/non-HTTPS sources.

## HTTP routes

Every route below requires device authentication. All normal failures use core `ErrorBody` unless a
route documents an extension-specific code. Names are normalized at the boundary. The schemas named
in this table are exported from `packages/contract/src/ext-bots.ts`.

| Route | Request | Success response | Notes |
| --- | --- | --- | --- |
| `GET /bots` | — | `{ bots: BotSummary[], updatedAt, stale }` | Hermes control-plane roster, with native-chat overlay for configured bots, plus one row per capability-45 native runtime bot. |
| `POST /bots` | `BotCreateRequest` | `201 BotCreateResponse` | Creates a Hermes profile and seeds it as a blank slate, or, with capability-49 `runtime: "cozyagents"`, a gateway-owned runtime bot with no Hermes profile at all. `409` extension code `conflict` when the name is taken. |
| `GET /bots/:name/runtime` | — | `BotRuntimeProjection` | Capability 49. Where a runtime bot's container stands: stage, desired and observed generations, and last runner contact. Three answers: `200` while the runtime exists OR while its delete is still being cleaned up (`deletion_pending`, `deleting`), `409` `unsupported_for_runtime` for a bot that never had a gateway-owned runtime (a Hermes bot, or a name this gateway does not serve), and `404` once the runner's terminal `deleted` receipt lands and there is nothing left to project. |
| `DELETE /bots/:name` | optional `?force=1` | `200 BotDeleteResponse` | Capability 37. Deletes the Hermes profile and purges every gateway row the bot owned. `409` extension code `conflict` (body carries `turnId`) when a native turn is running, unless `force=1`. `404` when neither Hermes nor this gateway knows the name. Capability 49: answers for a gateway-owned runtime bot too, revoking its credential and enqueueing `delete_runtime`. |
| `GET /runners` | — | `{ runners: Runner[] }` | Capability 52. The paired computers that run bots, each with its name, reported platform and version, backends, `default` flag, `lastSeenAt` and live `online`. A gateway carrying the legacy shared `COZYGATEWAY_RUNNER_TOKEN` lists it as one row with id `legacy`. |
| `POST /runners/pair-code` | — | `{ setupCode, expiresAt, gatewayUrl }` | Capability 52. Mints a runner-kind pairing code from the app: the same 10 minute TTL and the same gateway-wide 10-per-60-seconds bucket the unauthenticated `/pair` route spends, so a `429` with `retry-after` is the answer when it is exhausted. `gatewayUrl` is the origin the new computer should dial, which is the LAN address when the listener is on a wildcard. Minting any code revokes every older unredeemed one. |
| `GET /runners/self` | — | `RunnerSelf` | Capability 52. Authenticated by the RUNNER's own bearer, not a device token, and the only route that credential opens. Answers `{id, name, platform, default, lastSeenAt, attached, renamed}` for that one runner; `attached` is whether it holds a live `/runner/v1` socket, which is a different question from whether the row exists. It also supplies legacy `online` equal to `attached` so released Agents updaters can verify their first upgrade. When the current authenticated hello supplied one, it also answers optional `agentVersion`; an offline durable roster value is never presented as proof that an update is running. `401 unauthorized` for a missing, unknown, or revoked token. Capability 55: `name` is the display name once a person has set one, exactly as `GET /runners` renders it, and `renamed` is true exactly then. |
| `PATCH /runners/:id` | `RunnerPatchRequest` | `{ runner: Runner }` | Capability 52. `{default: true}` moves the account default and clears the previous holder in the same transaction. `default: false` and the `legacy` id are `400 invalid_request`; an unknown id is `404 not_found`. Capability 55: `name` sets the display name (1 to 64 characters, counted in code points, after trimming, with no control or Unicode format character), or clears it back to the reported name on the literal `""` or `null` -- a whitespace-only string is refused, not treated as a clear; a body naming neither `default` nor `name`, or a `name` that fails validation, is `400 invalid_request` naming the field. `default` and `name` may be sent together. |
| `DELETE /runners/:id` | no body | `200 RunnerDeleteResponse` | Capability 52. Revokes that runner's token and closes its socket. `404 not_found` for an unknown id, exactly as `DELETE /devices/:id` answers. The `legacy` row is revoked by unsetting the environment variable and answers `400 invalid_request`. Capability 54: the body carries `botCount`, the runtime bots left on that computer, and `reassignedOperations` (with `reassignedTo` when there was a default) for the not-yet-sent work it re-addressed. Unsetting `COZYGATEWAY_RUNNER_TOKEN` is NOT this route and re-addresses nothing: a bot created on the legacy row keeps `runnerId: "legacy"`, and after the variable is unset its queued work is deliverable only in that its `delete_runtime` is then addressed to nobody and picked up by the account default. A deployment that pairs a real computer should do so before unsetting the variable, and treat those bots as bots to recreate. |
| `POST /bots/focus` | `BotFocusRequest` | `{ ok: true }` | Hints control-plane polling while roster/routines UI is visible. |
| `GET /bots/catalog` | optional `q` | `BotCatalog` | Hermes profile/catalog read. |
| `GET /bots/:name/profile` | — | `BotProfile` | Hermes profile read. Capability 57: for a runtime bot this is the peer's `profile.read` answer over the `bot_config` lane, and `guardrailLevel` rides along exactly as the peer sent it, absent for a Hermes bot and for a peer below 57. Capability 58: `guardrailCeiling` rides along the same way, read-only, absent for a Hermes bot and for a peer below 58. |
| `PATCH /bots/:name/profile` | `BotProfilePatch` | `BotProfileConfigureResponse` | Hermes profile update. Capability 57: `guardrailLevel` in the body is forwarded to a runtime bot's peer over the `bot_config` lane unchanged and is not acted on for a Hermes bot. Capability 58: `guardrailCeiling` is never accepted in the body; a body naming it is `400 invalid_request` naming the field. |
| `GET /bots/:name/model-config` | — | `BotModelConfig` | Hermes profile model read. |
| `PUT /bots/:name/model-config` | `BotModelConfigPatch` | `BotModelConfig` | Hermes profile model update. |
| `GET /bots/:name/model-providers` | — | `BotModelProviderSetupCatalog` | Capability 41 compatibility route. New clients use `com.cozylabs.harness-settings`. For a runtime bot, the `cozyagents` harness's read-only projection of the peer's `model.read`. |
| `PUT /bots/:name/model-providers/:provider/fields/:field` | `BotModelProviderFieldUpdate` | `BotModelProviderSetupCatalog` | Writes one field through Hermes after re-validating that the field belongs to the provider. |
| `DELETE /bots/:name/model-providers/:provider/fields/:field` | — | `BotModelProviderSetupCatalog` | Clears one Hermes-owned provider field and returns refreshed state. |
| `POST /bots/:name/model-providers/:provider/oauth` | — | `BotModelProviderOAuthSession` | Starts a Hermes-hosted PKCE or device-code session. External CLI-only methods are rejected. |
| `GET /bots/:name/model-providers/:provider/oauth/:sessionId` | — | `BotModelProviderOAuthSession` | Polls Hermes' session; clients stop at `approved`, `expired`, or `error`. |
| `POST /bots/:name/model-providers/:provider/oauth/:sessionId/code` | `BotModelProviderOAuthCode` | `BotModelProviderOAuthSession` | Submits a PKCE authorization code to Hermes. |
| `DELETE /bots/:name/model-providers/:provider/oauth/:sessionId` | — | `204 No Content` | Cancels the Hermes OAuth session. |
| `GET /bots/:name/readiness` | — | `BotReadiness` | Capability 40. Reports `starting` until the configured attach identity is online, then `ready`. |
| `GET /bots/:name/chat` | — | `{ name, sessionId, adoption: "created" \| "pin" }` | Resolves the selected native chat. |
| `GET /bots/:name/chat/messages` | — | `{ name, sessionId, adoption, messages, running, inflight, updatedAt, suggestion?, toolSteps? }` | Reads native transcript and native tool history. |
| `POST /bots/:name/chat/messages` | `BotChatSendRequest` | `202 { name, sessionId, message: BotChatMessage }` | Admits a native turn or steer, then appends locally. |
| `POST /bots/:name/chat/messages/displayed` | `BotChatDisplayedRequest` | `202 BotChatDisplayedResponse` | Capability 31. Records that this device displayed those rows. |
| `POST /bots/:name/chat/photos` | multipart `file`, `BotChatPhotoFields` | `202 { name, sessionId, message: BotChatMessage }` | One validated image plus optional caption. |
| `POST /bots/:name/chat/attachments` | multipart `file`, `BotChatAttachmentFields` | `202 { name, sessionId, message: BotChatMessage }` | One validated PDF, text, RTF, Office, or OpenDocument file plus optional caption. |
| `POST /bots/:name/chat/stop` | — | `BotChatStopResponse` | Interrupts the current native turn; returns 409 when idle. |
| `POST /bots/:name/chat/reset` | — | `BotChatResetResponse` | Selects a fresh native chat and emits reset. |
| `GET /bots/:name/chat/attachments/:fileId` | optional single `Range` | attachment bytes | Gateway-owned attachment only. |
| `GET /bots/:name/media` | `src` query | proxied media bytes | HTTPS URL proxy; not an attachment lookup. |
| `GET /bots/:name/sessions` | — | `BotSessionsResponse` | Gateway-owned native sessions. |
| `POST /bots/:name/sessions/new` | — | `BotNewSessionResponse` | Fresh native chat, previous history retained. |
| `POST /bots/:name/sessions/:id/adopt` | — | `BotSessionAdoptResponse` | Selects an owned native session. |
| `DELETE /bots/:name/sessions/:id` | — | `204 No Content` | Capability 60. Deletes only an owned, inactive, non-selected native direct session. |
| `GET /bots/:name/routines` | — | `BotRoutineListResponse` | Hermes routine read. |
| `POST /bots/:name/routines` | `BotRoutineCreateRequest` | `BotRoutineWriteResponse` | Hermes routine create. |
| `PATCH /bots/:name/routines/:id` | `BotRoutinePatch` | `BotRoutineWriteResponse` | Hermes routine update. |
| `DELETE /bots/:name/routines/:id` | — | `{ id }` | Hermes routine delete. |
| `POST /bots/:name/routines/:id/run` | — | `BotRoutineRunResponse` | Capability 53, RUNTIME BOTS ONLY. Sends `routines.run` over the existing capability-48 `bot_config` lane so a person or a check can force the routine to fire now. `409 unsupported_for_runtime` for a Hermes bot or for a runtime bot whose peer did not negotiate `bot_config`, `404 not_found` for a routine id this bot's namespace does not have, `503 backend_unavailable` for an offline peer. |
| `GET /bots/groups` | — | `{ groups: BotGroup[] }` | Gateway-owned rooms. |
| `POST /bots/groups` | `BotGroupCreateRequest` | `201 { group: BotGroup }` | Creates a gateway-owned room. |
| `GET /bots/groups/:group` | — | `BotGroupDetail` | Reads a gateway-owned room. |
| `DELETE /bots/groups/:group` | — | `204 No Content` | Deletes a gateway-owned room. |
| `POST /bots/groups/:group/messages` | `BotGroupSendRequest` | `202 { group, message: BotGroupMessage }` | Queues member turns through attach-v1. |
| `POST /bots/:name/approvals/:toolCallId/approve` | — | `202 { status: "requested" }` | Durably requests a native approval; the terminal event confirms it. |
| `POST /bots/:name/approvals/:toolCallId/deny` | — | `202 { status: "requested" }` | Durably requests a native denial; the terminal event confirms it. |
| `GET /bots/approvals` | optional `state=pending` | `BotInteractionRecovery` | Bounded pending approvals/clarifications plus confirmed terminal receipts. |
| `POST /bots/:name/clarifications/:clarifyId` | `BotClarifyResolveRequest` | `202 { outcome: "requested" }` | Durably requests a clarification option; the terminal event confirms it. |
| `GET /bots/:name/memory` | — | `BotMemoryOverviewResponse` | Profile-local source health/capabilities only; the gateway never opens Hermes files or provider storage. |
| `PATCH /bots/:name/memory/setup` | `BotMemorySetupRequest` | `BotMemoryOverviewResponse` | Applies the three credential-free Hermes settings through the attached profile and returns a fresh authoritative projection. |
| `GET /bots/:name/memory/items` | bounded `q`, `source`, `kind`, `since`, `until`, `cursor`, `limit` | `BotMemoryItemsResponse` | Stable, source-labelled page (at most 100). One unavailable source is reported in `sources` without hiding healthy results. |
| `GET /bots/:name/memory/graph` | bounded `q`, `source`, `since`, `until`, `limit` | `BotMemoryGraphResponse` | At most 200 nodes / 400 Holographic entity or vault wikilink edges. |
| `GET /bots/:name/memory/sources/:source/items/:id` | — | `BotMemoryItem` | Full bounded content for one source-native item. |
| `POST /bots/:name/memory/sources/:source/items` | `BotMemoryWriteRequest` | `201 BotMemoryWriteResponse` | Native source create. |
| `PATCH /bots/:name/memory/sources/:source/items/:id` | `BotMemoryWriteRequest` with `expectedRevision` | `BotMemoryWriteResponse` | Conditional native source edit; stale data is `409 conflict` with `current` when available. |
| `DELETE /bots/:name/memory/sources/:source/items/:id` | `BotMemoryDeleteRequest` | `BotMemoryDeleteResponse` | Conditional native source delete; stale data is `409 conflict`. |
| `GET /bots/:name/history` | optional `since`, `limit` | `BotHistoryListResponse` | Capability 50, runtime bots only. The Changes list: one row per checkpoint, newest first, at most 200. `since` is a millisecond wall-clock bound in the same unit `at` reports. |
| `GET /bots/:name/history/:checkpoint/diff` | optional `to` | `BotHistoryDiffResponse` | Capability 50, runtime bots only. Per-file line counts for that checkpoint; `to` absent compares against the working version. Never a patch, never file content. |
| `POST /bots/:name/history/restore` | `BotHistoryRestoreRequest` | `BotHistoryRestoreResponse` | Capability 50, runtime bots only. Undo, and "go back to". Writes a NEW checkpoint doing the restoring, so undo is itself undoable; the answer names that new checkpoint and the one it restored from. |
| `POST /bots/:name/history/try` | `BotHistoryTryRequest` | `BotHistoryTryStartResponse`, `BotHistoryTryKeepResponse`, or `BotHistoryTryDiscardResponse` | Capability 50, runtime bots only. One route, three actions. `start` requires `label` and answers `{tryId, base}`; `keep` answers `{merged: true}` or `409` extension code `conflict` carrying `conflicts`; `discard` answers `{kept: false}`. A `label` on `keep` or `discard` is `400`. |
| `POST /bots/:name/history/resolve` | `BotHistoryResolveRequest` | `BotHistoryResolveResponse` | Capability 50, runtime bots only. The person's per-file answer to that one `409`: `ours` is the bot's experiment, `theirs` the change that landed meanwhile. |

`BotRoutine.lastDeliveryError` is optional read-only capability-4 enrichment from Hermes'
`last_delivery_error`. The gateway flattens control characters, limits it to 512 characters, and
redacts POSIX, Windows drive, UNC, and home-relative paths before it reaches a response or
`bot_routines` frame. It is not a create/patch field and is never carried into a replacement job.
`bot_routines` remains a full-replacement snapshot, so a later row without the field clears an
older displayed delivery failure.

Memory uses the attached plugin's `memory_management` attach-v1 capability and request id, not
Dashboard file routes. `MemoryItem.timestampKind` is `created` for provider/native explicit dates,
`fileCreated` for a vault filesystem birth time, `firstObserved` for a curated legacy entry tracked
by the plugin-side sidecar, and `unknown` otherwise. Absolute vault roots never cross this boundary.
Memory content never rides a websocket frame, push, heartbeat, telemetry, or trace record.

`MemoryItem.kind` is one of `memory`, `profile`, `fact`, `note`: `profile` is the curated About-me
store, which the plugin's own store calls `user`; that store-side name is not a wire value. Every
memory route spends a per-device token budget and answers `429 rate_limited` with `retryAfterMs`
when it is empty, reads included: the attached plugin serves one memory request at a time, and a
second request arriving while one is in flight is answered `unavailable` rather than queued.

`BotMemoryOverviewResponse.setupAvailable` and `BotMemoryItemsResponse.setupAvailable` are the
GATEWAY's own optional booleans, not the plugin's: `true` exactly when the attached peer negotiated
`memory_setup`, so a client knows `PATCH /bots/:name/memory/setup` is offered for this bot without
probing it with a mutation, and an absent field means this deployment observed nothing. It is a
fact about the peer and not about the memory: a bot that already reports sources still carries
`true`, which is what lets a settings screen exist next to a non-empty memory rather than only on a
first-run empty one.

Capability 42 setup additionally negotiates `memory_setup`. Its closed request requires
`memoryEnabled`, `userProfileEnabled`, and `holographicEnabled`, all booleans, with at least one
true. The plugin changes only `memory.memory_enabled`, `memory.user_profile_enabled`, and the
Holographic selection. Disabling Holographic preserves any different provider. It writes through
Hermes' native atomic config writer, re-reads effective configuration, and returns `sources()`;
requested values are never echoed as proof. The mutation is replay-safe by request id. Old plugins,
offline profiles, failed writes, and unconfirmed state return bounded display-safe errors. No
memory content, secret, provider configuration, or host path is logged, traced, pushed, or returned.

An unavailable attach-v1 identity is a `503 backend_unavailable` on native chat actions. A profile
that exists but is not configured as a native identity must not fall through to Dashboard chat.

### Pairing a runner (capability 52)

`POST /pair` is the core contract's unauthenticated pairing route and is unchanged for a device.
With `kind: "runner"` it consumes a runner-kind setup code (minted by `cozygateway pair --kind
runner`) and answers `RunnerPairResponse`: `{runnerToken, runner, gateway}`. `deviceName` carries
the runner's name, so the request stays additive and a client below 52 never sends `kind` and pairs
a device exactly as it always did. `deviceName` is required for a device pair and optional for a
runner pair, checked at the route rather than in the schema.

A code minted for a runner and presented as a device, or the reverse, answers the existing `401
setup_code_invalid` with the existing message: a wrong-kind code is indistinguishable from an
expired one. The 4 KiB body cap, the 10-attempts-per-60-seconds bucket, the 10-minute TTL and
single use are unchanged and apply identically to both kinds.

The runner token authenticates `/runner/v1` and `GET /runners/self` and nothing else. It cannot read
chats, list devices or create bots, and `DELETE /runners/:id` revokes it, after which both answer as
though it had never existed.

A code is minted either at a terminal with `cozygateway pair --kind runner` or from the app with
`POST /runners/pair-code`, which is device-authenticated and spends the same bucket. Both write the
same row, so a code from either place pairs the same way.

### A gateway with no Hermes endpoint (capability 52)

`hermesEndpoints` is optional from 52. A gateway configured without one starts, serves `/bots` and
`/runners` from its own runtime-bot rows, and advertises `com.cozylabs.bots`. The two
Hermes-shaped capabilities beside it (`com.cozylabs.hermes-desktop-sessions`,
`com.cozylabs.mobile-node`) are not advertised, because there is genuinely no Dashboard behind
them. `com.cozylabs.harness-settings` is advertised unconditionally: its `cozyagents` harness
answers from runtime bots' config lanes, one read-only scope per runtime bot, with or without
Hermes. `/health` and `/ready` report `bridges: {"hermes": "absent"}`
and `/ready` answers `200`: there is no bridge to alarm on or de-route from, and restarting the
process would fix nothing.

## Interactive Hermes session continuation

`com.cozylabs.hermes-desktop-sessions: 4` is deliberately separate from Bot Mode. It exposes
source-qualified Desktop, TUI, and CLI sessions without placing their raw Hermes ids in native
session history:

| Route | Response | Rule |
| --- | --- | --- |
| `GET /bots/:name/desktop-sessions` | `{ name, source: "hermes_desktop", sessions }` | Lists Hermes `source: "desktop"`, `"tui"`, or `"cli"` conversation rows for that exact profile. Each row carries its exact `origin`, `hermesSessionId`, timestamps, optional sanitized `title`, and optional `lastResumedAt`; no preview, transcript, tool row, media, host path, or private Dashboard metadata is exposed. |
| `POST /bots/:name/desktop-sessions/:hermesSessionId/resume` | `202 BotDesktopHermesResumeResponse` | Exact manual adoption. Normally waits briefly for a positive plugin confirmation and answers `status: "resumed"` + a distinct gateway `sessionId`; a bounded timeout answers `status: "pending"` with no session id. |

The request re-lists the profile's eligible desktop rows, stages a new gateway-owned session id,
and imports the selected `session.resume` snapshot through the existing rendered-role, compaction,
media-directive, and path-redaction filters. Imported row ids are source-qualified and idempotent.
The staged chat is not selected until the attached profile confirms it switched its stable attach
lane to the exact profile-local Hermes target. A confirmation mismatch, a running lane, a foreign
profile, a cron/routine/group/machine row, an unavailable capability, or any unproven switch fails
closed. Normal subsequent sends keep the gateway session id as `threadId`; the plugin holds the
private raw Hermes mapping and strict runner metadata proves it still targets that same context.

Version 2 additionally permits the attached profile, after negotiated `desktop_session_sync`, to
project a newly observed rendered `user` or `assistant` SessionDB row into its already-owned native
chat. The row carries the source-qualified current raw id and stable row id; an interactive row also
carries the original selected Hermes id and is accepted only when that exact persisted resume
binding is confirmed. Replays are idempotent, and this projection never selects a chat or changes a
turn state. Capability 3 broadens that exact proof from TUI to Desktop, TUI, and CLI origins.

Capability 4 makes the gateway authoritative for the active interactive conversation. Before a
canonical chat read or send, it compares the selected gateway conversation's latest real message
timestamp with the newest source-qualified Desktop, TUI, or CLI row, using `lastActiveAt`, then
`startedAt`, then opaque id as deterministic tie-breakers. A newer external row is selected only
after the same exact plugin resume proof described above. A running native turn is never redirected.
An empty, newly allocated gateway placeholder has no conversational activity and cannot outrank an
existing external conversation merely because it was created later.

If the selected gateway session already binds to the newest external row, the gateway keeps that
session id. It may privately re-prove the plugin mapping after an attach process restart, but that
no-op confirmation MUST NOT emit `bot_chat_adopted`. A capability-4 client therefore MUST NOT run
its own automatic desktop-session picker or present a continuation banner during chat opening; the
ordinary canonical history response is already the latest proven session. Discovery and the exact
manual route remain available for administration and compatibility.

## Server frames

All frames travel on the existing authenticated `/ws` and are members of the closed core
`ServerFrame` union. `updatedAt`, message timestamps, and tool timestamps are milliseconds.

- `bot_roster`: complete `BotSummary[]` control-plane roster snapshot. It is the same overlay
  `GET /bots` returns, rows and fields alike: `chatSessionId` carries the bot's real native chat
  session, so a client can join a `bot_chat_delta`, `bot_chat_state`, or `bot_tool_activity` frame
  to the roster row it belongs to.
- `bot_presence`: complete active profile-name set.
- `bot_chat`: native transcript delta. `messages` contains only newly committed rows.
- `bot_chat_state`: current native-turn phase: `polling`, `complete`, `timeout`, or `failed`.
  Capability 23 additionally carries exact `status`: `queued`, `executing`, `using_tools`,
  `awaiting_input`, `completed`, `failed`, `interrupted`, `timed_out`, or `connectivity_lost`.
  `cause` distinguishes absent/degraded/lost attach transport and cancellation; `queuedAt` is the
  durable outbox admission time. The existing gateway turn-timeout bound starts at `queuedAt`; on
  expiry the gateway discards an unacknowledged command or queues an interrupt for an acknowledged
  one, then projects `timed_out`.
- `bot_chat_delta`: full accumulated assistant draft for one native turn. `seq` is monotonic within
  `turnId`; `done` ends that draft. Clients may drop drafts and rely on committed `bot_chat` rows.
  Capability 46: when `room` is present the draft belongs to that room's member turn rather than to
  a 1:1 chat, and `sessionId` is the gateway-owned group thread rather than a chat session.
- `bot_chat_reset`: a reset selected a fresh native session. Rebind and reload its history.
- `bot_chat_adopted`: a new/adopt action selected an existing native session. Rebind and reload.
- `bot_tool_activity`: full-replace steps for a native turn. `BotToolStep.detail` and `errorText`
  are bounded/redacted display text; raw inputs and outputs never cross this contract.
- `bot_delegation_activity` (capability 34): full-replace children of one native turn's
  `delegate_task` batch. Identity is (`batchId`, `childId`); `seq` is monotonic within one
  (`turnId`, `batchId`) and `done` marks the batch fully settled. `label` is bounded display
  text and `currentTool` is a tool NAME; child args, results, reasoning, summaries, prompts,
  and paths never cross this contract. A batch may outlive its turn (async dispatch), so frames
  legitimately arrive after the turn sealed; a restart with a child in flight settles it
  `unknown` -- never `failed`. Active and past batches also ride chat history as the optional
  `delegations` array, so reconnect does not erase a live card, and `batchId` keys client
  reconciliation with the terminal "[ASYNC DELEGATION BATCH COMPLETE ...]" transcript row.
  When the attach plugin learns the canonical Hermes delegation id (`deleg_...`) from the
  structured `delegation_id` field of the parent `delegate_task` result, the snapshot frame
  and each history batch carry it as an optional batch-level `aliasId`. Identity stays
  (`batchId`, `childId`); a client whose exact-`batchId` reconciliation of that completion
  row fails falls back to matching the row's `deleg_...` id against `aliasId`. The alias
  typically appears from the batch's terminal legs onward (async spawn legs precede the tool
  result) and may be absent entirely under an older Hermes. Additive under capability 34: a
  below-capability or alias-unaware client ignores it.
  Hermes v0.21 synchronous parent results may also enrich a terminal child with `costUsd` and the
  closed `costStatus` (`estimated`, `reported`, or `unknown`), `schemaValidation` (`valid` plus at
  most one retry), and `durationMs`. These values are optional: absence means unavailable, an older
  result, or a background delegation, while `schemaValidation.valid: false` is an explicit failed
  verdict. They persist in the same child row and therefore survive reconnect/restart after receipt.
  Raw summaries, schema errors, token counts, tool traces, output, arguments, results, and paths are
  never serialized. Identity remains (`batchId`, `childId`); structured result rows join only by
  their explicit `task_index` to the existing spawn index.
- `bot_thinking_activity` (capability 35): latest-only sanitized preview of the bot's live
  reasoning for one native turn, shown in the thinking shimmer. `text` is a tail-truncated
  <=280-char display string (schema-enforced); `seq` is monotonic within `turnId` and a
  lower-or-equal frame is stale. EPHEMERAL BY DESIGN: never persisted, never in chat history,
  gone on reopen, and no frame follows the turn's terminal. This is a conscious, bounded
  reopening of the old "no reasoning on the wire" rule: the preview crosses, the chain of
  thought does not -- tool args, results, prompts, credentials, and file paths never appear.
  NOT pushed, ever.
- `bot_approval_pending`, `bot_approval_resolution_requested`, and `bot_approval_resolved`:
  durable native tool-approval lifecycle. The requested frame means outbox admission only; a
  terminal frame is emitted solely from the later plugin terminal event (or local expiry).
- `bot_clarify_pending`, `bot_clarify_resolution_requested`, and `bot_clarify_resolved`: durable
  native clarification lifecycle. A
  pending card contains only a display prompt and bounded option ids/labels, never model reasoning.
  Capability 51: `bot_clarify_pending` and `bot_clarify_resolved` may carry `room`, as the approval
  pair already could, when the clarification was raised by a room member turn.
- `bot_group`, `bot_group_state`: durable gateway-owned group-room transcript and state.
  Capability 51: `bot_group_state` may carry `pendingInteractions`, the same optional pointer array
  `BotGroup` carries, and a frame is emitted when one opens and when one settles so a client can
  badge the room without re-reading it.

Frames are independently safe to drop where their schema says they are deltas or snapshots.
Committed transcript history remains the recovery source after reconnect.

## Error and privacy rules

- Capability 45. `BotSummary.runtime` names which runtime serves the bot. It is optional and
  absent means Hermes, so every existing row is unchanged; the only other value is `"cozyagents"`,
  a config-declared bot served by a non-Hermes attach peer whose row is built from gateway config
  and attach presence rather than the Dashboard. Chat, readiness, approvals, and clarifications
  work for such a bot exactly as they do for a Hermes-backed one, and since capability 46 so do
  rooms: see the capability-46 note below. Roster
  `stale` is a fact about the Hermes control plane only; it says nothing about a runtime bot, whose
  row is always current because it is built from local config and live attach presence.
- Capability 46. A runtime bot is a full room member. `POST /bots/groups` naming one succeeds:
  room membership is resolved against gateway config as well as `profiles.list`, so a bot the
  roster is listing is never refused as "not a bot on this gateway", and a room whose members are
  all runtime bots is created and run without the Hermes Dashboard being consulted at all. The
  member turn is unchanged in every other respect: the same attach-v1 `turn` command on the same
  gateway-owned `group:<room>:<member>` thread, the same rounds, the same transcript. A member's
  display name and handle in the room come from its roster row, which for a runtime bot is the
  config-declared one. A room turn's live draft is published as `bot_chat_delta` with `room` set to
  the room name, `bot` set to the member, and `sessionId` set to that group thread: it is live text,
  never history, and a client that does not know the field renders nothing new. Every room bubble
  the gateway opens it also closes, with one final `bot_chat_delta` carrying `room`, an empty
  `text`, and `done: true`, at whichever settlement the turn reaches: a reply, a failure, a
  cancellation, an interrupt, the gateway's own turn timeout, or a drive abandoned because the room
  was deleted or superseded. A turn that never streamed opens no bubble and gets no frames at all.
  A draft that reads as the protocol's own pass is never published, matching the rule that keeps
  `(pass)` out of the transcript; drafts are coalesced latest-only inside a 100 ms window, and every
  frame carries the whole accumulated text, so a dropped one costs a reader nothing. Tool, thinking,
  and delegation activity inside a room turn is deliberately not projected in this version; tool
  activity arrives in capability 51 below, thinking and delegation still do not.
- Capability 51. A ROOM member turn can now ask. Below 51 a room acknowledged and dropped a
  member's `approval`, `clarify` and `tool` events, which is why a runtime peer had to run room
  turns with read-only tools: a bot that cannot ask for permission must never need it.
  An approval or clarification raised by a RUNTIME member's room turn is recorded in the same
  durable interaction record a 1:1 chat writes, keyed by the member bot and the attach id, with
  `sessionId` set to the gateway-owned `group:<room>:<member>` thread and `turnId` set to the room
  member turn. It therefore appears in `GET /bots/approvals` beside every other pending item,
  carrying the room name as the optional `room` field, and `POST
  /bots/:member/approvals/:id/approve|deny` and `POST /bots/:member/clarifications/:id` resolve it
  with no new route, no changed request or response shape, and the same `resolve_approval` /
  `resolve_clarify` command the gateway has always sent the peer. The
  `bot_approval_pending`/`bot_approval_resolved` and `bot_clarify_pending`/`bot_clarify_resolved`
  frames carry `room` so the card can be rendered above the right transcript. A room interaction
  carrying an `expiresAt` runs on the same deadline the 1:1 lane arms, so it expires on its own
  clock rather than waiting for anything; and one still pending when its member turn seals is
  EXPIRED by that turn's settlement, with the terminal frame the 1:1 lane emits. Either way a card
  that would resolve into a turn that is over is closed rather than left tappable.
  Tool events on a member turn project as `bot_tool_activity` carrying `room`, `bot` set to the
  member and `sessionId` set to the member thread: the 1:1 card shape, with `name` and `status`
  only. A room is where several bots and a human read each other's activity, so the projection
  stays at the narrowest useful thing and does NOT carry the 1:1 card's bounded `detail`; arguments
  and results were never on this wire. It is EPHEMERAL: never persisted, never in any history, and
  sealed by one final `done: true` frame at whichever settlement the turn reaches, exactly like the
  live draft. Thinking and delegation activity in a room stay unprojected.
  The room TRANSCRIPT gains nothing. A pending interaction is live state, so it rides `BotGroup`
  and `bot_group_state` as the optional `pendingInteractions` array: one pointer per blocked
  member, carrying `member`, `kind`, the resolution `id`, and the room `turnId`, and nothing a
  reader could mistake for the request itself. It is absent when there are none.
  HERMES MEMBERS ARE UNCHANGED. Only a member whose bot is a capability-45 runtime bot projects any
  of this; a Hermes-backed member's room turn drops these events exactly as it did below 51,
  acknowledged and unprojected, because the Hermes plugin has never been asked to raise one inside
  a room and a half-projected lane is worse than none.
- Capability 51, consequence for the CozyAgents peer. The read-only rule CozyAgents applies to room
  turns exists only because this gateway had no way to carry a question out of a room: a peer that
  cannot ask for approval must not run a tool that would need it, so wave-2 Track P-B restricted
  room turns to tools that never ask. That reason is gone. A room turn now reaches the same
  approval and clarification surface a 1:1 turn reaches, through the same commands, so the peer MAY
  lift the restriction and run a room turn with its ordinary toolset. The change belongs to
  CozyAgents and is not made here; this gateway only guarantees the lane. Two facts the peer should
  hold onto when it does: a room member turn is SERIAL within its room, so a turn blocked on a human
  holds the room's whole deliberation until it settles or the gateway's turn timeout seals it, and a
  pending interaction is expired when its turn seals, so a peer must not sit on an unanswered
  question past its own turn.
- Capability 48. A runtime bot's profile, model-config and routines routes are served by its own
  peer over the attach-v1 `bot_config` lane (see `contract/attach-v1.md`), so they answer normally
  rather than 409. Nothing about their request or response shape changes: the peer implements the
  same published schemas the Hermes-backed bot does. A peer that did not negotiate `bot_config`
  keeps the 409 on those routes, because the section is genuinely absent rather than temporarily
  unreachable, and a peer that is simply offline answers `503 backend_unavailable`.
- Capability 48. `GET /bots/:name/profile` and `GET /bots/:name/model-config` on a runtime bot
  answer `404 not_found` when the peer serves the bot but has nothing stored for that section (a
  bot brought up before its profile was written, or one that pins no model). The message says the
  bot has no stored profile or model config; it does NOT say the bot is missing, because it is not:
  the bot is on the roster and its chat lane works, and a client must keep the row and show the
  section as empty rather than dropping the bot. This is deliberately distinguished from `503
  backend_unavailable`, which is the answer when the peer is offline or unreachable and a retry is
  the right thing to offer. A write, a routines list, or a routines create that the peer refuses
  stays a `503`; a routine id that names nothing is the ordinary `404` about that routine.
- A Dashboard-backed surface asked about a bot whose `runtime` is not Hermes answers `409` with
  extension code `unsupported_for_runtime`. The body is the core `ErrorBody` plus `runtime` (the
  bot's runtime) and `feature` (the surface method name, for example `botProfile` or `routines`).
  Since capability 48 this covers the desktop-session and delete surfaces and the bot-scoped
  model-provider writes; the profile, model-config, and routines surfaces answer over the config
  lane instead, the model-provider read answers the read-only `com.cozylabs.harness-settings`
  projection of that lane's `model.read`, and all of them fall back to this 409 when the peer did
  not negotiate `bot_config`. It is deliberately not a `404`: the bot exists and its chat lane works, so a client
  must hide or disable that section rather than treat the bot as missing.
- Native session ids, attach message ids, and attachment ids are opaque. Never infer a filesystem
  path, Hermes Dashboard id, or URL from them.
- Attachment and media validation rejects unsafe bytes, unsupported types, oversized bodies, and
  invalid ranges before those values enter a transcript.
- Tool detail, approval display names, clarification prompts/options, group notes, and the
  capability-35 thinking preview are presentation fields. Raw tool arguments, results, command
  text, and full model reasoning are not serialized; the thinking preview is a sanitized,
  bounded display tail, not the chain of thought.
- Provider credentials and authorization codes may appear only in the authenticated request body
  for the one write that consumes them. They never appear in URLs, process arguments, responses,
  logs, WebSocket frames, or gateway persistence. Provider reads expose only `isSet`; even Hermes'
  redacted suffix is discarded at the bridge.
- A client handles an unknown extension frame or optional field by ignoring it, then re-reads the
  documented REST state when it needs recovery.

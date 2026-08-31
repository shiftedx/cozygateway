# Hermes v0.21 enrichment implementation handoff

Use this handoff to implement the smallest truthful CozyGateway changes enabled by Hermes v0.21.0. Work only in CozyGateway. Do not inspect or modify the CozyLabs repository.

## Outcome

Improve four existing product surfaces without creating parallel systems:

1. enrich the existing delegation activity card where Hermes exposes stable structured data;
2. enrich the existing routines API where Hermes exposes stable cron fields;
3. compose a Bot Activity experience from existing roster, chat, routines, and room resources while removing the remaining transcript-prefix A2A classification; and
4. keep the existing Room surface as the group-collaboration implementation.

The finished change must remain easy to review: prefer deletion and extension of existing schemas/routes over new modules, endpoints, persistence, or dependencies.

## Read first

1. Read [the Hermes v0.21 assessment](../research/hermes-botmode-a2a-primary-research-2026-08-31.md) completely.
2. Read [ADR 0081](../adr/0081-delegation-identity-stays-local-until-hermes-exposes-it.md) and [ADR 0082](../adr/0082-agent-inbox-stays-hidden-until-hermes-proves-a2a-identity.md).
3. Read the current Bot Mode contract in [`contract/ext-bots-v1.md`](../../contract/ext-bots-v1.md), then follow its links to normative TypeBox schemas.
4. Inspect the current implementation before proposing code:
   - delegation: `integrations/attach-plugin/cozygateway/adapter.py`, `packages/gateway/src/hermes-bridge/native-data-plane.ts`, and `packages/contract/src/ext-bots.ts`;
   - routines: `packages/gateway/src/hermes-bridge/routines.ts` and its routes/tests;
   - roster activity: `packages/gateway/src/hermes-bridge/roster.ts` and its tests;
   - rooms: `packages/gateway/src/hermes-bridge/group-rooms.ts`, `group-protocol.ts`, routes, storage, and tests.

## Non-negotiable boundaries

1. Apply ponytail in full for the entire task:
   - ask whether each change needs to exist;
   - reuse an existing contract, route, event, store, and test seam before adding one;
   - use platform/stdlib/current dependencies before adding a dependency;
   - do not introduce repositories, factories, managers, adapters, feature flags, compatibility branches, or duplicated projections without concrete evidence that the existing seam cannot carry the feature;
   - delete dead or misleading behavior instead of preserving it as a fallback;
   - never simplify authentication, authorization, privacy, persistence integrity, or bounded/redacted payload rules.
2. Do not enable the Hermes A2A plugin. Enabling it creates a new network and trust boundary and is not required for these four slices.
3. Do not advertise or restore `com.cozylabs.agent-inbox`. Do not add delivered/read/reply-to claims. Do not infer bot-to-bot identity from transcript text.
4. Preserve ADR 0081 identity: `(batchId, childId)` remains canonical and `aliasId` remains an optional result-derived alias until Hermes lifecycle hooks expose stable delegation identity.
5. Do not copy Hermes Desktop conversations into a second database or invent a new replay model.
6. Do not create a second room model, protocol, route family, screen concept, or persistence layer. Gateway-owned rooms remain authoritative for CozyGateway clients.
7. There is no app UI source in this repository. Produce Gateway contract/runtime changes and a precise client handoff; do not cross into another repository without explicit user authorization.

## Agent routing

The implementation driver owns architecture, scope control, final integration, and acceptance. It must delegate independent investigation or implementation packets to subagents under the repository's `AGENTS.md` policy.

Use this minimum routing unless the inspected diff proves a packet unnecessary:

1. Assign one read-only subagent to prove the Hermes v0.21 delegation and cron source surfaces. It must return exact upstream files/fields, live response or hook samples from disposable profiles where practical, and a supported/unsupported table. No transcript scraping is acceptable evidence.
2. Assign one subagent ownership of delegation-only code/tests if the proof gate passes.
3. Assign one subagent ownership of routines-only code/tests and the roster-classifier deletion. These files must not overlap the delegation packet.
4. Keep room verification, contract coherence, final integration, and whole-repo testing with the driver unless another non-overlapping packet is useful.

Every subagent packet must name allowed files, state that other agents share the worktree, forbid reverting others' edits, define exact tests, and return changed files, diff summary, test output, and blockers. The driver must inspect every resulting diff before accepting it.

## Execution

### 1. Establish the evidence table

Compare the installed Hermes v0.21.0 source and disposable live responses against the four current Gateway surfaces. Record a compact table in the implementation PR description or a new research note only if it contains durable facts not already captured in the existing assessment.

For each candidate field or action, record:

- its stable structured source;
- whether it survives restart;
- its identity/join key;
- its privacy/redaction bound;
- the existing CozyGateway seam that can carry it; and
- `implement`, `already present`, or `blocked`.

Do not add code for a candidate whose source is undocumented text, a Desktop renderer-only store, an internal file path, a process-memory-only inference presented as durable, or a hook that cannot be joined safely.

Completion criteria:

- [ ] Every proposed field/action has a structured source and an existing destination seam.
- [ ] Unsupported candidates are explicitly marked blocked and produce no speculative code.
- [ ] The evidence confirms whether delegation list/steer/stop, cost, structured-output validation, routine notepad/memory, monitor suppression, and result routing are actually available to the Gateway.

### 2. Enrich delegation activity, only where proven

The current baseline already provides capability 34: live and reconnectable delegation batches, bounded child labels/tool names, status/progress counts, stall state, and optional canonical alias. Extend those existing shapes and the existing attach event only for newly proven v0.21 structured values.

Priority order:

1. structured child cost;
2. structured-output validation state;
3. stable progress fields missing from the current card;
4. list, steer, or stop actions only if Hermes exposes a documented, authenticated, unambiguous command surface for the exact live child/batch.

If an action is not provable, keep existing parent-turn steer/stop behavior and document the blocked child action. Never simulate child steering by sending chat text and never address a child by parsing transcript prose or filesystem state.

Use the current `bot_delegation_activity` frame and chat-history `delegations` array. A new endpoint or capability is justified only when an action cannot fit an existing authenticated Bot Mode route without ambiguity. Any additive wire change must update the normative schema, contract history, exports, conformance expectations, runtime projection, reconnect history, and focused tests together.

Completion criteria:

- [ ] Existing `(batchId, childId)` identity and optional `aliasId` behavior are unchanged.
- [ ] Added values are bounded/redacted and survive frame reordering/reconnect as documented.
- [ ] Unsupported control actions are absent, not disabled-looking fiction.
- [ ] Focused tests cover live projection, reconnect/history, terminal settlement, restart honesty, and authorization for any new action.

### 3. Enrich routines through the existing cron surface

The current API already supports list/create/update/delete, pause/resume, next/last run, last status, repeat limits, continuity, and Bot Chat delivery through the existing routine wrapper. Do not rebuild those features.

Add only stable v0.21 cron fields that the evidence table proves and that materially improve a long-running monitor. Candidate value, in order:

1. durable notepad or memory reference;
2. explicit monitor/change-detection state;
3. explicit suppression reason and latest meaningful result;
4. stable owning Bot Chat/result reference;
5. per-run model/effort only when Hermes can apply both atomically rather than merely store inert selections.

Map reads and writes in `routines.ts`; reuse the existing routine routes and `bot_routines` full-replace frame. Preserve the current safe rewrite transaction and honest `replacedId`/`orphanedId` behavior. Do not parse prompts to recover state, create a second scheduler, or persist a shadow copy of Hermes cron jobs.

Completion criteria:

- [ ] Existing routine operations and continuity behavior remain intact.
- [ ] Every new field round-trips through Hermes rather than through Gateway-only shadow state.
- [ ] A missing field from an older/live response is represented as absent, not synthesized.
- [ ] Tests cover mapping, create/patch carry-over, backend refusal, and full-replace frames.

### 4. Replace “Agent Inbox” thinking with Bot Activity composition

Do not create a Bot Activity aggregate endpoint. The existing resources already provide the composition:

- `GET /bots` and `bot_roster`: identity, display metadata, activity, preview, and canonical chat session;
- `bot_presence`: active-now state;
- bot profile/model endpoints: role/specialization and provider/model detail;
- routines endpoints/frame: owned routines;
- `/bots/groups`: group membership and room activity;
- canonical Bot Chat/session/history routes: the conversation surface.

Delete the remaining roster behavior that recognizes `Message from ...` with a regular expression and emits `preview.kind = "a2a"` plus an inferred sender. An ordinary transcript preview must remain ordinary display text. Update the schema, gateway implementation, tests, contract prose, and capability version/history as required by the repository's extension rules; do not leave a legacy enum member or compatibility parser behind.

Create a short client-facing section in the contract or implementation handoff that tells the app to join these existing resources into a Bot Activity screen. It may show source-labelled activity and link to canonical chats/rooms. It must not claim delivery, read, reply, immutable history, or verified agent-to-agent provenance.

Completion criteria:

- [ ] No runtime regex/classifier labels transcript text as A2A or derives a sender from it.
- [ ] The reserved Agent Inbox capability remains dormant and unadvertised.
- [ ] No new aggregate route, activity database, or duplicate transcript exists.
- [ ] Roster previews still render ordinary/empty states and their tests cover a forged `Message from ...` prefix as plain text.

### 5. Keep Room collaboration on the existing surface

Item 4 already exists in CozyGateway. The current implementation has durable server-side named rooms, 2–6 validated members, up to three rounds/ten replies per send, `@member`/`@everyone`/`@user` routing, room-local ordered logs, running/settled/needs-you state, authenticated CRUD/send routes, WebSocket deltas, restart persistence, and cross-device behavior.

Therefore make no new Gateway room implementation. Verify the existing surface against Hermes v0.21 behavior and fix only a demonstrated mismatch in the existing files. Hermes Desktop rooms remain a separate Desktop-owned surface until Hermes publishes a stable, authorized read/write/replay API; do not replace Gateway rooms with renderer internals.

The client handoff must say: extend the existing Room view; do not add a second collaboration view. The smallest useful UI enrichment is to render the state and notes the Gateway already sends, expose mention/intervention through the existing composer, and link participating bots to their canonical Bot Chats.

Completion criteria:

- [ ] Existing room routes/frames remain the sole CozyGateway room contract.
- [ ] Persistence, mention routing, round/message caps, superseding user sends, and member-failure behavior remain covered by tests.
- [ ] Any zero-code conclusion is recorded as intentional reuse, not unfinished work.

### 6. Review, validate, and deliver

Before committing, run the narrow tests for every touched area, then run:

```sh
pnpm check
pnpm test:installer
python -m pytest integrations/attach-plugin/tests
git diff --check
```

If a platform-specific test cannot run on the current host, state the exact command and reason; do not substitute an unrelated test count. Keep commits independently reviewable and named by product slice. Do not mix generated artifacts, local Hermes state, backups, credentials, or unrelated worktree changes into the branch.

Final completion criteria:

- [ ] The diff contains no CozyLabs paths or edits.
- [ ] No new dependency was added unless the PR demonstrates why current code/stdlib cannot do the job.
- [ ] No legacy fallback, dual path, transcript parser, or speculative abstraction was added.
- [ ] Contract, conformance, runtime, integration plugin, tests, and docs agree for every changed wire value.
- [ ] Full validation is green, or the handoff reports the exact failing command and root cause.
- [ ] The final report separates shipped changes, intentional reuse, and upstream-blocked options.

## Expected final shape

The likely lean result is deliberately uneven:

- delegation: a few additive fields/actions if the upstream proof passes, otherwise no speculative controls;
- routines: a few native field mappings if the cron proof passes, otherwise retain the already-complete surface;
- Bot Activity: removal of the misleading transcript-prefix A2A classifier plus client composition guidance, not a new backend;
- rooms: verification and reuse of the existing implementation, normally zero new room code.

That is success. The goal is not four new subsystems; it is four clearer, more capable product surfaces with less misleading code.

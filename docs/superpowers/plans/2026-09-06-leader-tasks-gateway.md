# Leader Assignments (gateway slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A leader bot can assign one bounded piece of work to a named report bot over the gateway, the report answers it as an ordinary attach-v1 turn, and the leader (and the paired phone) can read the durable state, result and thread.

**Architecture:** An assignment is a gateway-owned record that wraps one existing capability-64 Task. The assignee's turn is queued on a gateway-owned thread `assignment:<id>`, so `Tasks.admit` creates the Task and every state, wait, absence, cancel and retry rule in `tasks.ts` applies unchanged. A thin `AssignmentRooms` orchestrator owns the turn hand-off, the deadline, the `Result:` block, the leader acknowledgement, the inbox reads and the `bot_inbox_activity` frame. Role and reports are gateway-owned (`bot_team`), merged into the profile read and stripped from the profile patch before it is forwarded, so Hermes and CozyAgents bots get them identically.

**Tech Stack:** TypeScript (Node 24, ESM, `.ts` imports), Hono, `node:sqlite` `DatabaseSync`, TypeBox schemas in `cozygateway-contract`, vitest 3, pnpm workspaces.

**Spec:** `/Users/kmcdowell/Documents/repos/worktrees/cozychat-features/docs/superpowers/specs/2026-09-06-leader-bot-design.md` (repo cozychat). This plan implements its slice 1: "Contract and gateway task store".

## Global Constraints

- Vocabulary is **leader** and **team**. Never CEO, never council, in code, copy, docs or tests.
- `role?: "leader" | "member"` (absent means member) and `reports?: string[]` (bot names, 0..16, leader only) on the profile read and patch.
- Only a leader may assign, and only to a bot in its `reports`. A subordinate cannot assign. No nested delegation in v1.
- Caps: at most **8** open assignments per leader, **1** open assignment per assignee across all leaders, `reports` at most **16**.
- Deadline default **30 min**, maximum **4 h**. `verifying` auto-completes after **24 h**. The assignee's turn timeout is the assignment deadline, not the room's 180 s.
- Typed refusals: `not_leader`, `not_a_report`, `assignee_busy`, `assignee_unavailable`, `leader_task_cap`, `not_verifying`.
- The peer lane authenticates with the assigning bot's attach bearer. No device token is involved in bot-to-bot calls.
- `AGENT_INBOX_CAPABILITY_VERSION = 1` on the existing `com.cozylabs.agent-inbox` id, advertised whenever the assignment store is present, never inferred from the bots scalar. `BOTS_CAPABILITY_VERSION` moves **69 → 70** for the additive `TurnContext.task` field and the two profile fields.
- `TurnContext` rule from capability 47 holds: the turn `text` is byte-identical with and without `context`.
- The assignee's reply ends with a `Result:` block listing `status (done | partial | blocked)`, what changed, and artifacts as paths or links. Its absence is recorded, never invented.
- Hermes bots can be assignees with zero plugin changes. A Hermes profile cannot be a leader in v1 (nothing on the Hermes side can call the assign route); the gateway still stores `role` for it so the app can say so honestly.
- Nothing ships without Kyle. This slice lands behind the capability gate and is releasable on its own.
- Every test file runs green under `pnpm -r test`; `pnpm -r typecheck` is clean.

## Deviations from the spec, decided by reading the code

The spec was written from a seams report that predates capability 64. Three of its choices collide with what already ships and are adapted here; the behaviour Kyle approved is unchanged.

1. **No `bot_tasks` trio.** The gateway already has durable Tasks (`packages/gateway/src/tasks.ts`, tables `tasks`, `task_runs`, `task_events`, …) with ten states and 45 reasons. Creating a parallel state machine would give two answers for one Run. An assignment therefore *wraps* a Task: the assignment turn is admitted exactly like a room member turn, and the nine assignment states the spec lists are **derived** from the Task view plus the assignment's own facts (deadline, acknowledgement, cancel). The mapping is in Task 3.
2. **Route names.** `GET /bots/:name/tasks` already exists (capability 64, lists Tasks by bot) and `GET /tasks/:taskId` already reads one. The spec's `POST /bots/:name/tasks` would shadow that surface. The peer and device routes are `/bots/:name/assignments`, `/assignments/:assignmentId`, `/assignments/:assignmentId/cancel`, `/assignments/:assignmentId/acknowledge`, plus `POST /bots/tasks/:taskId/acknowledge`, the same acknowledgement addressed by the Task id the CozyAgents `task_status` tool already holds. The Task view stays reachable through `GET /tasks/:taskId` via the assignment's `taskId`. The two inbox routes keep the spec's paths.
3. **Role and reports are stored by the gateway**, in `bot_team`, not forwarded to the peer. Hermes has no profile field for them and a CozyAgents peer would only echo them back; the gateway is the one enforcing them, so it owns them. A patch that carries only `role`/`reports` succeeds without touching the peer.

## File structure

| File | Responsibility |
| --- | --- |
| `packages/contract/src/ext-bots.ts` (modify) | `AGENT_INBOX_CAPABILITY_VERSION`, `BOTS_CAPABILITY_VERSION = 70`, `role`/`reports` on profile schemas, capability history rows. |
| `packages/contract/src/assignments.ts` (create) | Assignment request/view/state/refusal/inbox schemas and the `bot_inbox_activity` frame. |
| `packages/contract/src/ws.ts` (modify) | Add `BotInboxActivityFrameSchema` to `ServerFrameSchema`. |
| `packages/contract/src/index.ts` (modify) | `export * from "./assignments.ts"`. |
| `packages/gateway/src/adapters/attach/protocol-v1.ts` (modify) | `TurnContext.task` optional sibling to `room`. |
| `packages/gateway/src/storage.ts` (modify) | Tables `bot_team`, `bot_assignments`, `bot_assignment_log`, `bot_assignment_turns`; row types and methods. |
| `packages/gateway/src/tasks.ts` (modify) | `admit` learns the bot from `bot_assignments.thread_id`. |
| `packages/gateway/src/hermes-bridge/assignment-protocol.ts` (create) | Pure rules: caps, prompt builder, `Result:` parser, state derivation, refusal reasons. |
| `packages/gateway/src/hermes-bridge/assignments.ts` (create) | `AssignmentRooms`: assign, attach-event hooks, deadline poll, reconcile, cancel, acknowledge, inbox reads, frame emission. |
| `packages/gateway/src/hermes-bridge/group-turn.ts` (modify) | Widen `settledGroupTurn`'s parameter so an assignment turn row reuses it. |
| `packages/gateway/src/assignment-routes.ts` (create) | Peer and device routes, typed refusals, inbox routes. |
| `packages/gateway/src/hermes-bridge/routes.ts` (modify) | Profile GET merges `bot_team`; profile PATCH accepts `role`/`reports`, stores them, forwards the rest. |
| `packages/gateway/src/http.ts` (modify) | Register assignment routes with `requireDevice`, `requireAttach`, `attachAgent`. |
| `packages/gateway/src/server.ts` (modify) | Construct `AssignmentRooms`, hook attach events, advertise agent-inbox 1, start the sweeper. |
| `contract/ext-bots-v1.md`, `CHANGELOG.md` (modify) | Capability rows 70 and agent-inbox 1, routes table, changelog entry. |
| Tests | `packages/contract/test/{ext-bots,assignments}.test.ts`, `packages/gateway/test/{assignment-storage,assignment-protocol,assignments,assignment-routes,bots-profile-team,assignments-e2e}.test.ts`. |

Run commands (from the repo root `/Users/kmcdowell/Documents/repos/worktrees/cozygateway-council`):

```bash
pnpm --filter cozygateway-contract test test/ext-bots.test.ts     # one contract file
pnpm --filter cozygateway test test/assignments.test.ts            # one gateway file
pnpm -r typecheck && pnpm -r test                                  # the gate before every commit
```

Commit with the trailer every commit in this session carries:

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017mHmbfQXHqy8eAiQdtXhvr
```

---

### Task 1: Contract constants, profile fields, assignment schemas, turn context

**Files:**
- Modify: `packages/contract/src/ext-bots.ts:1304-1358` (`BotProfileSchema`, `BotProfilePatchSchema`), `:2231-2235` (`AGENT_INBOX_CAPABILITY_ID`), `:2878` (`BOTS_CAPABILITY_VERSION`), and the capability history comment block that ends with the `69` row (search for the literal `` `69` `` inside the block comment above `BOTS_CAPABILITY_VERSION`).
- Create: `packages/contract/src/assignments.ts`
- Modify: `packages/contract/src/ws.ts:264-300` (`ServerFrameSchema`), `packages/contract/src/index.ts`
- Modify: `packages/gateway/src/adapters/attach/protocol-v1.ts:155-171` (`TurnContext`)
- Test: `packages/contract/test/ext-bots.test.ts:816,927`, create `packages/contract/test/assignments.test.ts`, `packages/gateway/test/attach-v1-protocol.test.ts`

**Interfaces:**
- Produces (contract, all exported from `cozygateway-contract`):
  - `AGENT_INBOX_CAPABILITY_VERSION = 1`, `BOTS_CAPABILITY_VERSION = 70`
  - `BotTeamRoleSchema = Type.Union([Type.Literal("leader"), Type.Literal("member")])`, type `BotTeamRole`
  - `BotProfileSchema` gains `role: Type.Optional(BotTeamRoleSchema)`, `reports: Type.Optional(Type.Array(NameItem, { maxItems: 16 }))`; `BotProfilePatchSchema` gains the same two.
  - `ASSIGNMENT_STATES = ["queued","running","waiting_for_approval","waiting_for_user_input","blocked","verifying","completed","failed","cancelled"] as const`, `AssignmentStateSchema`, type `AssignmentState`
  - `ASSIGNMENT_REFUSALS = ["not_leader","not_a_report","assignee_busy","assignee_unavailable","leader_task_cap","not_verifying"] as const`, `AssignmentRefusalSchema`, type `AssignmentRefusal`
  - `AssignmentCreateRequestSchema = Type.Object({ to: Id, brief: Type.String({minLength:1,maxLength:8192}), doneCriteria: Type.String({minLength:1,maxLength:4096}), outputFormat: Type.Optional(Type.String({maxLength:2048})), deadlineMs: Type.Optional(Type.Integer({minimum:60_000, maximum:14_400_000})) })`
  - `AssignmentResultSchema = Type.Object({ status: Type.Union([Type.Literal("done"),Type.Literal("partial"),Type.Literal("blocked")]), summary: Type.String({maxLength:4096}), artifacts: Type.Array(Type.String({minLength:1,maxLength:1024}), {maxItems:32}) })`
  - `AssignmentViewSchema = Type.Object({ assignmentId: Id, leader: Id, assignee: Id, brief, doneCriteria, outputFormat?: , deadlineAt: At, createdAt: At, updatedAt: At, state: AssignmentStateSchema, threadId: Id, taskId: Type.Optional(Id), result: Type.Optional(AssignmentResultSchema), finalText: Type.Optional(Type.String({maxLength:65536})), failure: Type.Optional(Type.String({maxLength:1024})), cancelledBy: Type.Optional(Type.Union([Type.Literal("leader"),Type.Literal("user")])), acknowledgedAt: Type.Optional(At) })`, type `AssignmentView`
  - `AssignmentCreateResponseSchema = Type.Object({ assignmentId: Id, threadId: Id, taskId: Type.Optional(Id), state: AssignmentStateSchema })`
  - `AssignmentRefusalBodySchema = Type.Object({ error: Type.Object({ code: Type.Literal("assignment_refused"), message: Type.String() }), reason: AssignmentRefusalSchema })`
  - `AssignmentAcknowledgeRequestSchema = Type.Object({ outcome: Type.Union([Type.Literal("completed"),Type.Literal("failed")]) })`
  - `AssignmentAcknowledgeResponseSchema = Type.Object({ state: AssignmentStateSchema, assignmentId: Id, taskId: Id })`
  - `AssignmentCancelRequestSchema = Type.Object({ reason: Type.Optional(Type.String({maxLength:1024})) })`
  - `AssignmentListSchema = Type.Object({ assignments: Type.Array(AssignmentViewSchema) })`
  - `BotInboxThreadSchema = Type.Object({ id: Id, peers: Type.Array(Id,{minItems:2,maxItems:2}), startedAt: At, lastActiveAt: At, preview: Type.String({maxLength:280}), messageCount: Type.Integer({minimum:0}) })`, `BotInboxResponseSchema = Type.Object({ threads: Type.Array(BotInboxThreadSchema) })`, `BotInboxMessagesResponseSchema = Type.Object({ messages: Type.Array(BotGroupMessageSchema) })`
  - `BotInboxActivityFrameSchema = Type.Object({ type: Type.Literal("bot_inbox_activity"), bot: Id, threadId: Id, updatedAt: At, assignmentId: Id, state: AssignmentStateSchema })`, type `BotInboxActivityFrame`. The three fields the dormant iOS decoder requires are `bot`, `threadId`, `updatedAt` (`CozyKit/Sources/CozyGateway/GatewayFrames.swift:845-848`); the other two are additive.
- Produces (gateway): `AttachV1TurnContext.task?: { id: string; assignedBy: string; brief: string; doneCriteria: string; outputFormat?: string; deadlineAt: number }` and `TurnContext.room` becomes optional (an assignment turn has no room).

`Id` and `At` are the local aliases `tasks.ts` already uses (`Type.String({minLength:1,maxLength:256})` and `Type.Integer({minimum:0})`); copy their definitions into `assignments.ts` rather than exporting them.

- [ ] **Step 1: Write the failing contract tests**

Append to `packages/contract/test/ext-bots.test.ts` inside the existing capability `describe` (near line 927):

```ts
  it("advertises agent-inbox 1 beside bots 70", () => {
    expect(BOTS_CAPABILITY_VERSION).toBe(70);
    expect(AGENT_INBOX_CAPABILITY_VERSION).toBe(1);
  });
  it("accepts role and reports on the profile read and patch, bounded at 16", () => {
    const base = { name: "lead", description: "", soul: "", skills: [], toolsets: [], toolsetsPinned: false, mcpServers: [], model: { provider: "p", default: "m" }, runtimeInert: [] };
    expect(check(BotProfileSchema, { ...base, role: "leader", reports: ["a", "b"] })).toBe(true);
    expect(check(BotProfileSchema, { ...base, role: "ceo" })).toBe(false);
    expect(check(BotProfilePatchSchema, { role: "leader", reports: Array.from({ length: 16 }, (_, i) => `r${i}`) })).toBe(true);
    expect(check(BotProfilePatchSchema, { reports: Array.from({ length: 17 }, (_, i) => `r${i}`) })).toBe(false);
    expect(check(BotProfilePatchSchema, { reports: [" "] })).toBe(false);
  });
```

Add `AGENT_INBOX_CAPABILITY_VERSION`, `BotProfileSchema`, `BotProfilePatchSchema`, `check` to that file's import list if absent (the file already imports from `../src/index.ts`).

Create `packages/contract/test/assignments.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_REFUSALS, ASSIGNMENT_STATES, AssignmentAcknowledgeResponseSchema, AssignmentCreateRequestSchema, AssignmentRefusalBodySchema,
  AssignmentResultSchema, AssignmentViewSchema, BotInboxActivityFrameSchema, BotInboxThreadSchema,
  ServerFrameSchema, check,
} from "../src/index.ts";

describe("agent-inbox 1 assignment boundary", () => {
  it("declares nine closed states and five closed refusals", () => {
    expect(ASSIGNMENT_STATES).toHaveLength(9);
    expect(ASSIGNMENT_STATES).not.toContain("in_progress");
    expect(check(AssignmentAcknowledgeResponseSchema, { state: "completed", assignmentId: "a1", taskId: "t1" })).toBe(true);
    expect(ASSIGNMENT_REFUSALS).toEqual(["not_leader", "not_a_report", "assignee_busy", "assignee_unavailable", "leader_task_cap", "not_verifying"]);
  });
  it("bounds the create request: deadline between 1 minute and 4 hours", () => {
    const body = { to: "scout", brief: "Check CI", doneCriteria: "CI is green on main" };
    expect(check(AssignmentCreateRequestSchema, body)).toBe(true);
    expect(check(AssignmentCreateRequestSchema, { ...body, deadlineMs: 59_999 })).toBe(false);
    expect(check(AssignmentCreateRequestSchema, { ...body, deadlineMs: 14_400_001 })).toBe(false);
    expect(check(AssignmentCreateRequestSchema, { ...body, brief: "" })).toBe(false);
  });
  it("round-trips a view with and without a result", () => {
    const view = { assignmentId: "a1", leader: "lead", assignee: "scout", brief: "Check CI", doneCriteria: "green", deadlineAt: 10, createdAt: 1, updatedAt: 2, state: "queued", threadId: "assignment:a1" };
    expect(check(AssignmentViewSchema, view)).toBe(true);
    expect(check(AssignmentViewSchema, { ...view, state: "verifying", taskId: "t1", result: { status: "done", summary: "green", artifacts: ["ci/log.txt"] } })).toBe(true);
    expect(check(AssignmentResultSchema, { status: "unsure", summary: "", artifacts: [] })).toBe(false);
  });
  it("types the refusal body and the inbox activity frame, which the ws union carries", () => {
    expect(check(AssignmentRefusalBodySchema, { error: { code: "assignment_refused", message: "x" }, reason: "not_leader" })).toBe(true);
    expect(check(AssignmentRefusalBodySchema, { error: { code: "assignment_refused", message: "x" }, reason: "busy" })).toBe(false);
    const frame = { type: "bot_inbox_activity", bot: "lead", threadId: "assignment:a1", updatedAt: 5, assignmentId: "a1", state: "running" };
    expect(check(BotInboxActivityFrameSchema, frame)).toBe(true);
    expect(check(ServerFrameSchema, frame)).toBe(true);
    expect(check(BotInboxThreadSchema, { id: "assignment:a1", peers: ["lead", "scout"], startedAt: 1, lastActiveAt: 2, preview: "Check CI", messageCount: 2 })).toBe(true);
  });
});
```

Add to `packages/gateway/test/attach-v1-protocol.test.ts` (it already imports `check` and the command schemas; add `AttachV1CommandFrameSchema` if the file uses a different name, match what is there):

```ts
  it("carries an optional task context beside room, with text byte-identical either way", () => {
    const turn = { kind: "turn", threadId: "assignment:a1", turnId: "run", messageId: "run:assignment", text: "[Task from lead] Check CI" };
    const withTask = { ...turn, context: { actors: [], task: { id: "a1", assignedBy: "lead", brief: "Check CI", doneCriteria: "green", deadlineAt: 10 } } };
    expect(check(AttachV1CommandSchema, turn)).toBe(true);
    expect(check(AttachV1CommandSchema, withTask)).toBe(true);
    expect(check(AttachV1CommandSchema, { ...withTask, context: { ...withTask.context, task: { ...withTask.context.task, deadlineAt: -1 } } })).toBe(false);
    expect(withTask.text).toBe(turn.text);
  });
```

Use the exported name for the command-frame schema that `protocol-v1.ts` actually exports (grep `export const AttachV1Command`); if only the frame schema is exported, wrap the command as `{ kind: "command", sequence: 1, commandId: "c", command: turn }` and validate that.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter cozygateway-contract test test/ext-bots.test.ts test/assignments.test.ts && pnpm --filter cozygateway test test/attach-v1-protocol.test.ts`
Expected: FAIL. `AGENT_INBOX_CAPABILITY_VERSION` is not exported; `assignments.ts` does not exist; `BOTS_CAPABILITY_VERSION` is 69; the task context is refused by `additionalProperties: false`.

- [ ] **Step 3: Implement the contract changes**

In `packages/contract/src/ext-bots.ts`:

```ts
// beside NameItem (line ~1349)
export const BotTeamRoleSchema = Type.Union([Type.Literal("leader"), Type.Literal("member")]);
export type BotTeamRole = Static<typeof BotTeamRoleSchema>;
```

Add to `BotProfileSchema` (after `guardrailCeiling`) and to `BotProfilePatchSchema` (after `guardrailLevel`), with a doc comment on each:

```ts
  /** Capability 70. Gateway-owned team role. Absent means member. Stored by the gateway, never
   *  forwarded to the peer, because the gateway is what enforces it. */
  role: Type.Optional(BotTeamRoleSchema),
  /** Capability 70. The bots this leader may assign work to, at most 16 names. Refused with
   *  `invalid_request` on a member profile and for a name that is not a bot on this gateway. */
  reports: Type.Optional(Type.Array(NameItem, { maxItems: 16 })),
```

`NameItem` is declared after `BotProfileSchema` today; move the `const NameItem` line above `BotProfileSchema` so both can use it.

Replace the agent-inbox comment and add the version:

```ts
/** The A2A assignment seam. Version 1 is the leader assignment surface: `/bots/:name/assignments`,
 * `/assignments/:id`, and the reinstated `GET /bots/:name/inbox` routes, all backed by gateway-owned
 * rows rather than the withdrawn Hermes heuristic (ADR 0082). Separate from `com.cozylabs.bots`
 * because no later value of that scalar may be read as support for withdrawn capability 17. */
export const AGENT_INBOX_CAPABILITY_ID = "com.cozylabs.agent-inbox";
export const AGENT_INBOX_CAPABILITY_VERSION = 1;
```

Add a `70` row to the capability history block immediately after the `69` row, in the same ` *  - \`NN\`:` style:

```
 *  - `70`: TEAM ROLES AND THE ASSIGNMENT TURN CONTEXT. `BotProfile` and `BotProfilePatch` gain
 *    optional `role` (`leader` | `member`) and `reports` (≤ 16 bot names), stored by the gateway
 *    and merged into the read; a patch carrying only these two touches no peer. Attach-v1
 *    `TurnContext` gains an optional `task` sibling to `room` naming the assignment, its leader,
 *    brief, done criteria and deadline; `text` is byte-identical with and without it, exactly as
 *    47 promised for `room`. The assignment surface itself is advertised on
 *    `com.cozylabs.agent-inbox`, never inferred from this scalar. Additive.
```

Set `export const BOTS_CAPABILITY_VERSION = 70;`.

Create `packages/contract/src/assignments.ts` with the schemas listed in Interfaces. Import `BotGroupMessageSchema` from `./ext-bots.ts`. Doc-comment the file header: "Capability com.cozylabs.agent-inbox 1. An assignment wraps one capability-64 Task; its `state` is derived, never written."

In `packages/contract/src/ws.ts` import `BotInboxActivityFrameSchema` from `./assignments.ts` and add it to `ServerFrameSchema` after `BotGroupStateFrameSchema`. In `index.ts` add `export * from "./assignments.ts";` after the tasks line.

In `packages/gateway/src/adapters/attach/protocol-v1.ts` change `TurnContext`:

```ts
const TurnTask = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  assignedBy: Type.String({ minLength: 1, maxLength: 128 }),
  brief: Type.String({ minLength: 1, maxLength: 8192 }),
  doneCriteria: Type.String({ minLength: 1, maxLength: 4096 }),
  outputFormat: Type.Optional(Type.String({ maxLength: 2048 })),
  deadlineAt: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
const TurnContext = Type.Object({
  /** Present on ROOM turns. Absent on an assignment turn, which has no room. */
  room: Type.Optional(Type.Object({ /* unchanged body */ }, { additionalProperties: false })),
  actors: Type.Array(TurnActor, { maxItems: 8 }),
  cause: Type.Optional(/* unchanged */),
  /** Capability 70. Present on ASSIGNMENT turns only. Decoration in the capability-47 sense. */
  task: Type.Optional(TurnTask),
}, { additionalProperties: false });
```

Update the doc comment above `TurnContext` ("Sent on ROOM turns only" → "Sent on room and assignment turns"). Grep the gateway for `context.room.` accesses (`group-rooms.ts` builds it; nothing reads `.room` on the gateway side) and the `turnContext(` helper in `group-rooms.ts` still returns a room, so no caller changes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter cozygateway-contract test test/ext-bots.test.ts test/assignments.test.ts test/ws.test.ts && pnpm --filter cozygateway test test/attach-v1-protocol.test.ts && pnpm -r typecheck`
Expected: PASS. If `ws.test.ts` pins the number of server frame variants, update that count by one.

- [ ] **Step 5: Commit**

```bash
git add packages/contract/src packages/contract/test packages/gateway/src/adapters/attach/protocol-v1.ts packages/gateway/test/attach-v1-protocol.test.ts
git commit -m "contract: team roles, assignment schemas, agent-inbox 1, bots 70"
```

---

### Task 2: Storage tables, row types, and Task admission for assignment threads

**Files:**
- Modify: `packages/gateway/src/storage.ts` (SCHEMA string after the `bot_group_turns` index at `:433`; row interfaces near `:1004-1060`; methods after `pendingBotGroupTurns` at `:2672`)
- Modify: `packages/gateway/src/tasks.ts:344-361` (`admit`)
- Test: create `packages/gateway/test/assignment-storage.test.ts`

**Interfaces:**
- Produces (storage.ts exports):

```ts
export interface BotTeamRow { bot: string; role: "leader" | "member"; reports: string[]; updatedAt: number }
export interface BotAssignmentRow {
  assignmentId: string; leader: string; assignee: string; threadId: string;
  brief: string; doneCriteria: string; outputFormat?: string; deadlineAt: number;
  createdAt: number; updatedAt: number;
  taskId?: string;
  resultJson?: string; finalText?: string; failure?: string;
  cancelledBy?: "leader" | "user"; acknowledgedAt?: number; acknowledgedOutcome?: "completed" | "failed";
}
export interface BotAssignmentLogRow { seq: number; kind: "user" | "member"; name: string; displayName: string; text: string; at: number; messageId: string; turnId?: string }
export interface BotAssignmentTurnRow {
  assignmentId: string; turnId: string; agentId: string; threadId: string; messageId: string;
  state: "pending" | "commit" | "failed" | "cancelled" | "interrupted" | "timeout";
  text?: string; detail?: string; createdAt: number; completedAt?: number; consumedAt?: number;
}
// Storage methods
botTeam(bot: string): BotTeamRow | undefined
setBotTeam(row: { bot: string; role: "leader" | "member"; reports: string[]; updatedAt: number }): void
botTeamLeadersOf(report: string): string[]          // leaders whose reports include `report`
createBotAssignment(row: Omit<BotAssignmentRow, "updatedAt" | "taskId">): void   // threadId = `assignment:${assignmentId}`
botAssignment(assignmentId: string): BotAssignmentRow | undefined
botAssignmentByThread(threadId: string): BotAssignmentRow | undefined
botAssignmentByTask(taskId: string): BotAssignmentRow | undefined
botAssignments(filter: { leader?: string; assignee?: string; participant?: string }): BotAssignmentRow[]   // newest first
updateBotAssignment(assignmentId: string, patch: Partial<Pick<BotAssignmentRow, "taskId" | "resultJson" | "finalText" | "failure" | "cancelledBy" | "acknowledgedAt" | "acknowledgedOutcome">> & { updatedAt: number }): void
appendBotAssignmentMessage(assignmentId: string, entry: Omit<BotAssignmentLogRow, "seq">): BotAssignmentLogRow
botAssignmentLog(assignmentId: string): BotAssignmentLogRow[]
beginBotAssignmentTurn(turn: { assignmentId: string; turnId: string; agentId: string; threadId: string; messageId: string; createdAt: number }): boolean   // false when a pending turn exists
botAssignmentTurn(assignmentId: string, turnId: string): BotAssignmentTurnRow | undefined
botAssignmentTurnForAttach(agentId: string, threadId: string, turnId: string): BotAssignmentTurnRow | undefined
completeBotAssignmentTurn(agentId: string, threadId: string, turnId: string, state: Exclude<BotAssignmentTurnRow["state"], "pending" | "timeout">, text: string | undefined, detail: string | undefined, completedAt: number): BotAssignmentTurnRow | undefined
timeoutBotAssignmentTurn(assignmentId: string, turnId: string, detail: string, completedAt: number): void   // also tasks.nativeTerminal(assignee, threadId, turnId, "timed_out", completedAt)
pendingBotAssignmentTurns(): BotAssignmentTurnRow[]
```

- Produces (tasks.ts): `admit` resolves `bot` from `SELECT assignee AS bot FROM bot_assignments WHERE thread_id = ?` as a fourth source after `group`, `session`, `core`, so a Task is created for an assignment turn with `room` null.

- [ ] **Step 1: Write the failing storage tests**

Create `packages/gateway/test/assignment-storage.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { openStorage, type Storage } from "../src/storage.ts";

const storages: Storage[] = [];
afterEach(() => { for (const s of storages.splice(0)) s.close(); });
function open(): Storage { const s = openStorage(":memory:"); storages.push(s); return s; }

describe("bot_team", () => {
  it("stores role and reports per bot and answers who leads a report", () => {
    const s = open();
    s.setBotTeam({ bot: "lead", role: "leader", reports: ["scout", "sage"], updatedAt: 1 });
    s.setBotTeam({ bot: "boss", role: "leader", reports: ["sage"], updatedAt: 2 });
    expect(s.botTeam("lead")).toEqual({ bot: "lead", role: "leader", reports: ["scout", "sage"], updatedAt: 1 });
    expect(s.botTeam("scout")).toBeUndefined();
    expect(s.botTeamLeadersOf("sage").sort()).toEqual(["boss", "lead"]);
    s.setBotTeam({ bot: "lead", role: "member", reports: [], updatedAt: 3 });
    expect(s.botTeamLeadersOf("sage")).toEqual(["boss"]);
  });
});

describe("bot_assignments", () => {
  it("creates an assignment on a gateway-owned thread and admits its turn as a Task", () => {
    const s = open();
    s.tasks.clock(() => 0);
    s.createBotAssignment({ assignmentId: "a1", leader: "lead", assignee: "scout", threadId: "assignment:a1", brief: "Check CI", doneCriteria: "green", deadlineAt: 1_800_000, createdAt: 1 });
    expect(s.botAssignmentByThread("assignment:a1")?.assignee).toBe("scout");
    expect(s.beginBotAssignmentTurn({ assignmentId: "a1", turnId: "run", agentId: "scout", threadId: "assignment:a1", messageId: "run:assignment", createdAt: 2 })).toBe(true);
    expect(s.beginBotAssignmentTurn({ assignmentId: "a1", turnId: "run2", agentId: "scout", threadId: "assignment:a1", messageId: "run2:assignment", createdAt: 3 })).toBe(false);
    s.enqueueAttachCommand("scout", "cmd", { kind: "turn", threadId: "assignment:a1", turnId: "run", messageId: "run:assignment", text: "[Task from lead] Check CI" }, 2);
    const task = s.tasks.list({ bot: "scout" })[0]!;
    expect(task).toMatchObject({ bot: "scout", sessionId: "assignment:a1", state: "queued", goal: "[Task from lead] Check CI" });
    expect(task.room).toBeUndefined();
  });
  it("settles a turn once, records the log, and times out through the Task", () => {
    const s = open();
    s.tasks.clock(() => 0);
    s.createBotAssignment({ assignmentId: "a1", leader: "lead", assignee: "scout", threadId: "assignment:a1", brief: "Check CI", doneCriteria: "green", deadlineAt: 100, createdAt: 1 });
    s.beginBotAssignmentTurn({ assignmentId: "a1", turnId: "run", agentId: "scout", threadId: "assignment:a1", messageId: "run:assignment", createdAt: 2 });
    expect(s.botAssignmentTurnForAttach("scout", "assignment:a1", "run")?.state).toBe("pending");
    expect(s.completeBotAssignmentTurn("scout", "assignment:a1", "run", "commit", "Done.\nResult:\nstatus: done", undefined, 5)?.state).toBe("commit");
    expect(s.completeBotAssignmentTurn("scout", "assignment:a1", "run", "failed", undefined, "late", 6)?.state).toBe("commit");
    const row = s.appendBotAssignmentMessage("a1", { kind: "member", name: "scout", displayName: "Scout", text: "Done.", at: 5, messageId: "m1", turnId: "run" });
    expect(row.seq).toBe(1);
    expect(s.botAssignmentLog("a1")).toHaveLength(1);
    s.updateBotAssignment("a1", { finalText: "Done.", taskId: "t1", updatedAt: 6 });
    expect(s.botAssignment("a1")?.finalText).toBe("Done.");
    expect(s.botAssignmentByTask("t1")?.assignmentId).toBe("a1");
  });
  it("lists newest first by leader, assignee, or either side", () => {
    const s = open();
    s.createBotAssignment({ assignmentId: "a1", leader: "lead", assignee: "scout", threadId: "assignment:a1", brief: "b", doneCriteria: "d", deadlineAt: 9, createdAt: 1 });
    s.createBotAssignment({ assignmentId: "a2", leader: "lead", assignee: "sage", threadId: "assignment:a2", brief: "b", doneCriteria: "d", deadlineAt: 9, createdAt: 2 });
    expect(s.botAssignments({ leader: "lead" }).map((a) => a.assignmentId)).toEqual(["a2", "a1"]);
    expect(s.botAssignments({ assignee: "sage" }).map((a) => a.assignmentId)).toEqual(["a2"]);
    expect(s.botAssignments({ participant: "scout" }).map((a) => a.assignmentId)).toEqual(["a1"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter cozygateway test test/assignment-storage.test.ts`
Expected: FAIL with `s.setBotTeam is not a function`.

- [ ] **Step 3: Add the schema, row types, and methods**

Append to `SCHEMA` in `storage.ts` after the `bot_group_turns_target` index:

```sql
-- Capability 70. Gateway-owned team role. Hermes has no field for it and a runtime peer would
-- only echo it back; the gateway enforces it, so the gateway owns it.
CREATE TABLE IF NOT EXISTS bot_team (
  bot TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('leader', 'member')),
  reports_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
-- Agent-inbox 1. One assignment wraps one capability-64 Task. The thread is gateway-owned
-- (`assignment:<id>`), which is what lets Tasks.admit find the assignee for the turn.
CREATE TABLE IF NOT EXISTS bot_assignments (
  assignment_id TEXT PRIMARY KEY,
  leader TEXT NOT NULL,
  assignee TEXT NOT NULL,
  thread_id TEXT NOT NULL UNIQUE,
  brief TEXT NOT NULL,
  done_criteria TEXT NOT NULL,
  output_format TEXT,
  deadline_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  task_id TEXT,
  result_json TEXT,
  final_text TEXT,
  failure TEXT,
  cancelled_by TEXT CHECK (cancelled_by IN ('leader', 'user')),
  acknowledged_at INTEGER,
  acknowledged_outcome TEXT CHECK (acknowledged_outcome IN ('completed', 'failed'))
) STRICT;
CREATE INDEX IF NOT EXISTS bot_assignments_leader ON bot_assignments(leader, created_at);
CREATE INDEX IF NOT EXISTS bot_assignments_assignee ON bot_assignments(assignee, created_at);
CREATE TABLE IF NOT EXISTS bot_assignment_log (
  assignment_id TEXT NOT NULL REFERENCES bot_assignments(assignment_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  from_kind TEXT NOT NULL,
  from_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  turn_id TEXT,
  PRIMARY KEY (assignment_id, seq)
) STRICT, WITHOUT ROWID;
-- Same lifecycle as bot_group_turns and, like it, no FK: a late terminal after a delete must
-- still be acknowledged rather than poison the peer's ordered inbox.
CREATE TABLE IF NOT EXISTS bot_assignment_turns (
  assignment_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  state TEXT NOT NULL,
  text TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  consumed_at INTEGER,
  PRIMARY KEY (assignment_id, turn_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS bot_assignment_turns_target ON bot_assignment_turns(agent_id, thread_id, turn_id);
```

Add the four row interfaces from Interfaces beside `BotGroupTurnRow`. Add the methods after `pendingBotGroupTurns`, modelled line for line on their `botGroup*` twins (`beginBotAssignmentTurn` uses `SAVEPOINT assignment_turn` and refuses when a `pending` row exists for the assignment; `completeBotAssignmentTurn` updates only `state = 'pending'`; `timeoutBotAssignmentTurn` wraps in `this.tasks.atomic` and calls `this.tasks.nativeTerminal(row.agentId, row.threadId, turnId, "timed_out", completedAt)` exactly as `timeoutBotGroupTurn` does). `appendBotAssignmentMessage` computes `seq` as `COALESCE(MAX(seq),0)+1` inside a savepoint. `botAssignments` orders by `created_at DESC, assignment_id DESC`; `participant` matches `leader = ? OR assignee = ?`. Map columns to camelCase in a `toBotAssignmentRow` helper; optional columns become absent keys, never `null`.

In `tasks.ts` `admit`, after the `core` lookup:

```ts
    const assignment = this.#db.prepare("SELECT assignee AS bot FROM bot_assignments WHERE thread_id = ?").get(command.threadId) as { bot: string } | undefined;
    const bot = group?.bot ?? session?.bot ?? core?.bot ?? assignment?.bot;
```

`Tasks` is constructed inside `new Storage(db)` after `db.exec(SCHEMA)` in `openStorage` (`storage.ts:5634-5638`), so the table exists before the first `admit`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter cozygateway test test/assignment-storage.test.ts test/durable-tasks.test.ts test/attach-v1-storage.test.ts && pnpm --filter cozygateway typecheck`
Expected: PASS, and the existing Task and storage suites unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/storage.ts packages/gateway/src/tasks.ts packages/gateway/test/assignment-storage.test.ts
git commit -m "gateway: bot_team and bot_assignments storage; assignment turns admit as Tasks"
```

---

### Task 3: Pure assignment rules

**Files:**
- Create: `packages/gateway/src/hermes-bridge/assignment-protocol.ts`
- Test: create `packages/gateway/test/assignment-protocol.test.ts`

**Interfaces:**
- Produces:

```ts
export const ASSIGNMENT_MAX_OPEN_PER_LEADER = 8;
export const ASSIGNMENT_MAX_REPORTS = 16;
export const ASSIGNMENT_DEFAULT_DEADLINE_MS = 30 * 60_000;
export const ASSIGNMENT_MAX_DEADLINE_MS = 4 * 60 * 60_000;
export const ASSIGNMENT_VERIFYING_AUTO_COMPLETE_MS = 24 * 60 * 60_000;
export const ASSIGNMENT_OPEN_STATES: ReadonlySet<AssignmentState>;   // everything but completed, failed, cancelled
export interface AssignmentBrief { id: string; leader: string; leaderDisplayName: string; brief: string; doneCriteria: string; outputFormat?: string; deadlineAt: number }
export function buildAssignmentPrompt(input: AssignmentBrief, formatDeadline: (at: number) => string): string;
export interface ParsedResult { status: "done" | "partial" | "blocked"; summary: string; artifacts: string[] }
export function parseResultBlock(text: string): ParsedResult | undefined;   // undefined when no `Result:` block; never invents one
export interface AssignmentFacts { deadlineAt: number; acknowledgedOutcome?: "completed" | "failed"; cancelledBy?: "leader" | "user"; failure?: string; taskState?: TaskState; taskAt?: number }
export function deriveAssignmentState(facts: AssignmentFacts, now: number): AssignmentState;
export function refusalMessage(reason: AssignmentRefusal, detail: { leader: string; assignee: string }): string;
```

Derivation, in priority order (first match wins):
1. `cancelledBy` set → `cancelled`.
2. `acknowledgedOutcome` set → that outcome.
3. `failure` set → `failed`.
4. `taskState` absent → `queued` (turn not yet admitted).
5. `taskState` terminal: `cancelled` → `cancelled`; `failed` → `failed`; `completed` → `verifying` unless `now - taskAt >= ASSIGNMENT_VERIFYING_AUTO_COMPLETE_MS` → `completed`.
6. `taskState` non-terminal and `now >= deadlineAt` → `failed` (the orchestrator records `failure: "deadline"` and cancels the Task; the derivation says `failed` regardless so a read never shows a live state past its deadline).
7. `taskState` `waiting_for_device` → `blocked`; every other non-terminal Task state maps to itself (`queued`, `running`, `waiting_for_approval`, `waiting_for_user_input`, `blocked`, `verifying`).

Prompt shape, exactly the spec's:

```
[Task from <leaderDisplayName>] <brief>
Done when: <doneCriteria>
Reply format: <outputFormat or "a short result followed by a `Result:` block">
Deadline: <formatDeadline(deadlineAt)>
End your reply with a `Result:` block listing status (done | partial | blocked), what changed, and any artifacts as paths or links.
```

`parseResultBlock`: find the last line that is exactly `Result:` (trimmed, case-sensitive); the block is every line after it. Within the block, `status:` (case-insensitive key) takes one of the three literals, else the block is invalid and the function returns `undefined`; `artifacts:` accepts a comma-separated list on the same line and/or `- ` bullet lines following it; `summary` is the remaining non-key lines joined with a space and trimmed, capped at 4096 characters; artifacts are trimmed, deduplicated, capped at 32 entries of ≤ 1024 characters.

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/test/assignment-protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_DEFAULT_DEADLINE_MS, ASSIGNMENT_MAX_OPEN_PER_LEADER, ASSIGNMENT_VERIFYING_AUTO_COMPLETE_MS,
  buildAssignmentPrompt, deriveAssignmentState, parseResultBlock, refusalMessage,
} from "../src/hermes-bridge/assignment-protocol.ts";

describe("assignment prompt", () => {
  it("reproduces the spec's five lines and never mentions a council", () => {
    const text = buildAssignmentPrompt({ id: "a1", leader: "lead", leaderDisplayName: "Lead", brief: "Check CI", doneCriteria: "main is green", deadlineAt: 10 }, () => "3:30 PM");
    expect(text.split("\n")).toEqual([
      "[Task from Lead] Check CI",
      "Done when: main is green",
      "Reply format: a short result followed by a `Result:` block",
      "Deadline: 3:30 PM",
      "End your reply with a `Result:` block listing status (done | partial | blocked), what changed, and any artifacts as paths or links.",
    ]);
    expect(text.toLowerCase()).not.toContain("council");
  });
  it("uses the leader's output format when given", () => {
    const text = buildAssignmentPrompt({ id: "a1", leader: "lead", leaderDisplayName: "Lead", brief: "b", doneCriteria: "d", outputFormat: "JSON", deadlineAt: 10 }, () => "x");
    expect(text).toContain("Reply format: JSON");
  });
});

describe("Result: block", () => {
  it("parses status, summary and artifacts from the last Result: block", () => {
    const parsed = parseResultBlock("I looked.\nResult:\nstatus: done\nCI is green on main.\nartifacts:\n- ci/log.txt\n- https://ci/run/9");
    expect(parsed).toEqual({ status: "done", summary: "CI is green on main.", artifacts: ["ci/log.txt", "https://ci/run/9"] });
  });
  it("returns undefined when there is no block or the status is not one of the three words", () => {
    expect(parseResultBlock("I looked and it is fine.")).toBeUndefined();
    expect(parseResultBlock("Result:\nstatus: finished")).toBeUndefined();
  });
  it("accepts an inline comma list, dedupes, and caps at 32", () => {
    const many = Array.from({ length: 40 }, (_, i) => `f${i}`).join(", ");
    const parsed = parseResultBlock(`Result:\nstatus: partial\nartifacts: a, a, ${many}`);
    expect(parsed?.artifacts).toHaveLength(32);
    expect(parsed?.artifacts[0]).toBe("a");
  });
});

describe("state derivation", () => {
  const base = { deadlineAt: 1_000 };
  it("is queued before admission and mirrors live Task states", () => {
    expect(deriveAssignmentState(base, 0)).toBe("queued");
    expect(deriveAssignmentState({ ...base, taskState: "running" }, 0)).toBe("running");
    expect(deriveAssignmentState({ ...base, taskState: "waiting_for_device" }, 0)).toBe("blocked");
  });
  it("verifies on Task completion until the leader acknowledges or 24 hours pass", () => {
    expect(deriveAssignmentState({ ...base, taskState: "completed", taskAt: 0 }, 5)).toBe("verifying");
    expect(deriveAssignmentState({ ...base, taskState: "completed", taskAt: 0 }, ASSIGNMENT_VERIFYING_AUTO_COMPLETE_MS)).toBe("completed");
    expect(deriveAssignmentState({ ...base, taskState: "completed", taskAt: 0, acknowledgedOutcome: "failed" }, 5)).toBe("failed");
  });
  it("fails past the deadline and cancels win over everything", () => {
    expect(deriveAssignmentState({ ...base, taskState: "running" }, 1_000)).toBe("failed");
    expect(deriveAssignmentState({ ...base, taskState: "running", cancelledBy: "leader" }, 1_000)).toBe("cancelled");
  });
  it("exports the caps the spec names", () => {
    expect(ASSIGNMENT_MAX_OPEN_PER_LEADER).toBe(8);
    expect(ASSIGNMENT_DEFAULT_DEADLINE_MS).toBe(30 * 60_000);
    expect(refusalMessage("not_a_report", { leader: "lead", assignee: "scout" })).toBe("scout is not on lead's team");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter cozygateway test test/assignment-protocol.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `assignment-protocol.ts`**

Write the module per Interfaces. Refusal messages, exactly:

| reason | message |
| --- | --- |
| `not_leader` | `` `${leader} is not a leader` `` |
| `not_a_report` | `` `${assignee} is not on ${leader}'s team` `` |
| `assignee_busy` | `` `${assignee} already has an open assignment` `` |
| `assignee_unavailable` | `` `${assignee} is not attached to this gateway` `` |
| `leader_task_cap` | `` `${leader} already has ${ASSIGNMENT_MAX_OPEN_PER_LEADER} open assignments` `` |
| `not_verifying` | `` `assignment for ${assignee} is not waiting on ${leader}'s acknowledgement` `` |

Import `AssignmentState`, `AssignmentRefusal` from `cozygateway-contract` and `TaskState` for `AssignmentFacts`. No I/O, no `Date.now()`; `now` is always a parameter.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter cozygateway test test/assignment-protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/hermes-bridge/assignment-protocol.ts packages/gateway/test/assignment-protocol.test.ts
git commit -m "gateway: pure assignment rules (prompt, Result: block, state derivation, caps)"
```

---

### Task 4: `AssignmentRooms` orchestrator

**Files:**
- Create: `packages/gateway/src/hermes-bridge/assignments.ts`
- Modify: `packages/gateway/src/hermes-bridge/group-turn.ts:64` (widen `settledGroupTurn(row: Pick<BotGroupTurnRow, "state" | "text" | "detail">)`)
- Test: create `packages/gateway/test/assignments.test.ts`

**Interfaces:**
- Consumes: Task 2 storage methods; Task 3 rules; `NativeGroupTurnEndpoint` from `group-turn.ts` (`canQueue`, `sendNativeTurn`); `Storage.tasks` (`read`, `command`, `nativeTerminal`, `atomic`); `blocksToText` from `../adapters/attach/blocks-to-text.ts`.
- Produces:

```ts
export class AssignmentRefused extends Error { constructor(readonly reason: AssignmentRefusal, message: string) }
export class AssignmentNotFound extends Error {}
export class AssignmentForbidden extends Error {}   // caller is neither leader nor assignee nor a device
export interface AssignmentRoomsOptions {
  storage: Storage;
  broadcast: (frame: ServerFrame) => void;
  now: () => number;
  memberInfo: (name: string) => { name: string; displayName: string };
  /** Fresh membership check, the same one rooms use at create. */
  missingMembers: (names: string[]) => Promise<string[]>;
  isAttached: (agentId: string) => boolean;
  formatDeadline?: (at: number) => string;     // default: new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  pollMs?: number;                            // default 50
  flushTaskCommands?: () => void;             // called after a Task cancel so the interrupt dispatches
}
export class AssignmentRooms {
  constructor(opts: AssignmentRoomsOptions);
  setNativeTurns(endpoint: NativeGroupTurnEndpoint): void;
  /** Peer lane. Throws AssignmentRefused with a typed reason. Returns once the turn is queued. */
  assign(leader: string, request: AssignmentCreateRequest): Promise<AssignmentView>;
  view(assignmentId: string): AssignmentView | undefined;
  list(filter: { leader?: string; assignee?: string; participant?: string }): AssignmentView[];
  cancel(assignmentId: string, by: "leader" | "user", reason?: string): AssignmentView;      // throws AssignmentNotFound
  /** `by` is the leader's bot name from the attach bearer, or `{ device: true }` for a paired phone. */
  acknowledge(assignmentId: string, by: string | { device: true }, outcome: "completed" | "failed"): AssignmentView;   // throws AssignmentNotFound / AssignmentForbidden / AssignmentRefused("not_verifying")
  acknowledgeTask(taskId: string, by: string | { device: true }, outcome: "completed" | "failed"): AssignmentView;   // same, addressed by the wrapped Task id; AssignmentNotFound when no assignment wraps it
  inboxThreads(bot: string): BotInboxThread[];
  inboxMessages(bot: string, threadId: string): BotGroupMessage[] | undefined;      // undefined when the thread is not one of this bot's
  canAcceptAttachEvent(agentId: string, frame: AttachV1EventFrame): boolean;
  handleAttachEvent(agentId: string, frame: AttachV1EventFrame): boolean;
  onTaskUpdated(view: TaskView): void;       // called from the Task observer; emits bot_inbox_activity for wait/blocked transitions
  reconcile(now?: number): void;             // deadline sweep + 24 h verifying auto-complete + restart recovery
  close(): void;
}
```

Behaviour to implement:

- `assign`: `storage.botTeam(leader)` must have `role === "leader"` else `not_leader`; `request.to` must be in `reports` else `not_a_report`; `await missingMembers([to])` non-empty → `not_a_report` too (a name that stopped being a bot); `isAttached(to)` false → `assignee_unavailable`; any open assignment with `assignee === to` → `assignee_busy`; open assignments with `leader` ≥ 8 → `leader_task_cap`. Then, inside `storage.tasks.atomic`: `assignmentId = randomUUID()`, `threadId = "assignment:" + assignmentId`, `deadlineAt = now + (request.deadlineMs ?? DEFAULT)`, `createBotAssignment`, append the leader's brief as the first log row (`kind: "member", name: leader, displayName from memberInfo, text: brief, messageId: `${assignmentId}:brief``), `beginBotAssignmentTurn` with `turnId = randomUUID()`, `messageId = `${turnId}:assignment``, then `endpoint.sendNativeTurn(to, { threadId, turnId, messageId, text: prompt, context: { actors: [leader, assignee as members], task: {...} } })`. If `sendNativeTurn` returns false: `completeBotAssignmentTurn(..., "failed", undefined, "native attach-v1 profile is unavailable", now)` and throw `assignee_unavailable`. After the send, `storage.tasks.run(to, turnId)` gives the Task; write its `taskId` into the assignment with `updateBotAssignment`. Emit `bot_inbox_activity` for both leader and assignee (two frames, `bot` differs, same `threadId`). Start `#waitForTurn(assignmentId, turnId)` without awaiting it.
- `#waitForTurn`: poll `botAssignmentTurn` every `pollMs` until settled, or until `now >= deadlineAt + storage.tasks.suspended(agentId, turnId, createdAt, now)` (approval pauses do not eat the deadline, exactly like rooms), then `timeoutBotAssignmentTurn(assignmentId, turnId, "no reply before the deadline", now)`, `updateBotAssignment({ failure: "deadline" })`, and emit. Use the same `#waiters` map trick `GroupRooms.#waitForTurn` uses so a settle wakes the loop immediately.
- `handleAttachEvent`: owned turn via `botAssignmentTurnForAttach`; `commit` → `completeBotAssignmentTurn(..., "commit", blocksToText(event.blocks), ...)`, append a member log row for the assignee, `parseResultBlock(text)` → `updateBotAssignment({ finalText, resultJson })`; `failed` → `"failed"` with `event.message` and `updateBotAssignment({ failure: event.message ?? "turn failed" })`; `cancelled`/`interrupted` → that state; `draft`/`tool`/`approval`/`clarify`/`thinking`/`delegation` → return `true` (authorised turn, no assignment projection; approvals and clarifies still reach the phone through the native data plane, which sees the same event). Wake the waiter and emit.
- `cancel`: `updateBotAssignment({ cancelledBy: by, failure: reason })`; if `taskId` is set and the Task is non-terminal, `storage.tasks.command(taskId, "cancel", { idempotencyKey: `assignment:${assignmentId}:cancel` })` then `flushTaskCommands?.()`. Emit.
- `acknowledge`: a peer caller must equal `leader` else `AssignmentForbidden`; a device caller (`{ device: true }`) is always allowed. The derived state must be `verifying`, else throw `AssignmentRefused("not_verifying", refusalMessage(...))`. Then `updateBotAssignment({ acknowledgedAt: now, acknowledgedOutcome: outcome })`, emit. `acknowledgeTask` resolves `storage.botAssignmentByTask(taskId)` and delegates.
- `view`: read the row, read `storage.tasks.read(taskId)?.view` when present, call `deriveAssignmentState`, project `result` from `resultJson`. Every list/view call first runs `reconcile(now)`.
- `reconcile`: for each open assignment (derived state open): if `now >= deadlineAt` and no `failure`, record `failure: "deadline"` and cancel its Task (as in `cancel` but `cancelledBy` stays unset, because the derivation already answers `failed`); for a `verifying` older than 24 h, nothing to write (derived), but emit once by recording `acknowledgedAt: now, acknowledgedOutcome: "completed"` so the frame fires exactly once. On construction, for every `pendingBotAssignmentTurns()` row restart `#waitForTurn` (restart recovery; the Task side already re-leases the run). A `timer = setInterval(() => reconcile(), 30_000)` with `unref()`; `close()` clears it and stops loops.
- `onTaskUpdated(view)`: `botAssignmentByThread(view.sessionId)`; if found, emit for both parties. This is how `waiting_for_approval`, `blocked` (owner lost) and `running` reach the phone without the orchestrator polling.
- `inboxThreads(bot)`: `botAssignments({ participant: bot })` → `{ id: threadId, peers: [leader, assignee], startedAt: createdAt, lastActiveAt: updatedAt, preview: brief.slice(0, 280), messageCount: log.length }`. `inboxMessages(bot, threadId)`: only when `bot` is a participant; rows map to `BotGroupMessage` (`seq`, `from: {kind, name, displayName}`, `text`, `at`, `messageId`, `turnId?`).
- Emission helper: `#emit(row)` broadcasts `{ type: "bot_inbox_activity", bot, threadId, updatedAt: now, assignmentId, state }` once per participant.

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/test/assignments.test.ts` with a fake endpoint that behaves like the rooms harness (`bots-rooms-runtime-members.test.ts:98-125`): `sendNativeTurn` enqueues the command through `storage.enqueueAttachCommand(agentId, turnId, command, now)`, acks it with `storage.ackAttachCommand`, and (unless `opts.silent`) queues a microtask that calls `rooms.handleAttachEvent(agentId, commitFrame(reply))`.

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "cozygateway-contract";
import { openStorage, type Storage } from "../src/storage.ts";
import { AssignmentRooms, AssignmentRefused } from "../src/hermes-bridge/assignments.ts";

const storages: Storage[] = []; const rooms: AssignmentRooms[] = [];
afterEach(() => { for (const r of rooms.splice(0)) r.close(); for (const s of storages.splice(0)) s.close(); });

function harness(opts: { reply?: string; silent?: boolean; attached?: (bot: string) => boolean } = {}) {
  let now = 1_000;
  const storage = openStorage(":memory:"); storages.push(storage); storage.tasks.clock(() => now);
  const frames: ServerFrame[] = [];
  const commands: Array<{ agentId: string; threadId: string; turnId: string; text: string; context?: unknown }> = [];
  const room = new AssignmentRooms({
    storage, broadcast: (f) => frames.push(f), now: () => now,
    memberInfo: (name) => ({ name, displayName: name[0]!.toUpperCase() + name.slice(1) }),
    missingMembers: async (names) => names.filter((n) => !["lead", "scout", "sage"].includes(n)),
    isAttached: opts.attached ?? (() => true), pollMs: 1, formatDeadline: () => "soon",
  });
  rooms.push(room);
  room.setNativeTurns({
    canQueue: () => true,
    sendNativeTurn: (agentId, input) => {
      commands.push({ agentId, threadId: input.threadId, turnId: input.turnId, text: input.text, context: input.context });
      const cmd = storage.enqueueAttachCommand(agentId, input.turnId, { kind: "turn", ...input }, now);
      storage.ackAttachCommand(agentId, cmd.sequence, cmd.commandId, now);
      if (!opts.silent) queueMicrotask(() => room.handleAttachEvent(agentId, { kind: "event", sequence: 1, eventId: `commit:${input.turnId}`,
        event: { kind: "commit", threadId: input.threadId, turnId: input.turnId, messageId: `reply:${input.turnId}`, blocks: [{ type: "paragraph", text: opts.reply ?? "Green.\nResult:\nstatus: done\nCI is green.\nartifacts: ci/log.txt" }] } }));
      return true;
    },
  });
  storage.setBotTeam({ bot: "lead", role: "leader", reports: ["scout", "sage"], updatedAt: now });
  return { storage, room, frames, commands, tick: (ms: number) => { now += ms; } };
}
const req = { to: "scout", brief: "Check CI", doneCriteria: "main is green" };
const until = async (p: () => boolean) => { for (let i = 0; i < 200 && !p(); i++) await new Promise((r) => setTimeout(r, 2)); if (!p()) throw new Error("timeout"); };

describe("assign", () => {
  it("queues one turn on assignment:<id> with the prompt and task context, then verifies on the reply", async () => {
    const h = harness();
    const view = await h.room.assign("lead", req);
    expect(view).toMatchObject({ leader: "lead", assignee: "scout", state: "running", threadId: `assignment:${view.assignmentId}` });
    expect(h.commands[0]!.text.startsWith("[Task from Lead] Check CI\nDone when: main is green")).toBe(true);
    expect(h.commands[0]!.context).toMatchObject({ task: { id: view.assignmentId, assignedBy: "lead", deadlineAt: 1_000 + 30 * 60_000 } });
    await until(() => h.room.view(view.assignmentId)?.state === "verifying");
    expect(h.room.view(view.assignmentId)).toMatchObject({ result: { status: "done", summary: "CI is green.", artifacts: ["ci/log.txt"] }, finalText: expect.stringContaining("Green.") });
    expect(h.room.inboxMessages("lead", view.threadId)!.map((m) => m.from.name)).toEqual(["lead", "scout"]);
    expect(h.frames.filter((f) => f.type === "bot_inbox_activity").map((f) => (f as { bot: string }).bot)).toContain("scout");
  });
  it("refuses with typed reasons", async () => {
    const h = harness({ attached: (b) => b !== "sage" });
    await expect(h.room.assign("scout", req)).rejects.toMatchObject({ reason: "not_leader" });
    await expect(h.room.assign("lead", { ...req, to: "nobody" })).rejects.toMatchObject({ reason: "not_a_report" });
    await expect(h.room.assign("lead", { ...req, to: "sage" })).rejects.toMatchObject({ reason: "assignee_unavailable" });
    const first = await h.room.assign("lead", req);
    expect(first.state).toBe("running");
    await expect(h.room.assign("lead", req)).rejects.toBeInstanceOf(AssignmentRefused);
    await expect(h.room.assign("lead", req)).rejects.toMatchObject({ reason: "assignee_busy" });
  });
  it("caps a leader at eight open assignments", async () => {
    const h = harness({ silent: true });
    h.storage.setBotTeam({ bot: "lead", role: "leader", reports: Array.from({ length: 9 }, (_, i) => `r${i}`), updatedAt: 1 });
    const room = h.room as unknown as { assign: AssignmentRooms["assign"] };
    // r0..r8 are not real bots for missingMembers; override for this test
    (h.room as unknown as { ["opts"]?: unknown });
    for (let i = 0; i < 8; i++) await h.room.assign("lead", { ...req, to: `r${i}` });
    await expect(h.room.assign("lead", { ...req, to: "r8" })).rejects.toMatchObject({ reason: "leader_task_cap" });
  });
});

describe("deadline, cancel, acknowledge", () => {
  it("fails a silent assignee at the deadline through the Task's timeout", async () => {
    const h = harness({ silent: true });
    const view = await h.room.assign("lead", { ...req, deadlineMs: 60_000 });
    h.tick(60_001);
    await until(() => h.room.view(view.assignmentId)?.state === "failed");
    expect(h.room.view(view.assignmentId)).toMatchObject({ failure: "deadline" });
    expect(h.storage.tasks.read(view.taskId!)?.view.state).not.toBe("running");
  });
  it("cancels through the Task and records who asked", async () => {
    const h = harness({ silent: true });
    const view = await h.room.assign("lead", req);
    expect(h.room.cancel(view.assignmentId, "leader", "changed plans")).toMatchObject({ state: "cancelled", cancelledBy: "leader" });
    expect(h.storage.tasks.read(view.taskId!)?.view.pendingIntent?.command).toBe("cancel");
  });
  it("only the leader acknowledges, only from verifying, and 24 h auto-completes", async () => {
    const h = harness();
    const view = await h.room.assign("lead", req);
    await until(() => h.room.view(view.assignmentId)?.state === "verifying");
    expect(() => h.room.acknowledge(view.assignmentId, "scout", "completed")).toThrow(/forbidden|leader/i);
    const second = await h.room.assign("lead", { ...req, to: "sage" });
    expect(() => h.room.acknowledge(second.assignmentId, "lead", "completed")).toThrow(expect.objectContaining({ reason: "not_verifying" }));
    expect(h.room.acknowledgeTask(view.taskId!, { device: true }, "failed").state).toBe("failed");
    expect(() => h.room.acknowledgeTask("no-such-task", "lead", "completed")).toThrow(/not found/i);
    await until(() => h.room.view(second.assignmentId)?.state === "verifying");
    h.tick(24 * 60 * 60_000);
    expect(h.room.view(second.assignmentId)?.state).toBe("completed");
  });
});
```

For the cap test, make `missingMembers` in the harness accept any name that starts with `r` as well, so the loop's nine reports are real; simplify the two stray lines in that test accordingly (delete the `room`/`opts` no-op lines).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter cozygateway test test/assignments.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `assignments.ts` and widen `settledGroupTurn`**

Write the class per Interfaces and Behaviour. Reuse `settledGroupTurn` from `group-turn.ts` on the assignment turn row for settlement (widen its parameter type to `Pick<BotGroupTurnRow, "state" | "text" | "detail">`; `BotAssignmentTurnRow` satisfies it structurally). Build `context` as:

```ts
const context: AttachV1TurnContext = {
  actors: [leaderInfo, assigneeInfo].map((m) => ({ name: m.name, handle: m.name, displayName: m.displayName, kind: "member" })),
  task: { id: assignmentId, assignedBy: leader, brief, doneCriteria, ...(outputFormat === undefined ? {} : { outputFormat }), deadlineAt },
};
```

The turn `text` is `buildAssignmentPrompt(...)` and nothing else; assert in a comment that it does not depend on `context`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter cozygateway test test/assignments.test.ts test/bots-group-turn.test.ts test/bots-rooms-interactions.test.ts && pnpm --filter cozygateway typecheck`
Expected: PASS; the room suites are unaffected by the widened signature.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/hermes-bridge/assignments.ts packages/gateway/src/hermes-bridge/group-turn.ts packages/gateway/test/assignments.test.ts
git commit -m "gateway: AssignmentRooms orchestrates leader assignments over attach-v1 turns"
```

---

### Task 5: Routes: assignments, inbox, and the team fields on the profile

**Files:**
- Create: `packages/gateway/src/assignment-routes.ts`
- Modify: `packages/gateway/src/hermes-bridge/routes.ts:1069-1130` (profile GET and PATCH), `:143` (`extensionErrorBody` code union gains `"assignment_refused"`)
- Modify: `packages/gateway/src/http.ts:216` (`AppDeps` gains `assignments?: AssignmentRooms`), `:1725-1735` (registration)
- Test: create `packages/gateway/test/assignment-routes.test.ts`, `packages/gateway/test/bots-profile-team.test.ts`

**Interfaces:**
- Consumes: `AssignmentRooms` (Task 4); `requireDevice`, `requireAttach`, `attachAgent` already built in `http.ts:450-490`; `errorBody`, `canonicalName`, `failure` in `routes.ts`.
- Produces:

```ts
export function registerAssignmentRoutes(
  app: Hono<Env>,
  requireDevice: MiddlewareHandler<Env>,
  peer: { auth: MiddlewareHandler<Env>; agentOf: (c: Context<Env>) => string; resolve: (c: Context<Env>) => string | undefined },
  assignments: AssignmentRooms,
): void
```

Routes and auth:

| Route | Auth | Behaviour |
| --- | --- | --- |
| `POST /bots/:name/assignments` | `peer.auth`; `peer.agentOf(c)` must equal `:name` else `403 unauthorized` | Validate `AssignmentCreateRequestSchema` (400 `invalid_request`). `assignments.assign(name, body)` → `201 AssignmentCreateResponse`. `AssignmentRefused` → `409 { error: { code: "assignment_refused", message }, reason }`. |
| `GET /bots/:name/assignments` | either | `peer.resolve(c)` gives an agent → it must be `:name` (403 otherwise); else `requireDevice`. Returns `{ assignments: list({ participant: name }) }`. |
| `GET /assignments/:assignmentId` | either | Peer must be leader or assignee (403); device may read any. 404 `not_found` otherwise. |
| `POST /assignments/:assignmentId/cancel` | either | Peer must be the leader (403) → `cancel(id, "leader", body.reason)`; device → `cancel(id, "user", body.reason)`. Body validated by `AssignmentCancelRequestSchema`, empty body allowed. Returns the view. |
| `POST /assignments/:assignmentId/acknowledge` | either | Peer must be the leader (403); device allowed. `AssignmentAcknowledgeRequestSchema`; `AssignmentRefused("not_verifying")` → `409 { error: { code: "assignment_refused" }, reason: "not_verifying" }`. Returns the view. |
| `POST /bots/tasks/:taskId/acknowledge` | either | Same rules, addressed by the wrapped Task id (`assignments.acknowledgeTask`). 404 `not_found` when no assignment wraps that Task. Returns `AssignmentAcknowledgeResponse` `{ state, assignmentId, taskId }`. This is the route the CozyAgents `task_status` tool calls when the leader passes `acknowledge`. |
| `GET /bots/:name/inbox` | `requireDevice` | `{ threads: inboxThreads(name) }` |
| `GET /bots/:name/inbox/:threadId/messages` | `requireDevice` | `{ messages }` or 404. |

Implement "either" as a small middleware in the file: `const either = createMiddleware<Env>(async (c, next) => { const agent = peer.resolve(c); if (agent !== undefined) { c.set("agentId", agent); return next(); } return requireDevice(c, next); });` and read `c.get("agentId")` (add `agentId?: string` to the local `Env` Variables type).

Profile changes in `routes.ts`:
- GET: after `bots.botProfile(name)`, merge `const team = storage.botTeam(name)` → `{ ...profile, ...(team === undefined ? {} : { role: team.role, reports: team.reports }) }`. `registerBotRoutes` does not receive `storage` today; add a trailing optional parameter `team?: { read: (bot: string) => BotTeamRow | undefined; write: (row: {bot; role; reports; updatedAt}) => void; missingMembers: (names: string[]) => Promise<string[]> }` and pass it from `http.ts` (`deps.storage` plus `deps.assignments`'s `missingMembers`; when `deps.bots` has `missingMembers`, use the bridge's).
- PATCH: extend the "at least one of" guard with `parsed.role === undefined && parsed.reports === undefined`. Then: `reports` on a body whose effective role (body `role`, else stored role, else member) is `member` → 400 `invalid_request` "reports require role: leader"; more than 16 → schema already refuses; `missingMembers(reports)` non-empty → 400 "not a bot on this gateway: …"; a report equal to the bot itself → 400 "a bot cannot report to itself". Write `team.write({ bot: name, role: role ?? stored?.role ?? "member", reports: role === "member" ? [] : reports ?? stored?.reports ?? [], updatedAt })`. Strip `role` and `reports` from the patch; if nothing else remains, answer `{ name, outcome: "applied", ok: true, applied: { team: true }, requested: ["team"] }` without calling `bots.configureProfile`; otherwise forward the rest and add `team: true` to `applied` and `"team"` to `requested`. Demoting a leader to member cancels its open assignments with `cancelledBy: "user"` via `assignments.cancel` for each `list({ leader: name })` that is open; pass `assignments` through the same `team` parameter as `demote: (leader: string) => void`.

- [ ] **Step 1: Write the failing route tests**

Create `packages/gateway/test/assignment-routes.test.ts`. Build the app with `createApp` the way `bots-profile.test.ts:150-180` does, adding `attachTokens: new Map([["tok-lead", "lead"], ["tok-scout", "scout"]])` and `assignments` (an `AssignmentRooms` over the same storage with the fake endpoint from Task 4's harness). Pair a device to get `deviceToken`. Then:

```ts
  it("a leader assigns with its attach bearer and a device reads the inbox", async () => {
    const res = await peer("lead", "/bots/lead/assignments", { method: "POST", body: JSON.stringify(req) });
    expect(res.status).toBe(201);
    const { assignmentId, threadId } = await res.json() as { assignmentId: string; threadId: string };
    const inbox = await authed("/bots/lead/inbox");
    expect((await inbox.json() as { threads: Array<{ id: string; peers: string[] }> }).threads[0]).toMatchObject({ id: threadId, peers: ["lead", "scout"] });
    const messages = await authed(`/bots/lead/inbox/${threadId}/messages`);
    expect(((await messages.json()) as { messages: unknown[] }).messages).toHaveLength(2);
    expect((await authed(`/assignments/${assignmentId}`)).status).toBe(200);
  });
  it("refusals are typed and a non-leader peer is refused", async () => {
    const res = await peer("scout", "/bots/scout/assignments", { method: "POST", body: JSON.stringify({ ...req, to: "lead" }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "assignment_refused" }, reason: "not_leader" });
    expect((await peer("scout", "/bots/lead/assignments", { method: "POST", body: JSON.stringify(req) })).status).toBe(403);
    expect((await request("/bots/lead/assignments", { method: "POST", body: JSON.stringify(req) })).status).toBe(401);
  });
  it("acknowledges by Task id from verifying only; a device may cancel", async () => {
    const created = await (await peer("lead", "/bots/lead/assignments", { method: "POST", body: JSON.stringify(req) })).json() as { assignmentId: string; taskId: string };
    const early = await peer("lead", `/bots/tasks/${created.taskId}/acknowledge`, { method: "POST", body: JSON.stringify({ outcome: "completed" }) });
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: { code: "assignment_refused" }, reason: "not_verifying" });
    await until(async () => ((await (await authed(`/assignments/${created.assignmentId}`)).json()) as { state: string }).state === "verifying");
    expect((await peer("scout", `/bots/tasks/${created.taskId}/acknowledge`, { method: "POST", body: JSON.stringify({ outcome: "completed" }) })).status).toBe(403);
    const ok = await peer("lead", `/bots/tasks/${created.taskId}/acknowledge`, { method: "POST", body: JSON.stringify({ outcome: "completed" }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ state: "completed", assignmentId: created.assignmentId, taskId: created.taskId });
    expect((await peer("lead", `/bots/tasks/no-such/acknowledge`, { method: "POST", body: JSON.stringify({ outcome: "completed" }) })).status).toBe(404);
    const second = await (await peer("lead", "/bots/lead/assignments", { method: "POST", body: JSON.stringify({ ...req, to: "sage" }) })).json() as { assignmentId: string };
    const cancelled = await authed(`/assignments/${second.assignmentId}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(await cancelled.json()).toMatchObject({ state: "cancelled", cancelledBy: "user" });
  });
```

Write the three helper functions `peer(agent, path, init)` (adds `authorization: Bearer tok-<agent>` and `content-type`), `authed`, `request` as in the profile test.

Create `packages/gateway/test/bots-profile-team.test.ts` reusing `bots-profile.test.ts`'s `setup` shape (copy the harness; the fake Hermes serves `scout` and `sage`, and `profiles.describe` returns `describeResult`):

```ts
  it("stores role and reports on the gateway and merges them into the read", async () => {
    const res = await h.authed("/bots/scout/profile", patch({ role: "leader", reports: ["sage"] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: { team: true }, requested: ["team"] });
    expect(h.server.callsOf("profiles.configure")).toHaveLength(0);
    const read = await (await h.authed("/bots/scout/profile")).json() as { role?: string; reports?: string[] };
    expect(read).toMatchObject({ role: "leader", reports: ["sage"] });
  });
  it("refuses reports on a member, an unknown bot, and self", async () => {
    expect((await h.authed("/bots/scout/profile", patch({ reports: ["sage"] }))).status).toBe(400);
    expect((await h.authed("/bots/scout/profile", patch({ role: "leader", reports: ["nobody"] }))).status).toBe(400);
    expect((await h.authed("/bots/scout/profile", patch({ role: "leader", reports: ["scout"] }))).status).toBe(400);
  });
  it("a mixed patch forwards only the Hermes fields", async () => {
    await h.authed("/bots/scout/profile", patch({ role: "leader", reports: ["sage"], soul: "# Scout" }));
    const call = h.server.callsOf("profiles.configure").at(-1)!;
    expect(JSON.stringify(call.params)).not.toContain("reports");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter cozygateway test test/assignment-routes.test.ts test/bots-profile-team.test.ts`
Expected: FAIL: 404 on every assignment route; profile PATCH answers 400 "at least one of …".

- [ ] **Step 3: Implement the routes and wiring**

Write `assignment-routes.ts` per the table. In `routes.ts` add `"assignment_refused"` to the `extensionErrorBody` code union, and implement the profile GET merge and PATCH handling described above. In `http.ts`: add `assignments?: AssignmentRooms` to `AppDeps`; after `registerArtifactRoutes(...)` add

```ts
  if (deps.assignments !== undefined) {
    registerAssignmentRoutes(app, requireDevice, { auth: requireAttach, agentOf: attachAgent, resolve: (c) => deps.attachTokens === undefined ? undefined : resolveAttachBearer(deps.attachTokens, c.req.header("authorization")) }, deps.assignments);
  }
```

and pass the `team` parameter into `registerBotRoutes` (`read: (bot) => deps.storage.botTeam(bot)`, `write: (row) => deps.storage.setBotTeam(row)`, `missingMembers: deps.assignments?.missingMembers ?? (async () => [])`, `demote: (leader) => deps.assignments?.demote(leader)`). Add `missingMembers` and `demote(leader)` as public methods on `AssignmentRooms` (`demote` cancels every open assignment led by `leader` with `by: "user"`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter cozygateway test test/assignment-routes.test.ts test/bots-profile-team.test.ts test/bots-profile.test.ts && pnpm --filter cozygateway typecheck`
Expected: PASS, including the unchanged profile suite.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/assignment-routes.ts packages/gateway/src/http.ts packages/gateway/src/hermes-bridge/routes.ts packages/gateway/src/hermes-bridge/assignments.ts packages/gateway/test/assignment-routes.test.ts packages/gateway/test/bots-profile-team.test.ts
git commit -m "gateway: assignment and inbox routes; team role and reports on the profile"
```

---

### Task 6: Server assembly, capability advertisement, end-to-end

**Files:**
- Modify: `packages/gateway/src/server.ts:230-292` (`gatewayInfoForConfig`), `:576-620` (beside `roomHost`), `:672-690` (`canAcceptEvent`), `:752-770` (`handleEvent`), `:846-860` (`setGroupNativeTurns`), `:1126` (`storage.tasks.observe`), the `createApp` call (pass `assignments`), and `close()` (call `assignments.close()`).
- Test: create `packages/gateway/test/assignments-e2e.test.ts`; modify `packages/gateway/test/cozyagents-only-gateway.test.ts` (health advertises agent-inbox 1).

**Interfaces:**
- Consumes: `AssignmentRooms` (Task 4/5), `attachV1Ingress.isAttached/canQueue/sendNativeTurn`, `hub.broadcast`, `raiseLiveActivityFrame`.
- Produces: `gatewayInfoForConfig` gains a trailing `agentInbox = false` parameter; when true, `[AGENT_INBOX_CAPABILITY_ID]: AGENT_INBOX_CAPABILITY_VERSION` is advertised. `startGateway` always constructs `AssignmentRooms` (the store is always present), so `agentInbox` is `true` for every gateway, including the Hermes-free shape.

- [ ] **Step 1: Write the failing tests**

In `cozyagents-only-gateway.test.ts` add, in the existing health/ready assertions block:

```ts
    expect(info.capabilities["com.cozylabs.agent-inbox"]).toBe(1);
```

Create `packages/gateway/test/assignments-e2e.test.ts` using `startGateway` with two attach identities, one under `hermesEndpoints[0].profiles` (`scout`, the Hermes assignee, via the fake Hermes server like `bots-profile.test.ts`) and one under `bots: [{ id: "sage", runtime: "cozyagents", tokenEnv: "T_SAGE" }]` (the CozyAgents assignee, as `config-native-bots.test.ts` declares one), plus a third profile `lead`. Connect a real `ws` client for `scout` and one for `sage` to `${gateway.url.replace("http", "ws")}/attach/v1` with `Authorization: Bearer <token>`, send the v2 hello (copy the hello frame shape from `attach-v1-ingress.test.ts`), and reply to every `turn` command with a `commit` event whose blocks carry a `Result:` block. Then:

```ts
  it("a leader assigns to a Hermes profile and to a CozyAgents bot, both settle to verifying, the leader acknowledges each by Task id, and the phone reads the inbox", async () => {
    await authedPatch("/bots/lead/profile", { role: "leader", reports: ["scout", "sage"] });
    for (const to of ["scout", "sage"]) {
      const res = await fetch(`${gateway.url}/bots/lead/assignments`, { method: "POST", headers: { authorization: "Bearer tok-lead", "content-type": "application/json" }, body: JSON.stringify({ to, brief: "Check CI", doneCriteria: "green" }) });
      expect(res.status).toBe(201);
      const { assignmentId } = await res.json() as { assignmentId: string };
      await until(async () => ((await (await authed(`/assignments/${assignmentId}`)).json()) as { state: string }).state === "verifying");
      const { taskId } = (await (await authed(`/assignments/${assignmentId}`)).json()) as { taskId: string };
      const ack = await fetch(`${gateway.url}/bots/tasks/${taskId}/acknowledge`, { method: "POST", headers: { authorization: "Bearer tok-lead", "content-type": "application/json" }, body: JSON.stringify({ outcome: "completed" }) });
      expect(ack.status).toBe(200);
      expect(await ack.json()).toMatchObject({ state: "completed", taskId });
    }
    const inbox = (await (await authed("/bots/lead/inbox")).json()) as { threads: unknown[] };
    expect(inbox.threads).toHaveLength(2);
    expect(frames.filter((f) => f.type === "bot_inbox_activity").length).toBeGreaterThanOrEqual(4);
  });
```

`frames` come from a paired device WebSocket on `/ws` (see how `bots-rooms-interactions.test.ts` or `attach-v1-restart-e2e.test.ts` subscribes a device; copy that helper).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter cozygateway test test/assignments-e2e.test.ts test/cozyagents-only-gateway.test.ts`
Expected: FAIL: capability absent; 404 on the assign route.

- [ ] **Step 3: Wire the server**

In `server.ts`:

```ts
const assignments = new AssignmentRooms({
  storage,
  broadcast: (frame) => { hub.broadcast(frame); raiseLiveActivityFrame(frame); },
  now: () => Date.now(),
  memberInfo: (name) => rooms?.memberInfo?.(name) ?? { name, displayName: name },
  missingMembers: (names) => rooms?.missingMembers?.(names) ?? Promise.resolve(names.filter((n) => !nativeBotIds.includes(n))),
  isAttached: (agentId) => attachV1Ingress.isAttached(agentId),
  flushTaskCommands: () => flushTaskCommands(),
});
```

`memberInfo` and `missingMembers` are private on `GroupRooms` today; expose thin public wrappers on `HermesBridge` and `GatewayRoomHost` (`memberInfo(name)`, `missingMembers(names)`) that delegate to their `GroupRooms`. Place the construction after `attachV1Ingress` exists (the ingress is built after the bridge, so use a `let assignments: AssignmentRooms | undefined` declared beside `roomHost` and assign it after the ingress, then `assignments.setNativeTurns({ canQueue: (a) => attachV1Ingress.canQueue(a), sendNativeTurn: (a, i) => attachV1Ingress.sendNativeTurn(a, i) })` beside `rooms?.setGroupNativeTurns`). In `canAcceptEvent` add `if (assignments?.canAcceptAttachEvent(agentId, frame) === true) return true;` immediately after the rooms line; in `handleEvent` add `if (assignments?.handleAttachEvent(agentId, frame) === true) return true;` immediately after the rooms line. Replace the Task observer with `storage.tasks.observe((frame) => { hub.broadcast(frame); if (frame.type === "bot_task_updated") assignments?.onTaskUpdated(frame.view); }, BOTS_CAPABILITY_VERSION);`. Pass `assignments` into `createApp`. Call `assignments.close()` in the gateway `close()`. Add the `agentInbox` parameter to `gatewayInfoForConfig` and pass `true` at the call site.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: PASS across both packages. Any suite that snapshots the full capability map (`grep -rl "com.cozylabs.push-proxy" packages/gateway/test`) gains the agent-inbox row; update those expectations.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/server.ts packages/gateway/src/hermes-bridge/bridge.ts packages/gateway/src/hermes-bridge/group-rooms.ts packages/gateway/test/assignments-e2e.test.ts packages/gateway/test/cozyagents-only-gateway.test.ts
git commit -m "gateway: assemble leader assignments and advertise agent-inbox 1"
```

---

### Task 7: Contract document and changelog

**Files:**
- Modify: `contract/ext-bots-v1.md:111` (capability table, add row 70 after 69), `:855-870` (HTTP routes table), and a new subsection after `### The Task join, resolved from the Run` (`:1306`) titled `### Leader assignments (com.cozylabs.agent-inbox 1)`.
- Modify: `CHANGELOG.md:1-8` (new `## 0.8.0 (unreleased): leader assignments` series above 0.7.6).
- Modify: `docs/adr/0082-agent-inbox-stays-hidden-until-hermes-proves-a2a-identity.md` (status → `superseded by capability com.cozylabs.agent-inbox 1`, one sentence saying why: the identity is now gateway-owned rows, not a Hermes heuristic).

- [ ] **Step 1: Write the docs**

Capability row 70 (one table row, same voice as 69): team roles on the profile, the `TurnContext.task` field, byte-identical text, additive, the assignment surface advertised on agent-inbox. Routes table rows for the eight routes (including `POST /bots/tasks/:taskId/acknowledge`, body `{ outcome }`, response `{ state, assignmentId, taskId }`, valid only from `verifying`, else `409 assignment_refused` with `reason: "not_verifying"`) with their auth column values ("attach bearer of `:name`", "attach bearer or device", "device"). The subsection states: what an assignment is (wraps one Task; the Run is the assignee's turn; `state` derived), the nine states and the derivation table from Task 3, the caps, the six refusal reasons and the refusal body shape, the `Result:` block contract, the prompt text verbatim, that Hermes profiles are assignees with no plugin change and cannot lead in v1, and that `bot_inbox_activity` carries `bot, threadId, updatedAt, assignmentId, state`.

Changelog entry, in the file's voice:

```
## 0.8.0 (unreleased): leader assignments

- Leader assignments (`com.cozylabs.agent-inbox` 1, `com.cozylabs.bots` 70): a bot whose
  profile carries `role: "leader"` may assign one bounded piece of work to a bot in its
  `reports` over `POST /bots/:name/assignments` with its own attach bearer. The assignee answers
  an ordinary attach-v1 turn on a gateway-owned `assignment:<id>` thread, so the assignment is one
  capability-64 Task with every state, wait, absence and cancel rule that already exists; the
  assignment adds the leader, the brief, the done criteria, a deadline that is the turn's own
  timeout, the parsed `Result:` block and the leader's acknowledgement. Caps are 8 open per
  leader, 1 open per assignee, 16 reports. The withdrawn inbox routes return, backed by these rows
  (ADR 0082 superseded). Role and reports are stored by the gateway and merged into the profile
  read; a Hermes profile can be assigned to with no plugin change and cannot lead.
```

- [ ] **Step 2: Verify the docs match the code**

Run: `grep -n "assignment_refused\|/bots/:name/assignments\|agent-inbox" contract/ext-bots-v1.md CHANGELOG.md | wc -l`
Expected: at least 6 lines. Run `pnpm --filter cozygateway-contract test` once more; nothing in the docs is tested, but the run confirms the tree is still green before the commit.

- [ ] **Step 3: Commit**

```bash
git add contract/ext-bots-v1.md CHANGELOG.md docs/adr/0082-agent-inbox-stays-hidden-until-hermes-proves-a2a-identity.md
git commit -m "docs: capability 70, agent-inbox 1, leader assignment routes"
```

---

## Self-review

**Spec coverage.** Profile role/reports → Tasks 1, 2, 5. Durable task object with the nine-state machine → Task 2 (wraps capability 64) and Task 3 (derivation). Routes: assign/list/detail/cancel → Task 5 (renamed, see Deviations); reinstated inbox routes → Task 5. Attach-v1 turn reuse with `TurnContext.task` and byte-identical text → Tasks 1, 4. Deadline as the turn timeout, 180 s not reused → Task 4 `#waitForTurn`. Typed refusals (six, including `not_verifying`) and caps → Tasks 3, 4, 5. Acknowledge by Task id for the CozyAgents `task_status` tool → Tasks 2, 4, 5, 6, 7. Attach-bearer peer lane, no device token → Task 5. `bot_inbox_activity` on state change → Tasks 1, 4, 6. Restart reconciliation → Task 4 constructor (pending turns re-waited; the Task lease is capability 64's own). 24 h verifying auto-complete and deadline sweeper → Task 4 `reconcile`. Capability advertisement → Task 6. Leader deleted or demoted cancels its open assignments → Task 5 (`demote`) and, for deletion, `storage.tasks.ownerDeleted` already cancels the Tasks; add `assignments.demote(name)` to `killAttachIdentity` in Task 6's server edit so the assignment rows agree. Hermes and CozyAgents assignees → Task 6 e2e. Report delivery over `scheduled_canonical_home` needs no gateway change (the leader peer emits it; the projection at `native-data-plane.ts:952` already accepts it), so it has no task here and belongs to the CozyAgents slice. Contract doc and changelog → Task 7.

**Placeholder scan.** No TBD/TODO. Every code step shows the code or the exact edit. The two "copy the helper from …" instructions name the file and line range to copy from.

**Type consistency.** `AssignmentRooms.view/list/cancel/acknowledge/assign` all return `AssignmentView` (Task 1 schema); `AssignmentRefused.reason` is `AssignmentRefusal`; `AssignmentForbidden` and `AssignmentNotFound` are declared in Task 4 and mapped in Task 5; a bad-state acknowledgement is `AssignmentRefused("not_verifying")`, so no separate conflict class exists. `BotAssignmentTurnRow` satisfies the widened `settledGroupTurn` parameter. `deriveAssignmentState`'s `AssignmentFacts.taskState` is `TaskState` from `cozygateway-contract`. `gatewayInfoForConfig` gains one trailing boolean and every existing caller keeps its positional arguments.

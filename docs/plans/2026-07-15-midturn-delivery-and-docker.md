# Mid-Turn Delivery + Docker (cozygateway Lane 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give cozygateway a mid-turn delivery path (steer into an in-flight turn, hard interrupt, honest queue fallback) with additive contract v1.x changes, a steer/interrupt attach frame plus reference plugin support, and a first-class Docker deploy story, all testable without any LLM.

**Architecture:** A backend adapter declares a static `midTurnDelivery` capability (`steer` or `queue`). `TurnRunner` reads it: a send while a turn is in flight either steers into the existing turn (no new `turnId`), routes to a hard interrupt on a stop phrase, or queues exactly as today. A new `POST /threads/:id/interrupt` REST action and an optional `delivery` field on committed user messages are additive contract v1.x extensions. The attach protocol gains gateway-to-plugin `steer` and `interrupt` frames; the reference Python plugin parses and dispatches them. Multi-stage Dockerfiles plus a reference compose file ship the gateway and relay as containers with a SQLite volume, env-driven config, and a `/health` healthcheck.

**Tech Stack:** TypeScript (pure ESM, `.ts` import specifiers, `erasableSyntaxOnly`, no `enum`, no parameter properties), `@sinclair/typebox` for wire schemas and the shared `check()`/`assertValid()` guards, `hono` + `@hono/node-server` for REST, `ws` for WebSockets, Node 24 `node:sqlite`, Vitest (`vitest run`, no config file, tests under `packages/*/test/*.test.ts`), Python stdlib `unittest` for the plugin (no pytest, no new deps), Docker multi-stage builds on `node:24-slim` with pnpm 10 `deploy --prod`.

## Global Constraints

- Contract v1 (`contract/v1.md`) stays FROZEN at `contract: "v1"`; every change here is ADDITIVE within v1.x (new optional field, new endpoint, new error code, new attach frame). No existing field changes shape. `CONTRACT_VERSION` stays `"v1"`.
- This repo is public OSS, MIT, and NEVER imports CozyLabs code. Stop-phrase detection and the steer policy are re-implemented here independently; the repos never share code by design.
- No em-dashes anywhere in code, comments, docs, or copy (use commas, colons, parentheses).
- Pure ESM, `.ts` import specifiers, `erasableSyntaxOnly`; no `enum`, no parameter properties; drafts are full-replace; a failed turn REJECTS `send()` (no onCommit/onDone).
- Message objects for role `"user"` gain OPTIONAL `delivery?: "turn" | "steer"`; absent means `"turn"`. Only ever set on user messages. Additive contract v1.x minor bump.
- New REST action: `POST /threads/:id/interrupt`. Responses: `202` with JSON body `{"status":"interrupting"}` when a turn was in flight and interrupt was dispatched; `204` with no body when the thread is idle (no-op). Auth like every other route.
- A deliberately interrupted turn ends with a committed system message with marker `"turn.interrupted"` (mirroring the existing `"turn.failed"` marker mechanics) followed by the normal `done` frame.
- Stop-phrase spec (gateway-side detection in the send path): exactly `["stop", "stop it", "cancel", "abort"]`; normalization = trim whitespace, casefold, strip terminal `[.!?]+` characters; match the WHOLE message only. A phrase match routes the send to the interrupt path AND still commits the user message normally (delivery absent, it becomes the next turn per backend queue semantics). Everything else passes through.
- Adapter capability: `BackendAdapter` declares `midTurnDelivery: "steer" | "queue"` (static declaration). Steer-capable sessions expose `steer(blocks: RichBlock[]): Promise<void>` and `interrupt(): Promise<void>`. Hermes attach adapter declares `"steer"` (the plugin injects inbound events; the agent-side Hermes config `busy_input_mode=steer` makes injection steer natively, that config is NOT this repo's concern). OpenClaw declares `"queue"` and keeps today's behavior; interrupt on OpenClaw returns a clean error frame with message `"interrupt unsupported"`.
- TurnRunner policy on a send while a turn is in flight for that thread: stop-phrase match -> interrupt path; else adapter steer-capable -> deliver mid-turn into the in-flight turn, NO new `turnId` (drafts continue under the existing `turnId`), commit the user message with `delivery: "steer"`; else queue exactly as today. Race rule: a steer send that loses the race with turn completion falls back to a normal queued turn and commits with delivery absent.
- Docker: multi-stage Dockerfiles (node 24 base matching `engines >=24`, pnpm build, pruned production stage) for gateway and relay; reference `docker-compose.yml` with both services, a named volume for the gateway SQLite path, env-driven configuration (backend attach URL, API key, relay URL), and a container healthcheck.
- Health route: `GET /health` ALREADY EXISTS on both the gateway (`packages/gateway/src/http.ts:66`, unauthenticated, 200, returns `GatewayInfo`) and the relay (`packages/relay/src/http.ts:70`, 200, returns `{name, version}`). This plan REUSES `/health` for the container healthcheck and does NOT add `/healthz`.
- Env var names the compose file uses (the deployment plan being written next depends on these EXACT names): gateway service reads `COZYGATEWAY_HOST`, `COZYGATEWAY_PORT`, `COZYGATEWAY_DB_PATH`, `COZYGATEWAY_ATTACH_TOKEN`; relay service is parameterized by `COZY_RELAY_PORT` (compose interpolation into the relay CLI flags; the relay stays flag-driven with no code change).
- TypeScript tests: Vitest. Full gate from repo root: `pnpm check` (build + typecheck + test). Single package: `pnpm --filter cozygateway test`. Single file during a step: `cd packages/gateway && pnpm exec vitest run <file>`.
- Python tests: stdlib `unittest` only (mirrors `integrations/attach-plugin/tests/README.md`), run `cd integrations/attach-plugin && python3 -m unittest discover -s tests -v`.
- Sequencing note: the portable conformance suite (Task 6) drives a LIVE reference gateway, so its `POST /interrupt` assertions can only pass once the endpoint exists (Task 5). Pure-schema contract assertions live in Task 1. Every task below ends green on its own tests.

---

### Task 1: Contract additive types (delivery field, turn.interrupted marker, interrupt_unsupported code, InterruptResponse)

**Files:**
- Modify: `packages/contract/src/resources.ts` (`ERROR_CODES` at lines 7-16; `MessageSchema` at lines 87-95, `marker` at line 93).
- Modify: `packages/contract/src/rest.ts` (append after `PushRegisterRequestSchema`, current end at line 55).
- Modify: `contract/v1.md` (section 3 error table, section 5 Message marker + new delivery field, section 5 new interrupt endpoint).
- Test: `packages/contract/test/resources.test.ts` (append a describe block).
- Test: `packages/contract/test/rest.test.ts` (append a describe block).

**Interfaces:**
- Produces: `MessageSchema` static `Message` gains `delivery?: "turn" | "steer"` and `marker?: "turn.failed" | "turn.interrupted"`. `ERROR_CODES` gains `"interrupt_unsupported"`. New `InterruptResponseSchema` with static `InterruptResponse = { status: "interrupting" }`. All re-exported through `packages/contract/src/index.ts` (its `export *` already covers `resources.ts` and `rest.ts`).

- [ ] **Step 1: Write the failing schema tests**

Append to `packages/contract/test/resources.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { ERROR_CODES, MessageSchema, check } from "../src/index.ts";

describe("contract v1.x additive message fields", () => {
  const base = {
    threadId: "t1",
    seq: 1,
    role: "user" as const,
    blocks: [{ type: "paragraph", text: "hi" }],
    createdAt: 0,
  };

  it("accepts a user message with no delivery (delivery absent means turn)", () => {
    expect(check(MessageSchema, base)).toBe(true);
  });

  it("accepts delivery 'turn' and 'steer' and rejects any other value", () => {
    expect(check(MessageSchema, { ...base, delivery: "turn" })).toBe(true);
    expect(check(MessageSchema, { ...base, delivery: "steer" })).toBe(true);
    expect(check(MessageSchema, { ...base, delivery: "queue" })).toBe(false);
  });

  it("accepts both turn.failed and turn.interrupted markers on a system message", () => {
    const sys = { ...base, role: "system" as const, turnId: "x" };
    expect(check(MessageSchema, { ...sys, marker: "turn.failed" })).toBe(true);
    expect(check(MessageSchema, { ...sys, marker: "turn.interrupted" })).toBe(true);
    expect(check(MessageSchema, { ...sys, marker: "turn.aborted" })).toBe(false);
  });

  it("lists interrupt_unsupported as a known error code", () => {
    expect(ERROR_CODES).toContain("interrupt_unsupported");
  });
});
```

Append to `packages/contract/test/rest.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { InterruptResponseSchema, check } from "../src/index.ts";

describe("InterruptResponseSchema", () => {
  it("accepts the interrupting status body and rejects anything else", () => {
    expect(check(InterruptResponseSchema, { status: "interrupting" })).toBe(true);
    expect(check(InterruptResponseSchema, { status: "idle" })).toBe(false);
    expect(check(InterruptResponseSchema, {})).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd packages/contract && pnpm exec vitest run test/resources.test.ts test/rest.test.ts`
Expected failure: `delivery`/`turn.interrupted`/`interrupt_unsupported` assertions fail (schema unchanged), and `InterruptResponseSchema` is `undefined` (import error / not exported).

- [ ] **Step 3: Add the delivery field, marker union, and error code in resources.ts**

In `packages/contract/src/resources.ts`, change `ERROR_CODES` (lines 7-16) to include the new code:

```ts
export const ERROR_CODES = [
  "unauthorized",
  "not_found",
  "invalid_request",
  "setup_code_invalid",
  "thread_archived",
  "backend_unavailable",
  "turn_failed",
  "interrupt_unsupported",
  "internal",
] as const;
```

Replace the `MessageSchema` (lines 84-96) with:

```ts
/** A committed, durable message. `seq` is per-thread, gapless, starts at 1, allocated by the
 *  gateway in commit order; clients dedupe by per-thread high-water mark. `marker` flags
 *  synthetic system messages ("turn.failed" for a turn that did not finish, "turn.interrupted"
 *  for a turn a user deliberately stopped). `delivery` is only ever set on role "user"
 *  messages: absent (or "turn") means the message started or queued its own turn; "steer" means
 *  it was delivered mid-turn into an already in-flight turn (contract v1.x additive). */
export const MessageSchema = Type.Object({
  threadId: Type.String(),
  seq: Type.Integer({ minimum: 1 }),
  role: MessageRoleSchema,
  blocks: Type.Array(RichBlockSchema),
  turnId: Type.Optional(Type.String()),
  marker: Type.Optional(
    Type.Union([Type.Literal("turn.failed"), Type.Literal("turn.interrupted")]),
  ),
  delivery: Type.Optional(Type.Union([Type.Literal("turn"), Type.Literal("steer")])),
  createdAt: Type.Integer(),
});
export type Message = Static<typeof MessageSchema>;
```

- [ ] **Step 4: Add InterruptResponseSchema in rest.ts**

Append to `packages/contract/src/rest.ts` (after line 55):

```ts
/** Response body of POST /threads/:id/interrupt when a turn was in flight and the interrupt was
 *  dispatched (HTTP 202). An idle thread returns HTTP 204 with no body instead. */
export const InterruptResponseSchema = Type.Object({
  status: Type.Literal("interrupting"),
});
export type InterruptResponse = Static<typeof InterruptResponseSchema>;
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd packages/contract && pnpm exec vitest run test/resources.test.ts test/rest.test.ts`
Expected: all green.

- [ ] **Step 6: Document the additions in contract/v1.md**

In `contract/v1.md` section 3, add a row to the frozen code table (after `turn_failed`):

```
| `interrupt_unsupported` | an interrupt was requested but the agent backend cannot honor it |
```

In section 5 under Message, change the `marker` bullet and add a `delivery` bullet:

```
- `marker?: "turn.failed" | "turn.interrupted"` (optional). `turn.failed` flags a synthetic
  system message standing in for a turn that did not finish; `turn.interrupted` flags a turn a
  user deliberately stopped (see POST /threads/:id/interrupt). Both are additive v1.x values;
  a client that predates `turn.interrupted` treats it as an unknown-but-valid system marker.
- `delivery?: "turn" | "steer"` (optional; only ever present on `role: "user"` messages). Absent
  means `"turn"`: the message started or queued its own agent turn. `"steer"` means the message
  was delivered mid-turn into an already in-flight turn instead of starting a new one. Additive
  v1.x: a client that predates the field ignores it and renders the message normally.
```

In section 5, after `POST /threads/:id/messages`, add:

```
### POST /threads/:id/interrupt

Requests a hard interrupt of the thread's in-flight agent turn. Takes no request body.

Responses:

- `202 Accepted` with body `{ "status": "interrupting" }` when a turn was in flight and the
  interrupt was dispatched to the backend. For a steer-capable backend the turn ends as a
  committed system message with `marker: "turn.interrupted"` followed by a `done` frame. For a
  backend that cannot interrupt, the gateway emits an `error` frame with code
  `interrupt_unsupported` over the WebSocket and the turn runs to normal completion; the REST
  response is still `202` because a turn was in flight.
- `204 No Content` with no body when the thread has no turn in flight (a no-op).

Auth is required exactly as for every other route. A nonexistent thread returns `not_found`.
```

- [ ] **Step 7: Full contract gate and commit**

Run: `pnpm --filter cozygateway-contract test && pnpm --filter cozygateway-contract build`
Expected: green.
Commit:
```
git add packages/contract contract/v1.md
git commit -m "contract: additive delivery field, turn.interrupted marker, interrupt endpoint (v1.x)"
```

---

### Task 2: Adapter capability plumbing and the steerable mock backend

**Files:**
- Modify: `packages/gateway/src/adapters/types.ts` (`BackendSession` at lines 12-15, `BackendAdapter` at lines 17-21).
- Modify: `packages/gateway/src/adapters/mock.ts` (whole file, lines 1-38).
- Modify: `packages/gateway/src/adapters/registry.ts` (mock branch at lines 42-44).
- Test: `packages/gateway/test/mock-adapter.test.ts` (append a describe block).

**Interfaces:**
- Consumes: `TurnHandlers`, `BackendSession`, `BackendAdapter` from `./types.ts`; `RichBlock` from `cozygateway-contract`.
- Produces: `BackendAdapter.midTurnDelivery: "steer" | "queue"` (required). `BackendSession.steer?(blocks: RichBlock[]): Promise<void>` and `BackendSession.interrupt?(): Promise<void>` (optional; present only on steer-capable sessions). `createMockAdapter(...)` now returns `midTurnDelivery: "queue"`. New export `createSteerMockAdapter(): BackendAdapter` with `midTurnDelivery: "steer"`, whose session stays in flight after `send` (one initial draft) until `steer(blocks)` folds the text then commits+done+resolves, or `interrupt()` rejects the send. Registry `backend: "mock-steer"` builds it.

- [ ] **Step 1: Write the failing adapter interface + steer-mock tests**

Append to `packages/gateway/test/mock-adapter.test.ts`:

```ts
import { createSteerMockAdapter } from "../src/adapters/mock.ts";

describe("createMockAdapter capability", () => {
  it("declares queue mid-turn delivery and exposes no steer/interrupt", async () => {
    const adapter = createMockAdapter();
    expect(adapter.midTurnDelivery).toBe("queue");
    const session = await adapter.startSession("t1");
    expect(session.steer).toBeUndefined();
    expect(session.interrupt).toBeUndefined();
  });
});

describe("createSteerMockAdapter", () => {
  it("declares steer, stays in flight after send, then a steer folds text and commits", async () => {
    const adapter = createSteerMockAdapter();
    expect(adapter.midTurnDelivery).toBe("steer");
    const session = await adapter.startSession("t1");
    const rec = record();
    let settled = false;
    const turn = session.send([{ type: "paragraph", text: "one" }], rec.handlers).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false); // stays in flight, only the initial draft so far
    expect(rec.events).toEqual(["draft"]);
    expect(rec.drafts[0]).toEqual([{ type: "paragraph", text: "Working: one" }]);

    await session.steer?.([{ type: "paragraph", text: "two" }]);
    await turn;
    expect(rec.events).toEqual([
      "draft",
      "draft",
      `commit:${JSON.stringify([{ type: "paragraph", text: "Working: one + two" }])}`,
      "done",
    ]);
  });

  it("rejects the in-flight send when interrupt is called, with no commit or done", async () => {
    const adapter = createSteerMockAdapter();
    const session = await adapter.startSession("t1");
    const rec = record();
    const turn = session.send([{ type: "paragraph", text: "one" }], rec.handlers);
    await new Promise((r) => setTimeout(r, 5));
    await session.interrupt?.();
    await expect(turn).rejects.toThrow(/interrupted/);
    expect(rec.events).toEqual(["draft"]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd packages/gateway && pnpm exec vitest run test/mock-adapter.test.ts`
Expected failure: `adapter.midTurnDelivery` is `undefined` and `createSteerMockAdapter` is not exported.

- [ ] **Step 3: Extend the adapter interface**

Replace `packages/gateway/src/adapters/types.ts` lines 12-21 with:

```ts
export interface BackendSession {
  send(blocks: RichBlock[], handlers: TurnHandlers): Promise<void>;
  close(): Promise<void>;
  /** Deliver blocks mid-turn into the CURRENTLY in-flight turn of this session (no new turnId).
   *  Present only on steer-capable sessions (adapter.midTurnDelivery === "steer"). Best-effort:
   *  the runner only calls this while the session's send() promise is unsettled. */
  steer?(blocks: RichBlock[]): Promise<void>;
  /** Hard-interrupt the in-flight turn: the pending send() promise rejects, and the runner (which
   *  set its interrupting flag first) records a turn.interrupted system message. Present only on
   *  steer-capable sessions. */
  interrupt?(): Promise<void>;
}

export interface BackendAdapter {
  readonly backend: string;
  /** Static declaration of how a mid-turn send is handled: "steer" delivers into the in-flight
   *  turn (the session exposes steer/interrupt); "queue" serializes behind it as today. */
  readonly midTurnDelivery: "steer" | "queue";
  startSession(threadId: string): Promise<BackendSession>;
  presence(): PresenceState;
}
```

- [ ] **Step 4: Add midTurnDelivery to the mock and add createSteerMockAdapter**

Replace `packages/gateway/src/adapters/mock.ts` (whole file) with:

```ts
import type { RichBlock } from "cozygateway-contract";

import type { BackendAdapter, BackendSession, TurnHandlers } from "./types.ts";

function firstText(blocks: RichBlock[]): string {
  const first = blocks[0];
  return first !== undefined && first.type === "paragraph" ? first.text : "(rich content)";
}

/** Reference echo backend. contract/v1.md section 7 freezes these semantics; the conformance
 *  suite asserts them frame by frame. Change nothing here without a contract version bump. It
 *  declares "queue" mid-turn delivery: a send while a turn is in flight serializes behind it. */
export function createMockAdapter(options?: { failOn?: string }): BackendAdapter {
  const failToken = options?.failOn ?? "[[fail]]";

  const session: BackendSession = {
    async send(blocks: RichBlock[], handlers: TurnHandlers): Promise<void> {
      const text = firstText(blocks);
      await Promise.resolve();
      handlers.onDraft({ blocks: [{ type: "paragraph", text: "Echo: " }], toolCalls: [] });
      if (text.includes(failToken)) {
        await Promise.resolve();
        throw new Error("scripted failure");
      }
      await Promise.resolve();
      const final: RichBlock[] = [{ type: "paragraph", text: `Echo: ${text}` }];
      handlers.onDraft({ blocks: final, toolCalls: [] });
      await Promise.resolve();
      handlers.onCommit({ blocks: final });
      await Promise.resolve();
      handlers.onDone();
    },
    async close(): Promise<void> {},
  };

  return {
    backend: "mock",
    midTurnDelivery: "queue",
    async startSession(): Promise<BackendSession> {
      return session;
    },
    presence: () => "online",
  };
}

/** LLM-free steer-capable backend used to exercise the TurnRunner steer/interrupt policy and the
 *  full HTTP/WS stack end to end. A send emits one draft ("Working: <text>") and stays in flight;
 *  it never completes on its own. A steer folds the steer text ("Working: <text> + <steer>") and
 *  then commits + done + resolves. An interrupt rejects the pending send. One in-flight turn at a
 *  time per session (the runner serializes turns per thread and caches one session per thread). */
export function createSteerMockAdapter(): BackendAdapter {
  return {
    backend: "mock-steer",
    midTurnDelivery: "steer",
    presence: () => "online",
    async startSession(): Promise<BackendSession> {
      let inflight:
        | {
            handlers: TurnHandlers;
            text: string;
            resolve: () => void;
            reject: (err: Error) => void;
            settled: boolean;
          }
        | undefined;

      return {
        send(blocks: RichBlock[], handlers: TurnHandlers): Promise<void> {
          const text = `Working: ${firstText(blocks)}`;
          return new Promise<void>((resolve, reject) => {
            inflight = { handlers, text, resolve, reject, settled: false };
            handlers.onDraft({ blocks: [{ type: "paragraph", text }], toolCalls: [] });
            // Deliberately does not resolve: the turn stays in flight until steer/interrupt.
          });
        },
        async steer(steerBlocks: RichBlock[]): Promise<void> {
          const cur = inflight;
          if (cur === undefined || cur.settled) return; // race: the turn already ended
          cur.text = `${cur.text} + ${firstText(steerBlocks)}`;
          const final: RichBlock[] = [{ type: "paragraph", text: cur.text }];
          cur.handlers.onDraft({ blocks: final, toolCalls: [] });
          cur.settled = true;
          cur.handlers.onCommit({ blocks: final });
          cur.handlers.onDone();
          cur.resolve();
          inflight = undefined;
        },
        async interrupt(): Promise<void> {
          const cur = inflight;
          if (cur === undefined || cur.settled) return;
          cur.settled = true;
          cur.reject(new Error("interrupted by user"));
          inflight = undefined;
        },
        async close(): Promise<void> {},
      };
    },
  };
}
```

- [ ] **Step 5: Register the mock-steer backend**

In `packages/gateway/src/adapters/registry.ts`, change the import at lines 1-3 and the mock branch at lines 43-44.

Replace line 3 (`import { createMockAdapter } from "./mock.ts";`) with:

```ts
import { createMockAdapter, createSteerMockAdapter } from "./mock.ts";
```

Replace the mock branch (lines 43-44):

```ts
    if (agent.backend === "mock") {
      adapters.set(agent.id, createMockAdapter(agent.options as { failOn?: string } | undefined));
    } else if (agent.backend === "attach") {
```

with:

```ts
    if (agent.backend === "mock") {
      adapters.set(agent.id, createMockAdapter(agent.options as { failOn?: string } | undefined));
    } else if (agent.backend === "mock-steer") {
      adapters.set(agent.id, createSteerMockAdapter());
    } else if (agent.backend === "attach") {
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `cd packages/gateway && pnpm exec vitest run test/mock-adapter.test.ts && pnpm typecheck`
Expected: the new tests pass. `tsc --noEmit` (typecheck) compiles both `src` and `test` (see `packages/gateway/tsconfig.json` include), so it now flags every `BackendAdapter` value missing the required `midTurnDelivery` field. Fix all of them in this step so the task stays green in isolation:
- `packages/gateway/src/adapters/attach/adapter.ts` return object (line 118): add `midTurnDelivery: "steer",` (real behavior added in Task 7).
- `packages/gateway/src/adapters/openclaw/adapter.ts` return object (line 77): add `midTurnDelivery: "queue",` (confirmed in Task 9).
- `packages/gateway/test/turns.test.ts` `gatedAdapter` return (line 22): add `midTurnDelivery: "queue",`.

Run again: `cd packages/gateway && pnpm typecheck`
Expected: green.

- [ ] **Step 7: Commit**

```
git add packages/gateway/src/adapters
git commit -m "adapters: midTurnDelivery capability + steerable mock backend"
```

---

### Task 3: TurnRunner steer / interrupt / queue policy (with storage support)

**Files:**
- Modify: `packages/gateway/src/storage.ts` (`SCHEMA` messages table at lines 32-41, `MessageDbRow` at lines 77-85, `toMessage` at lines 87-98, `appendMessage` at lines 208-248, `openStorage` at lines 301-307).
- Modify: `packages/gateway/src/turns.ts` (whole file, lines 1-149).
- Test: `packages/gateway/test/turns.test.ts` (append describe blocks; the `gatedAdapter` helper already gained `midTurnDelivery: "queue"` in Task 2).

**Interfaces:**
- Consumes: `BackendAdapter.midTurnDelivery`, `BackendSession.steer?`, `BackendSession.interrupt?` (Task 2); `Storage.appendMessage` extended to accept `delivery` and the `turn.interrupted` marker.
- Produces: `TurnRunner.submitUserMessage(threadId, blocks)` now steers or queues by policy and labels `delivery`. New `TurnRunner.interrupt(threadId): InterruptOutcome` where `type InterruptOutcome = "interrupting" | "unsupported" | "idle"` (exported from `turns.ts`). A steer-capable interrupt yields a `turn.interrupted` system commit plus a `done` frame; a queue-only interrupt emits an `interrupt_unsupported` error frame.

- [ ] **Step 1: Extend storage to persist delivery and the new marker**

In `packages/gateway/src/storage.ts`, replace the `messages` table block inside `SCHEMA` (lines 32-41) with (add the `delivery` column):

```ts
CREATE TABLE IF NOT EXISTS messages (
  thread_id TEXT NOT NULL REFERENCES threads(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  turn_id TEXT,
  marker TEXT,
  delivery TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, seq)
) STRICT, WITHOUT ROWID;
```

Replace `MessageDbRow` (lines 77-85) with:

```ts
interface MessageDbRow {
  threadId: string;
  seq: number;
  role: string;
  blocksJson: string;
  turnId: string | null;
  marker: string | null;
  delivery: string | null;
  createdAt: number;
}
```

Replace `toMessage` (lines 87-98) with:

```ts
function toMessage(row: MessageDbRow): Message {
  const message: Message = {
    threadId: row.threadId,
    seq: row.seq,
    role: row.role as MessageRole,
    blocks: JSON.parse(row.blocksJson) as RichBlock[],
    createdAt: row.createdAt,
  };
  if (row.turnId !== null) message.turnId = row.turnId;
  if (row.marker === "turn.failed" || row.marker === "turn.interrupted") message.marker = row.marker;
  if (row.delivery === "turn" || row.delivery === "steer") message.delivery = row.delivery;
  return message;
}
```

Replace `appendMessage` (lines 208-248) with:

```ts
  appendMessage(
    threadId: string,
    entry: {
      role: MessageRole;
      blocks: RichBlock[];
      turnId?: string;
      marker?: "turn.failed" | "turn.interrupted";
      delivery?: "turn" | "steer";
    },
    createdAt: number,
  ): Message {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE thread_id = ?")
        .get(threadId) as { next: number };
      this.#db
        .prepare(
          `INSERT INTO messages (thread_id, seq, role, blocks_json, turn_id, marker, delivery, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          threadId,
          row.next,
          entry.role,
          JSON.stringify(entry.blocks),
          entry.turnId ?? null,
          entry.marker ?? null,
          entry.delivery ?? null,
          createdAt,
        );
      this.#db.prepare("UPDATE threads SET last_message_at = ? WHERE id = ?").run(createdAt, threadId);
      this.#db.exec("COMMIT");
      const message: Message = {
        threadId,
        seq: row.next,
        role: entry.role,
        blocks: entry.blocks,
        createdAt,
      };
      if (entry.turnId !== undefined) message.turnId = entry.turnId;
      if (entry.marker !== undefined) message.marker = entry.marker;
      if (entry.delivery !== undefined) message.delivery = entry.delivery;
      return message;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }
```

Update the two `SELECT` statements in `messagesSince` (lines 250-259) and `messagesBefore` (lines 261-271) to also read `delivery`: change each column list `turn_id AS turnId, marker, created_at AS createdAt` to `turn_id AS turnId, marker, delivery, created_at AS createdAt`.

Replace `openStorage` (lines 301-307) with (add the idempotent migration for a pre-existing DB that predates the `delivery` column):

```ts
export function openStorage(dbPath: string): Storage {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  // Additive migration for a DB created before the delivery column existed. ALTER TABLE ADD
  // COLUMN throws "duplicate column name" on an up-to-date DB, which is the no-op we want.
  try {
    db.exec("ALTER TABLE messages ADD COLUMN delivery TEXT");
  } catch {
    // column already present: nothing to do
  }
  return new Storage(db);
}
```

- [ ] **Step 2: Write the failing TurnRunner policy tests**

Append to `packages/gateway/test/turns.test.ts` (the file already imports `openStorage`, `TurnRunner`, `nullNotifier`, `BackendAdapter`, `ServerFrame`, `untilFrames`; add the `createSteerMockAdapter` import at the top):

```ts
import { createSteerMockAdapter } from "../src/adapters/mock.ts";

function steerSetup() {
  const storage = openStorage(":memory:");
  storage.upsertAgent({ id: "s1", name: "Steer", avatar: null, backend: "mock-steer" });
  storage.createThread({ id: "t1", agentId: "s1", title: "T", createdAt: 1 });
  const frames: ServerFrame[] = [];
  const runner = new TurnRunner({
    storage,
    hub: { broadcast: (f) => frames.push(f), connectedDeviceIds: () => new Set() },
    adapters: new Map<string, BackendAdapter>([["s1", createSteerMockAdapter()]]),
    notifier: nullNotifier,
    now: () => 42,
  });
  return { storage, frames, runner };
}

const draftTurnIds = (fs: ServerFrame[]): string[] =>
  fs.filter((f): f is Extract<ServerFrame, { type: "draft" }> => f.type === "draft").map((d) => d.turnId);

describe("TurnRunner mid-turn delivery", () => {
  it("steers a mid-turn send into the in-flight turn under the same turnId, delivery steer", async () => {
    const { storage, frames, runner } = steerSetup();
    const first = runner.submitUserMessage("t1", [{ type: "paragraph", text: "one" }]);
    expect(first.delivery).toBeUndefined();
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "draft"));

    const steered = runner.submitUserMessage("t1", [{ type: "paragraph", text: "two" }]);
    expect(steered.delivery).toBe("steer");
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "done"));

    expect(new Set(draftTurnIds(frames)).size).toBe(1); // no new turnId minted for the steer
    const agentCommit = frames.find((f) => f.type === "committed" && f.message.role === "agent");
    expect(agentCommit?.type === "committed" ? agentCommit.message.blocks : undefined).toEqual([
      { type: "paragraph", text: "Working: one + two" },
    ]);
    // The steer user message persisted with delivery "steer"; the first with none.
    const users = storage.messagesSince("t1", 0).filter((m) => m.role === "user");
    expect(users.map((m) => m.delivery)).toEqual([undefined, "steer"]);
  });

  it("interrupt on a steer-capable in-flight turn commits turn.interrupted then done, no error frame", async () => {
    const { storage, frames, runner } = steerSetup();
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "one" }]);
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "draft"));

    expect(runner.interrupt("t1")).toBe("interrupting");
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "done"));

    const sys = storage.messagesSince("t1", 0).find((m) => m.marker === "turn.interrupted");
    expect(sys?.role).toBe("system");
    expect(frames.some((f) => f.type === "error")).toBe(false);
    const types = frames.map((f) => f.type);
    const sysIdx = frames.findIndex((f) => f.type === "committed" && f.message.role === "system");
    expect(types.lastIndexOf("done")).toBeGreaterThan(sysIdx);
  });

  it("interrupt on an idle thread returns idle and broadcasts nothing new", () => {
    const { frames, runner } = steerSetup();
    expect(runner.interrupt("t1")).toBe("idle");
    expect(frames).toHaveLength(0);
  });

  it("a mid-turn send that loses the race (turn already done) queues normally with delivery absent", async () => {
    // The mock echo (queue backend) finishes its turn synchronously-ish; a second send after the
    // first turn's done sees no in-flight record and queues, committing with delivery absent.
    const { frames, runner } = setup();
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "one" }]);
    await untilFrames(frames, (fs) => fs.filter((f) => f.type === "done").length === 1);
    const second = runner.submitUserMessage("t1", [{ type: "paragraph", text: "two" }]);
    expect(second.delivery).toBeUndefined();
  });

  it("interrupt on a queue-only in-flight turn returns unsupported and emits interrupt_unsupported", async () => {
    const storage = openStorage(":memory:");
    storage.upsertAgent({ id: "slow", name: "Slow", avatar: null, backend: "gated" });
    storage.createThread({ id: "t1", agentId: "slow", title: "T", createdAt: 1 });
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const frames: ServerFrame[] = [];
    const runner = new TurnRunner({
      storage,
      hub: { broadcast: (f) => frames.push(f), connectedDeviceIds: () => new Set() },
      adapters: new Map<string, BackendAdapter>([["slow", gatedAdapter(gate)]]),
      notifier: nullNotifier,
      now: () => 42,
    });
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "one" }]);
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "draft"));

    expect(runner.interrupt("t1")).toBe("unsupported");
    const err = frames.find((f) => f.type === "error");
    expect(err?.type === "error" ? err.code : undefined).toBe("interrupt_unsupported");
    expect(err?.type === "error" ? err.message : undefined).toBe("interrupt unsupported");
    // The turn is NOT interrupted: it still completes normally when released.
    release();
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "committed" && f.message.role === "agent"));
    expect(storage.messagesSince("t1", 0).some((m) => m.marker === "turn.interrupted")).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `cd packages/gateway && pnpm exec vitest run test/turns.test.ts`
Expected failure: `runner.interrupt` is not a function; steered `delivery` is `undefined`; no `turn.interrupted` marker.

- [ ] **Step 4: Rewrite turns.ts with the policy**

Replace `packages/gateway/src/turns.ts` (whole file) with:

```ts
import { randomUUID } from "node:crypto";

import type { Message, RichBlock, ServerFrame } from "cozygateway-contract";

import type { Storage } from "./storage.ts";
import type { BackendAdapter, BackendSession } from "./adapters/types.ts";
import { BackendUnavailable } from "./errors.ts";

export interface Notifier {
  notify(
    event: { threadId: string; agentName: string; preview: string },
    connectedDeviceIds: ReadonlySet<string>,
  ): void;
}

export const nullNotifier: Notifier = { notify: () => {} };

interface Hub {
  broadcast(frame: ServerFrame): void;
  connectedDeviceIds(): ReadonlySet<string>;
}

/** Outcome of an interrupt dispatch. The REST layer maps both in-flight outcomes ("interrupting"
 *  for a steer-capable backend, "unsupported" for a queue-only one) to HTTP 202, and "idle" to
 *  HTTP 204. */
export type InterruptOutcome = "interrupting" | "unsupported" | "idle";

interface Inflight {
  turnId: string;
  session: BackendSession;
  steerCapable: boolean;
  interrupting: boolean;
}

function preview(blocks: RichBlock[]): string {
  const paragraph = blocks.find((b) => b.type === "paragraph");
  return paragraph !== undefined && paragraph.type === "paragraph" ? paragraph.text : "New message";
}

export class TurnRunner {
  readonly #storage: Storage;
  readonly #hub: Hub;
  readonly #adapters: Map<string, BackendAdapter>;
  readonly #notifier: Notifier;
  readonly #now: () => number;
  readonly #sessions = new Map<string, Promise<BackendSession>>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #inflight = new Map<string, Inflight>();

  constructor(deps: {
    storage: Storage;
    hub: Hub;
    adapters: Map<string, BackendAdapter>;
    notifier: Notifier;
    now: () => number;
  }) {
    this.#storage = deps.storage;
    this.#hub = deps.hub;
    this.#adapters = deps.adapters;
    this.#notifier = deps.notifier;
    this.#now = deps.now;
  }

  submitUserMessage(threadId: string, blocks: RichBlock[]): Message {
    const thread = this.#storage.threadById(threadId);
    if (thread === undefined) throw new Error(`unknown thread "${threadId}"`);
    const adapter = this.#adapters.get(thread.agentId);
    if (adapter === undefined) {
      throw new BackendUnavailable(`no adapter for agent "${thread.agentId}"`);
    }
    const agentName = this.#storage.agentById(thread.agentId)?.name ?? thread.agentId;

    // Mid-turn steer: an in-flight, steer-capable turn takes the message immediately, under its
    // existing turnId, and the user message commits with delivery "steer". The in-flight check is
    // synchronous, so a send handled after the turn has already settled reads no record and falls
    // through to the queue branch below (the race rule: fall back to a normal queued turn).
    const inflight = this.#inflight.get(threadId);
    if (inflight !== undefined && inflight.steerCapable && inflight.session.steer !== undefined) {
      const userMessage = this.#storage.appendMessage(
        threadId,
        { role: "user", blocks, delivery: "steer" },
        this.#now(),
      );
      this.#hub.broadcast({ type: "committed", threadId, seq: userMessage.seq, message: userMessage });
      void inflight.session.steer(blocks).catch(() => {
        // Best-effort mid-turn delivery: drafts continue under the existing turnId.
      });
      return userMessage;
    }

    return this.#commitAndQueue(threadId, agentName, adapter, blocks);
  }

  /** Request a hard interrupt of the thread's in-flight turn. Returns "idle" when nothing is in
   *  flight (HTTP 204). See InterruptOutcome. */
  interrupt(threadId: string): InterruptOutcome {
    const inflight = this.#inflight.get(threadId);
    if (inflight === undefined) return "idle";
    return this.#dispatchInterrupt(threadId, inflight);
  }

  #dispatchInterrupt(threadId: string, inflight: Inflight): InterruptOutcome {
    if (inflight.steerCapable && inflight.session.interrupt !== undefined) {
      inflight.interrupting = true;
      void inflight.session.interrupt().catch(() => {
        // The interrupting flag drives the turn.interrupted outcome once send() settles.
      });
      return "interrupting";
    }
    // Queue-only backend: it cannot interrupt. Be honest with a clean, thread-scoped error frame.
    this.#hub.broadcast({
      type: "error",
      code: "interrupt_unsupported",
      message: "interrupt unsupported",
      threadId,
    });
    return "unsupported";
  }

  #commitAndQueue(
    threadId: string,
    agentName: string,
    adapter: BackendAdapter,
    blocks: RichBlock[],
  ): Message {
    const userMessage = this.#storage.appendMessage(threadId, { role: "user", blocks }, this.#now());
    this.#hub.broadcast({ type: "committed", threadId, seq: userMessage.seq, message: userMessage });
    // Invariant: #runTurn never rejects, so the chain promise never rejects.
    const previous = this.#queues.get(threadId) ?? Promise.resolve();
    const next = previous.then(() => this.#runTurn(threadId, agentName, adapter, blocks));
    this.#queues.set(threadId, next);
    void next.then(() => {
      if (this.#queues.get(threadId) === next) this.#queues.delete(threadId);
    });
    return userMessage;
  }

  /** Runs one agent turn. NEVER rejects: a backend failure becomes a turn.failed marker plus an
   *  error frame; a deliberately interrupted turn becomes a turn.interrupted marker plus a done
   *  frame; a double fault on either failure path is swallowed. */
  async #runTurn(
    threadId: string,
    agentName: string,
    adapter: BackendAdapter,
    blocks: RichBlock[],
  ): Promise<void> {
    const turnId = randomUUID();
    let record: Inflight | undefined;
    try {
      let sessionPromise = this.#sessions.get(threadId);
      if (sessionPromise === undefined) {
        sessionPromise = adapter.startSession(threadId);
        this.#sessions.set(threadId, sessionPromise);
      }
      const session = await sessionPromise;
      record = {
        turnId,
        session,
        steerCapable: adapter.midTurnDelivery === "steer" && session.steer !== undefined,
        interrupting: false,
      };
      this.#inflight.set(threadId, record);
      await session.send(blocks, {
        onDraft: (update) => {
          this.#hub.broadcast({ type: "draft", threadId, turnId, blocks: update.blocks, toolCalls: update.toolCalls });
        },
        onCommit: (final) => {
          const message = this.#storage.appendMessage(
            threadId,
            { role: "agent", blocks: final.blocks, turnId },
            this.#now(),
          );
          this.#hub.broadcast({ type: "committed", threadId, seq: message.seq, message });
          this.#notifier.notify(
            { threadId, agentName, preview: preview(final.blocks) },
            this.#hub.connectedDeviceIds(),
          );
        },
        onDone: () => {
          this.#hub.broadcast({ type: "done", threadId, turnId });
        },
      });
    } catch (err) {
      const interrupted = record?.interrupting === true;
      try {
        const system = this.#storage.appendMessage(
          threadId,
          {
            role: "system",
            blocks: [
              {
                type: "paragraph",
                text: interrupted ? "The turn was interrupted." : "The agent turn failed. Send again to retry.",
              },
            ],
            turnId,
            marker: interrupted ? "turn.interrupted" : "turn.failed",
          },
          this.#now(),
        );
        this.#hub.broadcast({ type: "committed", threadId, seq: system.seq, message: system });
        if (interrupted) {
          // A deliberately interrupted turn ends with the normal done frame (contract v1.x).
          this.#hub.broadcast({ type: "done", threadId, turnId });
        } else {
          const message = err instanceof Error ? err.message : "unknown failure";
          this.#hub.broadcast({ type: "error", code: "turn_failed", message, threadId });
        }
      } catch {
        // Double fault (e.g. storage already closed): swallow to keep the never-rejects invariant.
      }
    } finally {
      if (this.#inflight.get(threadId) === record) this.#inflight.delete(threadId);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.#queues.values()]);
    this.#queues.clear();
    this.#inflight.clear();
    for (const sessionPromise of this.#sessions.values()) {
      try {
        const session = await sessionPromise;
        await session.close();
      } catch {
        // a session that failed to open has nothing to close
      }
    }
    this.#sessions.clear();
  }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd packages/gateway && pnpm exec vitest run test/turns.test.ts test/mock-adapter.test.ts && pnpm typecheck`
Expected: green. The existing TurnRunner tests (echo/queue path, serialization, failure, concurrency, closeAll) still pass unchanged.

- [ ] **Step 6: Commit**

```
git add packages/gateway/src/storage.ts packages/gateway/src/turns.ts packages/gateway/test/turns.test.ts
git commit -m "turns: steer/interrupt/queue policy + delivery + turn.interrupted"
```

---

### Task 4: POST /threads/:id/interrupt REST endpoint

**Files:**
- Modify: `packages/gateway/src/http.ts` (`AppDeps` at lines 27-35; add a route after the send route which ends at line 206).
- Modify: `packages/gateway/src/server.ts` (`createApp({...})` deps at lines 136-144).
- Test: `packages/gateway/test/interrupt-route.test.ts` (new file).

**Interfaces:**
- Consumes: `TurnRunner.interrupt(threadId): InterruptOutcome` (Task 3); `createSteerMockAdapter` (Task 2) for the in-flight case.
- Produces: `AppDeps.interruptThread(threadId: string): "interrupting" | "idle"`. HTTP: `POST /threads/:id/interrupt` returns 404 `not_found` (unknown thread), 202 `{status:"interrupting"}` (turn in flight), 204 no body (idle), 401 (no token).

- [ ] **Step 1: Write the failing route test**

Create `packages/gateway/test/interrupt-route.test.ts`:

```ts
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message, ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";

let gateway: RunningGateway;

beforeEach(async () => {
  gateway = await startGateway({
    name: "interrupt-e2e",
    port: 0,
    dbPath: ":memory:",
    agents: [
      { id: "echo", name: "Echo", backend: "mock" },
      { id: "steer", name: "Steer", backend: "mock-steer" },
    ],
  });
});

afterEach(async () => {
  await gateway.close();
});

async function pair(): Promise<string> {
  const res = await fetch(`${gateway.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }),
  });
  return ((await res.json()) as { deviceToken: string }).deviceToken;
}

async function thread(token: string, agentId: string): Promise<string> {
  const res = await fetch(`${gateway.url}/threads`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  return ((await res.json()) as { id: string }).id;
}

async function until(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 3_000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("POST /threads/:id/interrupt", () => {
  it("401 without a token", async () => {
    const res = await fetch(`${gateway.url}/threads/anything/interrupt`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("404 for an unknown thread", async () => {
    const token = await pair();
    const res = await fetch(`${gateway.url}/threads/no-such/interrupt`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("204 with no body when the thread is idle", async () => {
    const token = await pair();
    const id = await thread(token, "echo");
    const res = await fetch(`${gateway.url}/threads/${id}/interrupt`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("202 {status:interrupting} for a steer-capable in-flight turn, then turn.interrupted + done", async () => {
    const token = await pair();
    const id = await thread(token, "steer");
    const frames: ServerFrame[] = [];
    const ws = new WebSocket(`${gateway.url.replace("http", "ws")}/ws`);
    ws.on("message", (d) => frames.push(JSON.parse(String(d)) as ServerFrame));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => frames.some((f) => f.type === "ready"));

    await fetch(`${gateway.url}/threads/${id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "long task" }] }),
    });
    await until(() => frames.some((f) => f.type === "draft"));

    const res = await fetch(`${gateway.url}/threads/${id}/interrupt`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "interrupting" });

    await until(() => frames.some((f) => f.type === "done"));
    const committed = frames.filter(
      (f): f is Extract<ServerFrame, { type: "committed" }> => f.type === "committed",
    );
    const sys: Message | undefined = committed.map((f) => f.message).find((m) => m.role === "system");
    expect(sys?.marker).toBe("turn.interrupted");
    expect(frames.some((f) => f.type === "error")).toBe(false);
    ws.close();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/gateway && pnpm exec vitest run test/interrupt-route.test.ts`
Expected failure: `POST /interrupt` hits the `notFound` handler (404 for every case, so the 204/202 assertions fail).

- [ ] **Step 3: Add the AppDeps field and the route**

In `packages/gateway/src/http.ts`, add to `AppDeps` (after `submitUserMessage` at line 32):

```ts
  interruptThread: (threadId: string) => "interrupting" | "idle";
```

Add the route immediately after the send route (after line 206, before the `app.post("/push/register", ...)` block):

```ts
  app.post("/threads/:id/interrupt", requireDevice, (c) => {
    const thread = deps.storage.threadById(c.req.param("id"));
    if (thread === undefined) return c.json(errorBody("not_found", "no such thread"), 404);
    const outcome = deps.interruptThread(thread.id);
    if (outcome === "idle") return c.body(null, 204);
    return c.json({ status: "interrupting" }, 202);
  });
```

- [ ] **Step 4: Wire the dep in server.ts**

In `packages/gateway/src/server.ts`, add to the `createApp({...})` deps object (after `submitUserMessage:` at line 141):

```ts
    interruptThread: (threadId) => (runner.interrupt(threadId) === "idle" ? "idle" : "interrupting"),
```

(The runner's "unsupported" outcome collapses to "interrupting" here: a turn WAS in flight, so REST answers 202, and the runner has already emitted the `interrupt_unsupported` error frame over the WebSocket.)

- [ ] **Step 5: Run and confirm pass**

Run: `cd packages/gateway && pnpm exec vitest run test/interrupt-route.test.ts && pnpm typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```
git add packages/gateway/src/http.ts packages/gateway/src/server.ts packages/gateway/test/interrupt-route.test.ts
git commit -m "http: POST /threads/:id/interrupt endpoint (202/204)"
```

---

### Task 5: Gateway-side stop-phrase detection in the send path

**Files:**
- Create: `packages/gateway/src/stop-phrase.ts`.
- Modify: `packages/gateway/src/turns.ts` (`submitUserMessage`, add the stop branch before the steer branch).
- Test: `packages/gateway/test/stop-phrase.test.ts` (new file).
- Test: `packages/gateway/test/turns.test.ts` (append a stop-integration describe block).

**Interfaces:**
- Produces: `STOP_PHRASES: readonly string[]`, `normalizeStopCandidate(text: string): string`, `isStopPhrase(text: string): boolean`, `stopCandidateFromBlocks(blocks: RichBlock[]): string | undefined` (the whole-message text when the message is exactly one paragraph block, else `undefined`).
- Consumes: `TurnRunner.interrupt` internals (`#dispatchInterrupt` via the in-flight record) and `#commitAndQueue` (Task 3).

- [ ] **Step 1: Write the failing stop-phrase unit tests**

Create `packages/gateway/test/stop-phrase.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RichBlock } from "cozygateway-contract";

import { isStopPhrase, normalizeStopCandidate, stopCandidateFromBlocks } from "../src/stop-phrase.ts";

describe("normalizeStopCandidate", () => {
  it("trims, casefolds, and strips terminal .!? runs", () => {
    expect(normalizeStopCandidate("  Stop.  ")).toBe("stop");
    expect(normalizeStopCandidate("STOP IT!!!")).toBe("stop it");
    expect(normalizeStopCandidate("Cancel?")).toBe("cancel");
    expect(normalizeStopCandidate("abort")).toBe("abort");
  });
});

describe("isStopPhrase (whole-message match only)", () => {
  it("matches exactly the four phrases after normalization", () => {
    for (const yes of ["stop", "Stop.", "stop it", "STOP IT!", "cancel", "Cancel!!", "abort", "Abort."]) {
      expect(isStopPhrase(yes)).toBe(true);
    }
  });

  it("does not match a message that merely contains a stop word", () => {
    for (const no of [
      "stop adding comments to every file",
      "please stop",
      "don't abort yet",
      "cancellation policy",
      "stop it now and also do X",
      "",
      "   ",
    ]) {
      expect(isStopPhrase(no)).toBe(false);
    }
  });
});

describe("stopCandidateFromBlocks", () => {
  it("returns the text of a single paragraph block", () => {
    expect(stopCandidateFromBlocks([{ type: "paragraph", text: "stop" }])).toBe("stop");
  });

  it("returns undefined for multi-block or non-paragraph messages", () => {
    const multi: RichBlock[] = [
      { type: "paragraph", text: "stop" },
      { type: "paragraph", text: "more" },
    ];
    expect(stopCandidateFromBlocks(multi)).toBeUndefined();
    expect(stopCandidateFromBlocks([{ type: "code", code: "stop" }])).toBeUndefined();
    expect(stopCandidateFromBlocks([])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/gateway && pnpm exec vitest run test/stop-phrase.test.ts`
Expected failure: `../src/stop-phrase.ts` does not exist (import error).

- [ ] **Step 3: Write stop-phrase.ts**

Create `packages/gateway/src/stop-phrase.ts`:

```ts
import type { RichBlock } from "cozygateway-contract";

/** The deterministic whole-message hard-interrupt phrase set. Anything not in this set (after
 *  normalization) passes through as a normal message; the agent handles conversational
 *  stop-adjacent language itself. Independently implemented here: this repo shares no code with
 *  CozyLabs by design, so the spec set and vectors are transcribed, not imported. */
export const STOP_PHRASES: readonly string[] = ["stop", "stop it", "cancel", "abort"];

const STOP_SET = new Set(STOP_PHRASES);

/** trim whitespace, casefold, strip terminal [.!?]+ characters. */
export function normalizeStopCandidate(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/, "").trim();
}

/** Whole-message match only: the entire normalized message must equal one of STOP_PHRASES. */
export function isStopPhrase(text: string): boolean {
  return STOP_SET.has(normalizeStopCandidate(text));
}

/** The whole-message text to test, or undefined when the message is not a single paragraph block
 *  (a multi-block or non-paragraph message is never a stop phrase). */
export function stopCandidateFromBlocks(blocks: RichBlock[]): string | undefined {
  if (blocks.length !== 1) return undefined;
  const only = blocks[0];
  return only !== undefined && only.type === "paragraph" ? only.text : undefined;
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd packages/gateway && pnpm exec vitest run test/stop-phrase.test.ts`
Expected: green.

- [ ] **Step 5: Write the failing stop-integration test**

Append to `packages/gateway/test/turns.test.ts`:

```ts
describe("TurnRunner stop-phrase send path", () => {
  it("a whole-message stop interrupts the in-flight steer turn AND queues a normal next turn", async () => {
    const { storage, frames, runner } = steerSetup();
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "long task" }]);
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "draft"));

    // "stop" commits as a normal user message (delivery absent) and interrupts the in-flight turn.
    const stop = runner.submitUserMessage("t1", [{ type: "paragraph", text: "stop" }]);
    expect(stop.delivery).toBeUndefined();

    await untilFrames(frames, (fs) =>
      fs.some((f) => f.type === "committed" && f.message.marker === "turn.interrupted"),
    );
    // The stop message itself becomes the next queued turn (mock-steer draws "Working: stop").
    await untilFrames(frames, (fs) =>
      fs.some((f) => f.type === "draft" && f.blocks.some((b) => b.type === "paragraph" && b.text === "Working: stop")),
    );
    const users = storage.messagesSince("t1", 0).filter((m) => m.role === "user");
    expect(users.map((m) => m.delivery)).toEqual([undefined, undefined]);
  });

  it("a message that merely contains 'stop' steers instead of interrupting", async () => {
    const { frames, runner } = steerSetup();
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "one" }]);
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "draft"));
    const sent = runner.submitUserMessage("t1", [
      { type: "paragraph", text: "stop adding comments to every file" },
    ]);
    expect(sent.delivery).toBe("steer");
  });
});
```

- [ ] **Step 6: Run and confirm failure**

Run: `cd packages/gateway && pnpm exec vitest run test/turns.test.ts -t "stop-phrase"`
Expected failure: the "stop" send is treated as a steer (no `turn.interrupted`), so the first assertion fails.

- [ ] **Step 7: Add the stop branch to submitUserMessage**

In `packages/gateway/src/turns.ts`, add the import at the top:

```ts
import { isStopPhrase, stopCandidateFromBlocks } from "./stop-phrase.ts";
```

In `submitUserMessage`, insert the stop branch immediately after `agentName` is computed and before `const inflight = this.#inflight.get(threadId);`:

```ts
    // Stop-phrase detection (whole-message only). A match routes to the interrupt path AND still
    // commits the user message normally (delivery absent), so it becomes the next queued turn.
    const candidate = stopCandidateFromBlocks(blocks);
    if (candidate !== undefined && isStopPhrase(candidate)) {
      const active = this.#inflight.get(threadId);
      if (active !== undefined) this.#dispatchInterrupt(threadId, active);
      return this.#commitAndQueue(threadId, agentName, adapter, blocks);
    }
```

- [ ] **Step 8: Run and confirm pass**

Run: `cd packages/gateway && pnpm exec vitest run test/turns.test.ts test/stop-phrase.test.ts && pnpm typecheck`
Expected: green.

- [ ] **Step 9: Commit**

```
git add packages/gateway/src/stop-phrase.ts packages/gateway/src/turns.ts packages/gateway/test/stop-phrase.test.ts packages/gateway/test/turns.test.ts
git commit -m "turns: gateway-side stop-phrase detection routes to interrupt + queue"
```

---

### Task 6: Conformance coverage for the interrupt endpoint and delivery shape

**Files:**
- Modify: `packages/conformance/src/suite.ts` (add a describe block; the suite ends at line 798).
- Test host: `packages/conformance/test/reference-gateway.test.ts` runs it unchanged against the reference gateway (which now has the endpoint from Task 4).

**Interfaces:**
- Consumes: the running gateway's `POST /threads/:id/interrupt` (Task 4) and the additive `InterruptResponseSchema` / `MessageSchema.delivery` (Task 1). These assertions are portable: they test only contract-guaranteed behavior over the echo backend (idle interrupt is a no-op on every backend), never steer behavior (which the reference echo backend does not support).

- [ ] **Step 1: Write the failing conformance assertions**

In `packages/conformance/src/suite.ts`, add `InterruptResponseSchema` and `MessageSchema` to the import from `cozygateway-contract` (top of file, the existing multi-name import), then add this describe block just before the final closing `});` of `registerConformanceSuite` (after the "turn failure" block, before line 798):

```ts
    // Spec section 5: POST /threads/:id/interrupt. On an idle thread it is a no-op returning 204;
    // auth is required exactly as for every other route. Steer behavior is out of scope for the
    // portable suite (the reference echo backend is queue-only), so only the contract-level shape
    // and the idle no-op are asserted here.
    describe("mid-turn interrupt", () => {
      it(
        "POST interrupt without a token is 401 unauthorized",
        async () => {
          const res = await fetch(`${env.baseUrl()}/threads/anything/interrupt`, { method: "POST" });
          expect(res.status).toBe(401);
          expect(assertValid(ErrorBodySchema, await res.json()).error.code).toBe("unauthorized");
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "POST interrupt on a nonexistent thread is 404 not_found",
        async () => {
          const { token } = await pairDevice("interrupt-404");
          const res = await authFetch(token, "/threads/no-such-thread/interrupt", { method: "POST" });
          expect(res.status).toBe(404);
          expect(assertValid(ErrorBodySchema, await res.json()).error.code).toBe("not_found");
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "POST interrupt on an idle thread is 204 with no body",
        async () => {
          const { token } = await pairDevice("interrupt-idle");
          const thread = await createThread(token, "idle interrupt");
          const res = await authFetch(token, `/threads/${thread.id}/interrupt`, { method: "POST" });
          expect(res.status).toBe(204);
          expect(await res.text()).toBe("");
        },
        TEST_TIMEOUT_MS,
      );

      it("the InterruptResponse and delivery shapes are valid additive v1.x contract types", () => {
        // Pure schema checks: no backend dependency. A v1.0 client that predates delivery keeps
        // working because MessageSchema stays OPEN, and the 202 body shape is fixed.
        expect(check(InterruptResponseSchema, { status: "interrupting" })).toBe(true);
        const userMsg = {
          threadId: "t",
          seq: 1,
          role: "user" as const,
          blocks: [{ type: "paragraph", text: "x" }],
          delivery: "steer" as const,
          createdAt: 0,
        };
        expect(check(MessageSchema, userMsg)).toBe(true);
        const { delivery: _drop, ...withoutDelivery } = userMsg;
        expect(check(MessageSchema, withoutDelivery)).toBe(true);
      });
    });
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/conformance && pnpm exec vitest run`
Expected failure: the idle-interrupt case returns 404 unless Task 4 is already merged; if running the whole plan in order Task 4 is done, so the failure here is only the missing imports (`InterruptResponseSchema` / `MessageSchema` undefined). Add them (Step 1 already specifies the import edit); rerun.

- [ ] **Step 3: Run and confirm pass**

Run: `cd packages/conformance && pnpm exec vitest run`
Expected: the full conformance suite passes against the reference gateway, including the four new interrupt assertions.

- [ ] **Step 4: Commit**

```
git add packages/conformance/src/suite.ts
git commit -m "conformance: interrupt endpoint (401/404/204) + delivery shape coverage"
```

---

### Task 7: Attach protocol steer + interrupt frames and adapter wiring

**Files:**
- Modify: `packages/gateway/src/adapters/attach/protocol.ts` (append after `AttachTurnFrameSchema` at line 54).
- Modify: `packages/gateway/src/adapters/attach/ingress.ts` (imports at line 8; `sendTurn` at lines 117-124).
- Modify: `packages/gateway/src/adapters/attach/adapter.ts` (`TurnEndpoint` at lines 12-15; imports at line 7; `createAttachAdapter` `turns`/`settle` at lines 103-115; the session object at lines 121-152; `midTurnDelivery: "steer"` was added in Task 2 Step 6).
- Modify: `contract/attach-v0.md` (Gateway to plugin frames, current section ends around line 45).
- Test: `packages/gateway/test/attach-adapter.test.ts` (`FakeEndpoint` at lines 89-106; append adapter steer/interrupt tests).
- Test: `packages/gateway/test/attach-e2e.test.ts` (append steer + interrupt e2e).

**Interfaces:**
- Produces: `AttachSteerFrame = { kind: "steer"; threadId: string; turnId: string; text: string }`, `AttachInterruptFrame = { kind: "interrupt"; threadId: string; turnId: string }`, and `AttachOutboundFrameSchema` union. `TurnEndpoint.sendSteer(agentId, frame): boolean` and `TurnEndpoint.sendInterrupt(agentId, frame): boolean`. The attach `BackendSession` gains `steer(blocks)` (sends a steer frame under the in-flight turnId) and `interrupt()` (sends an interrupt frame and fails the in-flight turn so the runner records `turn.interrupted`).

- [ ] **Step 1: Write the failing protocol test**

Append to `packages/gateway/test/attach-protocol.test.ts` (mirror its existing `check`-based style; if the file imports differ, add the needed imports):

```ts
import { describe, expect, it } from "vitest";
import { check } from "cozygateway-contract";

import {
  AttachInterruptFrameSchema,
  AttachOutboundFrameSchema,
  AttachSteerFrameSchema,
} from "../src/adapters/attach/protocol.ts";

describe("attach outbound steer/interrupt frames", () => {
  it("accepts a well-formed steer frame and rejects a missing turnId", () => {
    expect(check(AttachSteerFrameSchema, { kind: "steer", threadId: "t", turnId: "u", text: "hi" })).toBe(true);
    expect(check(AttachSteerFrameSchema, { kind: "steer", threadId: "t", text: "hi" })).toBe(false);
  });

  it("accepts a well-formed interrupt frame and rejects a wrong kind", () => {
    expect(check(AttachInterruptFrameSchema, { kind: "interrupt", threadId: "t", turnId: "u" })).toBe(true);
    expect(check(AttachInterruptFrameSchema, { kind: "steer", threadId: "t", turnId: "u" })).toBe(false);
  });

  it("the outbound union accepts turn, steer, and interrupt frames", () => {
    expect(check(AttachOutboundFrameSchema, { kind: "turn", threadId: "t", turnId: "u", text: "x" })).toBe(true);
    expect(check(AttachOutboundFrameSchema, { kind: "steer", threadId: "t", turnId: "u", text: "x" })).toBe(true);
    expect(check(AttachOutboundFrameSchema, { kind: "interrupt", threadId: "t", turnId: "u" })).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/gateway && pnpm exec vitest run test/attach-protocol.test.ts`
Expected failure: `AttachSteerFrameSchema` / `AttachInterruptFrameSchema` / `AttachOutboundFrameSchema` are not exported.

- [ ] **Step 3: Add the frames to protocol.ts**

Append to `packages/gateway/src/adapters/attach/protocol.ts`:

```ts
/** Gateway-to-plugin: deliver blocks mid-turn into an in-flight turn (native steer). Carries the
 *  EXISTING turnId so the continuing reply still anchors to the original turn. */
export const AttachSteerFrameSchema = Type.Object({
  kind: Type.Literal("steer"),
  threadId: Type.String({ minLength: 1 }),
  turnId: Type.String({ minLength: 1 }),
  text: Type.String(),
});
export type AttachSteerFrame = Static<typeof AttachSteerFrameSchema>;

/** Gateway-to-plugin: hard-interrupt an in-flight turn (native interrupt). No content. */
export const AttachInterruptFrameSchema = Type.Object({
  kind: Type.Literal("interrupt"),
  threadId: Type.String({ minLength: 1 }),
  turnId: Type.String({ minLength: 1 }),
});
export type AttachInterruptFrame = Static<typeof AttachInterruptFrameSchema>;

/** The closed set of gateway-to-plugin frames. Objects stay open, but an unknown `kind` is
 *  invalid, mirroring the inbound stance. */
export const AttachOutboundFrameSchema = Type.Union([
  AttachTurnFrameSchema,
  AttachSteerFrameSchema,
  AttachInterruptFrameSchema,
]);
export type AttachOutboundFrame = Static<typeof AttachOutboundFrameSchema>;
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd packages/gateway && pnpm exec vitest run test/attach-protocol.test.ts`
Expected: green.

- [ ] **Step 5: Add sendSteer/sendInterrupt to the ingress**

In `packages/gateway/src/adapters/attach/ingress.ts`, change the import at line 8 to add the frame types:

```ts
import {
  AttachInboundFrameSchema,
  type AttachInterruptFrame,
  type AttachSteerFrame,
  type AttachTurnFrame,
  type AttachUpdate,
} from "./protocol.ts";
```

Replace `sendTurn` (lines 117-124) with a shared sender plus three public methods:

```ts
  #send(agentId: string, frame: AttachTurnFrame | AttachSteerFrame | AttachInterruptFrame): boolean {
    const socket = this.#current.get(agentId);
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  /** Deliver a turn frame to the agent's live connection. False when there is none (the adapter
   *  fails the turn fast rather than queueing). */
  sendTurn(agentId: string, frame: AttachTurnFrame): boolean {
    return this.#send(agentId, frame);
  }

  /** Deliver a steer frame (mid-turn injection). False when no live connection. */
  sendSteer(agentId: string, frame: AttachSteerFrame): boolean {
    return this.#send(agentId, frame);
  }

  /** Deliver an interrupt frame (native stop). False when no live connection. */
  sendInterrupt(agentId: string, frame: AttachInterruptFrame): boolean {
    return this.#send(agentId, frame);
  }
```

- [ ] **Step 6: Wire steer/interrupt into the attach adapter**

In `packages/gateway/src/adapters/attach/adapter.ts`, change the protocol import (line 7) to add the frame types:

```ts
import type {
  AttachInterruptFrame,
  AttachSteerFrame,
  AttachTurnFrame,
  AttachUpdate,
} from "./protocol.ts";
```

Extend the `TurnEndpoint` interface (lines 12-15):

```ts
export interface TurnEndpoint {
  isAttached(agentId: string): boolean;
  sendTurn(agentId: string, frame: AttachTurnFrame): boolean;
  sendSteer(agentId: string, frame: AttachSteerFrame): boolean;
  sendInterrupt(agentId: string, frame: AttachInterruptFrame): boolean;
}
```

Inside `createAttachAdapter`, add a thread-to-turn index next to `const turns = ...` (line 103):

```ts
  const turns = new Map<string, InflightTurn>();
  // One in-flight turn per thread (the runner serializes per thread); steer/interrupt look the
  // active turnId up by threadId.
  const inflightByThread = new Map<string, string>();
```

Replace `settle` (lines 105-111) so it also clears the thread index:

```ts
  const settle = (turnId: string): InflightTurn | undefined => {
    const turn = turns.get(turnId);
    if (turn === undefined) return undefined;
    turns.delete(turnId);
    if (inflightByThread.get(turn.threadId) === turnId) inflightByThread.delete(turn.threadId);
    clearTimeout(turn.timer);
    return turn;
  };
```

In the session's `send` (lines 122-150), record the thread index right after `turns.set(turnId, {...})`:

```ts
            turns.set(turnId, { threadId, handlers, latest: undefined, timer, resolve, reject });
            inflightByThread.set(threadId, turnId);
```

Add `steer` and `interrupt` to the returned session object (after `send`, before `async close()` at line 151):

```ts
        async steer(steerBlocks: RichBlock[]): Promise<void> {
          const turnId = inflightByThread.get(threadId);
          if (turnId === undefined) return; // race: no in-flight turn for this thread
          // The plugin injects this as another inbound message; with the agent-side Hermes config
          // busy_input_mode=steer, injection steers the running turn natively. The reply continues
          // under the EXISTING turnId (no new turn), so no local turn bookkeeping changes here.
          deps.endpoint.sendSteer(deps.agentId, {
            kind: "steer",
            threadId,
            turnId,
            text: blocksToText(steerBlocks),
          });
        },
        async interrupt(): Promise<void> {
          const turnId = inflightByThread.get(threadId);
          if (turnId === undefined) return;
          // Fire the native interrupt to the plugin (best-effort), then fail the in-flight turn so
          // the runner (which set its interrupting flag first) records turn.interrupted.
          try {
            deps.endpoint.sendInterrupt(deps.agentId, { kind: "interrupt", threadId, turnId });
          } catch {
            // a socket write failure still proceeds to fail the turn locally
          }
          failTurn(turnId, "interrupted by user");
        },
```

- [ ] **Step 7: Write the failing adapter steer/interrupt tests**

In `packages/gateway/test/attach-adapter.test.ts`, extend `FakeEndpoint` and `fakeEndpoint` (lines 89-106) to capture the new frames:

```ts
interface FakeEndpoint extends TurnEndpoint {
  attached: boolean;
  frames: AttachTurnFrame[];
  steerFrames: AttachSteerFrame[];
  interruptFrames: AttachInterruptFrame[];
}

function fakeEndpoint(): FakeEndpoint {
  const endpoint: FakeEndpoint = {
    attached: true,
    frames: [],
    steerFrames: [],
    interruptFrames: [],
    isAttached: () => endpoint.attached,
    sendTurn: (_agentId, frame) => {
      if (!endpoint.attached) return false;
      endpoint.frames.push(frame);
      return true;
    },
    sendSteer: (_agentId, frame) => {
      if (!endpoint.attached) return false;
      endpoint.steerFrames.push(frame);
      return true;
    },
    sendInterrupt: (_agentId, frame) => {
      if (!endpoint.attached) return false;
      endpoint.interruptFrames.push(frame);
      return true;
    },
  };
  return endpoint;
}
```

Add the type imports at the top (extend the existing `./protocol.ts` import):

```ts
import type {
  AttachInterruptFrame,
  AttachSteerFrame,
  AttachTurnFrame,
} from "../src/adapters/attach/protocol.ts";
```

Append these tests inside `describe("createAttachAdapter", ...)`:

```ts
  it("declares steer mid-turn delivery", () => {
    const adapter = createAttachAdapter({ agentId: "a1", endpoint: fakeEndpoint(), turnTimeoutMs: 1_000 });
    expect(adapter.midTurnDelivery).toBe("steer");
  });

  it("steer sends a steer frame under the in-flight turnId without settling the turn", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const { session, turn, observed, frame } = await startTurn(adapter, endpoint, "t1");
    await session.steer?.([{ type: "paragraph", text: "also do X" }]);

    expect(endpoint.steerFrames).toEqual([
      { kind: "steer", threadId: "t1", turnId: frame.turnId, text: "also do X" },
    ]);
    // The turn is still in flight: a later draft + done still commits.
    adapter.handleUpdate("t1", {
      kind: "draft",
      turnId: frame.turnId,
      blocks: [{ type: "paragraph", text: "did X" }],
    });
    adapter.handleUpdate("t1", { kind: "done", turnId: frame.turnId });
    await turn;
    expect(observed.commits).toEqual([[{ type: "paragraph", text: "did X" }]]);
  });

  it("interrupt sends an interrupt frame and rejects the in-flight turn", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const { session, turn, frame } = await startTurn(adapter, endpoint, "t1");
    await session.interrupt?.();
    expect(endpoint.interruptFrames).toEqual([{ kind: "interrupt", threadId: "t1", turnId: frame.turnId }]);
    await expect(turn).rejects.toThrow(/interrupted/);
  });

  it("steer and interrupt are no-ops when no turn is in flight for the thread", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const session = await adapter.startSession("t1");
    await session.steer?.([{ type: "paragraph", text: "x" }]);
    await session.interrupt?.();
    expect(endpoint.steerFrames).toHaveLength(0);
    expect(endpoint.interruptFrames).toHaveLength(0);
  });
```

- [ ] **Step 8: Run and confirm the adapter tests pass**

Run: `cd packages/gateway && pnpm exec vitest run test/attach-adapter.test.ts && pnpm typecheck`
Expected: green (Steps 3, 5, 6 make them pass).

- [ ] **Step 9: Add the steer + interrupt e2e**

Append to `packages/gateway/test/attach-e2e.test.ts` inside `describe("attach backend end to end", ...)`. This reuses the file's existing `pairDevice`, `createThread`, `openClientWs`, `until`, and `attachFakeHarness` helpers; add a steer-aware harness inline:

```ts
  it("delivers a mid-turn steer to the harness and commits the continued reply", async () => {
    const deviceToken = await pairDevice();
    const frames: ServerFrame[] = [];
    await openClientWs(deviceToken, frames);

    // A harness that answers a turn with one draft then hangs, and on a steer frame finishes the
    // turn with a final draft (echoing the steer text) + done under the same turnId.
    const harness = track(
      new WebSocket(`${gateway.url.replace("http", "ws")}/attach`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    await once(harness, "open");
    harness.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { kind: string; threadId: string; turnId: string; text?: string };
      const send = (update: unknown) => harness.send(JSON.stringify({ threadId: frame.threadId, update }));
      if (frame.kind === "turn") {
        send({ kind: "draft", turnId: frame.turnId, blocks: [{ type: "paragraph", text: "working" }] });
      } else if (frame.kind === "steer") {
        send({ kind: "draft", turnId: frame.turnId, blocks: [{ type: "paragraph", text: `ok: ${frame.text}` }] });
        send({ kind: "done", turnId: frame.turnId });
      }
    });
    await until(() => frames.some((f) => f.type === "presence" && f.state === "online"));

    const threadId = await createThread(deviceToken);
    await fetch(`${gateway.url}/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "start" }] }),
    });
    await until(() => frames.some((f) => f.type === "draft"));

    // Mid-turn send: routes to steer (attach declares steer), committed with delivery "steer".
    await fetch(`${gateway.url}/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "also Y" }] }),
    });
    await until(() => frames.some((f) => f.type === "done"));

    const committed = frames.filter(
      (f): f is Extract<ServerFrame, { type: "committed" }> => f.type === "committed",
    );
    const steered = committed.map((f) => f.message).find((m) => m.role === "user" && m.delivery === "steer");
    expect(steered).toBeDefined();
    const agentReply = committed.map((f) => f.message).find((m) => m.role === "agent");
    expect(agentReply?.blocks).toEqual([{ type: "paragraph", text: "ok: also Y" }]);
    // All drafts and the agent commit share one turnId (no new turn was minted for the steer).
    const turnIds = new Set(
      frames.filter((f) => f.type === "draft").map((f) => (f.type === "draft" ? f.turnId : "")),
    );
    expect(turnIds.size).toBe(1);
  });

  it("interrupts an in-flight attach turn into a turn.interrupted marker plus done", async () => {
    const deviceToken = await pairDevice();
    const frames: ServerFrame[] = [];
    await openClientWs(deviceToken, frames);

    // A harness that answers with one draft and then hangs (never done): the interrupt is what
    // ends the turn.
    const harness = track(
      new WebSocket(`${gateway.url.replace("http", "ws")}/attach`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    await once(harness, "open");
    harness.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { kind: string; threadId: string; turnId: string };
      if (frame.kind === "turn") {
        harness.send(
          JSON.stringify({
            threadId: frame.threadId,
            update: { kind: "draft", turnId: frame.turnId, blocks: [{ type: "paragraph", text: "thinking" }] },
          }),
        );
      }
    });
    await until(() => frames.some((f) => f.type === "presence" && f.state === "online"));

    const threadId = await createThread(deviceToken);
    await fetch(`${gateway.url}/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "run forever" }] }),
    });
    await until(() => frames.some((f) => f.type === "draft"));

    const res = await fetch(`${gateway.url}/threads/${threadId}/interrupt`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.status).toBe(202);
    await until(() => frames.some((f) => f.type === "done"));

    const history = await fetch(`${gateway.url}/threads/${threadId}/messages`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const body = (await history.json()) as { messages: Message[] };
    expect(body.messages.some((m) => m.marker === "turn.interrupted")).toBe(true);
    expect(body.messages.some((m) => m.role === "agent")).toBe(false);
    expect(frames.some((f) => f.type === "error")).toBe(false);
  });
```

- [ ] **Step 10: Run the e2e and confirm pass**

Run: `cd packages/gateway && pnpm exec vitest run test/attach-e2e.test.ts`
Expected: green.

- [ ] **Step 11: Document the new frames in contract/attach-v0.md**

In `contract/attach-v0.md`, under "### Gateway to plugin", after the turn frame block, add:

```
Steer (mid-turn injection into the in-flight turn):

    {"kind": "steer", "threadId": "<id>", "turnId": "<id>", "text": "<prompt text>"}

- Sent only while a turn is already in flight for `threadId`. It carries the SAME `turnId` as the
  in-flight turn; the plugin injects `text` as another inbound message so the harness steers the
  running turn natively (agent-side `busy_input_mode: steer`). The continued reply keeps streaming
  under the original `turnId`; the plugin does NOT start a new turn or seal anything for the steer.

Interrupt (hard stop of the in-flight turn):

    {"kind": "interrupt", "threadId": "<id>", "turnId": "<id>"}

- Sent to stop the in-flight turn (the harness's native interrupt). The gateway independently fails
  the turn on its side and records a `turn.interrupted` system message, so the plugin need only
  trigger the native stop; any late frames for `turnId` are dropped by the gateway.
```

- [ ] **Step 12: Full gateway gate and commit**

Run: `pnpm --filter cozygateway test && pnpm --filter cozygateway typecheck`
Expected: green.
Commit:
```
git add packages/gateway/src/adapters/attach contract/attach-v0.md packages/gateway/test/attach-adapter.test.ts packages/gateway/test/attach-e2e.test.ts packages/gateway/test/attach-protocol.test.ts
git commit -m "attach: steer + interrupt frames and adapter session methods"
```

---

### Task 8: Reference Python plugin steer + interrupt support

**Files:**
- Modify: `integrations/attach-plugin/cozygateway/attach_client.py` (`parse_turn_frame` at lines 198-215, `AttachClientConfig` at lines 218-233, `_dispatch_inbound` at lines 364-380).
- Modify: `integrations/attach-plugin/cozygateway/adapter.py` (imports at lines 36-42, `connect` AttachClientConfig at lines 199-206, add methods near `_on_turn` at lines 306-329).
- Test: `integrations/attach-plugin/tests/test_inbound_frames.py` (new file, stdlib `unittest`, harness-free).

**Interfaces:**
- Produces: `SteerFrame(thread_id, turn_id, text)`, `InterruptFrame(thread_id, turn_id)`, `parse_steer_frame(frame) -> Optional[SteerFrame]`, `parse_interrupt_frame(frame) -> Optional[InterruptFrame]`, `AttachClientConfig.on_steer` / `.on_interrupt`. `_dispatch_inbound` routes `kind` in `{turn, steer, interrupt}` to the matching handler and drops anything else.
- Note: the harness-coupled injection (`_handle_steer` via `handle_message`, `_handle_interrupt` via the native interrupt seam) is validated by the live suite, not unit tests, exactly as `_handle_turn` is today. The unit tests cover only the harness-free client parsing and dispatch.

- [ ] **Step 1: Write the failing unittest**

Create `integrations/attach-plugin/tests/test_inbound_frames.py`:

```python
"""Harness-free tests for inbound steer/interrupt frame parsing and dispatch.

Run with:
    cd integrations/attach-plugin && python3 -m unittest tests.test_inbound_frames -v
"""

import json
import unittest

from cozygateway.attach_client import (
    AttachClient,
    AttachClientConfig,
    InterruptFrame,
    SteerFrame,
    parse_interrupt_frame,
    parse_steer_frame,
)


class ParseSteerFrameTests(unittest.TestCase):
    def test_valid_steer_frame(self):
        frame = parse_steer_frame({"kind": "steer", "threadId": "t", "turnId": "u", "text": "hi"})
        self.assertEqual(frame, SteerFrame(thread_id="t", turn_id="u", text="hi"))

    def test_rejects_wrong_kind_or_missing_fields(self):
        self.assertIsNone(parse_steer_frame({"kind": "turn", "threadId": "t", "turnId": "u", "text": "x"}))
        self.assertIsNone(parse_steer_frame({"kind": "steer", "threadId": "t", "turnId": "u"}))
        self.assertIsNone(parse_steer_frame({"kind": "steer", "threadId": "", "turnId": "u", "text": "x"}))
        self.assertIsNone(parse_steer_frame("nope"))


class ParseInterruptFrameTests(unittest.TestCase):
    def test_valid_interrupt_frame(self):
        frame = parse_interrupt_frame({"kind": "interrupt", "threadId": "t", "turnId": "u"})
        self.assertEqual(frame, InterruptFrame(thread_id="t", turn_id="u"))

    def test_rejects_wrong_kind_or_missing_fields(self):
        self.assertIsNone(parse_interrupt_frame({"kind": "steer", "threadId": "t", "turnId": "u"}))
        self.assertIsNone(parse_interrupt_frame({"kind": "interrupt", "threadId": "t"}))


class DispatchRoutingTests(unittest.TestCase):
    def _client(self):
        self.turns = []
        self.steers = []
        self.interrupts = []
        config = AttachClientConfig(
            gateway_url="http://gw.example",
            token="secret",
            on_turn=self.turns.append,
            on_steer=self.steers.append,
            on_interrupt=self.interrupts.append,
        )
        return AttachClient(config)

    def test_routes_each_kind_to_its_handler(self):
        client = self._client()
        client._dispatch_inbound(json.dumps({"kind": "turn", "threadId": "t", "turnId": "u", "text": "hi"}))
        client._dispatch_inbound(json.dumps({"kind": "steer", "threadId": "t", "turnId": "u", "text": "more"}))
        client._dispatch_inbound(json.dumps({"kind": "interrupt", "threadId": "t", "turnId": "u"}))
        self.assertEqual([t.text for t in self.turns], ["hi"])
        self.assertEqual([s.text for s in self.steers], ["more"])
        self.assertEqual([(i.thread_id, i.turn_id) for i in self.interrupts], [("t", "u")])

    def test_unknown_kind_and_malformed_json_are_dropped(self):
        client = self._client()
        client._dispatch_inbound(json.dumps({"kind": "mystery", "threadId": "t"}))
        client._dispatch_inbound("{not json")
        self.assertEqual(self.turns, [])
        self.assertEqual(self.steers, [])
        self.assertEqual(self.interrupts, [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd integrations/attach-plugin && python3 -m unittest tests.test_inbound_frames -v`
Expected failure: `ImportError` for `SteerFrame` / `parse_steer_frame` (not defined yet).

- [ ] **Step 3: Add the dataclasses and parsers to attach_client.py**

In `integrations/attach-plugin/cozygateway/attach_client.py`, append after `parse_turn_frame` (line 215):

```python
@dataclass
class SteerFrame:
    """A parsed inbound ``steer`` frame: inject text into the running turn ``turn_id`` on
    ``thread_id``. Carries the SAME ``turn_id`` as the in-flight turn."""

    thread_id: str
    turn_id: str
    text: str


@dataclass
class InterruptFrame:
    """A parsed inbound ``interrupt`` frame: hard-stop the running turn ``turn_id`` on
    ``thread_id``."""

    thread_id: str
    turn_id: str


def parse_steer_frame(frame: Any) -> Optional[SteerFrame]:
    """Parse a decoded inbound frame into a :class:`SteerFrame`, or None to drop it."""
    if not isinstance(frame, dict) or frame.get("kind") != "steer":
        return None
    thread_id = frame.get("threadId")
    turn_id = frame.get("turnId")
    text = frame.get("text")
    if not isinstance(thread_id, str) or not thread_id:
        return None
    if not isinstance(turn_id, str) or not turn_id:
        return None
    if not isinstance(text, str):
        return None
    return SteerFrame(thread_id=thread_id, turn_id=turn_id, text=text)


def parse_interrupt_frame(frame: Any) -> Optional[InterruptFrame]:
    """Parse a decoded inbound frame into an :class:`InterruptFrame`, or None to drop it."""
    if not isinstance(frame, dict) or frame.get("kind") != "interrupt":
        return None
    thread_id = frame.get("threadId")
    turn_id = frame.get("turnId")
    if not isinstance(thread_id, str) or not thread_id:
        return None
    if not isinstance(turn_id, str) or not turn_id:
        return None
    return InterruptFrame(thread_id=thread_id, turn_id=turn_id)
```

Extend `AttachClientConfig` (lines 218-233) by adding two fields after `on_turn`:

```python
    on_steer: Optional[Callable[[SteerFrame], None]] = None
    on_interrupt: Optional[Callable[[InterruptFrame], None]] = None
```

Replace `_dispatch_inbound` (lines 364-380) with a kind-routing dispatcher:

```python
    @staticmethod
    def _safe_call(handler: Callable[[Any], None], arg: Any) -> None:
        try:
            handler(arg)
        except Exception:  # noqa: BLE001 - a handler error must never kill the drain loop
            logger.debug("attach: inbound handler raised", exc_info=True)

    def _dispatch_inbound(self, raw: Any) -> None:
        try:
            frame = json.loads(raw)
        except Exception:  # noqa: BLE001 - malformed inbound frame, drop
            logger.debug("attach: dropping non-JSON inbound frame")
            return
        kind = frame.get("kind") if isinstance(frame, dict) else None
        if kind == "turn":
            turn = parse_turn_frame(frame)
            if turn is not None and self._config.on_turn is not None:
                self._safe_call(self._config.on_turn, turn)
            return
        if kind == "steer":
            steer = parse_steer_frame(frame)
            if steer is not None and self._config.on_steer is not None:
                self._safe_call(self._config.on_steer, steer)
            return
        if kind == "interrupt":
            interrupt = parse_interrupt_frame(frame)
            if interrupt is not None and self._config.on_interrupt is not None:
                self._safe_call(self._config.on_interrupt, interrupt)
            return
        logger.debug("attach: dropping unknown/malformed inbound frame")
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd integrations/attach-plugin && python3 -m unittest tests.test_inbound_frames -v`
Expected: green.

- [ ] **Step 5: Wire the handlers into the adapter**

In `integrations/attach-plugin/cozygateway/adapter.py`, extend the import (lines 36-42) to add the frame types:

```python
from .attach_client import (
    AttachAuthError,
    AttachClient,
    AttachClientConfig,
    AttachSupersededError,
    InterruptFrame,
    SteerFrame,
    TurnFrame,
)
```

In `connect` (lines 199-206), add the two callbacks to the `AttachClientConfig`:

```python
        self._client = AttachClient(
            AttachClientConfig(
                gateway_url=self.gateway_url,
                token=self.token,
                ca_file=self.ca_file,
                on_turn=self._on_turn,
                on_steer=self._on_steer,
                on_interrupt=self._on_interrupt,
            )
        )
```

Add these methods immediately after `_handle_turn` (after line 357):

```python
    # -- mid-turn steer -------------------------------------------------------
    def _on_steer(self, frame: SteerFrame) -> None:
        """Bound to the client's ``on_steer``: schedule the injection as a task."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._spawn_background(loop, self._handle_steer(frame))

    async def _handle_steer(self, frame: SteerFrame) -> None:
        """Inject a mid-turn steer as another inbound message on the same thread.

        Deliberately does NOT touch ``_active_turn``, ``_seen_turns``, or seal anything: with the
        agent-side config ``busy_input_mode=steer``, the harness's busy handler routes this
        injection into the running turn natively, and the continued reply keeps streaming under
        the original ``turn_id`` (still held in ``_active_turn[thread_id]``).
        """
        from gateway.platforms.base import MessageEvent  # harness-defined identifier

        source = self.build_source(  # type: ignore[attr-defined]
            chat_id=frame.thread_id,
            chat_type="dm",
            user_name=INBOUND_USER,
            user_id=INBOUND_USER,
            role_authorized=True,
        )
        # A distinct message_id for the injected message; the running turn's reply anchor is left
        # untouched so continued drafts still anchor to the original turn.
        event = MessageEvent(text=frame.text, source=source, message_id=f"{frame.turn_id}:steer")
        try:
            await self.handle_message(event)  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001 - a steer must never crash the drain loop
            logger.debug("attach: steer injection raised", exc_info=True)

    # -- hard interrupt -------------------------------------------------------
    def _on_interrupt(self, frame: InterruptFrame) -> None:
        """Bound to the client's ``on_interrupt``: schedule the native stop as a task."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._spawn_background(loop, self._handle_interrupt(frame))

    async def _handle_interrupt(self, frame: InterruptFrame) -> None:
        """Trigger the harness's native interrupt for the thread's running turn.

        The gateway independently records ``turn.interrupted`` on its side, so this only needs to
        stop the live run. The interrupt seam is harness-provided and imported lazily so this
        module stays importable without the harness (mirrors ``_handle_turn``). A harness build
        without an interrupt seam degrades to a best-effort no-op.
        """
        try:
            from gateway.run import interrupt_session  # harness-defined identifier
        except Exception:  # noqa: BLE001 - no native interrupt seam in this harness build
            logger.debug("attach: native interrupt unavailable", exc_info=True)
            return
        try:
            await interrupt_session(frame.thread_id)
        except Exception:  # noqa: BLE001 - best-effort stop
            logger.debug("attach: interrupt raised", exc_info=True)
```

- [ ] **Step 6: Run the whole plugin suite and commit**

Run: `cd integrations/attach-plugin && python3 -m unittest discover -s tests -v`
Expected: the full suite (existing tests plus `test_inbound_frames`) passes; the package still imports with no harness on the path (all harness imports stay lazy).
Commit:
```
git add integrations/attach-plugin/cozygateway/attach_client.py integrations/attach-plugin/cozygateway/adapter.py integrations/attach-plugin/tests/test_inbound_frames.py
git commit -m "attach-plugin: parse and dispatch steer + interrupt frames"
```

---

### Task 9: OpenClaw honest queue + unsupported interrupt

**Files:**
- Modify: `packages/gateway/src/adapters/openclaw/adapter.ts` (return object at line 76-80; `midTurnDelivery: "queue"` was added as a placeholder in Task 2 Step 6, confirmed real here).
- Test: `packages/gateway/test/openclaw-adapter.test.ts` (reuses the existing `FakeOpenClawClient`; append a describe block).

**Interfaces:**
- Consumes: `createOpenClawAdapter` and `FakeOpenClawClient` (existing in the test file); the generic queue-only interrupt behavior lives in `TurnRunner.#dispatchInterrupt` (Task 3), which emits `interrupt_unsupported` for ANY adapter whose session exposes no `interrupt`. This task proves OpenClaw is exactly that: `midTurnDelivery: "queue"` and a session with no `steer`/`interrupt`.

- [ ] **Step 1: Write the failing declaration test**

Append to `packages/gateway/test/openclaw-adapter.test.ts`:

```ts
describe("openclaw mid-turn delivery capability", () => {
  it("declares queue and exposes no steer/interrupt on its session", async () => {
    const client = new FakeOpenClawClient();
    const adapter = createOpenClawAdapter({
      agentId: "oc1",
      client,
      turnTimeoutMs: DEFAULT_TURN_TIMEOUT_SECONDS * 1000,
    });
    expect(adapter.midTurnDelivery).toBe("queue");
    const session = await adapter.startSession("t1");
    expect(session.steer).toBeUndefined();
    expect(session.interrupt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and confirm status**

Run: `cd packages/gateway && pnpm exec vitest run test/openclaw-adapter.test.ts`
Expected: if the Task 2 Step 6 placeholder is present, `midTurnDelivery` already equals `"queue"` and the session already exposes no steer/interrupt, so this test passes immediately (it is the regression guard that pins the honest declaration). If the placeholder was not added, `midTurnDelivery` is `undefined` and the test fails; then apply Step 3.

- [ ] **Step 3: Confirm the declaration in the adapter**

In `packages/gateway/src/adapters/openclaw/adapter.ts`, the returned adapter object (lines 76-80) must read:

```ts
  return {
    backend: "openclaw",
    midTurnDelivery: "queue",

    presence(): PresenceState {
      return deps.client.state() === "online" ? "online" : "absent";
    },
```

The session returned by `startSession` (lines 86-194) is unchanged: it exposes only `send` and `close`, so `TurnRunner` treats it as queue-only. A mid-turn interrupt against it (via `POST /interrupt` or a stop phrase) yields a clean `interrupt_unsupported` error frame through `TurnRunner.#dispatchInterrupt` (already covered by the queue-only interrupt test in Task 3).

- [ ] **Step 4: Run and commit**

Run: `cd packages/gateway && pnpm exec vitest run test/openclaw-adapter.test.ts && pnpm typecheck`
Expected: green.
Commit:
```
git add packages/gateway/src/adapters/openclaw/adapter.ts packages/gateway/test/openclaw-adapter.test.ts
git commit -m "openclaw: declare queue mid-turn delivery (interrupt stays honestly unsupported)"
```

---

### Task 10: Configurable bind host + env overrides (Docker prerequisite)

**Files:**
- Modify: `packages/gateway/src/config.ts` (`GatewayConfigSchema` at lines 15-25; append `applyEnvOverrides`).
- Modify: `packages/gateway/src/server.ts` (the `serve({...})` call at line 147).
- Modify: `packages/gateway/src/cli.ts` (`serve` at lines 19-29 and `pair` at lines 31-41).
- Test: `packages/gateway/test/config.test.ts` (append a describe block).

**Interfaces:**
- Produces: `GatewayConfig.host?: string` (optional; server binds `config.host ?? "127.0.0.1"`, preserving today's loopback-only default). New `applyEnvOverrides(config: GatewayConfig, env: Record<string, string | undefined>): GatewayConfig` applying `COZYGATEWAY_HOST`, `COZYGATEWAY_PORT`, `COZYGATEWAY_DB_PATH`. The attach token stays env-sourced via `options.tokenEnv` (no code change); the compose config names it `COZYGATEWAY_ATTACH_TOKEN`.
- Rationale: a container that binds `127.0.0.1` is unreachable through a published port, so the compose deploy needs `0.0.0.0`. The default stays `127.0.0.1` so nothing about the current single-box security posture changes unless the operator opts in.

- [ ] **Step 1: Write the failing config tests**

Append to `packages/gateway/test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { applyEnvOverrides, type GatewayConfig } from "../src/config.ts";

const base: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: "cozygateway.db",
  agents: [{ id: "echo", name: "Echo", backend: "mock" }],
};

describe("applyEnvOverrides", () => {
  it("overrides host, port, and dbPath from the environment", () => {
    const next = applyEnvOverrides(base, {
      COZYGATEWAY_HOST: "0.0.0.0",
      COZYGATEWAY_PORT: "9000",
      COZYGATEWAY_DB_PATH: "/data/cozygateway.db",
    });
    expect(next.host).toBe("0.0.0.0");
    expect(next.port).toBe(9000);
    expect(next.dbPath).toBe("/data/cozygateway.db");
    // The original is not mutated.
    expect(base.host).toBeUndefined();
    expect(base.port).toBe(8787);
  });

  it("leaves the config unchanged when the env vars are unset or empty", () => {
    expect(applyEnvOverrides(base, {})).toEqual(base);
    expect(applyEnvOverrides(base, { COZYGATEWAY_HOST: "", COZYGATEWAY_PORT: "" })).toEqual(base);
  });

  it("throws on a non-integer or out-of-range COZYGATEWAY_PORT", () => {
    expect(() => applyEnvOverrides(base, { COZYGATEWAY_PORT: "not-a-port" })).toThrow(/COZYGATEWAY_PORT/);
    expect(() => applyEnvOverrides(base, { COZYGATEWAY_PORT: "70000" })).toThrow(/COZYGATEWAY_PORT/);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/gateway && pnpm exec vitest run test/config.test.ts`
Expected failure: `applyEnvOverrides` is not exported.

- [ ] **Step 3: Add host to the schema and applyEnvOverrides**

In `packages/gateway/src/config.ts`, add a `host` field to `GatewayConfigSchema` (inside the object at lines 15-25, after `port`):

```ts
  host: Type.Optional(Type.String({ minLength: 1 })),
```

Append `applyEnvOverrides` to the end of the file:

```ts
/** Apply container-friendly environment overrides on top of a loaded config. Only host, port, and
 *  dbPath are env-driven; everything else (name, agents, capabilities, and the attach token, whose
 *  env var NAME lives in options.tokenEnv) comes from the config file. Returns a new object; the
 *  input is not mutated. */
export function applyEnvOverrides(
  config: GatewayConfig,
  env: Record<string, string | undefined>,
): GatewayConfig {
  const next: GatewayConfig = { ...config };
  const host = env["COZYGATEWAY_HOST"];
  if (host !== undefined && host.length > 0) next.host = host;
  const portRaw = env["COZYGATEWAY_PORT"];
  if (portRaw !== undefined && portRaw.length > 0) {
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid COZYGATEWAY_PORT "${portRaw}"`);
    }
    next.port = port;
  }
  const dbPath = env["COZYGATEWAY_DB_PATH"];
  if (dbPath !== undefined && dbPath.length > 0) next.dbPath = dbPath;
  return next;
}
```

- [ ] **Step 4: Bind the configured host in server.ts**

In `packages/gateway/src/server.ts`, change the `serve` call (line 147) from `hostname: "127.0.0.1"` to:

```ts
    const s = serve({ fetch: app.fetch, port: config.port, hostname: config.host ?? "127.0.0.1" }, () => {
```

Also update the returned `url` (line 168) so it reports a reachable host when bound non-loopback:

```ts
    url: `http://${config.host ?? "127.0.0.1"}:${port}`,
```

- [ ] **Step 5: Apply overrides in the CLI (serve and pair)**

In `packages/gateway/src/cli.ts`, import `applyEnvOverrides` (line 4 area):

```ts
import { applyEnvOverrides, loadConfig } from "./config.ts";
```

In the `serve` branch (line 20), replace `const config = loadConfig(configPath);` with:

```ts
    const config = applyEnvOverrides(loadConfig(configPath), process.env);
```

In the `pair` branch (line 32), replace `const config = loadConfig(configPath);` with the same (so `pair` opens the SAME db path the container's `serve` uses when both read `COZYGATEWAY_DB_PATH`):

```ts
    const config = applyEnvOverrides(loadConfig(configPath), process.env);
```

- [ ] **Step 6: Run and confirm pass**

Run: `cd packages/gateway && pnpm exec vitest run test/config.test.ts && pnpm --filter cozygateway test && pnpm --filter cozygateway typecheck`
Expected: green. Existing `startGateway` callers that omit `host` still typecheck (the field is optional) and still bind `127.0.0.1`.

- [ ] **Step 7: Commit**

```
git add packages/gateway/src/config.ts packages/gateway/src/server.ts packages/gateway/src/cli.ts packages/gateway/test/config.test.ts
git commit -m "gateway: configurable bind host + env overrides (host/port/dbPath)"
```

---

### Task 11: Docker packaging (gateway + relay images, compose, quickstart, container smoke, CI)

**Files:**
- Create: `packages/gateway/Dockerfile`, `packages/relay/Dockerfile`.
- Create: `.dockerignore`.
- Create: `packages/gateway/docker/cozygateway.config.json` (baked default mock config).
- Create: `docker/cozygateway.config.json` (reference attach config the compose mounts).
- Create: `docker-compose.yml`.
- Create: `packages/gateway/scripts/smoke-driver.mjs`, `scripts/docker-smoke.sh`.
- Create: `docs/self-host-docker.md`.
- Modify: `.github/workflows/ci.yml` (add a `docker` job; existing single `check` job uses `actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4` node 24 with `cache: pnpm`, then `pnpm install --frozen-lockfile`).

**Interfaces:**
- Consumes: `GET /health` (existing), the baked `mock` echo agent, the `COZYGATEWAY_HOST/PORT/DB_PATH/ATTACH_TOKEN` env contract (Task 10), and `cozygateway pair --config` (existing CLI). The smoke script drives the reference echo backend, no LLM.

- [ ] **Step 1: Write the gateway Dockerfile**

Create `packages/gateway/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
# Multi-stage build for the cozygateway process. Build context is the monorepo ROOT.

FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Prune to a self-contained production deployment: dist (the package's only published files) plus
# prod-only node_modules, with the workspace contract hard-copied in. --legacy keeps the
# well-understood deploy semantics across pnpm versions.
RUN pnpm --filter=cozygateway deploy --prod --legacy /app

FROM node:24-slim AS runtime
ENV NODE_ENV=production
ENV COZYGATEWAY_HOST=0.0.0.0
ENV COZYGATEWAY_PORT=8787
ENV COZYGATEWAY_DB_PATH=/data/cozygateway.db
WORKDIR /app
COPY --from=build /app /app
# A default mock ("echo") config so `docker run` works out of the box and the CI smoke test needs
# no mount. Real deployments mount their own config over this path (see docker-compose.yml).
COPY packages/gateway/docker/cozygateway.config.json /app/cozygateway.config.json
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
EXPOSE 8787
# Reuse the existing unauthenticated GET /health (200, returns GatewayInfo). Node 24 has fetch.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.COZYGATEWAY_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "dist/cli.js", "serve", "--config", "/app/cozygateway.config.json"]
```

- [ ] **Step 2: Write the relay Dockerfile**

Create `packages/relay/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
# Multi-stage build for the cozygateway push relay. Build context is the monorepo ROOT.

FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter=cozygateway-relay deploy --prod --legacy /app

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
EXPOSE 8788
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8788/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
# Flags are the container-internal defaults; the operator maps host ports and volumes in compose.
CMD ["node", "dist/cli.js", "--host", "0.0.0.0", "--port", "8788", "--db", "/data/relay.db"]
```

- [ ] **Step 3: Write .dockerignore**

Create `.dockerignore`:

```
node_modules
**/node_modules
**/dist
*.db
*.db-wal
*.db-shm
*.db-journal
.git
.github
docs
**/test
**/*.test.ts
.superpowers
coverage
*.tsbuildinfo
.DS_Store
```

- [ ] **Step 4: Write the two reference config files**

Create `packages/gateway/docker/cozygateway.config.json` (baked default, mock echo backend):

```json
{
  "name": "cozygateway",
  "agents": [{ "id": "echo", "name": "Echo", "backend": "mock" }]
}
```

Create `docker/cozygateway.config.json` (mounted by compose, real attach backend for the homelab dogfood):

```json
{
  "name": "cozygateway",
  "agents": [
    {
      "id": "hermes",
      "name": "Hermes",
      "backend": "attach",
      "options": { "tokenEnv": "COZYGATEWAY_ATTACH_TOKEN" }
    }
  ]
}
```

- [ ] **Step 5: Write docker-compose.yml**

Create `docker-compose.yml` at the repo root:

```yaml
# Reference deployment: the gateway plus the push relay, each as its own container with a named
# SQLite volume and a /health healthcheck. Copy .env.example to .env and set a strong attach token.
services:
  gateway:
    build:
      context: .
      dockerfile: packages/gateway/Dockerfile
    environment:
      COZYGATEWAY_HOST: "0.0.0.0"
      COZYGATEWAY_PORT: "8787"
      COZYGATEWAY_DB_PATH: "/data/cozygateway.db"
      # The bearer token the attaching Hermes plugin must present on /attach. Named by the mounted
      # config's options.tokenEnv. Required: compose fails fast if unset.
      COZYGATEWAY_ATTACH_TOKEN: "${COZYGATEWAY_ATTACH_TOKEN:?set a strong attach token in .env}"
    ports:
      - "8787:8787"
    volumes:
      - gateway-data:/data
      - ./docker/cozygateway.config.json:/app/cozygateway.config.json:ro
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 5s
    restart: unless-stopped

  relay:
    build:
      context: .
      dockerfile: packages/relay/Dockerfile
    command:
      ["node", "dist/cli.js", "--host", "0.0.0.0", "--port", "${COZY_RELAY_PORT:-8788}", "--db", "/data/relay.db"]
    ports:
      - "${COZY_RELAY_PORT:-8788}:${COZY_RELAY_PORT:-8788}"
    volumes:
      - relay-data:/data
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:${COZY_RELAY_PORT:-8788}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 5s
    restart: unless-stopped

volumes:
  gateway-data:
  relay-data:
```

- [ ] **Step 6: Write the smoke driver**

Create `packages/gateway/scripts/smoke-driver.mjs` (imports `ws`, resolved from the gateway package's node_modules):

```js
import { WebSocket } from "ws";

const baseUrl = process.env.SMOKE_GATEWAY_URL ?? "http://127.0.0.1:8787";
const setupCode = process.env.SMOKE_SETUP_CODE;
if (!setupCode) {
  console.error("SMOKE_SETUP_CODE is required");
  process.exit(1);
}

const deadline = Date.now() + 15000;
const until = async (predicate, label) => {
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

async function main() {
  const pairRes = await fetch(`${baseUrl}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode, deviceName: "smoke" }),
  });
  if (pairRes.status !== 200) throw new Error(`pair failed: HTTP ${pairRes.status}`);
  const { deviceToken } = await pairRes.json();
  const authed = { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" };

  const threadRes = await fetch(`${baseUrl}/threads`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ agentId: "echo" }),
  });
  if (threadRes.status !== 200) throw new Error(`create thread failed: HTTP ${threadRes.status}`);
  const { id: threadId } = await threadRes.json();

  const frames = [];
  const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);
  ws.on("message", (d) => frames.push(JSON.parse(String(d))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "auth", token: deviceToken }));
  await until(() => frames.some((f) => f.type === "ready"), "ready");

  const sendRes = await fetch(`${baseUrl}/threads/${threadId}/messages`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ blocks: [{ type: "paragraph", text: "hello" }] }),
  });
  if (sendRes.status !== 200) throw new Error(`send failed: HTTP ${sendRes.status}`);

  await until(() => frames.some((f) => f.type === "done"), "done");
  const draft = frames.find((f) => f.type === "draft");
  if (!draft) throw new Error("no draft frame observed");
  const agentCommit = frames.find((f) => f.type === "committed" && f.message.role === "agent");
  const text = agentCommit?.message?.blocks?.[0]?.text;
  if (text !== "Echo: hello") throw new Error(`unexpected agent reply: ${JSON.stringify(agentCommit)}`);

  ws.close();
  console.log("SMOKE OK: draft observed, agent committed 'Echo: hello'");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`SMOKE FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
```

- [ ] **Step 7: Write the smoke orchestration script**

Create `scripts/docker-smoke.sh`:

```bash
#!/usr/bin/env bash
# Build the gateway image, run it with the baked mock config, and drive a full pair/send/observe
# round trip against the reference echo backend INSIDE the container. No LLM, no external services.
set -euo pipefail

IMAGE="cozygateway:smoke"
NAME="cozygateway-smoke-$$"
PORT=8787
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> building gateway image"
docker build -f "$ROOT/packages/gateway/Dockerfile" -t "$IMAGE" "$ROOT"

echo "==> running container"
docker run -d --name "$NAME" -p "$PORT:8787" -e COZYGATEWAY_HOST=0.0.0.0 "$IMAGE" >/dev/null

echo "==> waiting for /health"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  if [ "$i" = "30" ]; then echo "gateway did not become healthy"; docker logs "$NAME"; exit 1; fi
  sleep 1
done

echo "==> minting a setup code inside the container"
PAIR_JSON="$(docker exec "$NAME" node dist/cli.js pair --config /app/cozygateway.config.json | head -1)"
SETUP_CODE="$(printf '%s' "$PAIR_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).setupCode))")"
if [ -z "$SETUP_CODE" ]; then echo "failed to mint a setup code"; docker logs "$NAME"; exit 1; fi

echo "==> driving pair/send/observe"
SMOKE_GATEWAY_URL="http://127.0.0.1:$PORT" SMOKE_SETUP_CODE="$SETUP_CODE" \
  node "$ROOT/packages/gateway/scripts/smoke-driver.mjs"

echo "==> smoke passed"
```

Make it executable:

```
chmod +x scripts/docker-smoke.sh
```

- [ ] **Step 8: Build the images and run the smoke locally**

Run:
```
docker build -f packages/gateway/Dockerfile -t cozygateway:local .
docker build -f packages/relay/Dockerfile -t cozygateway-relay:local .
pnpm install --frozen-lockfile
bash scripts/docker-smoke.sh
```
Expected: both images build; the smoke prints `SMOKE OK: draft observed, agent committed 'Echo: hello'` and exits 0. (If `pnpm deploy --legacy` is unavailable in a future pnpm, the documented fallback is a runtime stage that `COPY --from=build /repo /repo` then `pnpm install --prod --frozen-lockfile`; the smoke result is the acceptance gate either way.)

- [ ] **Step 9: Write the self-host quickstart doc**

Create `docs/self-host-docker.md`:

```markdown
# Self-hosting cozygateway with Docker

Two containers: the gateway (your agent as a chat contact) and the push relay (ciphertext-only
notification forwarder). Both build from this monorepo and store SQLite on a named volume.

## Try it in one command (reference echo backend)

    docker build -f packages/gateway/Dockerfile -t cozygateway .
    docker run --rm -p 8787:8787 -e COZYGATEWAY_HOST=0.0.0.0 cozygateway

The image ships a default `mock` ("echo") agent. In another terminal, mint a pairing code:

    docker exec <container> node dist/cli.js pair --config /app/cozygateway.config.json

## Full deployment (gateway + relay via compose)

    cp .env.example .env      # then edit COZYGATEWAY_ATTACH_TOKEN
    docker compose up --build

- The gateway listens on `8787`, the relay on `8788` (override the relay port with
  `COZY_RELAY_PORT`).
- The mounted `docker/cozygateway.config.json` selects the `attach` backend; point your agent
  harness's plugin at `http://<host>:8787/attach` with `COZYGATEWAY_TOKEN` equal to
  `COZYGATEWAY_ATTACH_TOKEN`.
- SQLite persists in the `gateway-data` and `relay-data` named volumes.

## Environment

Gateway:

| Variable | Default | Meaning |
| --- | --- | --- |
| `COZYGATEWAY_HOST` | `127.0.0.1` (image sets `0.0.0.0`) | bind address |
| `COZYGATEWAY_PORT` | `8787` | listen port |
| `COZYGATEWAY_DB_PATH` | `cozygateway.db` (image sets `/data/cozygateway.db`) | SQLite path |
| `COZYGATEWAY_ATTACH_TOKEN` | (required for the attach config) | bearer token the plugin presents on `/attach` |

Relay:

| Variable | Default | Meaning |
| --- | --- | --- |
| `COZY_RELAY_PORT` | `8788` | listen port (compose maps and passes it to the relay CLI) |

## Security note

The gateway serves plaintext over `0.0.0.0` inside the container. Keep it on a trusted network
(the homelab LAN) or behind your own TLS-terminating reverse proxy; TLS with certificate pinning
for the phone link is planned upstream.
```

Also create `.env.example`:

```
# Copy to .env. A strong random token the attaching agent plugin must present on /attach.
COZYGATEWAY_ATTACH_TOKEN=change-me-to-a-long-random-string
# Optional: override the relay listen/host port.
COZY_RELAY_PORT=8788
```

- [ ] **Step 10: Wire the CI job**

In `.github/workflows/ci.yml`, add a second job after the existing `check` job (keep `check` unchanged):

```yaml
  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      # ws (used by the smoke driver) resolves from the gateway package after install
      - run: pnpm install --frozen-lockfile
      - run: bash scripts/docker-smoke.sh
```

- [ ] **Step 11: Commit**

```
git add packages/gateway/Dockerfile packages/relay/Dockerfile .dockerignore docker-compose.yml docker/cozygateway.config.json packages/gateway/docker/cozygateway.config.json packages/gateway/scripts/smoke-driver.mjs scripts/docker-smoke.sh docs/self-host-docker.md .env.example .github/workflows/ci.yml
git commit -m "docker: multi-stage gateway + relay images, compose, quickstart, container smoke + CI"
```

---

### Task 12: Relay APNs transport

**Files:**
- Create: `packages/relay/src/apns.ts`.
- Modify: `packages/relay/src/server.ts` (`RelayConfig` at lines 15-25; `startRelay` transports at lines 34-44).
- Modify: `packages/relay/src/cli.ts` (`runCli` at lines 46-63).
- Modify: `contract/push-v0.md` (the `apns` line, "recognized, not yet available; returns 501").
- Modify: `docker-compose.yml` and `docs/self-host-docker.md` and `.env.example` (Task 11 outputs; add optional APNs env).
- Test: `packages/relay/test/apns.test.ts` (new file, fake HTTP/2 server, no real Apple calls).

**Interfaces:**
- Produces: `ApnsConfig = { keyP8: string; keyId: string; teamId: string; topic: string; environment: "development" | "production" }`; `buildProviderJwt(config, iatSeconds): string` (ES256, raw R||S signature); `apnsTransport(config, options?): Transport`; `apnsConfigFromEnv(env, readFile): ApnsConfig | undefined`.
- HTTP/2 client choice: `node:http2` (stdlib), because APNs requires HTTP/2 and the relay's defining constraint is to stay dependency-free.
- The daily cap and `notify_counts` mechanics are transport-agnostic (they run in the `/notify` route before transport selection, `packages/relay/src/http.ts:103-123`), so they already apply to APNs unchanged; no lifting needed.
- Notification shape (PINNED, the iOS NSE reads `payload["c"]`): `{"aps":{"alert":{"title":"CozyChat","body":"New message"},"mutable-content":1},"c":"<ciphertext>"}`. The ciphertext is the opaque base64url blob the relay receives in `/notify` (`packages/gateway/src/push-crypto.ts` emits `base64url(nonce||ciphertext||tag)`); the relay forwards it verbatim and never decrypts.

- [ ] **Step 1: Write the failing APNs tests**

Create `packages/relay/test/apns.test.ts`:

```ts
import { createServer, type Http2Server } from "node:http2";
import { once } from "node:events";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { apnsConfigFromEnv, apnsTransport, buildProviderJwt, type ApnsConfig } from "../src/apns.ts";

function testConfig(): { config: ApnsConfig; publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"] } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    publicKey,
    config: {
      keyP8: String(privateKey.export({ format: "pem", type: "pkcs8" })),
      keyId: "KEY123",
      teamId: "TEAM123",
      topic: "com.cozylabs.cozychat",
      environment: "development",
    },
  };
}

let server: Http2Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

async function fakeApns(
  handler: (headers: Record<string, unknown>, body: string, stream: import("node:http2").ServerHttp2Stream) => void,
): Promise<string> {
  server = createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (d) => (body += d));
    stream.on("end", () => handler(headers as Record<string, unknown>, body, stream));
  });
  server.listen(0);
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

describe("buildProviderJwt", () => {
  it("produces a verifiable ES256 JWT with the right header and claims", () => {
    const { config, publicKey } = testConfig();
    const jwt = buildProviderJwt(config, 1_700_000_000);
    const [h, c, s] = jwt.split(".");
    const ok = cryptoVerify(
      "sha256",
      Buffer.from(`${h}.${c}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(s ?? "", "base64url"),
    );
    expect(ok).toBe(true);
    expect(JSON.parse(Buffer.from(h ?? "", "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(JSON.parse(Buffer.from(c ?? "", "base64url").toString())).toEqual({ iss: "TEAM123", iat: 1_700_000_000 });
  });
});

describe("apnsTransport.deliver", () => {
  it("POSTs the alert + ciphertext under 'c' to /3/device/<token> with a bearer JWT", async () => {
    const { config, publicKey } = testConfig();
    let seen: { headers: Record<string, unknown>; body: string } | undefined;
    const baseUrl = await fakeApns((headers, body, stream) => {
      seen = { headers, body };
      stream.respond({ ":status": 200 });
      stream.end();
    });

    await apnsTransport(config, { baseUrl }).deliver("DEVICETOKENHEX", "CIPHERBLOB");

    expect(seen?.headers[":path"]).toBe("/3/device/DEVICETOKENHEX");
    expect(seen?.headers[":method"]).toBe("POST");
    expect(seen?.headers["apns-topic"]).toBe("com.cozylabs.cozychat");
    expect(seen?.headers["apns-push-type"]).toBe("alert");
    const auth = String(seen?.headers["authorization"]);
    expect(auth.startsWith("bearer ")).toBe(true);
    const [h, c, s] = auth.slice("bearer ".length).split(".");
    expect(
      cryptoVerify(
        "sha256",
        Buffer.from(`${h}.${c}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(s ?? "", "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(seen?.body ?? "")).toEqual({
      aps: { alert: { title: "CozyChat", body: "New message" }, "mutable-content": 1 },
      c: "CIPHERBLOB",
    });
  });

  it("rejects on a non-2xx APNs status", async () => {
    const { config } = testConfig();
    const baseUrl = await fakeApns((_headers, _body, stream) => {
      stream.respond({ ":status": 400 });
      stream.end(JSON.stringify({ reason: "BadDeviceToken" }));
    });
    await expect(apnsTransport(config, { baseUrl }).deliver("tok", "c")).rejects.toThrow(/HTTP 400/);
  });
});

describe("apnsConfigFromEnv", () => {
  it("returns undefined when no APNs vars are set (relay runs webhook-only)", () => {
    expect(apnsConfigFromEnv({}, () => "")).toBeUndefined();
  });

  it("throws when only some APNs vars are set", () => {
    expect(() => apnsConfigFromEnv({ APNS_KEY_ID: "k" }, () => "")).toThrow(/APNs config incomplete/);
  });

  it("reads the key file and returns config when all are set", () => {
    const cfg = apnsConfigFromEnv(
      {
        APNS_KEY_P8_PATH: "/keys/apns.p8",
        APNS_KEY_ID: "k",
        APNS_TEAM_ID: "t",
        APNS_TOPIC: "com.cozylabs.cozychat",
        APNS_ENVIRONMENT: "production",
      },
      (p) => (p === "/keys/apns.p8" ? "PEMDATA" : ""),
    );
    expect(cfg).toEqual({
      keyP8: "PEMDATA",
      keyId: "k",
      teamId: "t",
      topic: "com.cozylabs.cozychat",
      environment: "production",
    });
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/relay && pnpm exec vitest run test/apns.test.ts`
Expected failure: `../src/apns.ts` does not exist.

- [ ] **Step 3: Write apns.ts**

Create `packages/relay/src/apns.ts`:

```ts
import { connect as http2Connect, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, sign } from "node:crypto";

import type { Transport } from "./transports.ts";

/** APNs provider config. The .p8 key is PEM (PKCS8) contents; env plumbing reads it from a file. */
export interface ApnsConfig {
  keyP8: string;
  keyId: string;
  teamId: string;
  /** The app bundle id, e.g. com.cozylabs.cozychat. */
  topic: string;
  environment: "development" | "production";
}

export interface ApnsTransportOptions {
  /** Override the APNs origin (test seam; default derives from `environment`). */
  baseUrl?: string;
  now?: () => number;
}

const APNS_HOSTS: Record<ApnsConfig["environment"], string> = {
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

/** APNs rejects a provider token older than 60 minutes; refresh comfortably before that. */
const JWT_REFRESH_MS = 50 * 60 * 1000;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Build an ES256 provider JWT: header { alg: "ES256", kid }, claims { iss: teamId, iat }. The EC
 *  P-256 signature MUST be raw R||S (JOSE / ieee-p1363), not the DER form node emits by default. */
export function buildProviderJwt(config: ApnsConfig, iatSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = b64url(JSON.stringify({ iss: config.teamId, iat: iatSeconds }));
  const signingInput = `${header}.${claims}`;
  const key = createPrivateKey(config.keyP8);
  const signature = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(signature)}`;
}

/** A first-class APNs delivery transport. Token-based auth (ES256 provider JWT, cached and
 *  refreshed). The relay never decrypts: the opaque ciphertext rides under the top-level custom
 *  key "c" (the iOS Notification Service Extension reads exactly payload["c"]). Uses node:http2
 *  (stdlib) because APNs requires HTTP/2 and the relay stays dependency-free. */
export function apnsTransport(config: ApnsConfig, options: ApnsTransportOptions = {}): Transport {
  const baseUrl = options.baseUrl ?? APNS_HOSTS[config.environment];
  const now = options.now ?? Date.now;
  let cached: { token: string; mintedAt: number } | undefined;

  const providerJwt = (): string => {
    const t = now();
    if (cached === undefined || t - cached.mintedAt >= JWT_REFRESH_MS) {
      cached = { token: buildProviderJwt(config, Math.floor(t / 1000)), mintedAt: t };
    }
    return cached.token;
  };

  return {
    deliver(token: string, ciphertext: string): Promise<void> {
      const body = JSON.stringify({
        aps: { alert: { title: "CozyChat", body: "New message" }, "mutable-content": 1 },
        c: ciphertext,
      });
      return new Promise<void>((resolve, reject) => {
        let session: ClientHttp2Session;
        try {
          session = http2Connect(baseUrl);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        session.on("error", (err) => reject(err));
        const req = session.request({
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: `bearer ${providerJwt()}`,
          "apns-topic": config.topic,
          "apns-push-type": "alert",
          "content-type": "application/json",
        });
        let status = 0;
        let responseBody = "";
        req.setEncoding("utf8");
        req.on("response", (headers) => {
          status = Number(headers[":status"]) || 0;
        });
        req.on("data", (chunk) => {
          responseBody += chunk;
        });
        req.on("end", () => {
          session.close();
          if (status >= 200 && status < 300) resolve();
          else reject(new Error(`apns delivery failed: HTTP ${status} ${responseBody}`.trim()));
        });
        req.on("error", (err) => {
          session.close();
          reject(err);
        });
        req.write(body);
        req.end();
      });
    },
  };
}

/** Read APNs config from the environment, or undefined when unconfigured (relay runs webhook-only).
 *  All five vars are required together; a partial set is a startup error. `readFile` is injected so
 *  the .p8 file read stays testable. */
export function apnsConfigFromEnv(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): ApnsConfig | undefined {
  const p8Path = env["APNS_KEY_P8_PATH"];
  const keyId = env["APNS_KEY_ID"];
  const teamId = env["APNS_TEAM_ID"];
  const topic = env["APNS_TOPIC"];
  const environment = env["APNS_ENVIRONMENT"];
  if (!p8Path && !keyId && !teamId && !topic && !environment) return undefined;
  if (!p8Path || !keyId || !teamId || !topic || !environment) {
    throw new Error(
      "APNs config incomplete: set APNS_KEY_P8_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC, and APNS_ENVIRONMENT together (or none)",
    );
  }
  if (environment !== "development" && environment !== "production") {
    throw new Error(`invalid APNS_ENVIRONMENT "${environment}" (expected development or production)`);
  }
  return { keyP8: readFile(p8Path), keyId, teamId, topic, environment };
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd packages/relay && pnpm exec vitest run test/apns.test.ts`
Expected: green.

- [ ] **Step 5: Register the transport in the relay server and CLI**

In `packages/relay/src/server.ts`, add the import and extend `RelayConfig`, then build the transports record conditionally.

Add near the top imports:

```ts
import { apnsTransport, type ApnsConfig } from "./apns.ts";
```

Add to `RelayConfig` (after `restrictEgress` at line 24):

```ts
  /** When set, the relay serves the "apns" platform; unset means webhook-only. */
  apns?: ApnsConfig;
```

Replace the `createRelayApp({...})` transports line (line 38) with a conditional record:

```ts
  const transports: Record<string, ReturnType<typeof webhookTransport> | undefined> = {
    webhook: webhookTransport({ restrictEgress: config.restrictEgress }),
  };
  if (config.apns !== undefined) transports.apns = apnsTransport(config.apns);
  const app = createRelayApp({
    storage,
    transports,
    dailyCap: config.dailyCap,
    maxRegistrations: config.maxRegistrations,
    version: RELAY_VERSION,
    now: () => Date.now(),
    restrictEgress: config.restrictEgress,
  });
```

In `packages/relay/src/cli.ts`, add imports and read APNs env into the config inside `runCli`.

Add imports:

```ts
import { readFileSync } from "node:fs";

import { apnsConfigFromEnv } from "./apns.ts";
```

Replace the parse block in `runCli` (lines 47-54):

```ts
  let config: RelayConfig;
  try {
    config = parseCliConfig(argv);
    config.apns = apnsConfigFromEnv(process.env, (p) => readFileSync(p, "utf8"));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    return 1;
  }
```

- [ ] **Step 6: Update the contract doc**

In `contract/push-v0.md`, replace the `apns` line (currently "recognized, not yet available; returns 501 `unsupported_platform`") with:

```
- `apns`: token-based APNs (ES256 provider JWT) when the relay is configured with an APNs key
  (env: APNS_KEY_P8_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC, APNS_ENVIRONMENT); `token` is the
  hex device token. When APNs is not configured, an `apns` registration returns 501
  `unsupported_platform`. The push payload is an alert with `mutable-content: 1` carrying the opaque
  ciphertext under the top-level custom key `c`; the relay never decrypts it.
```

- [ ] **Step 7: Add optional APNs env to the compose and quickstart (Task 11 outputs)**

In `docker-compose.yml`, add to the `relay` service `environment:` (all empty by default so an unset APNs config leaves the relay webhook-only):

```yaml
      # Optional APNs (set all five to enable real push; leave empty for webhook-only).
      APNS_KEY_P8_PATH: "${APNS_KEY_P8_PATH:-}"
      APNS_KEY_ID: "${APNS_KEY_ID:-}"
      APNS_TEAM_ID: "${APNS_TEAM_ID:-}"
      APNS_TOPIC: "${APNS_TOPIC:-}"
      APNS_ENVIRONMENT: "${APNS_ENVIRONMENT:-}"
```

And add a commented .p8 mount to the relay `volumes:` (the operator uncomments and points `APNS_KEY_P8_HOST_PATH` at their key file, with `APNS_KEY_P8_PATH=/keys/apns.p8`):

```yaml
      # - "${APNS_KEY_P8_HOST_PATH}:/keys/apns.p8:ro"
```

Append to `.env.example`:

```
# Optional APNs (real iOS push). Set all five and mount your .p8, or leave unset for webhook-only.
# APNS_KEY_P8_HOST_PATH=./secrets/AuthKey_XXXXXXXXXX.p8
# APNS_KEY_P8_PATH=/keys/apns.p8
# APNS_KEY_ID=XXXXXXXXXX
# APNS_TEAM_ID=YYYYYYYYYY
# APNS_TOPIC=com.cozylabs.cozychat
# APNS_ENVIRONMENT=development
```

Append an APNs section to `docs/self-host-docker.md`:

```markdown
## Push over APNs (optional)

The relay is webhook-only by default. To deliver real iOS push, configure APNs token auth and
mount your `.p8` key:

1. In the Apple developer portal, create an APNs auth key (`.p8`), and note the key id, your team
   id, and the app bundle id (`com.cozylabs.cozychat`).
2. Put the `.p8` on the host and uncomment the relay `.p8` volume in `docker-compose.yml`.
3. Set in `.env`: `APNS_KEY_P8_HOST_PATH`, `APNS_KEY_P8_PATH=/keys/apns.p8`, `APNS_KEY_ID`,
   `APNS_TEAM_ID`, `APNS_TOPIC=com.cozylabs.cozychat`, `APNS_ENVIRONMENT` (`development` for a dev
   build, `production` for TestFlight/App Store).

Relay APNs environment:

| Variable | Meaning |
| --- | --- |
| `APNS_KEY_P8_PATH` | in-container path to the mounted `.p8` (e.g. `/keys/apns.p8`) |
| `APNS_KEY_ID` | the APNs auth key id |
| `APNS_TEAM_ID` | your Apple developer team id |
| `APNS_TOPIC` | the app bundle id (`com.cozylabs.cozychat`) |
| `APNS_ENVIRONMENT` | `development` or `production` |

When any of these is set they must all be set, or the relay fails to start.
```

- [ ] **Step 8: Full relay gate and commit**

Run: `pnpm --filter cozygateway-relay test && pnpm --filter cozygateway-relay typecheck && pnpm --filter cozygateway-relay build`
Expected: green.
Commit:
```
git add packages/relay/src/apns.ts packages/relay/src/server.ts packages/relay/src/cli.ts packages/relay/test/apns.test.ts contract/push-v0.md docker-compose.yml docs/self-host-docker.md .env.example
git commit -m "relay: first-class APNs transport (ES256 JWT, node:http2, ciphertext under 'c')"
```

---

### Task 13: Full-repo verification gate

**Files:** none created; this task only runs the aggregate gates and fixes any cross-package fallout surfaced by them.

**Interfaces:** Consumes every prior task. This is the merge gate the wave requires (spec section 9).

- [ ] **Step 1: Run the full TypeScript gate**

Run: `pnpm check`
Expected: `pnpm build` then `pnpm typecheck` then `pnpm test` (all packages) pass. In particular:
- `cozygateway-contract`: additive delivery/marker/error-code/InterruptResponse tests green.
- `cozygateway`: adapter capability, steerable mock, TurnRunner policy, stop-phrase, interrupt route, attach steer/interrupt (unit + e2e), openclaw declaration, config env overrides green.
- `cozygateway-conformance`: the full black-box suite plus the four interrupt assertions green against the reference gateway.
- `cozygateway-relay`: APNs transport, config-from-env, plus the existing relay suite green.

- [ ] **Step 2: Run the Python plugin suite**

Run: `cd integrations/attach-plugin && python3 -m unittest discover -s tests -v`
Expected: the whole suite (existing tests plus `test_inbound_frames`) passes, and the package still imports with no harness on the path.

- [ ] **Step 3: Run the container smoke**

Run: `pnpm install --frozen-lockfile && bash scripts/docker-smoke.sh`
Expected: `SMOKE OK: draft observed, agent committed 'Echo: hello'`, exit 0.

- [ ] **Step 4: Confirm the CI workflow parses and both jobs are present**

Run: `cat .github/workflows/ci.yml`
Expected: the `check` job (unchanged) and the new `docker` job are both present; the `docker` job installs deps and runs `scripts/docker-smoke.sh`.

- [ ] **Step 5: Final commit (only if Steps 1-4 surfaced any fixes)**

```
git add -A
git commit -m "verify: full gate green across contract, gateway, conformance, relay, plugin, docker"
```

If Steps 1-4 were already green with no changes, there is nothing to commit and the branch is ready for review.

---

## Appendix: cross-repo interface contracts (pinned; the parallel iOS plan is written against these)

- User `Message.delivery?: "turn" | "steer"` (absent means turn; only on user messages). Additive contract v1.x.
- `POST /threads/:id/interrupt`: 202 `{"status":"interrupting"}` when a turn was in flight; 204 no body when idle. Auth like every route.
- Interrupted turn: committed system message `marker: "turn.interrupted"` then the normal `done` frame.
- Stop-phrase set: exactly `["stop", "stop it", "cancel", "abort"]`; normalize = trim, casefold, strip terminal `[.!?]+`; whole-message match only. A match interrupts the in-flight turn AND commits the message normally (delivery absent) as the next queued turn.
- Adapter `midTurnDelivery: "steer" | "queue"`; steer-capable sessions expose `steer(blocks)` and `interrupt()`. Attach declares `"steer"`; OpenClaw declares `"queue"` and its interrupt yields a clean `interrupt_unsupported` error frame.
- APNs push payload: `{"aps":{"alert":{"title":"CozyChat","body":"New message"},"mutable-content":1},"c":"<base64url ciphertext>"}`. The iOS NSE reads exactly `payload["c"]`.
- Compose env var names (the deployment plan depends on these): gateway `COZYGATEWAY_HOST`, `COZYGATEWAY_PORT`, `COZYGATEWAY_DB_PATH`, `COZYGATEWAY_ATTACH_TOKEN`; relay `COZY_RELAY_PORT`; relay APNs (optional) `APNS_KEY_P8_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`, `APNS_ENVIRONMENT` (plus `APNS_KEY_P8_HOST_PATH` as the host-side mount source in compose).

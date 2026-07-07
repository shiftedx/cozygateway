# Contract v1 + Gateway Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze cozygateway wire contract v1 as a publishable TypeBox package plus a prose spec, and build the gateway core (pairing, SQLite thread/session registry, message history, WS event stream, mock backend adapter) proven by an in-repo conformance suite.

**Architecture:** pnpm workspace, three packages. `cozygateway-contract` holds TypeBox schemas with static types derived from them (never duplicated). `cozygateway` (packages/gateway) is a single Node process: hono REST + one `ws` WebSocket hub on the same HTTP server, `node:sqlite` storage, backend adapters behind a narrow interface with a deterministic mock adapter for CI. `cozygateway-conformance` is a black-box suite that talks only HTTP/WS and runs against any gateway implementation.

**Tech Stack:** Node >= 24 (`node:sqlite`, type stripping), TypeScript strict (repo `tsconfig.base.json`), pnpm 10, vitest 3, hono + @hono/node-server, ws, @sinclair/typebox.

## Global Constraints

- Node engines: `>=24`. Local dev on this machine: prefix `PATH=/opt/homebrew/opt/node@26/bin:$PATH` (default node is 22).
- NEVER import from or reference the CozyLabs repo in code. Reading CozyLabs sources for reference is allowed; copied shapes are re-licensed clean under MIT here.
- Pure ESM everywhere (`"type": "module"`). Relative imports use `.ts` extensions (the base tsconfig rewrites them on emit).
- `erasableSyntaxOnly` is on: no TS enums, no namespaces, no parameter properties.
- Never fabricate test DATA with `as` casts; build typed literals instead (shoehorn conventions). Allowed narrowing uses of `as`: `as const`, narrowing a parsed `unknown` (e.g. `await res.json()` or `JSON.parse`) to a response shape, and post-`instanceof` narrowing; the plan's test code shows the pattern.
- No em-dashes in any public-facing copy (README, contract spec, package descriptions, error messages).
- "works with OpenClaw" nominative framing only; never "Claw" in a name. Never name coding-agent harnesses in public copy.
- Every commit message and code comment states constraints, not narration.
- Test command inside a package: `pnpm test` (vitest run). Full gate from repo root: `pnpm check`.
- Git: work on the slice branch the executor names for your task. Do not create or switch to any other branch. Do not push. Absolute paths only inside `/Users/kmcdowell/Documents/repos/cozygateway`.

## Contract quick reference (names every task must match)

Package `cozygateway-contract` exports (all from `src/index.ts`):

- `CONTRACT_VERSION = "v1"`
- Schemas (TypeBox, suffix `Schema`) and derived types: `RichBlock`, `ListItem`, `ToolCall`, `PresenceState`, `Device`, `GatewayInfo`, `Agent`, `Thread`, `Message`, `MessageRole`, `ErrorBody`
- REST: `PairRequest`, `PairResponse`, `CreateThreadRequest`, `RenameThreadRequest`, `ListMessagesResponse`, `SendMessageRequest`, `SendMessageResponse`, `PushRegisterRequest`
- WS: `AuthFrame`, `SyncFrame`, `ClientFrame`, `ReadyFrame`, `SyncedFrame`, `CommittedFrame`, `DraftFrame`, `DoneFrame`, `PresenceFrame`, `ErrorFrame`, `ServerFrame`
- Helpers: `check(schema, value)`, `assertValid(schema, value)`, `ContractViolation`
- Error codes: `ERROR_CODES` (readonly tuple) with type `ErrorCode`

Wire semantics fixed by this plan (the prose spec in Task 5 restates them):

- Objects are OPEN: receivers must ignore unknown fields. Unknown WS server-frame types must be ignored by clients; unknown client-frame types get an `error` frame. Unknown RichBlock types are invalid (closed union).
- `seq` is per-thread, starts at 1, gapless, allocated by the gateway in commit order. Drafts are ephemeral and carry no seq.
- WS auth happens in the first client frame, never in the URL. Auth failure closes with code 1008.
- `sync` carries the client's per-thread high-water marks; the server replays committed messages with `seq > sinceSeq` in ascending order, then sends `synced`.
- The `attachment` RichBlock shape is frozen in v1 but upload/download endpoints are a later phase; the mock backend never emits it.

---

### Task 1: Contract validation helpers + RichBlock schemas

**Files:**
- Create: `packages/contract/src/validate.ts`
- Create: `packages/contract/src/rich-blocks.ts`
- Modify: `packages/contract/src/index.ts`
- Test: `packages/contract/test/rich-blocks.test.ts`, `packages/contract/test/validate.test.ts`

**Interfaces:**
- Consumes: nothing (first real code in the package).
- Produces: `check<S extends TSchema>(schema: S, value: unknown): value is Static<S>`; `assertValid<S extends TSchema>(schema: S, value: unknown): Static<S>` (throws `ContractViolation` with `.path`); `RichBlockSchema`/`RichBlock`, `ListItemSchema`/`ListItem`. Every later schema task uses these helpers in tests.

- [ ] **Step 1: Write failing tests**

`packages/contract/test/validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";

import { ContractViolation, assertValid, check } from "../src/validate.ts";

const Point = Type.Object({ x: Type.Number(), y: Type.Number() });

describe("check", () => {
  it("accepts a conforming value", () => {
    expect(check(Point, { x: 1, y: 2 })).toBe(true);
  });
  it("accepts unknown extra fields (open objects)", () => {
    expect(check(Point, { x: 1, y: 2, z: 3 })).toBe(true);
  });
  it("rejects a malformed value", () => {
    expect(check(Point, { x: 1 })).toBe(false);
  });
});

describe("assertValid", () => {
  it("returns the typed value on success", () => {
    const p = assertValid(Point, { x: 1, y: 2 });
    expect(p.x).toBe(1);
  });
  it("throws ContractViolation with a path on failure", () => {
    try {
      assertValid(Point, { x: 1, y: "nope" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect((err as ContractViolation).path).toBe("/y");
    }
  });
});
```

(`err` in a catch is `unknown`; the single `as ContractViolation` after an `instanceof` expect is acceptable narrowing in tests.)

`packages/contract/test/rich-blocks.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { RichBlock } from "../src/rich-blocks.ts";
import { RichBlockSchema } from "../src/rich-blocks.ts";
import { check } from "../src/validate.ts";

const valid: RichBlock[] = [
  { type: "paragraph", text: "hello" },
  { type: "code", code: "let x = 1", language: "ts" },
  { type: "code", code: "no lang" },
  { type: "heading", level: 2, text: "Title" },
  { type: "list", items: [{ text: "a" }, { text: "b", checked: true }], ordered: true },
  { type: "table", header: ["k", "v"], rows: [["a", "1"]] },
  { type: "math", latex: "e^{i\\pi}" },
  { type: "attachment", fileId: "f1", name: "notes.pdf", mimeType: "application/pdf", size: 1024 },
];

describe("RichBlockSchema", () => {
  it.each(valid.map((b) => [b.type, b] as const))("accepts %s", (_type, block) => {
    expect(check(RichBlockSchema, block)).toBe(true);
  });

  it("rejects unknown block types (closed union)", () => {
    expect(check(RichBlockSchema, { type: "cardMention", taskId: "t", title: "x" })).toBe(false);
    expect(check(RichBlockSchema, { type: "html", html: "<b>" })).toBe(false);
  });

  it("rejects malformed fields", () => {
    expect(check(RichBlockSchema, { type: "heading", level: 4, text: "x" })).toBe(false);
    expect(check(RichBlockSchema, { type: "list", items: [{ text: 1 }] })).toBe(false);
    expect(check(RichBlockSchema, { type: "table", header: ["a"], rows: [[1]] })).toBe(false);
    expect(check(RichBlockSchema, { type: "attachment", fileId: "f", name: "n", mimeType: "m", size: "big" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/contract && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: FAIL, cannot find `../src/validate.ts` / `../src/rich-blocks.ts`.

- [ ] **Step 3: Implement**

`packages/contract/src/validate.ts`:

```ts
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** A value failed schema validation at the wire boundary. `path` is the JSON pointer of the
 *  first failing location ("" for the root). */
export class ContractViolation extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(message);
    this.name = "ContractViolation";
    this.path = path;
  }
}

export function check<S extends TSchema>(schema: S, value: unknown): value is Static<S> {
  return Value.Check(schema, value);
}

export function assertValid<S extends TSchema>(schema: S, value: unknown): Static<S> {
  const first = Value.Errors(schema, value).First();
  if (first !== undefined) {
    throw new ContractViolation(`${first.message} at ${first.path === "" ? "/" : first.path}`, first.path);
  }
  return value as Static<S>;
}
```

(The `as Static<S>` here is the one place a cast is allowed in src: it is the validated narrowing point.)

`packages/contract/src/rich-blocks.ts`:

```ts
/** Agent-visible content as a CLOSED union of typed blocks. The client renders only this
 *  schema, with no markdown parser and no raw HTML of agent content; that makes the renderer
 *  the security floor. Objects stay OPEN (unknown fields ignored) so v1.x can add optional
 *  fields, but unknown block TYPES are invalid: a client that cannot render a block must know
 *  it is looking at one. `attachment` carries a gateway-scoped fileId, never a URL, so no
 *  block can become a navigable anchor. */
import { type Static, Type } from "@sinclair/typebox";

export const ListItemSchema = Type.Object({
  text: Type.String(),
  checked: Type.Optional(Type.Boolean()),
});
export type ListItem = Static<typeof ListItemSchema>;

export const RichBlockSchema = Type.Union([
  Type.Object({ type: Type.Literal("paragraph"), text: Type.String() }),
  Type.Object({
    type: Type.Literal("code"),
    code: Type.String(),
    language: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("heading"),
    level: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    text: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("list"),
    items: Type.Array(ListItemSchema),
    ordered: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    type: Type.Literal("table"),
    header: Type.Array(Type.String()),
    rows: Type.Array(Type.Array(Type.String())),
  }),
  Type.Object({ type: Type.Literal("math"), latex: Type.String() }),
  Type.Object({
    type: Type.Literal("attachment"),
    fileId: Type.String(),
    name: Type.String(),
    mimeType: Type.String(),
    size: Type.Integer({ minimum: 0 }),
  }),
]);
export type RichBlock = Static<typeof RichBlockSchema>;
```

`packages/contract/src/index.ts` becomes:

```ts
/** cozygateway wire contract. The human-readable spec lives in contract/v1.md at the repo
 *  root; this package is its machine artifact: TypeBox schemas with static types derived
 *  from them. */

export const CONTRACT_VERSION = "v1";

export * from "./validate.ts";
export * from "./rich-blocks.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/contract && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: PASS (all files).

- [ ] **Step 5: Typecheck and commit**

```bash
PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm typecheck
git add packages/contract
git commit -m "feat(contract): RichBlock v1 closed union + wire validation helpers"
```

---

### Task 2: Contract resource schemas

**Files:**
- Create: `packages/contract/src/resources.ts`
- Modify: `packages/contract/src/index.ts` (add `export * from "./resources.ts";`)
- Test: `packages/contract/test/resources.test.ts`

**Interfaces:**
- Consumes: `RichBlockSchema` from Task 1.
- Produces: `PresenceStateSchema`/`PresenceState` (`"online" | "absent" | "unknown"`), `ToolCallSchema`/`ToolCall` (`{id, name, status: "running"|"ok"|"error", detail?}`), `DeviceSchema`/`Device` (`{id, name, createdAt, lastSeenAt: number|null}`), `GatewayInfoSchema`/`GatewayInfo` (`{name, version, contract: "v1"}`), `AgentSchema`/`Agent` (`{id, name, avatar?, backend, presence}`), `ThreadSchema`/`Thread` (`{id, agentId, title, createdAt, lastMessageAt: number|null}`), `MessageRoleSchema`/`MessageRole` (`"user"|"agent"|"system"`), `MessageSchema`/`Message` (`{threadId, seq >= 1, role, blocks: RichBlock[], turnId?, marker?: "turn.failed", createdAt}`), `ErrorBodySchema`/`ErrorBody` (`{error: {code, message}}`), `ERROR_CODES`/`ErrorCode`.

- [ ] **Step 1: Write failing tests**

`packages/contract/test/resources.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Agent, Message, Thread } from "../src/resources.ts";
import { AgentSchema, ERROR_CODES, MessageSchema, ThreadSchema } from "../src/resources.ts";
import { check } from "../src/validate.ts";

describe("resource schemas", () => {
  it("accepts a full agent", () => {
    const agent: Agent = {
      id: "a1",
      name: "Sage",
      avatar: "owl",
      backend: "hermes",
      presence: "online",
    };
    expect(check(AgentSchema, agent)).toBe(true);
  });

  it("accepts a thread with a null lastMessageAt", () => {
    const thread: Thread = {
      id: "t1",
      agentId: "a1",
      title: "New thread",
      createdAt: 1_720_000_000_000,
      lastMessageAt: null,
    };
    expect(check(ThreadSchema, thread)).toBe(true);
  });

  it("accepts committed messages including a turn.failed marker", () => {
    const message: Message = {
      threadId: "t1",
      seq: 3,
      role: "system",
      blocks: [{ type: "paragraph", text: "The agent turn failed." }],
      turnId: "turn-9",
      marker: "turn.failed",
      createdAt: 1_720_000_000_000,
    };
    expect(check(MessageSchema, message)).toBe(true);
  });

  it("rejects seq 0 (seq starts at 1)", () => {
    expect(
      check(MessageSchema, {
        threadId: "t1",
        seq: 0,
        role: "user",
        blocks: [],
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it("rejects an unknown presence and an unknown role", () => {
    expect(check(AgentSchema, { id: "a", name: "n", backend: "mock", presence: "away" })).toBe(false);
    expect(
      check(MessageSchema, { threadId: "t", seq: 1, role: "bot", blocks: [], createdAt: 1 }),
    ).toBe(false);
  });

  it("freezes the error code list", () => {
    expect(ERROR_CODES).toContain("unauthorized");
    expect(ERROR_CODES).toContain("not_found");
    expect(ERROR_CODES).toContain("invalid_request");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/contract && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: FAIL, cannot find `../src/resources.ts`.

- [ ] **Step 3: Implement**

`packages/contract/src/resources.ts`:

```ts
import { type Static, Type } from "@sinclair/typebox";

import { RichBlockSchema } from "./rich-blocks.ts";

/** Wire error codes. Frozen list: additions are a contract minor bump; clients treat unknown
 *  codes as a generic failure. */
export const ERROR_CODES = [
  "unauthorized",
  "not_found",
  "invalid_request",
  "setup_code_invalid",
  "thread_archived",
  "backend_unavailable",
  "turn_failed",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorBodySchema = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String() }),
});
export type ErrorBody = Static<typeof ErrorBodySchema>;

export const PresenceStateSchema = Type.Union([
  Type.Literal("online"),
  Type.Literal("absent"),
  Type.Literal("unknown"),
]);
export type PresenceState = Static<typeof PresenceStateSchema>;

export const ToolCallSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  status: Type.Union([Type.Literal("running"), Type.Literal("ok"), Type.Literal("error")]),
  detail: Type.Optional(Type.String()),
});
export type ToolCall = Static<typeof ToolCallSchema>;

export const DeviceSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  createdAt: Type.Integer(),
  lastSeenAt: Type.Union([Type.Integer(), Type.Null()]),
});
export type Device = Static<typeof DeviceSchema>;

export const GatewayInfoSchema = Type.Object({
  name: Type.String(),
  version: Type.String(),
  contract: Type.Literal("v1"),
});
export type GatewayInfo = Static<typeof GatewayInfoSchema>;

export const AgentSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  avatar: Type.Optional(Type.String()),
  backend: Type.String(),
  presence: PresenceStateSchema,
});
export type Agent = Static<typeof AgentSchema>;

export const ThreadSchema = Type.Object({
  id: Type.String(),
  agentId: Type.String(),
  title: Type.String(),
  createdAt: Type.Integer(),
  lastMessageAt: Type.Union([Type.Integer(), Type.Null()]),
});
export type Thread = Static<typeof ThreadSchema>;

export const MessageRoleSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("agent"),
  Type.Literal("system"),
]);
export type MessageRole = Static<typeof MessageRoleSchema>;

/** A committed, durable message. `seq` is per-thread, gapless, starts at 1, allocated by the
 *  gateway in commit order; clients dedupe by per-thread high-water mark. `marker` flags
 *  synthetic system messages (today only "turn.failed"). */
export const MessageSchema = Type.Object({
  threadId: Type.String(),
  seq: Type.Integer({ minimum: 1 }),
  role: MessageRoleSchema,
  blocks: Type.Array(RichBlockSchema),
  turnId: Type.Optional(Type.String()),
  marker: Type.Optional(Type.Literal("turn.failed")),
  createdAt: Type.Integer(),
});
export type Message = Static<typeof MessageSchema>;
```

Add to `packages/contract/src/index.ts`: `export * from "./resources.ts";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/contract && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm typecheck
git add packages/contract
git commit -m "feat(contract): resource schemas (device, agent, thread, message, error codes)"
```

---

### Task 3: Contract REST schemas

**Files:**
- Create: `packages/contract/src/rest.ts`
- Modify: `packages/contract/src/index.ts` (add `export * from "./rest.ts";`)
- Test: `packages/contract/test/rest.test.ts`

**Interfaces:**
- Consumes: Task 1 blocks, Task 2 resources.
- Produces: `PairRequestSchema`/`PairRequest` (`{setupCode, deviceName (1..120), devicePubkey?}`), `PairResponseSchema`/`PairResponse` (`{deviceToken, device: Device, gateway: GatewayInfo}`), `CreateThreadRequestSchema` (`{agentId, title? (<=200)}`), `RenameThreadRequestSchema` (`{title (1..200)}`), `ListMessagesResponseSchema` (`{messages: Message[]}` ascending seq), `SendMessageRequestSchema` (`{blocks: RichBlock[] minItems 1}`), `SendMessageResponseSchema` (`{message: Message}`), `PushRegisterRequestSchema` (`{pushId, relayUrl, pushKey}`).

- [ ] **Step 1: Write failing tests**

`packages/contract/test/rest.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { PairRequest, SendMessageRequest } from "../src/rest.ts";
import {
  CreateThreadRequestSchema,
  PairRequestSchema,
  RenameThreadRequestSchema,
  SendMessageRequestSchema,
} from "../src/rest.ts";
import { check } from "../src/validate.ts";

describe("REST schemas", () => {
  it("accepts a pair request without a pubkey", () => {
    const req: PairRequest = { setupCode: "ABCD-1234", deviceName: "Kyle's phone" };
    expect(check(PairRequestSchema, req)).toBe(true);
  });

  it("rejects an empty device name", () => {
    expect(check(PairRequestSchema, { setupCode: "x", deviceName: "" })).toBe(false);
  });

  it("requires agentId to create a thread; title is optional", () => {
    expect(check(CreateThreadRequestSchema, { agentId: "a1" })).toBe(true);
    expect(check(CreateThreadRequestSchema, { title: "no agent" })).toBe(false);
  });

  it("rejects an empty rename", () => {
    expect(check(RenameThreadRequestSchema, { title: "" })).toBe(false);
  });

  it("requires at least one block to send", () => {
    const ok: SendMessageRequest = { blocks: [{ type: "paragraph", text: "hi" }] };
    expect(check(SendMessageRequestSchema, ok)).toBe(true);
    expect(check(SendMessageRequestSchema, { blocks: [] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/contract && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: FAIL, cannot find `../src/rest.ts`.

- [ ] **Step 3: Implement**

`packages/contract/src/rest.ts`:

```ts
import { type Static, Type } from "@sinclair/typebox";

import { RichBlockSchema } from "./rich-blocks.ts";
import { DeviceSchema, GatewayInfoSchema, MessageSchema } from "./resources.ts";

export const PairRequestSchema = Type.Object({
  setupCode: Type.String({ minLength: 1 }),
  deviceName: Type.String({ minLength: 1, maxLength: 120 }),
  devicePubkey: Type.Optional(Type.String()),
});
export type PairRequest = Static<typeof PairRequestSchema>;

export const PairResponseSchema = Type.Object({
  deviceToken: Type.String(),
  device: DeviceSchema,
  gateway: GatewayInfoSchema,
});
export type PairResponse = Static<typeof PairResponseSchema>;

export const CreateThreadRequestSchema = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String({ maxLength: 200 })),
});
export type CreateThreadRequest = Static<typeof CreateThreadRequestSchema>;

export const RenameThreadRequestSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
});
export type RenameThreadRequest = Static<typeof RenameThreadRequestSchema>;

/** Messages are returned in ascending seq order. */
export const ListMessagesResponseSchema = Type.Object({
  messages: Type.Array(MessageSchema),
});
export type ListMessagesResponse = Static<typeof ListMessagesResponseSchema>;

export const SendMessageRequestSchema = Type.Object({
  blocks: Type.Array(RichBlockSchema, { minItems: 1 }),
});
export type SendMessageRequest = Static<typeof SendMessageRequestSchema>;

export const SendMessageResponseSchema = Type.Object({
  message: MessageSchema,
});
export type SendMessageResponse = Static<typeof SendMessageResponseSchema>;

/** pushKey is the symmetric key the gateway uses to encrypt notification payloads. The relay
 *  never sees it; it travels only device -> gateway over the paired TLS channel. */
export const PushRegisterRequestSchema = Type.Object({
  pushId: Type.String({ minLength: 1 }),
  relayUrl: Type.String({ minLength: 1 }),
  pushKey: Type.String({ minLength: 1 }),
});
export type PushRegisterRequest = Static<typeof PushRegisterRequestSchema>;
```

Add to `packages/contract/src/index.ts`: `export * from "./rest.ts";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/contract && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm typecheck
git add packages/contract
git commit -m "feat(contract): REST request/response schemas"
```

---

### Task 4: Contract WS frame schemas

**Files:**
- Create: `packages/contract/src/ws.ts`
- Modify: `packages/contract/src/index.ts` (add `export * from "./ws.ts";`)
- Test: `packages/contract/test/ws.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: client frames `AuthFrameSchema` (`{type:"auth", token}`), `SyncFrameSchema` (`{type:"sync", threads: Record<threadId, sinceSeq >= 0>}`), `ClientFrameSchema` (union); server frames `ReadyFrameSchema` (`{type:"ready", deviceId, gateway}`), `SyncedFrameSchema` (`{type:"synced"}`), `CommittedFrameSchema` (`{type:"committed", threadId, seq, message}`), `DraftFrameSchema` (`{type:"draft", threadId, turnId, blocks, toolCalls}`), `DoneFrameSchema` (`{type:"done", threadId, turnId}`), `PresenceFrameSchema` (`{type:"presence", agentId, state}`), `ErrorFrameSchema` (`{type:"error", code, message, threadId?}`), `ServerFrameSchema` (union). Types with the same names minus `Schema`.

- [ ] **Step 1: Write failing tests**

`packages/contract/test/ws.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { ClientFrame, ServerFrame } from "../src/ws.ts";
import { ClientFrameSchema, ServerFrameSchema } from "../src/ws.ts";
import { check } from "../src/validate.ts";

describe("client frames", () => {
  it("accepts auth and sync", () => {
    const auth: ClientFrame = { type: "auth", token: "tok" };
    const sync: ClientFrame = { type: "sync", threads: { t1: 0, t2: 17 } };
    expect(check(ClientFrameSchema, auth)).toBe(true);
    expect(check(ClientFrameSchema, sync)).toBe(true);
  });

  it("rejects a negative sinceSeq and an unknown type", () => {
    expect(check(ClientFrameSchema, { type: "sync", threads: { t1: -1 } })).toBe(false);
    expect(check(ClientFrameSchema, { type: "send", text: "hi" })).toBe(false);
  });
});

describe("server frames", () => {
  it("accepts the full lifecycle frames", () => {
    const frames: ServerFrame[] = [
      { type: "ready", deviceId: "d1", gateway: { name: "g", version: "0.1.0", contract: "v1" } },
      {
        type: "committed",
        threadId: "t1",
        seq: 4,
        message: {
          threadId: "t1",
          seq: 4,
          role: "agent",
          blocks: [{ type: "paragraph", text: "done" }],
          turnId: "turn-1",
          createdAt: 1,
        },
      },
      {
        type: "draft",
        threadId: "t1",
        turnId: "turn-1",
        blocks: [{ type: "paragraph", text: "thinking" }],
        toolCalls: [{ id: "c1", name: "search", status: "running" }],
      },
      { type: "done", threadId: "t1", turnId: "turn-1" },
      { type: "presence", agentId: "a1", state: "absent" },
      { type: "error", code: "backend_unavailable", message: "agent offline", threadId: "t1" },
      { type: "synced" },
    ];
    for (const frame of frames) {
      expect(check(ServerFrameSchema, frame)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/contract && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: FAIL, cannot find `../src/ws.ts`.

- [ ] **Step 3: Implement**

`packages/contract/src/ws.ts`:

```ts
/** One WebSocket per device carries all threads. Auth rides in the FIRST client frame, never
 *  the URL. Drafts are ephemeral full-replace frames; only `committed` carries a seq. Clients
 *  must ignore unknown server frame types (forward compatibility); the gateway answers unknown
 *  client frames with an `error` frame. */
import { type Static, Type } from "@sinclair/typebox";

import { RichBlockSchema } from "./rich-blocks.ts";
import {
  GatewayInfoSchema,
  MessageSchema,
  PresenceStateSchema,
  ToolCallSchema,
} from "./resources.ts";

export const AuthFrameSchema = Type.Object({
  type: Type.Literal("auth"),
  token: Type.String({ minLength: 1 }),
});
export type AuthFrame = Static<typeof AuthFrameSchema>;

/** threads maps threadId -> the client's high-water seq (0 = send everything). */
export const SyncFrameSchema = Type.Object({
  type: Type.Literal("sync"),
  threads: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
});
export type SyncFrame = Static<typeof SyncFrameSchema>;

export const ClientFrameSchema = Type.Union([AuthFrameSchema, SyncFrameSchema]);
export type ClientFrame = Static<typeof ClientFrameSchema>;

export const ReadyFrameSchema = Type.Object({
  type: Type.Literal("ready"),
  deviceId: Type.String(),
  gateway: GatewayInfoSchema,
});
export type ReadyFrame = Static<typeof ReadyFrameSchema>;

export const SyncedFrameSchema = Type.Object({ type: Type.Literal("synced") });
export type SyncedFrame = Static<typeof SyncedFrameSchema>;

export const CommittedFrameSchema = Type.Object({
  type: Type.Literal("committed"),
  threadId: Type.String(),
  seq: Type.Integer({ minimum: 1 }),
  message: MessageSchema,
});
export type CommittedFrame = Static<typeof CommittedFrameSchema>;

export const DraftFrameSchema = Type.Object({
  type: Type.Literal("draft"),
  threadId: Type.String(),
  turnId: Type.String(),
  blocks: Type.Array(RichBlockSchema),
  toolCalls: Type.Array(ToolCallSchema),
});
export type DraftFrame = Static<typeof DraftFrameSchema>;

export const DoneFrameSchema = Type.Object({
  type: Type.Literal("done"),
  threadId: Type.String(),
  turnId: Type.String(),
});
export type DoneFrame = Static<typeof DoneFrameSchema>;

export const PresenceFrameSchema = Type.Object({
  type: Type.Literal("presence"),
  agentId: Type.String(),
  state: PresenceStateSchema,
});
export type PresenceFrame = Static<typeof PresenceFrameSchema>;

export const ErrorFrameSchema = Type.Object({
  type: Type.Literal("error"),
  code: Type.String(),
  message: Type.String(),
  threadId: Type.Optional(Type.String()),
});
export type ErrorFrame = Static<typeof ErrorFrameSchema>;

export const ServerFrameSchema = Type.Union([
  ReadyFrameSchema,
  SyncedFrameSchema,
  CommittedFrameSchema,
  DraftFrameSchema,
  DoneFrameSchema,
  PresenceFrameSchema,
  ErrorFrameSchema,
]);
export type ServerFrame = Static<typeof ServerFrameSchema>;
```

Add to `packages/contract/src/index.ts`: `export * from "./ws.ts";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/contract && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: PASS.

- [ ] **Step 5: Full package gate and commit**

```bash
PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm typecheck && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm build && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway-contract lint:package
git add packages/contract
git commit -m "feat(contract): WS frame schemas (auth-first, sync replay, draft/committed/done)"
```

---

### Task 5: Prose contract spec `contract/v1.md` + contract package README

**Files:**
- Create: `contract/v1.md`
- Create: `packages/contract/README.md`

**Interfaces:**
- Consumes: every schema name from Tasks 1-4 (the doc must match them exactly).
- Produces: the frozen human-readable contract that Android and third-party clients build against.

- [ ] **Step 1: Write `contract/v1.md`**

Structure (write full prose for each; PUBLIC COPY: no em-dashes, nominative OpenClaw mention only if needed, no harness names):

```markdown
# cozygateway wire contract v1

Status: frozen 2026-07-06. Additive changes only within v1.x; receivers must ignore unknown
object fields and unknown server frame types. Unknown RichBlock types are invalid.

## 1. Transport
HTTPS REST for actions, one WebSocket for live traffic. Bearer device token on every REST
request (Authorization: Bearer <token>). WS auth in the first frame, never the URL.
GET /health and POST /pair are the only unauthenticated endpoints.

## 2. Content model: RichBlock
[List the seven block types with their exact JSON shapes from rich-blocks.ts. State the
closed-union rule and the no-URL rule for attachment. State that attachment upload/download
endpoints are reserved for a v1.x additive extension and the reference gateway does not emit
attachment blocks yet.]

## 3. Errors
HTTP errors: status + {"error": {"code", "message"}}. Codes: unauthorized, not_found,
invalid_request, setup_code_invalid, thread_archived, backend_unavailable, turn_failed,
internal. WS errors: {"type": "error", ...} frame; fatal auth failures close with 1008.

## 4. Pairing
[QR payload {"gatewayUrl", "setupCode"}; setup codes single use, 10 minute expiry;
POST /pair request/response shapes; GET /devices; DELETE /devices/:id revokes immediately,
including live WS connections of that device.]

## 5. Resources
[GET /agents; GET/POST /threads; PATCH /threads/:id; DELETE /threads/:id archives (thread
disappears from GET /threads, its messages stay readable);
GET /threads/:id/messages?before=<seq>&limit=<n> returns ascending seq, the <limit> newest
messages older than <before> (omit before = newest page); POST /threads/:id/messages;
POST /push/register. Exact JSON shapes for each, matching rest.ts.]

## 6. Live stream
[Frame-by-frame lifecycle with a worked example: connect, auth, ready, sync, replay,
synced, then live committed/draft/done/presence/error. seq semantics: per thread, gapless,
starts at 1, allocated in commit order; drafts ephemeral, full replace per frame; client
dedupe by high-water mark. Reconnect story: drafts are lost by design, sync replays
committed only, interrupted turns appear as a committed system message with marker
"turn.failed".]

## 7. Conformance
A gateway implementation is conformant when the cozygateway-conformance suite passes against
it while it exposes the reference echo backend (an agent whose reply to a message whose first
block is {"type":"paragraph","text":T} is exactly two draft frames then a commit of
[{"type":"paragraph","text":"Echo: " + T}]; a T containing "[[fail]]" fails the turn).
```

- [ ] **Step 2: Write `packages/contract/README.md`**

Short: what the package is, install (`npm i cozygateway-contract`), one usage example with `check(ServerFrameSchema, frame)` narrowing, link to `contract/v1.md` in the repo. No em-dashes.

- [ ] **Step 3: Cross-check doc against code**

Re-read `rich-blocks.ts`, `resources.ts`, `rest.ts`, `ws.ts`; verify every field name and optionality in the doc matches. Run `grep -n '—' contract/v1.md packages/contract/README.md` and expect no hits.

- [ ] **Step 4: Commit**

```bash
git add contract packages/contract/README.md
git commit -m "docs(contract): freeze wire contract v1 prose spec"
```

---

### Task 6: Gateway package scaffold + config loader

**Files:**
- Create: `packages/gateway/package.json`, `packages/gateway/tsconfig.json`, `packages/gateway/tsconfig.build.json`
- Create: `packages/gateway/src/config.ts`
- Test: `packages/gateway/test/config.test.ts`

**Interfaces:**
- Consumes: contract package via `"cozygateway-contract": "workspace:*"`.
- Produces: `GatewayConfig` type `{name: string; port: number; dbPath: string; agents: AgentConfig[]}` with `AgentConfig = {id: string; name: string; avatar?: string; backend: string; options?: Record<string, unknown>}`; `loadConfig(path: string): GatewayConfig` (validates with TypeBox, throws `ContractViolation` on bad config); `defineConfig` not needed.

- [ ] **Step 1: Package scaffold**

`packages/gateway/package.json`:

```json
{
  "name": "cozygateway",
  "version": "0.1.0",
  "description": "Self-hosted gateway that turns your AI agent into a chat contact on your phone. Speaks the cozygateway wire contract; drives backends through adapters.",
  "type": "module",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/shiftedx/cozygateway.git",
    "directory": "packages/gateway"
  },
  "engines": { "node": ">=24" },
  "bin": { "cozygateway": "dist/cli.js" },
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "build": "tsc -p tsconfig.build.json"
  },
  "dependencies": {
    "@hono/node-server": "^1.13.0",
    "@sinclair/typebox": "^0.34.0",
    "cozygateway-contract": "workspace:*",
    "hono": "^4.6.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.0"
  }
}
```

`tsconfig.json` and `tsconfig.build.json`: copy the contract package's files verbatim.

Run `PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm install` at the repo root after creating package.json.

NOTE: the workspace dependency resolves to `packages/contract` source via its `exports` map pointing at `dist`. Build the contract package once (`pnpm --filter cozygateway-contract build`) before gateway typecheck, and remember `pnpm build` at the root builds in dependency order.

- [ ] **Step 2: Write failing config test**

`packages/gateway/test/config.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { ContractViolation } from "cozygateway-contract";

import { loadConfig } from "../src/config.ts";

function writeConfig(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cozygateway-config-"));
  const path = join(dir, "cozygateway.config.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("loadConfig", () => {
  it("loads a valid config and applies defaults", () => {
    const path = writeConfig({
      name: "test-gateway",
      agents: [{ id: "mock", name: "Mock", backend: "mock" }],
    });
    const config = loadConfig(path);
    expect(config.port).toBe(8787);
    expect(config.dbPath).toBe("cozygateway.db");
    expect(config.agents[0]?.backend).toBe("mock");
  });

  it("rejects a config with no agents", () => {
    const path = writeConfig({ name: "g", agents: [] });
    expect(() => loadConfig(path)).toThrow(ContractViolation);
  });

  it("rejects duplicate agent ids", () => {
    const path = writeConfig({
      name: "g",
      agents: [
        { id: "a", name: "A", backend: "mock" },
        { id: "a", name: "B", backend: "mock" },
      ],
    });
    expect(() => loadConfig(path)).toThrow(/duplicate agent id/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: FAIL, cannot find `../src/config.ts`.

- [ ] **Step 4: Implement `src/config.ts`**

```ts
import { readFileSync } from "node:fs";

import { type Static, Type } from "@sinclair/typebox";
import { ContractViolation, assertValid } from "cozygateway-contract";

const AgentConfigSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  avatar: Type.Optional(Type.String()),
  backend: Type.String({ minLength: 1 }),
  options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type AgentConfig = Static<typeof AgentConfigSchema>;

const GatewayConfigSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  port: Type.Integer({ minimum: 1, maximum: 65535, default: 8787 }),
  dbPath: Type.String({ minLength: 1, default: "cozygateway.db" }),
  agents: Type.Array(AgentConfigSchema, { minItems: 1 }),
});
export type GatewayConfig = Static<typeof GatewayConfigSchema>;

export function loadConfig(path: string): GatewayConfig {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const withDefaults =
    typeof raw === "object" && raw !== null
      ? { port: 8787, dbPath: "cozygateway.db", ...raw }
      : raw;
  const config = assertValid(GatewayConfigSchema, withDefaults);
  const seen = new Set<string>();
  for (const agent of config.agents) {
    if (seen.has(agent.id)) {
      throw new ContractViolation(`duplicate agent id "${agent.id}"`, "/agents");
    }
    seen.add(agent.id);
  }
  return config;
}
```

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `cd packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm typecheck`
Expected: PASS.

```bash
git add packages/gateway pnpm-lock.yaml
git commit -m "feat(gateway): package scaffold + validated config loader"
```

---

### Task 7: Storage layer (node:sqlite)

**Files:**
- Create: `packages/gateway/src/storage.ts`
- Test: `packages/gateway/test/storage.test.ts`

**Interfaces:**
- Consumes: contract types `Message`, `MessageRole`, `RichBlock`.
- Produces: `openStorage(dbPath: string): Storage` (":memory:" allowed). `Storage` is a class with methods:
  - `createSetupCode(code: string, expiresAt: number): void`
  - `consumeSetupCode(code: string, now: number): "ok" | "invalid"` (single use; expired or unknown or used = "invalid")
  - `createDevice(device: {id: string; name: string; tokenHash: string; createdAt: number}): void`
  - `deviceByTokenHash(tokenHash: string): {id: string; name: string; createdAt: number; lastSeenAt: number | null} | undefined`
  - `listDevices(): Array<{id; name; createdAt; lastSeenAt}>` / `deleteDevice(id: string): boolean` / `touchDevice(id: string, at: number): void`
  - `upsertAgent(agent: {id; name; avatar: string | null; backend}): void` / `listAgents()` / `agentById(id)`
  - `createThread(thread: {id; agentId; title; createdAt}): void` / `listThreads()` (excludes archived, newest lastMessageAt first, nulls last) / `threadById(id)` (includes archived, exposes `archivedAt`) / `renameThread(id, title): boolean` / `archiveThread(id): boolean`
  - `appendMessage(threadId: string, entry: {role: MessageRole; blocks: RichBlock[]; turnId?: string; marker?: "turn.failed"}, createdAt: number): Message` (allocates the next per-thread seq atomically, bumps thread lastMessageAt)
  - `messagesSince(threadId: string, sinceSeq: number): Message[]` (ascending, seq > sinceSeq)
  - `messagesBefore(threadId: string, before: number | null, limit: number): Message[]` (ascending order, the `limit` newest with seq < before; null before = newest page)
  - `savePushRegistration(deviceId: string, reg: {pushId; relayUrl; pushKey}): void`
  - `close(): void`

- [ ] **Step 1: Write failing tests**

`packages/gateway/test/storage.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { openStorage } from "../src/storage.ts";

function seeded() {
  const storage = openStorage(":memory:");
  storage.upsertAgent({ id: "a1", name: "Mock", avatar: null, backend: "mock" });
  storage.createThread({ id: "t1", agentId: "a1", title: "First", createdAt: 100 });
  return storage;
}

describe("setup codes", () => {
  it("consumes a live code exactly once", () => {
    const storage = openStorage(":memory:");
    storage.createSetupCode("CODE", 1_000);
    expect(storage.consumeSetupCode("CODE", 500)).toBe("ok");
    expect(storage.consumeSetupCode("CODE", 501)).toBe("invalid");
  });
  it("rejects expired and unknown codes", () => {
    const storage = openStorage(":memory:");
    storage.createSetupCode("CODE", 1_000);
    expect(storage.consumeSetupCode("CODE", 1_001)).toBe("invalid");
    expect(storage.consumeSetupCode("NOPE", 0)).toBe("invalid");
  });
});

describe("devices", () => {
  it("stores, finds by token hash, and deletes", () => {
    const storage = openStorage(":memory:");
    storage.createDevice({ id: "d1", name: "Phone", tokenHash: "h1", createdAt: 1 });
    expect(storage.deviceByTokenHash("h1")?.id).toBe("d1");
    expect(storage.deleteDevice("d1")).toBe(true);
    expect(storage.deviceByTokenHash("h1")).toBeUndefined();
    expect(storage.deleteDevice("d1")).toBe(false);
  });
});

describe("messages", () => {
  it("allocates gapless per-thread seq starting at 1", () => {
    const storage = seeded();
    const m1 = storage.appendMessage("t1", { role: "user", blocks: [{ type: "paragraph", text: "one" }] }, 200);
    const m2 = storage.appendMessage("t1", { role: "agent", blocks: [{ type: "paragraph", text: "two" }], turnId: "turn-1" }, 300);
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);
    expect(m2.turnId).toBe("turn-1");
    expect(storage.threadById("t1")?.lastMessageAt).toBe(300);
  });

  it("seq is independent per thread", () => {
    const storage = seeded();
    storage.createThread({ id: "t2", agentId: "a1", title: "Second", createdAt: 100 });
    storage.appendMessage("t1", { role: "user", blocks: [] }, 1);
    const other = storage.appendMessage("t2", { role: "user", blocks: [] }, 2);
    expect(other.seq).toBe(1);
  });

  it("messagesSince replays ascending above the mark", () => {
    const storage = seeded();
    for (let i = 0; i < 5; i++) {
      storage.appendMessage("t1", { role: "user", blocks: [{ type: "paragraph", text: String(i) }] }, i);
    }
    const replay = storage.messagesSince("t1", 2);
    expect(replay.map((m) => m.seq)).toEqual([3, 4, 5]);
  });

  it("messagesBefore pages backwards but returns ascending", () => {
    const storage = seeded();
    for (let i = 0; i < 5; i++) {
      storage.appendMessage("t1", { role: "user", blocks: [] }, i);
    }
    expect(storage.messagesBefore("t1", null, 2).map((m) => m.seq)).toEqual([4, 5]);
    expect(storage.messagesBefore("t1", 4, 2).map((m) => m.seq)).toEqual([2, 3]);
    expect(storage.messagesBefore("t1", 2, 5).map((m) => m.seq)).toEqual([1]);
  });

  it("round-trips marker messages", () => {
    const storage = seeded();
    const marker = storage.appendMessage(
      "t1",
      { role: "system", blocks: [{ type: "paragraph", text: "failed" }], turnId: "turn-9", marker: "turn.failed" },
      50,
    );
    expect(storage.messagesSince("t1", 0)[0]?.marker).toBe("turn.failed");
    expect(marker.marker).toBe("turn.failed");
  });
});

describe("threads", () => {
  it("archives out of the list but keeps lookup", () => {
    const storage = seeded();
    expect(storage.archiveThread("t1")).toBe(true);
    expect(storage.listThreads()).toHaveLength(0);
    expect(storage.threadById("t1")?.archivedAt).not.toBeNull();
  });
  it("renames", () => {
    const storage = seeded();
    expect(storage.renameThread("t1", "Renamed")).toBe(true);
    expect(storage.threadById("t1")?.title).toBe("Renamed");
    expect(storage.renameThread("missing", "x")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: FAIL, cannot find `../src/storage.ts`.

- [ ] **Step 3: Implement `src/storage.ts`**

```ts
import { DatabaseSync } from "node:sqlite";

import type { Message, MessageRole, RichBlock } from "cozygateway-contract";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS setup_codes (
  code TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  backend TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER,
  archived_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS messages (
  thread_id TEXT NOT NULL REFERENCES threads(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  turn_id TEXT,
  marker TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, seq)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS push_registrations (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  push_id TEXT NOT NULL,
  relay_url TEXT NOT NULL,
  push_key TEXT NOT NULL
) STRICT;
`;

export interface DeviceRow {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
}
export interface AgentRow {
  id: string;
  name: string;
  avatar: string | null;
  backend: string;
}
export interface ThreadRow {
  id: string;
  agentId: string;
  title: string;
  createdAt: number;
  lastMessageAt: number | null;
  archivedAt: number | null;
}

interface MessageDbRow {
  threadId: string;
  seq: number;
  role: string;
  blocksJson: string;
  turnId: string | null;
  marker: string | null;
  createdAt: number;
}

function toMessage(row: MessageDbRow): Message {
  const message: Message = {
    threadId: row.threadId,
    seq: row.seq,
    role: row.role as MessageRole,
    blocks: JSON.parse(row.blocksJson) as RichBlock[],
    createdAt: row.createdAt,
  };
  if (row.turnId !== null) message.turnId = row.turnId;
  if (row.marker === "turn.failed") message.marker = "turn.failed";
  return message;
}

export class Storage {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  createSetupCode(code: string, expiresAt: number): void {
    this.#db.prepare("INSERT INTO setup_codes (code, expires_at) VALUES (?, ?)").run(code, expiresAt);
  }

  consumeSetupCode(code: string, now: number): "ok" | "invalid" {
    const result = this.#db
      .prepare("UPDATE setup_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at >= ?")
      .run(now, code, now);
    return result.changes === 1 ? "ok" : "invalid";
  }

  createDevice(device: { id: string; name: string; tokenHash: string; createdAt: number }): void {
    this.#db
      .prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(device.id, device.name, device.tokenHash, device.createdAt);
  }

  deviceByTokenHash(tokenHash: string): DeviceRow | undefined {
    return this.#db
      .prepare(
        "SELECT id, name, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices WHERE token_hash = ?",
      )
      .get(tokenHash) as DeviceRow | undefined;
  }

  listDevices(): DeviceRow[] {
    return this.#db
      .prepare(
        "SELECT id, name, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices ORDER BY created_at",
      )
      .all() as unknown as DeviceRow[];
  }

  deleteDevice(id: string): boolean {
    return this.#db.prepare("DELETE FROM devices WHERE id = ?").run(id).changes === 1;
  }

  touchDevice(id: string, at: number): void {
    this.#db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(at, id);
  }

  upsertAgent(agent: AgentRow): void {
    this.#db
      .prepare(
        `INSERT INTO agents (id, name, avatar, backend) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, backend = excluded.backend`,
      )
      .run(agent.id, agent.name, agent.avatar, agent.backend);
  }

  listAgents(): AgentRow[] {
    return this.#db
      .prepare("SELECT id, name, avatar, backend FROM agents ORDER BY id")
      .all() as unknown as AgentRow[];
  }

  agentById(id: string): AgentRow | undefined {
    return this.#db.prepare("SELECT id, name, avatar, backend FROM agents WHERE id = ?").get(id) as
      | AgentRow
      | undefined;
  }

  createThread(thread: { id: string; agentId: string; title: string; createdAt: number }): void {
    this.#db
      .prepare("INSERT INTO threads (id, agent_id, title, created_at) VALUES (?, ?, ?, ?)")
      .run(thread.id, thread.agentId, thread.title, thread.createdAt);
  }

  listThreads(): ThreadRow[] {
    return this.#db
      .prepare(
        `SELECT id, agent_id AS agentId, title, created_at AS createdAt,
                last_message_at AS lastMessageAt, archived_at AS archivedAt
         FROM threads WHERE archived_at IS NULL
         ORDER BY last_message_at IS NULL, last_message_at DESC, created_at DESC`,
      )
      .all() as unknown as ThreadRow[];
  }

  threadById(id: string): ThreadRow | undefined {
    return this.#db
      .prepare(
        `SELECT id, agent_id AS agentId, title, created_at AS createdAt,
                last_message_at AS lastMessageAt, archived_at AS archivedAt
         FROM threads WHERE id = ?`,
      )
      .get(id) as ThreadRow | undefined;
  }

  renameThread(id: string, title: string): boolean {
    return this.#db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(title, id).changes === 1;
  }

  archiveThread(id: string): boolean {
    return (
      this.#db
        .prepare("UPDATE threads SET archived_at = ? WHERE id = ? AND archived_at IS NULL")
        .run(Date.now(), id).changes === 1
    );
  }

  appendMessage(
    threadId: string,
    entry: { role: MessageRole; blocks: RichBlock[]; turnId?: string; marker?: "turn.failed" },
    createdAt: number,
  ): Message {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE thread_id = ?")
        .get(threadId) as { next: number };
      this.#db
        .prepare(
          `INSERT INTO messages (thread_id, seq, role, blocks_json, turn_id, marker, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          threadId,
          row.next,
          entry.role,
          JSON.stringify(entry.blocks),
          entry.turnId ?? null,
          entry.marker ?? null,
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
      return message;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  messagesSince(threadId: string, sinceSeq: number): Message[] {
    const rows = this.#db
      .prepare(
        `SELECT thread_id AS threadId, seq, role, blocks_json AS blocksJson, turn_id AS turnId,
                marker, created_at AS createdAt
         FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq`,
      )
      .all(threadId, sinceSeq) as unknown as MessageDbRow[];
    return rows.map(toMessage);
  }

  messagesBefore(threadId: string, before: number | null, limit: number): Message[] {
    const rows = this.#db
      .prepare(
        `SELECT thread_id AS threadId, seq, role, blocks_json AS blocksJson, turn_id AS turnId,
                marker, created_at AS createdAt
         FROM messages WHERE thread_id = ? AND seq < ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(threadId, before ?? Number.MAX_SAFE_INTEGER, limit) as unknown as MessageDbRow[];
    return rows.reverse().map(toMessage);
  }

  savePushRegistration(deviceId: string, reg: { pushId: string; relayUrl: string; pushKey: string }): void {
    this.#db
      .prepare(
        `INSERT INTO push_registrations (device_id, push_id, relay_url, push_key) VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET push_id = excluded.push_id,
           relay_url = excluded.relay_url, push_key = excluded.push_key`,
      )
      .run(deviceId, reg.pushId, reg.relayUrl, reg.pushKey);
  }

  close(): void {
    this.#db.close();
  }
}

export function openStorage(dbPath: string): Storage {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return new Storage(db);
}
```

The `as unknown as XRow[]` casts on `.all()` are the storage boundary narrowing; keep them here only (node:sqlite returns untyped records). If `STRICT` or `WITHOUT ROWID` fails on the CI sqlite version, drop `WITHOUT ROWID` first and re-run; keep `STRICT`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm typecheck
git add packages/gateway
git commit -m "feat(gateway): node:sqlite storage with gapless per-thread seq allocation"
```

---

### Task 8: Auth + pairing routes + app factory

**Files:**
- Create: `packages/gateway/src/auth.ts`
- Create: `packages/gateway/src/http.ts`
- Test: `packages/gateway/test/pairing.test.ts`

**Interfaces:**
- Consumes: `Storage` (Task 7), `GatewayConfig` (Task 6), contract schemas.
- Produces:
  - `auth.ts`: `mintDeviceToken(): {token: string; tokenHash: string}` (32 random bytes base64url; hash = sha256 hex), `hashToken(token: string): string`, `newSetupCode(): string` (format `XXXX-XXXX`, A-Z2-9 alphabet), `SETUP_CODE_TTL_MS = 10 * 60 * 1000`.
  - `http.ts`: `createApp(deps: AppDeps): Hono` where `AppDeps = {storage: Storage; config: GatewayConfig; gatewayInfo: GatewayInfo; presenceOf: (agentId: string) => PresenceState; submitUserMessage: (threadId: string, blocks: RichBlock[]) => Message; onDeviceRevoked: (deviceId: string) => void; now: () => number}`. Routes this task: `GET /health`, `POST /pair`, `GET /devices`, `DELETE /devices/:id`. Bearer middleware sets `c.set("deviceId", ...)`; 401 body uses `ErrorBody` shape. Later tasks add routes to the same factory.
  - Helper exported for tests and later tasks: `errorBody(code: ErrorCode, message: string): ErrorBody`.

- [ ] **Step 1: Write failing tests**

`packages/gateway/test/pairing.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { openStorage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";

const config: GatewayConfig = {
  name: "test-gateway",
  port: 8787,
  dbPath: ":memory:",
  agents: [{ id: "mock", name: "Mock", backend: "mock" }],
};

function makeApp(now = () => 1_000) {
  const storage = openStorage(":memory:");
  const revoked: string[] = [];
  const app = createApp({
    storage,
    config,
    gatewayInfo: { name: "test-gateway", version: "0.1.0", contract: "v1" },
    presenceOf: () => "online",
    submitUserMessage: () => {
      throw new Error("not under test");
    },
    onDeviceRevoked: (id) => revoked.push(id),
    now,
  });
  return { app, storage, revoked };
}

async function pair(app: ReturnType<typeof makeApp>["app"], storage: ReturnType<typeof openStorage>, now = 1_000) {
  const code = newSetupCode();
  storage.createSetupCode(code, now + SETUP_CODE_TTL_MS);
  const res = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "Test phone" }),
  });
  return res;
}

describe("GET /health", () => {
  it("is unauthenticated and reports contract v1", async () => {
    const { app } = makeApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contract: string };
    expect(body.contract).toBe("v1");
  });
});

describe("POST /pair", () => {
  it("issues a device token for a live setup code", async () => {
    const { app, storage } = makeApp();
    const res = await pair(app, storage);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deviceToken: string; device: { name: string } };
    expect(body.deviceToken.length).toBeGreaterThan(20);
    expect(body.device.name).toBe("Test phone");
  });

  it("rejects an unknown or reused code with setup_code_invalid", async () => {
    const { app, storage } = makeApp();
    const first = await pair(app, storage);
    expect(first.status).toBe(200);
    const res = await app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: "NOPE-0000", deviceName: "x" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("setup_code_invalid");
  });

  it("rejects a malformed body with invalid_request", async () => {
    const { app } = makeApp();
    const res = await app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceName: "no code" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("bearer auth + device management", () => {
  it("rejects missing/garbage tokens and accepts a paired one", async () => {
    const { app, storage } = makeApp();
    expect((await app.request("/devices")).status).toBe(401);
    expect(
      (await app.request("/devices", { headers: { authorization: "Bearer garbage" } })).status,
    ).toBe(401);

    const pairRes = await pair(app, storage);
    const { deviceToken } = (await pairRes.json()) as { deviceToken: string };
    const res = await app.request("/devices", { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(res.status).toBe(200);
    const devices = (await res.json()) as Array<{ id: string }>;
    expect(devices).toHaveLength(1);
  });

  it("revokes a device and fires the revocation hook", async () => {
    const { app, storage, revoked } = makeApp();
    const pairRes = await pair(app, storage);
    const { deviceToken, device } = (await pairRes.json()) as {
      deviceToken: string;
      device: { id: string };
    };
    const del = await app.request(`/devices/${device.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(del.status).toBe(200);
    expect(revoked).toEqual([device.id]);
    expect(
      (await app.request("/devices", { headers: { authorization: `Bearer ${deviceToken}` } })).status,
    ).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: FAIL, cannot find `../src/http.ts` / `../src/auth.ts`.

- [ ] **Step 3: Implement**

`packages/gateway/src/auth.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

export const SETUP_CODE_TTL_MS = 10 * 60 * 1000;

/** Unambiguous alphabet (no 0/O/1/I) for codes a human may need to type. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newSetupCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += "-";
    code += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  }
  return code;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function mintDeviceToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}
```

`packages/gateway/src/http.ts`:

```ts
import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  type ErrorBody,
  type ErrorCode,
  type GatewayInfo,
  type Message,
  type PresenceState,
  type RichBlock,
  ContractViolation,
  PairRequestSchema,
  assertValid,
} from "cozygateway-contract";

import type { GatewayConfig } from "./config.ts";
import type { Storage } from "./storage.ts";
import { hashToken, mintDeviceToken } from "./auth.ts";

export interface AppDeps {
  storage: Storage;
  config: GatewayConfig;
  gatewayInfo: GatewayInfo;
  presenceOf: (agentId: string) => PresenceState;
  submitUserMessage: (threadId: string, blocks: RichBlock[]) => Message;
  onDeviceRevoked: (deviceId: string) => void;
  now: () => number;
}

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

type Env = { Variables: { deviceId: string } };

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();

  const requireDevice = async (c: Context<Env>, next: Next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const device = token === "" ? undefined : deps.storage.deviceByTokenHash(hashToken(token));
    if (device === undefined) {
      return c.json(errorBody("unauthorized", "missing or unknown device token"), 401);
    }
    deps.storage.touchDevice(device.id, deps.now());
    c.set("deviceId", device.id);
    await next();
  };

  const readBody = async (c: Context<Env>): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };

  app.get("/health", (c) => c.json(deps.gatewayInfo));

  app.post("/pair", async (c) => {
    const body = await readBody(c);
    let pairRequest;
    try {
      pairRequest = assertValid(PairRequestSchema, body);
    } catch (err) {
      const detail = err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    if (deps.storage.consumeSetupCode(pairRequest.setupCode, deps.now()) !== "ok") {
      return c.json(errorBody("setup_code_invalid", "setup code is unknown, used, or expired"), 401);
    }
    const { token, tokenHash } = mintDeviceToken();
    const device = {
      id: randomUUID(),
      name: pairRequest.deviceName,
      tokenHash,
      createdAt: deps.now(),
    };
    deps.storage.createDevice(device);
    return c.json({
      deviceToken: token,
      device: { id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: null },
      gateway: deps.gatewayInfo,
    });
  });

  app.get("/devices", requireDevice, (c) => c.json(deps.storage.listDevices()));

  app.delete("/devices/:id", requireDevice, (c) => {
    const id = c.req.param("id");
    if (!deps.storage.deleteDevice(id)) {
      return c.json(errorBody("not_found", "no such device"), 404);
    }
    deps.onDeviceRevoked(id);
    return c.json({ ok: true });
  });

  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm typecheck
git add packages/gateway
git commit -m "feat(gateway): pairing, device tokens, bearer auth, health endpoint"
```

---

### Task 9: Resource routes (agents, threads, messages, push registration)

**Files:**
- Modify: `packages/gateway/src/http.ts` (extend `createApp`)
- Test: `packages/gateway/test/resources-routes.test.ts`

**Interfaces:**
- Consumes: Task 8 `createApp`/`AppDeps` (uses `presenceOf` and `submitUserMessage`), Task 7 storage.
- Produces routes: `GET /agents`, `GET /threads`, `POST /threads`, `PATCH /threads/:id`, `DELETE /threads/:id`, `GET /threads/:id/messages?before&limit`, `POST /threads/:id/messages`, `POST /push/register`. All behind `requireDevice`. Default page limit 50, max 200. New thread title default: `"New thread"`. Sending to an archived thread returns 409 `thread_archived`. `submitUserMessage` throwing `BackendUnavailable` (exported from `src/turns.ts` in Task 12; for THIS task define and export `class BackendUnavailable extends Error` in `src/http.ts` temporarily is WRONG; instead create `packages/gateway/src/errors.ts` with it now and Task 12 imports from there) maps to 503 `backend_unavailable`.

Also create `packages/gateway/src/errors.ts`:

```ts
/** The thread's backend adapter cannot accept a send right now. REST maps this to
 *  503 backend_unavailable; the message is NOT persisted (the client keeps it queued). */
export class BackendUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendUnavailable";
  }
}
```

- [ ] **Step 1: Write failing tests**

`packages/gateway/test/resources-routes.test.ts` (reuse the `makeApp`/`pair` helpers pattern from Task 8's test, but give `submitUserMessage` a real fake):

```ts
import { describe, expect, it } from "vitest";
import type { Message, RichBlock } from "cozygateway-contract";

import { openStorage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { BackendUnavailable } from "../src/errors.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";

const config: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: ":memory:",
  agents: [{ id: "mock", name: "Mock", backend: "mock" }],
};

async function setup(opts?: { backendDown?: boolean }) {
  const storage = openStorage(":memory:");
  storage.upsertAgent({ id: "mock", name: "Mock", avatar: null, backend: "mock" });
  const app = createApp({
    storage,
    config,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1" },
    presenceOf: () => "online",
    submitUserMessage: (threadId: string, blocks: RichBlock[]): Message => {
      if (opts?.backendDown === true) throw new BackendUnavailable("backend down");
      return storage.appendMessage(threadId, { role: "user", blocks }, 500);
    },
    onDeviceRevoked: () => {},
    now: () => 1_000,
  });
  const code = newSetupCode();
  storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS);
  const pairRes = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
  });
  const { deviceToken } = (await pairRes.json()) as { deviceToken: string };
  const authed = (path: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` },
    });
  return { app, storage, authed };
}

describe("agents", () => {
  it("lists agents with presence", async () => {
    const { authed } = await setup();
    const res = await authed("/agents");
    expect(res.status).toBe(200);
    const agents = (await res.json()) as Array<{ id: string; presence: string }>;
    expect(agents).toEqual([
      { id: "mock", name: "Mock", backend: "mock", presence: "online" },
    ]);
  });
});

describe("threads", () => {
  it("creates with default title, renames, archives", async () => {
    const { authed } = await setup();
    const created = await authed("/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "mock" }),
    });
    expect(created.status).toBe(200);
    const thread = (await created.json()) as { id: string; title: string };
    expect(thread.title).toBe("New thread");

    const renamed = await authed(`/threads/${thread.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Project X" }),
    });
    expect(((await renamed.json()) as { title: string }).title).toBe("Project X");

    expect((await authed(`/threads/${thread.id}`, { method: "DELETE" })).status).toBe(200);
    const list = (await (await authed("/threads")).json()) as unknown[];
    expect(list).toHaveLength(0);
  });

  it("404s creating a thread for an unknown agent", async () => {
    const { authed } = await setup();
    const res = await authed("/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "ghost" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("messages", () => {
  async function withThread() {
    const ctx = await setup();
    const created = await ctx.authed("/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "mock", title: "T" }),
    });
    const thread = (await created.json()) as { id: string };
    return { ...ctx, threadId: thread.id };
  }

  it("sends a message and reads it back with pagination", async () => {
    const { authed, threadId } = await withThread();
    const sent = await authed(`/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "hello" }] }),
    });
    expect(sent.status).toBe(200);
    const { message } = (await sent.json()) as { message: { seq: number } };
    expect(message.seq).toBe(1);

    const page = await authed(`/threads/${threadId}/messages?limit=10`);
    const body = (await page.json()) as { messages: Array<{ seq: number }> };
    expect(body.messages.map((m) => m.seq)).toEqual([1]);
  });

  it("rejects empty blocks and unknown block types", async () => {
    const { authed, threadId } = await withThread();
    expect(
      (
        await authed(`/threads/${threadId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ blocks: [] }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await authed(`/threads/${threadId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ blocks: [{ type: "html", html: "<b>" }] }),
        })
      ).status,
    ).toBe(400);
  });

  it("409s on an archived thread and 503s when the backend is unavailable", async () => {
    const { authed, threadId } = await withThread();
    await authed(`/threads/${threadId}`, { method: "DELETE" });
    const archived = await authed(`/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "x" }] }),
    });
    expect(archived.status).toBe(409);

    const down = await setup({ backendDown: true });
    const created = await down.authed("/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "mock" }),
    });
    const thread = (await created.json()) as { id: string };
    const res = await down.authed(`/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "x" }] }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("backend_unavailable");
  });
});

describe("push registration", () => {
  it("stores a registration", async () => {
    const { authed } = await setup();
    const res = await authed("/push/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pushId: "p1", relayUrl: "https://relay.example", pushKey: "k" }),
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: FAIL (missing `src/errors.ts`, missing routes -> 404s).

- [ ] **Step 3: Implement**

Create `src/errors.ts` as specified in Interfaces. Extend `createApp` in `src/http.ts`, after the device routes (all use `requireDevice`). Add imports: `AgentSchema` is not needed; use `CreateThreadRequestSchema`, `RenameThreadRequestSchema`, `SendMessageRequestSchema`, `PushRegisterRequestSchema` from `cozygateway-contract`, `BackendUnavailable` from `./errors.ts`, plus a small local `parseOr400` helper:

```ts
  const parseOr400 = <S extends Parameters<typeof assertValid>[0]>(
    c: Context<Env>,
    schema: S,
    body: unknown,
  ) => {
    try {
      return { ok: true as const, value: assertValid(schema, body) };
    } catch (err) {
      const detail = err instanceof ContractViolation ? err.message : "malformed body";
      return { ok: false as const, response: c.json(errorBody("invalid_request", detail), 400) };
    }
  };

  const threadToWire = (t: ThreadRow) => ({
    id: t.id,
    agentId: t.agentId,
    title: t.title,
    createdAt: t.createdAt,
    lastMessageAt: t.lastMessageAt,
  });

  app.get("/agents", requireDevice, (c) =>
    c.json(
      deps.storage.listAgents().map((a) => ({
        id: a.id,
        name: a.name,
        ...(a.avatar === null ? {} : { avatar: a.avatar }),
        backend: a.backend,
        presence: deps.presenceOf(a.id),
      })),
    ),
  );

  app.get("/threads", requireDevice, (c) => c.json(deps.storage.listThreads().map(threadToWire)));

  app.post("/threads", requireDevice, async (c) => {
    const parsed = parseOr400(c, CreateThreadRequestSchema, await readBody(c));
    if (!parsed.ok) return parsed.response;
    if (deps.storage.agentById(parsed.value.agentId) === undefined) {
      return c.json(errorBody("not_found", "no such agent"), 404);
    }
    const thread = {
      id: randomUUID(),
      agentId: parsed.value.agentId,
      title: parsed.value.title ?? "New thread",
      createdAt: deps.now(),
    };
    deps.storage.createThread(thread);
    return c.json({ ...thread, lastMessageAt: null });
  });

  app.patch("/threads/:id", requireDevice, async (c) => {
    const parsed = parseOr400(c, RenameThreadRequestSchema, await readBody(c));
    if (!parsed.ok) return parsed.response;
    if (!deps.storage.renameThread(c.req.param("id"), parsed.value.title)) {
      return c.json(errorBody("not_found", "no such thread"), 404);
    }
    const thread = deps.storage.threadById(c.req.param("id"));
    return thread === undefined
      ? c.json(errorBody("not_found", "no such thread"), 404)
      : c.json(threadToWire(thread));
  });

  app.delete("/threads/:id", requireDevice, (c) => {
    if (!deps.storage.archiveThread(c.req.param("id"))) {
      return c.json(errorBody("not_found", "no such thread or already archived"), 404);
    }
    return c.json({ ok: true });
  });

  app.get("/threads/:id/messages", requireDevice, (c) => {
    const thread = deps.storage.threadById(c.req.param("id"));
    if (thread === undefined) return c.json(errorBody("not_found", "no such thread"), 404);
    const beforeRaw = c.req.query("before");
    const limitRaw = c.req.query("limit");
    const before = beforeRaw === undefined ? null : Number.parseInt(beforeRaw, 10);
    const limit = Math.min(limitRaw === undefined ? 50 : Number.parseInt(limitRaw, 10), 200);
    if ((before !== null && (Number.isNaN(before) || before < 1)) || Number.isNaN(limit) || limit < 1) {
      return c.json(errorBody("invalid_request", "bad before/limit"), 400);
    }
    return c.json({ messages: deps.storage.messagesBefore(thread.id, before, limit) });
  });

  app.post("/threads/:id/messages", requireDevice, async (c) => {
    const thread = deps.storage.threadById(c.req.param("id"));
    if (thread === undefined) return c.json(errorBody("not_found", "no such thread"), 404);
    if (thread.archivedAt !== null) {
      return c.json(errorBody("thread_archived", "thread is archived"), 409);
    }
    const parsed = parseOr400(c, SendMessageRequestSchema, await readBody(c));
    if (!parsed.ok) return parsed.response;
    try {
      const message = deps.submitUserMessage(thread.id, parsed.value.blocks);
      return c.json({ message });
    } catch (err) {
      if (err instanceof BackendUnavailable) {
        return c.json(errorBody("backend_unavailable", err.message), 503);
      }
      throw err;
    }
  });

  app.post("/push/register", requireDevice, async (c) => {
    const parsed = parseOr400(c, PushRegisterRequestSchema, await readBody(c));
    if (!parsed.ok) return parsed.response;
    deps.storage.savePushRegistration(c.get("deviceId"), parsed.value);
    return c.json({ ok: true });
  });
```

Import `type { ThreadRow }` from `./storage.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: PASS (all gateway test files).

- [ ] **Step 5: Typecheck and commit**

```bash
PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm typecheck
git add packages/gateway
git commit -m "feat(gateway): agents/threads/messages/push REST surface"
```

---

### Task 10: Adapter interface + mock backend adapter

**Files:**
- Create: `packages/gateway/src/adapters/types.ts`
- Create: `packages/gateway/src/adapters/mock.ts`
- Create: `packages/gateway/src/adapters/registry.ts`
- Test: `packages/gateway/test/mock-adapter.test.ts`

**Interfaces:**
- Consumes: contract `RichBlock`, `ToolCall`, `PresenceState`.
- Produces (`types.ts`):

```ts
import type { PresenceState, RichBlock, ToolCall } from "cozygateway-contract";

/** Callbacks for one agent turn. The adapter calls onDraft zero or more times (full-replace
 *  semantics), then exactly one onCommit, then onDone. A failed turn REJECTS the send()
 *  promise instead of calling onCommit/onDone. */
export interface TurnHandlers {
  onDraft(update: { blocks: RichBlock[]; toolCalls: ToolCall[] }): void;
  onCommit(final: { blocks: RichBlock[] }): void;
  onDone(): void;
}

export interface BackendSession {
  send(blocks: RichBlock[], handlers: TurnHandlers): Promise<void>;
  close(): Promise<void>;
}

export interface BackendAdapter {
  readonly backend: string;
  startSession(threadId: string): Promise<BackendSession>;
  presence(): PresenceState;
}
```

- Produces (`mock.ts`): `createMockAdapter(options?: {failOn?: string}): BackendAdapter` with `backend: "mock"`. Reference echo semantics (the conformance suite and contract/v1.md §7 depend on these EXACTLY): for a send whose first block is `{type:"paragraph", text: T}`:
  - if `T` contains `"[[fail]]"` (or `options.failOn` when set): `send` rejects with `new Error("scripted failure")` after emitting one draft.
  - else: emit draft 1 `[{type:"paragraph", text:"Echo: "}]`, draft 2 `[{type:"paragraph", text:"Echo: " + T}]`, then `onCommit([{type:"paragraph", text:"Echo: " + T}])`, then `onDone()`. Non-paragraph first blocks echo `"Echo: (rich content)"`.
  - Emission is async (each step in its own microtask via `await Promise.resolve()`) so WS clients observe distinct frames; `send` resolves after `onDone`.
- Produces (`registry.ts`): `buildAdapters(agents: AgentConfig[]): Map<string, BackendAdapter>` keyed by agent id; backend `"mock"` -> `createMockAdapter(agent.options as {failOn?: string} | undefined)`; unknown backend -> throw `new Error(\`unknown backend "\${backend}" for agent "\${id}"\`)`.

- [ ] **Step 1: Write failing tests**

`packages/gateway/test/mock-adapter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RichBlock, ToolCall } from "cozygateway-contract";

import { createMockAdapter } from "../src/adapters/mock.ts";
import { buildAdapters } from "../src/adapters/registry.ts";

function record() {
  const events: string[] = [];
  const drafts: RichBlock[][] = [];
  return {
    events,
    drafts,
    handlers: {
      onDraft: (u: { blocks: RichBlock[]; toolCalls: ToolCall[] }) => {
        events.push("draft");
        drafts.push(u.blocks);
      },
      onCommit: (f: { blocks: RichBlock[] }) => {
        events.push(`commit:${JSON.stringify(f.blocks)}`);
      },
      onDone: () => events.push("done"),
    },
  };
}

describe("mock adapter echo semantics", () => {
  it("emits two drafts, a commit, and done", async () => {
    const adapter = createMockAdapter();
    const session = await adapter.startSession("t1");
    const rec = record();
    await session.send([{ type: "paragraph", text: "hi" }], rec.handlers);
    expect(rec.events).toEqual([
      "draft",
      "draft",
      `commit:${JSON.stringify([{ type: "paragraph", text: "Echo: hi" }])}`,
      "done",
    ]);
    expect(rec.drafts[0]).toEqual([{ type: "paragraph", text: "Echo: " }]);
    expect(rec.drafts[1]).toEqual([{ type: "paragraph", text: "Echo: hi" }]);
  });

  it("rejects on [[fail]] after one draft, with no commit or done", async () => {
    const adapter = createMockAdapter();
    const session = await adapter.startSession("t1");
    const rec = record();
    await expect(session.send([{ type: "paragraph", text: "boom [[fail]]" }], rec.handlers)).rejects.toThrow(
      "scripted failure",
    );
    expect(rec.events).toEqual(["draft"]);
  });

  it("reports online presence", () => {
    expect(createMockAdapter().presence()).toBe("online");
  });
});

describe("registry", () => {
  it("builds mock adapters and rejects unknown backends", () => {
    const adapters = buildAdapters([{ id: "m", name: "M", backend: "mock" }]);
    expect(adapters.get("m")?.backend).toBe("mock");
    expect(() => buildAdapters([{ id: "x", name: "X", backend: "warp" }])).toThrow(/unknown backend/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: FAIL, missing adapter modules.

- [ ] **Step 3: Implement**

`src/adapters/mock.ts`:

```ts
import type { RichBlock } from "cozygateway-contract";

import type { BackendAdapter, BackendSession, TurnHandlers } from "./types.ts";

/** Reference echo backend. contract/v1.md section 7 freezes these semantics; the conformance
 *  suite asserts them frame by frame. Change nothing here without a contract version bump. */
export function createMockAdapter(options?: { failOn?: string }): BackendAdapter {
  const failToken = options?.failOn ?? "[[fail]]";

  const session: BackendSession = {
    async send(blocks: RichBlock[], handlers: TurnHandlers): Promise<void> {
      const first = blocks[0];
      const text = first !== undefined && first.type === "paragraph" ? first.text : "(rich content)";
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
    async startSession(): Promise<BackendSession> {
      return session;
    },
    presence: () => "online",
  };
}
```

`src/adapters/registry.ts`:

```ts
import type { AgentConfig } from "../config.ts";
import type { BackendAdapter } from "./types.ts";
import { createMockAdapter } from "./mock.ts";

export function buildAdapters(agents: AgentConfig[]): Map<string, BackendAdapter> {
  const adapters = new Map<string, BackendAdapter>();
  for (const agent of agents) {
    if (agent.backend === "mock") {
      adapters.set(agent.id, createMockAdapter(agent.options as { failOn?: string } | undefined));
    } else {
      throw new Error(`unknown backend "${agent.backend}" for agent "${agent.id}"`);
    }
  }
  return adapters;
}
```

(The single `as` on `agent.options` is the config boundary; acceptable.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm typecheck
git add packages/gateway
git commit -m "feat(gateway): backend adapter interface + reference mock echo adapter"
```

---

### Task 11: WS hub

**Files:**
- Create: `packages/gateway/src/ws-hub.ts`
- Test: `packages/gateway/test/ws-hub.test.ts`

**Interfaces:**
- Consumes: `Storage` (Task 7), contract frames (Task 4), `hashToken` (Task 8).
- Produces:

```ts
export class WsHub {
  constructor(deps: {
    storage: Storage;
    gatewayInfo: GatewayInfo;
    now: () => number;
    authTimeoutMs?: number; // default 10_000
  });
  /** Attach to an http.Server; handles upgrade on `path` (default "/ws"). */
  attach(server: import("node:http").Server, path?: string): void;
  broadcast(frame: ServerFrame): void;
  hasClients(): boolean;
  /** Close every socket belonging to a revoked device with 1008. */
  closeDevice(deviceId: string): void;
  close(): void;
}
```

Behavior contract:
- First client frame must be a valid `auth` frame whose token hashes to a known device; on success send `ready`, else send `error` frame (code `unauthorized`) and close 1008. A socket that sends nothing for `authTimeoutMs` is closed 1008.
- A valid `sync` frame after auth: for each `threadId -> sinceSeq`, send `committed` frames for `storage.messagesSince(threadId, sinceSeq)` in ascending order, then one `synced` frame. Unknown threadIds are skipped silently.
- Any other/invalid frame after auth: `error` frame (code `invalid_request`), connection stays open.
- `broadcast` sends the frame to every authed socket (JSON.stringify once).
- Frames sent before auth completes (other than auth) get `error` + close 1008.

- [ ] **Step 1: Write failing tests**

`packages/gateway/test/ws-hub.test.ts` (real server on port 0, real `ws` client):

```ts
import { createServer } from "node:http";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { WsHub } from "../src/ws-hub.ts";
import { mintDeviceToken } from "../src/auth.ts";

let hub: WsHub;
let storage: Storage;
let server: ReturnType<typeof createServer>;
let port: number;
let token: string;

beforeEach(async () => {
  storage = openStorage(":memory:");
  const minted = mintDeviceToken();
  token = minted.token;
  storage.createDevice({ id: "d1", name: "phone", tokenHash: minted.tokenHash, createdAt: 1 });
  storage.upsertAgent({ id: "a1", name: "A", avatar: null, backend: "mock" });
  storage.createThread({ id: "t1", agentId: "a1", title: "T", createdAt: 1 });
  hub = new WsHub({
    storage,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1" },
    now: () => 1_000,
    authTimeoutMs: 200,
  });
  server = createServer();
  hub.attach(server);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  port = address.port;
});

afterEach(async () => {
  hub.close();
  server.close();
  await once(server, "close");
});

function connect(): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws`);
}

function frames(ws: WebSocket): ServerFrame[] {
  const seen: ServerFrame[] = [];
  ws.on("message", (data) => seen.push(JSON.parse(String(data)) as ServerFrame));
  return seen;
}

async function until(predicate: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("auth", () => {
  it("ready on a good token", async () => {
    const ws = connect();
    const seen = frames(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => seen.some((f) => f.type === "ready"));
    expect(hub.hasClients()).toBe(true);
    ws.close();
  });

  it("closes 1008 on a bad token", async () => {
    const ws = connect();
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token: "bad" }));
    const [code] = (await once(ws, "close")) as [number];
    expect(code).toBe(1008);
  });

  it("closes 1008 when auth never arrives (timeout)", async () => {
    const ws = connect();
    await once(ws, "open");
    const [code] = (await once(ws, "close")) as [number];
    expect(code).toBe(1008);
  });
});

describe("sync replay", () => {
  it("replays committed above the high-water mark then synced", async () => {
    for (let i = 0; i < 4; i++) {
      storage.appendMessage("t1", { role: "user", blocks: [{ type: "paragraph", text: String(i) }] }, i);
    }
    const ws = connect();
    const seen = frames(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => seen.some((f) => f.type === "ready"));
    ws.send(JSON.stringify({ type: "sync", threads: { t1: 2, ghost: 0 } }));
    await until(() => seen.some((f) => f.type === "synced"));
    const committed = seen.filter((f) => f.type === "committed");
    expect(committed.map((f) => f.seq)).toEqual([3, 4]);
    ws.close();
  });
});

describe("broadcast + revocation", () => {
  it("delivers broadcasts to authed clients and closes revoked devices", async () => {
    const ws = connect();
    const seen = frames(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => seen.some((f) => f.type === "ready"));

    hub.broadcast({ type: "presence", agentId: "a1", state: "absent" });
    await until(() => seen.some((f) => f.type === "presence"));

    hub.closeDevice("d1");
    const [code] = (await once(ws, "close")) as [number];
    expect(code).toBe(1008);
    expect(hub.hasClients()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: FAIL, cannot find `../src/ws-hub.ts`.

- [ ] **Step 3: Implement `src/ws-hub.ts`**

```ts
import type { Server } from "node:http";

import { WebSocketServer, WebSocket } from "ws";
import {
  type GatewayInfo,
  type ServerFrame,
  ClientFrameSchema,
  check,
} from "cozygateway-contract";

import type { Storage } from "./storage.ts";
import { hashToken } from "./auth.ts";

interface Client {
  socket: WebSocket;
  deviceId: string;
}

export class WsHub {
  readonly #storage: Storage;
  readonly #gatewayInfo: GatewayInfo;
  readonly #now: () => number;
  readonly #authTimeoutMs: number;
  readonly #clients = new Set<Client>();
  #wss: WebSocketServer | undefined;

  constructor(deps: {
    storage: Storage;
    gatewayInfo: GatewayInfo;
    now: () => number;
    authTimeoutMs?: number;
  }) {
    this.#storage = deps.storage;
    this.#gatewayInfo = deps.gatewayInfo;
    this.#now = deps.now;
    this.#authTimeoutMs = deps.authTimeoutMs ?? 10_000;
  }

  attach(server: Server, path = "/ws"): void {
    const wss = new WebSocketServer({ server, path });
    this.#wss = wss;
    wss.on("connection", (socket) => this.#onConnection(socket));
  }

  #send(socket: WebSocket, frame: ServerFrame): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  #onConnection(socket: WebSocket): void {
    let client: Client | undefined;
    const authTimer = setTimeout(() => {
      if (client === undefined) socket.close(1008, "auth timeout");
    }, this.#authTimeoutMs);

    socket.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        frame = undefined;
      }
      if (!check(ClientFrameSchema, frame)) {
        if (client === undefined) {
          this.#send(socket, { type: "error", code: "unauthorized", message: "first frame must be auth" });
          socket.close(1008, "unauthenticated");
        } else {
          this.#send(socket, { type: "error", code: "invalid_request", message: "unknown frame" });
        }
        return;
      }

      if (frame.type === "auth") {
        if (client !== undefined) return;
        const device = this.#storage.deviceByTokenHash(hashToken(frame.token));
        if (device === undefined) {
          this.#send(socket, { type: "error", code: "unauthorized", message: "unknown device token" });
          socket.close(1008, "unauthenticated");
          return;
        }
        clearTimeout(authTimer);
        this.#storage.touchDevice(device.id, this.#now());
        client = { socket, deviceId: device.id };
        this.#clients.add(client);
        this.#send(socket, { type: "ready", deviceId: device.id, gateway: this.#gatewayInfo });
        return;
      }

      if (client === undefined) {
        this.#send(socket, { type: "error", code: "unauthorized", message: "first frame must be auth" });
        socket.close(1008, "unauthenticated");
        return;
      }

      for (const [threadId, sinceSeq] of Object.entries(frame.threads)) {
        for (const message of this.#storage.messagesSince(threadId, sinceSeq)) {
          this.#send(socket, { type: "committed", threadId, seq: message.seq, message });
        }
      }
      this.#send(socket, { type: "synced" });
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (client !== undefined) this.#clients.delete(client);
    });
  }

  broadcast(frame: ServerFrame): void {
    const payload = JSON.stringify(frame);
    for (const client of this.#clients) {
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
    }
  }

  hasClients(): boolean {
    return this.#clients.size > 0;
  }

  closeDevice(deviceId: string): void {
    for (const client of this.#clients) {
      if (client.deviceId === deviceId) client.socket.close(1008, "device revoked");
    }
  }

  close(): void {
    for (const client of this.#clients) client.socket.close(1001, "server shutdown");
    this.#wss?.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm typecheck
git add packages/gateway
git commit -m "feat(gateway): WS hub with first-frame auth, sync replay, broadcast, revocation"
```

---

### Task 12: Turn runner + server assembly (`startGateway`)

**Files:**
- Create: `packages/gateway/src/turns.ts`
- Create: `packages/gateway/src/server.ts`
- Create: `packages/gateway/src/index.ts`
- Test: `packages/gateway/test/turns.test.ts`, `packages/gateway/test/server.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 6-11.
- Produces:
  - `turns.ts`: `class TurnRunner { constructor(deps: {storage: Storage; hub: Pick<WsHub, "broadcast" | "hasClients">; adapters: Map<string, BackendAdapter>; notifier: Notifier; now: () => number}); submitUserMessage(threadId: string, blocks: RichBlock[]): Message; async closeAll(): Promise<void> }`. Throws `BackendUnavailable` (from `./errors.ts`) when the thread's agent has no adapter. Persists the user message, broadcasts its `committed` frame, then runs the agent turn in the background (`void this.#runTurn(...)`).
  - `Notifier` interface (in `turns.ts`): `{ notify(event: {threadId: string; agentName: string; preview: string}): void }` plus `export const nullNotifier: Notifier` (no-op). Real push relay client is a later phase.
  - Turn behavior: `turnId = randomUUID()`. Per-thread session cache (`Map<threadId, Promise<BackendSession>>`, created via `adapter.startSession(threadId)` on first send). `onDraft` -> broadcast `draft` frame. `onCommit` -> `storage.appendMessage(threadId, {role: "agent", blocks, turnId}, now())`, broadcast `committed`, and when `!hub.hasClients()` call `notifier.notify({threadId, agentName, preview})` where preview = first paragraph text of the committed blocks, else `"New message"`. `onDone` -> broadcast `done`. `send` rejection -> `storage.appendMessage` a `role: "system"`, `marker: "turn.failed"` message with blocks `[{type:"paragraph", text:"The agent turn failed. Send again to retry."}]`, broadcast its `committed` frame, then broadcast `error` frame `{code:"turn_failed", message:<err.message>, threadId}`. Per-thread turns are serialized with a per-thread promise chain so two rapid sends cannot interleave their agent turns.
  - `server.ts`: `startGateway(config: GatewayConfig): Promise<RunningGateway>` where `RunningGateway = {url: string; port: number; storage: Storage; issueSetupCode(): string; close(): Promise<void>}`. Assembly: `openStorage(config.dbPath)`; upsert every configured agent; `buildAdapters`; `WsHub`; `TurnRunner`; `createApp` wired with `presenceOf` (adapter presence or `"unknown"` when missing), `submitUserMessage: (threadId, blocks) => runner.submitUserMessage(threadId, blocks)`, `onDeviceRevoked: (id) => hub.closeDevice(id)`; `@hono/node-server` `serve({fetch: app.fetch, port: config.port, hostname: "127.0.0.1"})` on port 0 for tests; `hub.attach(server)`. `issueSetupCode` mints `newSetupCode()`, stores with `SETUP_CODE_TTL_MS`, returns it. `close()` closes hub, server, runner sessions, storage.
  - `index.ts`: re-export the public programmatic surface: `startGateway`, `RunningGateway`, `loadConfig`, `GatewayConfig`, `AgentConfig`, adapter types (`BackendAdapter`, `BackendSession`, `TurnHandlers`), `Notifier`.

- [ ] **Step 1: Write failing turn-runner tests**

`packages/gateway/test/turns.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { openStorage } from "../src/storage.ts";
import { TurnRunner, nullNotifier, type Notifier } from "../src/turns.ts";
import { createMockAdapter } from "../src/adapters/mock.ts";
import { BackendUnavailable } from "../src/errors.ts";

function setup(opts?: { clients?: boolean; notifier?: Notifier }) {
  const storage = openStorage(":memory:");
  storage.upsertAgent({ id: "a1", name: "Mock", avatar: null, backend: "mock" });
  storage.createThread({ id: "t1", agentId: "a1", title: "T", createdAt: 1 });
  const frames: ServerFrame[] = [];
  const runner = new TurnRunner({
    storage,
    hub: { broadcast: (f) => frames.push(f), hasClients: () => opts?.clients ?? true },
    adapters: new Map([["a1", createMockAdapter()]]),
    notifier: opts?.notifier ?? nullNotifier,
    now: () => 42,
  });
  return { storage, frames, runner };
}

async function untilFrames(frames: ServerFrame[], predicate: (fs: ServerFrame[]) => boolean) {
  const start = Date.now();
  while (!predicate(frames)) {
    if (Date.now() - start > 2_000) throw new Error(`timeout; saw ${JSON.stringify(frames)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("TurnRunner", () => {
  it("persists the user message, streams drafts, commits the echo, and signals done", async () => {
    const { storage, frames, runner } = setup();
    const user = runner.submitUserMessage("t1", [{ type: "paragraph", text: "hi" }]);
    expect(user.seq).toBe(1);
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "done"));

    const types = frames.map((f) => f.type);
    expect(types[0]).toBe("committed"); // the user's own message
    expect(types.filter((t) => t === "draft")).toHaveLength(2);
    const committedAgent = frames.find((f) => f.type === "committed" && f.message.role === "agent");
    expect(committedAgent !== undefined && committedAgent.type === "committed").toBe(true);
    if (committedAgent !== undefined && committedAgent.type === "committed") {
      expect(committedAgent.message.blocks).toEqual([{ type: "paragraph", text: "Echo: hi" }]);
      expect(committedAgent.seq).toBe(2);
    }
    expect(types.indexOf("done")).toBeGreaterThan(types.lastIndexOf("draft"));
    expect(storage.messagesSince("t1", 0)).toHaveLength(2);
  });

  it("writes a turn.failed marker and an error frame when the adapter rejects", async () => {
    const { storage, frames, runner } = setup();
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "please [[fail]]" }]);
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "error"));

    const marker = storage.messagesSince("t1", 0).find((m) => m.marker === "turn.failed");
    expect(marker?.role).toBe("system");
    const errorFrame = frames.find((f) => f.type === "error");
    expect(errorFrame !== undefined && errorFrame.type === "error" && errorFrame.code === "turn_failed").toBe(true);
    expect(frames.some((f) => f.type === "done")).toBe(false);
  });

  it("notifies when no client is connected, not when one is", async () => {
    const notified: string[] = [];
    const notifier: Notifier = { notify: (e) => notified.push(e.preview) };

    const connected = setup({ clients: true, notifier });
    connected.runner.submitUserMessage("t1", [{ type: "paragraph", text: "a" }]);
    await untilFrames(connected.frames, (fs) => fs.some((f) => f.type === "done"));
    expect(notified).toHaveLength(0);

    const empty = setup({ clients: false, notifier });
    empty.runner.submitUserMessage("t1", [{ type: "paragraph", text: "b" }]);
    await untilFrames(empty.frames, (fs) => fs.some((f) => f.type === "done"));
    expect(notified).toEqual(["Echo: b"]);
  });

  it("throws BackendUnavailable for an agent with no adapter", () => {
    const { storage } = setup();
    storage.upsertAgent({ id: "ghost", name: "G", avatar: null, backend: "mock" });
    storage.createThread({ id: "t2", agentId: "ghost", title: "T2", createdAt: 1 });
    const runner = new TurnRunner({
      storage,
      hub: { broadcast: () => {}, hasClients: () => true },
      adapters: new Map(),
      notifier: nullNotifier,
      now: () => 42,
    });
    expect(() => runner.submitUserMessage("t2", [{ type: "paragraph", text: "x" }])).toThrow(
      BackendUnavailable,
    );
  });

  it("serializes two rapid sends on one thread (no interleaved turns)", async () => {
    const { frames, runner } = setup();
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "one" }]);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "two" }]);
    await untilFrames(frames, (fs) => fs.filter((f) => f.type === "done").length === 2);
    const agentCommits = frames.filter((f) => f.type === "committed" && f.message.role === "agent");
    expect(
      agentCommits.map((f) => (f.type === "committed" ? f.message.blocks[0] : undefined)),
    ).toEqual([
      { type: "paragraph", text: "Echo: one" },
      { type: "paragraph", text: "Echo: two" },
    ]);
  });
});
```

- [ ] **Step 2: Write failing server assembly test**

`packages/gateway/test/server.test.ts` (end to end over real HTTP + WS):

```ts
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";

let gateway: RunningGateway;

beforeEach(async () => {
  gateway = await startGateway({
    name: "e2e",
    port: 0,
    dbPath: ":memory:",
    agents: [{ id: "mock", name: "Mock", backend: "mock" }],
  });
});

afterEach(async () => {
  await gateway.close();
});

describe("startGateway end to end", () => {
  it("pairs, creates a thread, sends, and observes the stream on WS", async () => {
    const code = gateway.issueSetupCode();
    const pairRes = await fetch(`${gateway.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: code, deviceName: "e2e phone" }),
    });
    expect(pairRes.status).toBe(200);
    const { deviceToken } = (await pairRes.json()) as { deviceToken: string };

    const seen: ServerFrame[] = [];
    const ws = new WebSocket(`${gateway.url.replace("http", "ws")}/ws`);
    ws.on("message", (d) => seen.push(JSON.parse(String(d)) as ServerFrame));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token: deviceToken }));

    const authed = { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" };
    const threadRes = await fetch(`${gateway.url}/threads`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ agentId: "mock" }),
    });
    const thread = (await threadRes.json()) as { id: string };

    const sendRes = await fetch(`${gateway.url}/threads/${thread.id}/messages`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "round trip" }] }),
    });
    expect(sendRes.status).toBe(200);

    const start = Date.now();
    while (!seen.some((f) => f.type === "done")) {
      if (Date.now() - start > 5_000) throw new Error(`timeout; saw ${JSON.stringify(seen)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(seen.filter((f) => f.type === "draft").length).toBeGreaterThanOrEqual(1);
    const commits = seen.filter((f) => f.type === "committed");
    expect(commits.map((f) => (f.type === "committed" ? f.message.role : ""))).toEqual(["user", "agent"]);
    ws.close();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: FAIL, missing `../src/turns.ts` / `../src/server.ts`.

- [ ] **Step 4: Implement `src/turns.ts`**

```ts
import { randomUUID } from "node:crypto";

import type { Message, RichBlock, ServerFrame } from "cozygateway-contract";

import type { Storage } from "./storage.ts";
import type { BackendAdapter, BackendSession } from "./adapters/types.ts";
import { BackendUnavailable } from "./errors.ts";

export interface Notifier {
  notify(event: { threadId: string; agentName: string; preview: string }): void;
}

export const nullNotifier: Notifier = { notify: () => {} };

interface Hub {
  broadcast(frame: ServerFrame): void;
  hasClients(): boolean;
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
    const userMessage = this.#storage.appendMessage(threadId, { role: "user", blocks }, this.#now());
    this.#hub.broadcast({ type: "committed", threadId, seq: userMessage.seq, message: userMessage });

    const agentName = this.#storage.agentById(thread.agentId)?.name ?? thread.agentId;
    const previous = this.#queues.get(threadId) ?? Promise.resolve();
    const next = previous.then(() => this.#runTurn(threadId, thread.agentId, agentName, adapter, blocks));
    this.#queues.set(threadId, next);
    return userMessage;
  }

  async #runTurn(
    threadId: string,
    agentId: string,
    agentName: string,
    adapter: BackendAdapter,
    blocks: RichBlock[],
  ): Promise<void> {
    const turnId = randomUUID();
    try {
      let sessionPromise = this.#sessions.get(threadId);
      if (sessionPromise === undefined) {
        sessionPromise = adapter.startSession(threadId);
        this.#sessions.set(threadId, sessionPromise);
      }
      const session = await sessionPromise;
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
          if (!this.#hub.hasClients()) {
            this.#notifier.notify({ threadId, agentName, preview: preview(final.blocks) });
          }
        },
        onDone: () => {
          this.#hub.broadcast({ type: "done", threadId, turnId });
        },
      });
    } catch (err) {
      const failure = this.#storage.appendMessage(
        threadId,
        {
          role: "system",
          blocks: [{ type: "paragraph", text: "The agent turn failed. Send again to retry." }],
          turnId,
          marker: "turn.failed",
        },
        this.#now(),
      );
      this.#hub.broadcast({ type: "committed", threadId, seq: failure.seq, message: failure });
      const message = err instanceof Error ? err.message : "unknown failure";
      this.#hub.broadcast({ type: "error", code: "turn_failed", message, threadId });
    }
  }

  async closeAll(): Promise<void> {
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

- [ ] **Step 5: Implement `src/server.ts` and `src/index.ts`**

`src/server.ts`:

```ts
import type { Server } from "node:http";

import { serve } from "@hono/node-server";
import type { GatewayInfo } from "cozygateway-contract";

import type { GatewayConfig } from "./config.ts";
import { openStorage, type Storage } from "./storage.ts";
import { buildAdapters } from "./adapters/registry.ts";
import { createApp } from "./http.ts";
import { WsHub } from "./ws-hub.ts";
import { TurnRunner, nullNotifier } from "./turns.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "./auth.ts";

export const GATEWAY_VERSION = "0.1.0";

export interface RunningGateway {
  url: string;
  port: number;
  storage: Storage;
  issueSetupCode(): string;
  close(): Promise<void>;
}

export async function startGateway(config: GatewayConfig): Promise<RunningGateway> {
  const storage = openStorage(config.dbPath);
  for (const agent of config.agents) {
    storage.upsertAgent({ id: agent.id, name: agent.name, avatar: agent.avatar ?? null, backend: agent.backend });
  }
  const adapters = buildAdapters(config.agents);
  const gatewayInfo: GatewayInfo = { name: config.name, version: GATEWAY_VERSION, contract: "v1" };
  const hub = new WsHub({ storage, gatewayInfo, now: () => Date.now() });
  const runner = new TurnRunner({ storage, hub, adapters, notifier: nullNotifier, now: () => Date.now() });

  const app = createApp({
    storage,
    config,
    gatewayInfo,
    presenceOf: (agentId) => adapters.get(agentId)?.presence() ?? "unknown",
    submitUserMessage: (threadId, blocks) => runner.submitUserMessage(threadId, blocks),
    onDeviceRevoked: (deviceId) => hub.closeDevice(deviceId),
    now: () => Date.now(),
  });

  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, () => {
      resolve(s as Server);
    });
  });
  hub.attach(server);
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : config.port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    storage,
    issueSetupCode: () => {
      const code = newSetupCode();
      storage.createSetupCode(code, Date.now() + SETUP_CODE_TTL_MS);
      return code;
    },
    close: async () => {
      hub.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await runner.closeAll();
      storage.close();
    },
  };
}
```

(`serve` returns a `ServerType`; the single `as Server` narrowing is acceptable at this boundary. If `@hono/node-server`'s types make it unnecessary, drop it.)

`src/index.ts`:

```ts
export { startGateway, GATEWAY_VERSION, type RunningGateway } from "./server.ts";
export { loadConfig, type AgentConfig, type GatewayConfig } from "./config.ts";
export type { BackendAdapter, BackendSession, TurnHandlers } from "./adapters/types.ts";
export type { Notifier } from "./turns.ts";
export { BackendUnavailable } from "./errors.ts";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: PASS (all files, including the end-to-end server test).

- [ ] **Step 7: Full gate and commit**

```bash
cd ../.. && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm check
git add packages/gateway
git commit -m "feat(gateway): turn pipeline + startGateway assembly (REST + WS + mock backend e2e)"
```

---

### Task 13: CLI + gateway README

**Files:**
- Create: `packages/gateway/src/cli.ts`
- Create: `packages/gateway/README.md`
- Test: `packages/gateway/test/cli.test.ts`

**Interfaces:**
- Consumes: `startGateway`, `loadConfig`, `newSetupCode`/`SETUP_CODE_TTL_MS`, `openStorage`.
- Produces: `cozygateway serve --config <path>` (starts, logs `cozygateway <version> listening on <url>`, runs until SIGINT); `cozygateway pair --config <path>` (opens the config's dbPath directly, inserts a fresh setup code, prints the QR payload JSON `{"gatewayUrl": "<http://host:port>", "setupCode": "<code>"}` and a human line, exits 0). Export `runCli(argv: string[]): Promise<number>` for tests; the bin entry calls it with `process.argv.slice(2)` and exits with its return code. `pair` computes gatewayUrl as `http://<hostname>:<port>` using `os.hostname()`.

- [ ] **Step 1: Write failing tests**

`packages/gateway/test/cli.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.ts";
import { openStorage } from "../src/storage.ts";

function tempConfig(): { configPath: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "cozygateway-cli-"));
  const dbPath = join(dir, "gw.db");
  const configPath = join(dir, "cozygateway.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ name: "cli-gw", port: 0, dbPath, agents: [{ id: "mock", name: "Mock", backend: "mock" }] }),
  );
  return { configPath, dbPath };
}

describe("cozygateway pair", () => {
  it("prints a QR payload and persists the code", async () => {
    const { configPath, dbPath } = tempConfig();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const exitCode = await runCli(["pair", "--config", configPath]);
    vi.restoreAllMocks();
    expect(exitCode).toBe(0);

    const payloadLine = lines.find((l) => l.startsWith("{"));
    expect(payloadLine).toBeDefined();
    const payload = JSON.parse(payloadLine ?? "{}") as { gatewayUrl: string; setupCode: string };
    expect(payload.setupCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const storage = openStorage(dbPath);
    expect(storage.consumeSetupCode(payload.setupCode, Date.now())).toBe("ok");
    storage.close();
  });

  it("fails with a usage message on an unknown command", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const exitCode = await runCli(["dance"]);
    vi.restoreAllMocks();
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("usage");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected: FAIL, cannot find `../src/cli.ts`.

- [ ] **Step 3: Implement `src/cli.ts`**

```ts
#!/usr/bin/env node
import { hostname } from "node:os";
import { parseArgs } from "node:util";

import { loadConfig } from "./config.ts";
import { openStorage } from "./storage.ts";
import { startGateway, GATEWAY_VERSION } from "./server.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "./auth.ts";

const USAGE = `usage: cozygateway <serve|pair> --config <path>`;

export async function runCli(argv: string[]): Promise<number> {
  const command = argv[0];
  const { values } = parseArgs({
    args: argv.slice(1),
    options: { config: { type: "string", default: "cozygateway.config.json" } },
  });
  const configPath = values.config;

  if (command === "serve") {
    const config = loadConfig(configPath);
    const gateway = await startGateway(config);
    console.log(`cozygateway ${GATEWAY_VERSION} listening on ${gateway.url}`);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
    await gateway.close();
    return 0;
  }

  if (command === "pair") {
    const config = loadConfig(configPath);
    const storage = openStorage(config.dbPath);
    const code = newSetupCode();
    storage.createSetupCode(code, Date.now() + SETUP_CODE_TTL_MS);
    storage.close();
    const payload = { gatewayUrl: `http://${hostname()}:${config.port}`, setupCode: code };
    console.log(JSON.stringify(payload));
    console.log(`Setup code ${code} is valid for 10 minutes. Scan or type it in the app.`);
    return 0;
  }

  console.error(USAGE);
  return 1;
}

const invokedDirectly = process.argv[1]?.endsWith("cli.js") === true || process.argv[1]?.endsWith("cli.ts") === true;
if (invokedDirectly) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
```

- [ ] **Step 4: Write `packages/gateway/README.md`**

Quickstart (PUBLIC COPY rules apply): install, minimal `cozygateway.config.json` with one mock agent, `cozygateway serve`, `cozygateway pair`, what the app does with the QR payload, pointer to `contract/v1.md` and the conformance suite. State plainly: plaintext lives on your box, the gateway never sends content anywhere else, TLS termination guidance comes with the app release.

- [ ] **Step 5: Run tests, full gate, commit**

Run: `cd packages/gateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`, then `cd ../.. && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm check`
Expected: PASS.

```bash
git add packages/gateway
git commit -m "feat(gateway): serve/pair CLI + quickstart README"
```

---

### Task 14: Conformance suite package

**Files:**
- Create: `packages/conformance/package.json`, `packages/conformance/tsconfig.json`, `packages/conformance/tsconfig.build.json`
- Create: `packages/conformance/src/suite.ts`, `packages/conformance/src/index.ts`
- Create: `packages/conformance/test/reference-gateway.test.ts`
- Create: `packages/conformance/README.md`

**Interfaces:**
- Consumes: contract package; gateway package as a DEV dependency only (`"cozygateway": "workspace:*"` in devDependencies; the suite itself must import nothing from it in `src/`).
- Produces: `registerConformanceSuite(env: ConformanceEnv): void` where

```ts
export interface ConformanceEnv {
  /** Base HTTP URL of the gateway under test, no trailing slash. */
  baseUrl: () => string;
  /** Mint a fresh single-use setup code on the gateway under test. */
  issueSetupCode: () => Promise<string>;
  /** Agent id of the reference echo backend on the gateway under test. */
  echoAgentId: string;
}
```

`registerConformanceSuite` calls vitest's `describe`/`it` (import from `"vitest"`) and registers the whole black-box suite. Package exports it so third-party gateways can run the identical suite from their own vitest config.

- [ ] **Step 1: Package scaffold**

`packages/conformance/package.json`:

```json
{
  "name": "cozygateway-conformance",
  "version": "0.1.0",
  "description": "Black-box conformance suite for the cozygateway wire contract v1. Point it at any gateway implementation exposing the reference echo backend.",
  "type": "module",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/shiftedx/cozygateway.git",
    "directory": "packages/conformance"
  },
  "engines": { "node": ">=24" },
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "build": "tsc -p tsconfig.build.json"
  },
  "dependencies": {
    "cozygateway-contract": "workspace:*",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.0",
    "cozygateway": "workspace:*"
  },
  "peerDependencies": {
    "vitest": ">=3"
  }
}
```

tsconfigs: copy from the contract package. `src/index.ts`: `export * from "./suite.ts";`

- [ ] **Step 2: Write the suite RED against the plan's contract (this is the north star)**

`packages/conformance/src/suite.ts` registers, in order (each `it` is complete runnable code in this step; write them all):

1. **health**: `GET /health` unauthenticated returns `GatewayInfoSchema`-valid body with `contract: "v1"` (validate with `check` from the contract package).
2. **pairing**: valid setup code pairs and returns `PairResponseSchema`-valid body; the same code fails the second time with 401 `setup_code_invalid`; garbage code 401; malformed body 400.
3. **auth wall**: `/devices`, `/agents`, `/threads` each 401 without a token.
4. **device lifecycle**: pair two devices; `GET /devices` shows both; `DELETE` one; its token now 401s; the other still works.
5. **agents**: `GET /agents` contains `echoAgentId` with a valid `PresenceState`.
6. **thread lifecycle**: create (`ThreadSchema`-valid), rename, archive; archived thread absent from list; messages of archived thread still readable; send to archived thread 409 `thread_archived`.
7. **message round trip + seq discipline**: send three messages, observe user commits seq 1..n strictly increasing with agent echoes interleaved, each `MessageSchema`-valid; `GET /messages` pagination: `limit` and `before` behave as contract/v1.md section 5 describes (ascending order within a page, newest page when `before` omitted).
8. **WS lifecycle**: connect, auth with the device token, expect `ready`; bad token expects close 1008; sync with high-water 0 replays every committed message ascending then `synced`.
9. **streaming order**: with WS connected, POST a message to the echo agent; assert the frame order for that turn: user `committed`, then >= 1 `draft` (each `DraftFrameSchema`-valid), then agent `committed` whose blocks equal `[{type:"paragraph", text:"Echo: <sent text>"}]`, then `done`; no `draft` after `committed` for that `turnId`.
10. **reconnect dedup**: note the high-water seq, disconnect, send another message via REST, reconnect + sync with that mark; expect exactly the missed committed frames (user + agent), nothing replayed twice.
11. **turn failure**: send `"[[fail]] please"`; expect a committed `role:"system"` message with `marker:"turn.failed"` and an `error` frame with code `turn_failed`; thread stays usable (a follow-up send echoes normally).

Implementation notes for the suite author: use `fetch` (Node global) and `ws`; helper `collectFrames(socket)` pattern from Task 11's tests; every response body that the contract types must be `check`-validated against the corresponding schema, failures reported with the TypeBox error path. Time limits: 10s per test.

- [ ] **Step 3: Wire the in-repo runner and watch it fail RED first**

`packages/conformance/test/reference-gateway.test.ts`:

```ts
import { afterAll, beforeAll } from "vitest";
import { startGateway, type RunningGateway } from "cozygateway";

import { registerConformanceSuite } from "../src/suite.ts";

let gateway: RunningGateway;

beforeAll(async () => {
  gateway = await startGateway({
    name: "conformance-reference",
    port: 0,
    dbPath: ":memory:",
    agents: [{ id: "conformance-echo", name: "Echo", backend: "mock" }],
  });
});

afterAll(async () => {
  await gateway.close();
});

registerConformanceSuite({
  baseUrl: () => gateway.url,
  issueSetupCode: () => Promise.resolve(gateway.issueSetupCode()),
  echoAgentId: "conformance-echo",
});
```

IMPORTANT sequencing: if Tasks 6-13 are not merged yet when this task starts, the runner cannot import `cozygateway`; in that case commit the suite with the runner file present but the import failing is NOT acceptable. Instead: this task runs AFTER Task 13 in this plan's order; the suite is still authored from `contract/v1.md` alone (do not peek at gateway internals; the gateway is exercised only over HTTP/WS).

Run: `cd packages/conformance && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm test`
Expected on first full run: any failures are CONTRACT BUGS in the gateway; fix the gateway (not the suite) unless the suite contradicts `contract/v1.md`.

- [ ] **Step 4: Green the suite**

Iterate on gateway fixes until the conformance run passes. Every gateway change stays within the behaviors already specified in Tasks 7-12; if a genuine contract ambiguity surfaces, update `contract/v1.md` AND the prose in the affected task, and note it in the PR description.

- [ ] **Step 5: README + full gate + commit**

`packages/conformance/README.md`: what conformance means (suite passes while the gateway exposes the reference echo backend), how a third party wires `registerConformanceSuite` into their own vitest run, the echo backend semantics copied verbatim from `contract/v1.md` section 7.

```bash
cd ../.. && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm check
git add packages/conformance pnpm-lock.yaml
git commit -m "feat(conformance): black-box contract v1 suite, green against the reference gateway"
```

---

## Slice boundaries (branch + PR discipline)

- Slice A = Tasks 1-5 on branch `feat/contract-v1`, PR "Contract v1: schemas + frozen prose spec".
- Slice B = Tasks 6-13 on branch `feat/gateway-core`, PR "Gateway core: pairing, storage, REST, WS, mock backend".
- Slice C = Task 14 on branch `feat/conformance-suite`, PR "Conformance suite v1".
- Merge order A -> B -> C; each PR merges only when `pnpm check` is green locally and CI is green.

## Out of scope for this plan (next plans, in order)

1. Hermes adapter (attach mode against a live Hermes; study CozyLabs `packages/mcp-gateway/src/session/` + `packages/companion/src/profile-runtime.ts` as reference, re-license clean).
2. Push relay service + gateway push origination (replace `nullNotifier`).
3. OpenClaw adapter (pinned protocol v4, canary CI).
4. TLS + TOFU serving in the gateway CLI (config already reserves nothing; add `tls: {certPath, keyPath}` when the iOS work starts).
5. Attachment upload/download endpoints (block shape is already frozen).

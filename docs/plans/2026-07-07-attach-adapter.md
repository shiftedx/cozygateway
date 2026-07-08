# Attach Backend Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real backend adapter, `attach`, that lets an agent harness dial INTO the gateway over a small WebSocket protocol and answer chat turns, replacing the mock echo as the first live backend.

**Architecture:** The gateway hosts a second WebSocket endpoint, `/attach`, next to the client `/ws`. A harness-side plugin dials it (bearer token, header-only), holds one long-lived connection per agent, and speaks a tiny closed frame union: the gateway pushes content-bearing `turn` frames; the plugin streams full-replace `draft` updates (typed blocks plus tool-call chips) and ends each turn with `done` (the latest draft becomes the durable reply) or `failed`. Connection liveness doubles as agent presence. A reference plugin for one harness family ships in `integrations/`.

**Tech Stack:** TypeScript (pure ESM, TypeBox, ws, vitest) for the gateway side; Python 3 (stdlib plus `websockets`) for the reference plugin.

## Global Constraints

- Node >= 24; on this machine prefix every node/pnpm command with `PATH=/opt/homebrew/opt/node@26/bin:$PATH`.
- Every shell command starts with `cd /Users/kmcdowell/Documents/repos/cozygateway && ...` (the shell cwd resets between calls).
- Pure ESM, `.ts`-extension relative imports, `erasableSyntaxOnly` (no enums, no namespaces, no parameter properties), strictest tsconfig.
- Never fabricate test data with `as` casts. Allowed narrowing: `as const`, parsed `unknown`, post-`instanceof`.
- No em-dashes anywhere in this repo's copy. Public copy never names the private codebase or any specific agent harness product; say "agent harness". Do not promise unbuilt features.
- The client wire contract v1 (`contract/v1.md`) is FROZEN. This plan adds an adapter-facing protocol versioned separately as v0 (`contract/attach-v0.md`); it must not change any client-facing frame or REST shape, and the conformance suite must stay 21/21 against the mock backend.
- Gate order matters: `pnpm check` runs build THEN typecheck THEN test (workspace packages resolve `cozygateway-contract` via exports to `dist/`). Run a full `pnpm check` once before the first task so `dist/` exists for vitest.
- Tests: TDD, `:memory:` DBs, ephemeral ports (`port: 0`), pristine vitest exit (clear every timer, close every socket and server).
- Credentials NEVER ride the config file, examples, tests, or git history. The attach token is referenced by environment variable NAME in config (`options.tokenEnv`) and read from the environment at startup.
- Branch: `feat/attach-adapter`. No pushes until the final gate passes. Subagents: stay on this branch, no branch creation or switching, no push, never touch any other repository checkout.

## File Structure

Create:
- `contract/attach-v0.md`: the adapter-facing attach protocol spec (v0, explicitly not frozen).
- `packages/gateway/src/adapters/attach/protocol.ts`: TypeBox schemas for the attach frames.
- `packages/gateway/src/adapters/attach/blocks-to-text.ts`: RichBlock[] to plain-text rendering for turn frames.
- `packages/gateway/src/adapters/attach/ingress.ts`: the `/attach` WebSocket server (auth, connection registry, frame validation, presence).
- `packages/gateway/src/adapters/attach/adapter.ts`: options parsing, token collection, the BackendAdapter implementation, and the update router.
- `packages/gateway/test/attach-protocol.test.ts`, `attach-ingress.test.ts`, `attach-adapter.test.ts`, `attach-e2e.test.ts`.
- `integrations/attach-plugin/`: the reference harness plugin (Python) speaking attach v0.

Modify:
- `packages/gateway/src/adapters/registry.ts`: add the `attach` backend branch.
- `packages/gateway/src/server.ts`: build and wire the ingress, presence broadcast, shutdown order.
- `README.md`: backends section (honest copy).

## Design decisions (traceable to the design spec, section 6)

1. Ingress topology (harness dials out to the gateway) is the production-proven shape the spec's backend-adapter section describes: ingress, stream drafts, project tool calls, commit on done. The gateway stays harness-agnostic: normalization to typed blocks happens plugin-side, at the source, and the gateway schema-validates every inbound frame as defense in depth.
2. The turn frame CARRIES the prompt text (push). This gateway has no side channel a plugin could pull prompt content from, so the trigger-then-pull shape is deliberately not reproduced.
3. `done` carries no content; the gateway seals the LATEST draft as the durable reply. A turn that ends with no draft content is a failure (the runner records `turn.failed`), never an empty commit.
4. `failed` is an explicit wire frame. The studied pipeline had no failure frame and a failed terminal send left the turn hanging; the attach protocol closes that gap, and a turn timeout plus disconnect detection cover a plugin that dies before sending it.
5. One live connection per agent, newest wins: a second authenticated connection for the same agent supersedes the first (close code 4000) and fails its in-flight turns. Re-dial after a drop is the common case; two live harnesses for one agent is a misconfiguration.
6. Presence is connection liveness: `online` while a connection is open, `absent` otherwise, broadcast to clients as the contract v1 `presence` frame (this adapter is the contract's first presence producer).
7. Sends while no harness is attached REJECT fast (the runner commits the `turn.failed` marker; REST already returns the committed user message). Gateway-side queue-until-attached is deferred; clients queue locally per the design spec's offline-first error model. Recorded as a deliberate v0 deviation to revisit.

---

### Task 1: Attach protocol schemas, block rendering, and the protocol spec

**Files:**
- Create: `contract/attach-v0.md`
- Create: `packages/gateway/src/adapters/attach/protocol.ts`
- Create: `packages/gateway/src/adapters/attach/blocks-to-text.ts`
- Test: `packages/gateway/test/attach-protocol.test.ts`

**Interfaces:**
- Consumes: `RichBlockSchema`, `ToolCallSchema`, `check` from `cozygateway-contract`.
- Produces: `AttachUpdateSchema`/`AttachUpdate`, `AttachInboundFrameSchema`/`AttachInboundFrame`, `AttachTurnFrameSchema`/`AttachTurnFrame` (protocol.ts); `blocksToText(blocks: RichBlock[]): string` (blocks-to-text.ts). Tasks 2 and 3 import exactly these names.

- [ ] **Step 1: Write the failing test**

`packages/gateway/test/attach-protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { check } from "cozygateway-contract";

import {
  AttachInboundFrameSchema,
  AttachTurnFrameSchema,
} from "../src/adapters/attach/protocol.ts";
import { blocksToText } from "../src/adapters/attach/blocks-to-text.ts";

describe("attach protocol schemas", () => {
  it("accepts a draft update with blocks and tool calls", () => {
    expect(
      check(AttachInboundFrameSchema, {
        threadId: "t1",
        update: {
          kind: "draft",
          turnId: "turn-1",
          blocks: [{ type: "paragraph", text: "hi" }],
          toolCalls: [{ id: "search#1", name: "search", status: "running" }],
        },
      }),
    ).toBe(true);
  });

  it("accepts a draft update without toolCalls (optional when empty)", () => {
    expect(
      check(AttachInboundFrameSchema, {
        threadId: "t1",
        update: { kind: "draft", turnId: "turn-1", blocks: [] },
      }),
    ).toBe(true);
  });

  it("accepts done and failed updates", () => {
    expect(
      check(AttachInboundFrameSchema, { threadId: "t1", update: { kind: "done", turnId: "turn-1" } }),
    ).toBe(true);
    expect(
      check(AttachInboundFrameSchema, {
        threadId: "t1",
        update: { kind: "failed", turnId: "turn-1", message: "model unreachable" },
      }),
    ).toBe(true);
  });

  it("rejects unknown kinds, missing ids, and malformed members", () => {
    expect(check(AttachInboundFrameSchema, { threadId: "t1", update: { kind: "working" } })).toBe(false);
    expect(check(AttachInboundFrameSchema, { update: { kind: "done", turnId: "x" } })).toBe(false);
    expect(check(AttachInboundFrameSchema, { threadId: "", update: { kind: "done", turnId: "x" } })).toBe(false);
    expect(
      check(AttachInboundFrameSchema, {
        threadId: "t1",
        update: { kind: "draft", turnId: "x", blocks: [{ type: "nonsense" }] },
      }),
    ).toBe(false);
    expect(
      check(AttachInboundFrameSchema, {
        threadId: "t1",
        update: {
          kind: "draft",
          turnId: "x",
          blocks: [],
          toolCalls: [{ id: "a", name: "b", status: "started" }],
        },
      }),
    ).toBe(false);
  });

  it("validates the outbound turn frame shape", () => {
    expect(
      check(AttachTurnFrameSchema, { kind: "turn", threadId: "t1", turnId: "turn-1", text: "hello" }),
    ).toBe(true);
    expect(check(AttachTurnFrameSchema, { kind: "turn", threadId: "t1", turnId: "turn-1" })).toBe(false);
  });
});

describe("blocksToText", () => {
  it("renders every block type and joins with blank lines", () => {
    const text = blocksToText([
      { type: "heading", level: 2, text: "Title" },
      { type: "paragraph", text: "Hello there." },
      { type: "code", code: "print(1)", language: "python" },
      { type: "code", code: "raw" },
      {
        type: "list",
        ordered: true,
        items: [{ text: "first" }, { text: "task", checked: true }],
      },
      { type: "list", items: [{ text: "loose", checked: false }] },
      { type: "table", header: ["a", "b"], rows: [["1", "2"]] },
      { type: "math", latex: "x^2" },
      { type: "attachment", fileId: "f1", name: "notes.txt", mimeType: "text/plain", size: 10 },
    ]);
    expect(text).toBe(
      [
        "## Title",
        "Hello there.",
        "```python\nprint(1)\n```",
        "```\nraw\n```",
        "1. first\n2. [x] task",
        "- [ ] loose",
        "| a | b |\n| --- | --- |\n| 1 | 2 |",
        "$$\nx^2\n$$",
        "[attachment: notes.txt]",
      ].join("\n\n"),
    );
  });

  it("renders an empty block list as an empty string", () => {
    expect(blocksToText([])).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway exec vitest run test/attach-protocol.test.ts`
Expected: FAIL (cannot resolve `../src/adapters/attach/protocol.ts`).

- [ ] **Step 3: Implement the schemas**

`packages/gateway/src/adapters/attach/protocol.ts`:

```ts
import { type Static, Type } from "@sinclair/typebox";
import { RichBlockSchema, ToolCallSchema } from "cozygateway-contract";

/** Adapter-facing attach wire protocol v0 (contract/attach-v0.md). A harness-side plugin dials
 *  the gateway's /attach WebSocket and speaks this closed frame union. v0 is versioned
 *  independently of the frozen client contract v1 and may change until declared stable. Objects
 *  stay open (unknown fields ignored) but unknown update KINDS are invalid, mirroring the
 *  client contract's forward-compatibility stance. */

export const AttachDraftUpdateSchema = Type.Object({
  kind: Type.Literal("draft"),
  turnId: Type.String({ minLength: 1 }),
  blocks: Type.Array(RichBlockSchema),
  toolCalls: Type.Optional(Type.Array(ToolCallSchema)),
});
export type AttachDraftUpdate = Static<typeof AttachDraftUpdateSchema>;

export const AttachDoneUpdateSchema = Type.Object({
  kind: Type.Literal("done"),
  turnId: Type.String({ minLength: 1 }),
});
export type AttachDoneUpdate = Static<typeof AttachDoneUpdateSchema>;

export const AttachFailedUpdateSchema = Type.Object({
  kind: Type.Literal("failed"),
  turnId: Type.String({ minLength: 1 }),
  message: Type.Optional(Type.String()),
});
export type AttachFailedUpdate = Static<typeof AttachFailedUpdateSchema>;

export const AttachUpdateSchema = Type.Union([
  AttachDraftUpdateSchema,
  AttachDoneUpdateSchema,
  AttachFailedUpdateSchema,
]);
export type AttachUpdate = Static<typeof AttachUpdateSchema>;

/** Every plugin-to-gateway frame names the thread it belongs to; the agent identity comes from
 *  the authenticated connection, never from the frame. */
export const AttachInboundFrameSchema = Type.Object({
  threadId: Type.String({ minLength: 1 }),
  update: AttachUpdateSchema,
});
export type AttachInboundFrame = Static<typeof AttachInboundFrameSchema>;

/** Gateway-to-plugin: one frame kind, a content-bearing turn start. The prompt text rides the
 *  frame (push); there is no side channel to pull content from. */
export const AttachTurnFrameSchema = Type.Object({
  kind: Type.Literal("turn"),
  threadId: Type.String({ minLength: 1 }),
  turnId: Type.String({ minLength: 1 }),
  text: Type.String(),
});
export type AttachTurnFrame = Static<typeof AttachTurnFrameSchema>;
```

`packages/gateway/src/adapters/attach/blocks-to-text.ts`:

```ts
import type { RichBlock } from "cozygateway-contract";

/** Render typed blocks to the plain text a harness receives as its prompt. Deliberately lossy
 *  in the harness direction (markdown-ish, good enough to prompt with); the plugin normalizes
 *  the harness's reply back into typed blocks on its side. */
export function blocksToText(blocks: RichBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
        parts.push(block.text);
        break;
      case "heading":
        parts.push(`${"#".repeat(block.level)} ${block.text}`);
        break;
      case "code":
        parts.push(`\`\`\`${block.language ?? ""}\n${block.code}\n\`\`\``);
        break;
      case "list":
        parts.push(
          block.items
            .map((item, i) => {
              const marker = block.ordered === true ? `${i + 1}.` : "-";
              const box = item.checked === undefined ? "" : item.checked ? "[x] " : "[ ] ";
              return `${marker} ${box}${item.text}`;
            })
            .join("\n"),
        );
        break;
      case "table":
        parts.push(
          [
            `| ${block.header.join(" | ")} |`,
            `| ${block.header.map(() => "---").join(" | ")} |`,
            ...block.rows.map((row) => `| ${row.join(" | ")} |`),
          ].join("\n"),
        );
        break;
      case "math":
        parts.push(`$$\n${block.latex}\n$$`);
        break;
      case "attachment":
        parts.push(`[attachment: ${block.name}]`);
        break;
    }
  }
  return parts.join("\n\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway exec vitest run test/attach-protocol.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 5: Write the protocol spec**

`contract/attach-v0.md` (complete file):

```markdown
# Attach protocol v0 (adapter-facing)

Status: v0, NOT frozen. This is the gateway's adapter-facing protocol, versioned independently
of the client wire contract (`v1.md`). It may change in breaking ways until it is declared
stable. The client contract is unaffected by anything here.

## Purpose

The `attach` backend lets an agent harness answer chat turns by dialing INTO the gateway and
holding one long-lived WebSocket connection per agent. The harness side is a small plugin (a
reference implementation ships in `integrations/attach-plugin/`). The gateway pushes turn
prompts down the connection; the plugin streams the agent's reply back as typed content.

## Transport and authentication

- Endpoint: `GET /attach` (WebSocket upgrade) on the gateway's one listener.
- Auth: `Authorization: Bearer <token>`, header only. Tokens never ride URLs or frames.
- Each configured `attach` agent has its own token, supplied to the gateway by environment
  variable (the config file names the variable via `options.tokenEnv`; it never holds the
  value). The token identifies WHICH agent the connection speaks for.
- A bad or missing token closes the socket with code 1008. Treat 1008 as fatal
  (do not redial with the same credentials in a loop).
- One live connection per agent, newest wins: a second authenticated connection for the same
  agent supersedes the first, which is closed with code 4000 ("superseded"). A superseded
  plugin instance must stop redialing. In-flight turns on the superseded connection fail.
- Gateway shutdown closes connections with code 1001.

## Frames

All frames are JSON text messages.

### Gateway to plugin

One kind, the turn start:

    {"kind": "turn", "threadId": "<id>", "turnId": "<id>", "text": "<prompt text>"}

- `threadId` is the conversation key. It is stable across turns; a plugin should key its
  harness session on it so each gateway thread maps to one persistent harness conversation.
- `turnId` correlates every frame the plugin sends back for this turn.
- `text` is the user's message rendered to plain text. Rich blocks are flattened
  (headings/lists/tables/code render markdown-ish).

The gateway may start turns on different threads concurrently. Turns within one thread are
serialized by the gateway (a thread never has two in-flight turns).

### Plugin to gateway

Every frame:

    {"threadId": "<id>", "update": { ... }}

The agent identity comes from the authenticated connection, never from the frame. `update` is
a closed union; a frame that fails validation is dropped (defense in depth: the plugin
normalizes at the source, the gateway re-validates).

Draft (zero or more per turn), FULL REPLACE:

    {"kind": "draft", "turnId": "<id>",
     "blocks": [RichBlock, ...],
     "toolCalls": [{"id": "<id>", "name": "<tool>", "status": "running|ok|error", "detail": "..."}, ...]}

- `blocks` is the complete current view of the reply so far (never a delta).
- `toolCalls` is the complete current set of tool-call chips, latest state per id. Omit the
  key when empty. `id` need only be unique within the turn.
- Block shapes are the client contract's RichBlock union (`v1.md`); the `attachment` type is
  never emitted by a plugin in v0.

Done (exactly one per successful turn, after the final draft):

    {"kind": "done", "turnId": "<id>"}

`done` carries no content. The gateway seals the LATEST draft's blocks as the durable reply.
Ending a turn with no draft content is invalid; the gateway records a failed turn.

Failed (instead of done):

    {"kind": "failed", "turnId": "<id>", "message": "<short reason>"}

Send best-effort when the turn errors or produced no visible content. Never send both `failed`
and `done` for one turn.

## Failure semantics

- The gateway bounds every turn with a timeout (default 600 s, per-agent configurable). A turn
  with no `done`/`failed` by then is recorded as failed; late frames for it are dropped.
- If the connection drops mid-turn, in-flight turns on it fail immediately.
- A send while no connection is live fails immediately (the client sees the standard
  `turn.failed` marker from contract v1; presence tells it the agent is absent).

## Presence

Connection liveness IS agent presence: `online` while a connection is open for the agent,
`absent` otherwise. The gateway broadcasts contract v1 `presence` frames on transitions and
reports the same state on `GET /agents`.

## Known v0 limitations (deliberate)

- No gateway-side queue-until-attached: sends while absent fail fast; clients queue locally.
- No liveness ping on `/attach`: a half-dead connection is detected by the turn timeout, not
  by heartbeat. Revisit alongside TLS for off-box serving.
- No typing/working indicator and no command manifest in the frame union.
```

- [ ] **Step 6: Run the repo gate**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm check`
Expected: build, typecheck, and all tests green (102 existing + the new file's tests).

- [ ] **Step 7: Commit**

```bash
cd /Users/kmcdowell/Documents/repos/cozygateway && git add contract/attach-v0.md packages/gateway/src/adapters/attach/protocol.ts packages/gateway/src/adapters/attach/blocks-to-text.ts packages/gateway/test/attach-protocol.test.ts && git commit -m "feat: attach protocol v0 schemas, block rendering, and spec"
```

---

### Task 2: Attach ingress (the /attach WebSocket server)

**Files:**
- Create: `packages/gateway/src/adapters/attach/ingress.ts`
- Test: `packages/gateway/test/attach-ingress.test.ts`

**Interfaces:**
- Consumes: `AttachInboundFrameSchema`, `AttachTurnFrame`, `AttachUpdate` from `./protocol.ts` (Task 1); `check` from `cozygateway-contract`.
- Produces: `AttachEvents` interface `{ onUpdate(agentId, threadId, update), onDisconnect(agentId), onPresence(agentId, state) }`; `class AttachIngress` with `constructor({ tokens: Map<string, string>, events: AttachEvents })` (tokens maps token to agentId), `attach(server: Server, path?: string)`, `isAttached(agentId): boolean`, `sendTurn(agentId, frame: AttachTurnFrame): boolean`, `close(): void`. Task 3's adapter consumes `isAttached`/`sendTurn` (as `TurnEndpoint`); Task 4's server wiring consumes the rest.

- [ ] **Step 1: Write the failing test**

`packages/gateway/test/attach-ingress.test.ts`:

```ts
import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttachIngress, type AttachEvents } from "../src/adapters/attach/ingress.ts";
import type { AttachUpdate } from "../src/adapters/attach/protocol.ts";

interface Recorded {
  updates: Array<{ agentId: string; threadId: string; update: AttachUpdate }>;
  disconnects: string[];
  presence: Array<{ agentId: string; state: "online" | "absent" }>;
}

let server: Server;
let ingress: AttachIngress;
let recorded: Recorded;
let url: string;
const sockets: WebSocket[] = [];

function recorder(): AttachEvents {
  return {
    onUpdate: (agentId, threadId, update) => recorded.updates.push({ agentId, threadId, update }),
    onDisconnect: (agentId) => recorded.disconnects.push(agentId),
    onPresence: (agentId, state) => recorded.presence.push({ agentId, state }),
  };
}

function dial(token?: string): WebSocket {
  const socket = new WebSocket(`${url}/attach`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  sockets.push(socket);
  return socket;
}

async function until(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2_000) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  recorded = { updates: [], disconnects: [], presence: [] };
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  url = `ws://127.0.0.1:${port}`;
  ingress = new AttachIngress({ tokens: new Map([["tok-a", "a1"]]), events: recorder() });
  ingress.attach(server);
});

afterEach(async () => {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
  sockets.length = 0;
  ingress.close();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("AttachIngress", () => {
  it("rejects a connection with no bearer token (close 1008)", async () => {
    const socket = dial();
    const [code] = (await once(socket, "close")) as [number];
    expect(code).toBe(1008);
    expect(recorded.presence).toHaveLength(0);
  });

  it("rejects a connection with a wrong token (close 1008)", async () => {
    const socket = dial("wrong");
    const [code] = (await once(socket, "close")) as [number];
    expect(code).toBe(1008);
    expect(ingress.isAttached("a1")).toBe(false);
  });

  it("accepts a valid token, reports presence online, and isAttached", async () => {
    const socket = dial("tok-a");
    await once(socket, "open");
    await until(() => recorded.presence.length === 1);
    expect(recorded.presence[0]).toEqual({ agentId: "a1", state: "online" });
    expect(ingress.isAttached("a1")).toBe(true);
  });

  it("routes valid frames to onUpdate and drops malformed ones silently", async () => {
    const socket = dial("tok-a");
    await once(socket, "open");
    socket.send("not json");
    socket.send(JSON.stringify({ threadId: "t1", update: { kind: "working" } }));
    socket.send(JSON.stringify({ threadId: "t1", update: { kind: "done", turnId: "x" } }));
    await until(() => recorded.updates.length === 1);
    expect(recorded.updates[0]).toEqual({
      agentId: "a1",
      threadId: "t1",
      update: { kind: "done", turnId: "x" },
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("delivers turn frames to the attached socket and reports false when absent", async () => {
    expect(ingress.sendTurn("a1", { kind: "turn", threadId: "t1", turnId: "u1", text: "hi" })).toBe(false);
    const socket = dial("tok-a");
    await once(socket, "open");
    await until(() => ingress.isAttached("a1"));
    const received: unknown[] = [];
    socket.on("message", (data) => received.push(JSON.parse(String(data))));
    expect(ingress.sendTurn("a1", { kind: "turn", threadId: "t1", turnId: "u1", text: "hi" })).toBe(true);
    await until(() => received.length === 1);
    expect(received[0]).toEqual({ kind: "turn", threadId: "t1", turnId: "u1", text: "hi" });
  });

  it("reports absent and onDisconnect when the connection closes", async () => {
    const socket = dial("tok-a");
    await once(socket, "open");
    await until(() => ingress.isAttached("a1"));
    socket.close();
    await until(() => recorded.disconnects.length === 1);
    expect(recorded.presence).toEqual([
      { agentId: "a1", state: "online" },
      { agentId: "a1", state: "absent" },
    ]);
    expect(ingress.isAttached("a1")).toBe(false);
  });

  it("supersedes an existing connection: old socket closes 4000, turns fail, presence stays online", async () => {
    const first = dial("tok-a");
    await once(first, "open");
    await until(() => ingress.isAttached("a1"));
    const second = dial("tok-a");
    const [code] = (await once(first, "close")) as [number];
    expect(code).toBe(4000);
    await once(second, "open");
    // The supersede fired onDisconnect exactly once (for the old connection's turns) and never
    // reported the agent absent.
    await until(() => recorded.disconnects.length === 1);
    expect(recorded.presence.filter((p) => p.state === "absent")).toHaveLength(0);
    expect(ingress.isAttached("a1")).toBe(true);
    const received: unknown[] = [];
    second.on("message", (data) => received.push(JSON.parse(String(data))));
    ingress.sendTurn("a1", { kind: "turn", threadId: "t1", turnId: "u2", text: "again" });
    await until(() => received.length === 1);
  });

  it("close() shuts every connection down with 1001", async () => {
    const socket = dial("tok-a");
    await once(socket, "open");
    ingress.close();
    const [code] = (await once(socket, "close")) as [number];
    expect(code).toBe(1001);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway exec vitest run test/attach-ingress.test.ts`
Expected: FAIL (cannot resolve `../src/adapters/attach/ingress.ts`).

- [ ] **Step 3: Implement the ingress**

`packages/gateway/src/adapters/attach/ingress.ts`:

```ts
import type { IncomingMessage, Server } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { WebSocketServer, WebSocket } from "ws";
import { check } from "cozygateway-contract";

import { AttachInboundFrameSchema, type AttachTurnFrame, type AttachUpdate } from "./protocol.ts";

/** What the ingress reports upward. The server maps presence transitions to contract v1
 *  presence frames; the router maps updates/disconnects to the owning agent's adapter. */
export interface AttachEvents {
  onUpdate(agentId: string, threadId: string, update: AttachUpdate): void;
  onDisconnect(agentId: string): void;
  onPresence(agentId: string, state: "online" | "absent"): void;
}

/** Constant-time secret comparison; a length mismatch returns false without a timing oracle
 *  on where the strings diverge. */
function tokenEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** The adapter-facing /attach WebSocket server. Authenticates each connection by bearer token
 *  (header only, never the URL), keeps ONE live connection per agent (newest wins), validates
 *  every inbound frame against the closed attach union as defense in depth, and reports
 *  connection liveness as agent presence. */
export class AttachIngress {
  readonly #tokens: Map<string, string>;
  readonly #events: AttachEvents;
  readonly #current = new Map<string, WebSocket>();
  #wss: WebSocketServer | undefined;

  constructor(deps: { tokens: Map<string, string>; events: AttachEvents }) {
    this.#tokens = deps.tokens;
    this.#events = deps.events;
  }

  attach(server: Server, path = "/attach"): void {
    const wss = new WebSocketServer({ server, path });
    this.#wss = wss;
    // Swallow server-level errors: an unhandled 'error' event would crash the process.
    wss.on("error", () => {});
    wss.on("connection", (socket, req) => this.#onConnection(socket, req));
  }

  #agentForRequest(req: IncomingMessage): string | undefined {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (token === "") return undefined;
    for (const [candidate, agentId] of this.#tokens) {
      if (tokenEquals(candidate, token)) return agentId;
    }
    return undefined;
  }

  #onConnection(socket: WebSocket, req: IncomingMessage): void {
    // A ws socket with no 'error' listener crashes the process on the first socket error.
    socket.on("error", () => {
      try {
        socket.close(1008, "socket error");
      } catch {
        socket.terminate();
      }
    });

    const agentId = this.#agentForRequest(req);
    if (agentId === undefined) {
      socket.close(1008, "unauthorized");
      return;
    }

    // Newest wins: supersede any existing connection for this agent. Its in-flight turns are
    // dead (the new plugin instance knows nothing about them), so fire onDisconnect for them,
    // but presence never flips: the agent stays online across the handover.
    const previous = this.#current.get(agentId);
    if (previous !== undefined) {
      this.#current.delete(agentId);
      previous.close(4000, "superseded");
      this.#events.onDisconnect(agentId);
    }
    this.#current.set(agentId, socket);
    if (previous === undefined) this.#events.onPresence(agentId, "online");

    socket.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return; // malformed JSON: drop (defense in depth)
      }
      if (!check(AttachInboundFrameSchema, frame)) return; // outside the closed union: drop
      this.#events.onUpdate(agentId, frame.threadId, frame.update);
    });

    socket.on("close", () => {
      // Only the CURRENT connection's close flips presence; a superseded socket's close is
      // already accounted for.
      if (this.#current.get(agentId) === socket) {
        this.#current.delete(agentId);
        this.#events.onPresence(agentId, "absent");
        this.#events.onDisconnect(agentId);
      }
    });
  }

  isAttached(agentId: string): boolean {
    return this.#current.get(agentId)?.readyState === WebSocket.OPEN;
  }

  /** Deliver a turn frame to the agent's live connection. False when there is none (the
   *  adapter fails the turn fast rather than queueing). */
  sendTurn(agentId: string, frame: AttachTurnFrame): boolean {
    const socket = this.#current.get(agentId);
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  close(): void {
    for (const socket of this.#current.values()) socket.close(1001, "server shutdown");
    this.#current.clear();
    this.#wss?.close();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway exec vitest run test/attach-ingress.test.ts`
Expected: PASS, pristine exit (no lingering handles).

- [ ] **Step 5: Commit**

```bash
cd /Users/kmcdowell/Documents/repos/cozygateway && git add packages/gateway/src/adapters/attach/ingress.ts packages/gateway/test/attach-ingress.test.ts && git commit -m "feat: attach ingress with bearer auth, newest-wins connections, presence"
```

---

### Task 3: The attach BackendAdapter (options, tokens, router, turn orchestration)

**Files:**
- Create: `packages/gateway/src/adapters/attach/adapter.ts`
- Test: `packages/gateway/test/attach-adapter.test.ts`

**Interfaces:**
- Consumes: `AttachTurnFrame`, `AttachUpdate` from `./protocol.ts`; `blocksToText` from `./blocks-to-text.ts`; `BackendAdapter`, `BackendSession`, `TurnHandlers` from `../types.ts`; `AgentConfig` from `../../config.ts`.
- Produces:
  - `interface TurnEndpoint { isAttached(agentId: string): boolean; sendTurn(agentId: string, frame: AttachTurnFrame): boolean }` (structurally satisfied by `AttachIngress`).
  - `interface AttachAdapter extends BackendAdapter { handleUpdate(threadId: string, update: AttachUpdate): void; handleDisconnect(): void }`.
  - `DEFAULT_TURN_TIMEOUT_SECONDS = 600`.
  - `parseAttachOptions(agent: AgentConfig, env: Record<string, string | undefined>): { tokenEnv: string; token: string; turnTimeoutMs: number }`.
  - `collectAttachTokens(agents: AgentConfig[], env: Record<string, string | undefined>): Map<string, string>` (token to agentId; throws on collision).
  - `createAttachAdapter(deps: { agentId: string; endpoint: TurnEndpoint; turnTimeoutMs: number }): AttachAdapter`.
  - `class AttachRouter { register(agentId: string, adapter: AttachAdapter): void; onUpdate(agentId, threadId, update): void; onDisconnect(agentId): void }`.
  Task 4 imports exactly these names.

- [ ] **Step 1: Write the failing test**

`packages/gateway/test/attach-adapter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RichBlock } from "cozygateway-contract";

import {
  AttachRouter,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  collectAttachTokens,
  createAttachAdapter,
  parseAttachOptions,
  type AttachAdapter,
  type TurnEndpoint,
} from "../src/adapters/attach/adapter.ts";
import type { AttachTurnFrame } from "../src/adapters/attach/protocol.ts";
import type { TurnHandlers } from "../src/adapters/types.ts";

const agent = (id: string, options?: Record<string, unknown>) => ({
  id,
  name: id,
  backend: "attach",
  ...(options === undefined ? {} : { options }),
});

describe("parseAttachOptions", () => {
  it("requires options.tokenEnv", () => {
    expect(() => parseAttachOptions(agent("a1"), {})).toThrow(/options\.tokenEnv/);
    expect(() => parseAttachOptions(agent("a1", { tokenEnv: "" }), {})).toThrow(/options\.tokenEnv/);
  });

  it("requires the named environment variable to be set and non-empty", () => {
    expect(() => parseAttachOptions(agent("a1", { tokenEnv: "A1_TOKEN" }), {})).toThrow(/A1_TOKEN/);
    expect(() => parseAttachOptions(agent("a1", { tokenEnv: "A1_TOKEN" }), { A1_TOKEN: "" })).toThrow(
      /A1_TOKEN/,
    );
  });

  it("parses the token and defaults the turn timeout", () => {
    const parsed = parseAttachOptions(agent("a1", { tokenEnv: "A1_TOKEN" }), { A1_TOKEN: "secret" });
    expect(parsed).toEqual({
      tokenEnv: "A1_TOKEN",
      token: "secret",
      turnTimeoutMs: DEFAULT_TURN_TIMEOUT_SECONDS * 1000,
    });
  });

  it("accepts a positive turnTimeoutSeconds and rejects anything else", () => {
    const parsed = parseAttachOptions(
      agent("a1", { tokenEnv: "A1_TOKEN", turnTimeoutSeconds: 5 }),
      { A1_TOKEN: "secret" },
    );
    expect(parsed.turnTimeoutMs).toBe(5_000);
    for (const bad of [0, -1, "5", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        parseAttachOptions(agent("a1", { tokenEnv: "A1_TOKEN", turnTimeoutSeconds: bad }), {
          A1_TOKEN: "secret",
        }),
      ).toThrow(/turnTimeoutSeconds/);
    }
  });
});

describe("collectAttachTokens", () => {
  it("collects one entry per attach agent and ignores other backends", () => {
    const tokens = collectAttachTokens(
      [
        agent("a1", { tokenEnv: "A1_TOKEN" }),
        { id: "m1", name: "m1", backend: "mock" },
        agent("a2", { tokenEnv: "A2_TOKEN" }),
      ],
      { A1_TOKEN: "one", A2_TOKEN: "two" },
    );
    expect(tokens).toEqual(
      new Map([
        ["one", "a1"],
        ["two", "a2"],
      ]),
    );
  });

  it("rejects two agents sharing a token (the token identifies the agent)", () => {
    expect(() =>
      collectAttachTokens(
        [agent("a1", { tokenEnv: "A1_TOKEN" }), agent("a2", { tokenEnv: "A2_TOKEN" })],
        { A1_TOKEN: "same", A2_TOKEN: "same" },
      ),
    ).toThrow(/token/);
  });
});

interface FakeEndpoint extends TurnEndpoint {
  attached: boolean;
  frames: AttachTurnFrame[];
}

function fakeEndpoint(): FakeEndpoint {
  const endpoint: FakeEndpoint = {
    attached: true,
    frames: [],
    isAttached: () => endpoint.attached,
    sendTurn: (agentId, frame) => {
      if (!endpoint.attached) return false;
      endpoint.frames.push(frame);
      return true;
    },
  };
  return endpoint;
}

interface Observed {
  drafts: Array<{ blocks: RichBlock[]; toolCalls: unknown[] }>;
  commits: RichBlock[][];
  done: number;
}

function observer(): { handlers: TurnHandlers; observed: Observed } {
  const observed: Observed = { drafts: [], commits: [], done: 0 };
  return {
    observed,
    handlers: {
      onDraft: (update) => observed.drafts.push(update),
      onCommit: (final) => observed.commits.push(final.blocks),
      onDone: () => {
        observed.done += 1;
      },
    },
  };
}

async function startTurn(adapter: AttachAdapter, endpoint: FakeEndpoint, threadId: string) {
  const session = await adapter.startSession(threadId);
  const { handlers, observed } = observer();
  const before = endpoint.frames.length;
  const turn = session.send([{ type: "paragraph", text: "hi" }], handlers);
  // send() writes the turn frame synchronously; belt and braces for slower paths.
  if (endpoint.frames.length === before) throw new Error("turn frame was not sent");
  const frame = endpoint.frames[endpoint.frames.length - 1]!;
  return { session, turn, observed, frame };
}

describe("createAttachAdapter", () => {
  it("rejects a send while no connection is attached", async () => {
    const endpoint = fakeEndpoint();
    endpoint.attached = false;
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const session = await adapter.startSession("t1");
    const { handlers } = observer();
    await expect(session.send([{ type: "paragraph", text: "x" }], handlers)).rejects.toThrow(
      /not attached/,
    );
    expect(adapter.presence()).toBe("absent");
  });

  it("sends a rendered turn frame and completes on draft/done", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const { turn, observed, frame } = await startTurn(adapter, endpoint, "t1");
    expect(frame.kind).toBe("turn");
    expect(frame.threadId).toBe("t1");
    expect(frame.text).toBe("hi");

    adapter.handleUpdate("t1", {
      kind: "draft",
      turnId: frame.turnId,
      blocks: [{ type: "paragraph", text: "th" }],
      toolCalls: [{ id: "search#1", name: "search", status: "running" }],
    });
    adapter.handleUpdate("t1", {
      kind: "draft",
      turnId: frame.turnId,
      blocks: [{ type: "paragraph", text: "the answer" }],
    });
    adapter.handleUpdate("t1", { kind: "done", turnId: frame.turnId });
    await turn;

    expect(observed.drafts).toEqual([
      {
        blocks: [{ type: "paragraph", text: "th" }],
        toolCalls: [{ id: "search#1", name: "search", status: "running" }],
      },
      { blocks: [{ type: "paragraph", text: "the answer" }], toolCalls: [] },
    ]);
    expect(observed.commits).toEqual([[{ type: "paragraph", text: "the answer" }]]);
    expect(observed.done).toBe(1);
    expect(adapter.presence()).toBe("online");
  });

  it("fails a turn that ends with no draft content", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const { turn, observed, frame } = await startTurn(adapter, endpoint, "t1");
    adapter.handleUpdate("t1", { kind: "done", turnId: frame.turnId });
    await expect(turn).rejects.toThrow(/without any reply content/);
    expect(observed.commits).toHaveLength(0);
    expect(observed.done).toBe(0);
  });

  it("fails a turn on an explicit failed frame, with the plugin's message", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const { turn, frame } = await startTurn(adapter, endpoint, "t1");
    adapter.handleUpdate("t1", { kind: "failed", turnId: frame.turnId, message: "model unreachable" });
    await expect(turn).rejects.toThrow(/model unreachable/);
  });

  it("fails all in-flight turns when the connection drops", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const first = await startTurn(adapter, endpoint, "t1");
    const second = await startTurn(adapter, endpoint, "t2");
    adapter.handleDisconnect();
    await expect(first.turn).rejects.toThrow(/dropped mid-turn/);
    await expect(second.turn).rejects.toThrow(/dropped mid-turn/);
  });

  it("times out a turn that never completes", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 20 });
    const { turn } = await startTurn(adapter, endpoint, "t1");
    await expect(turn).rejects.toThrow(/timed out/);
  });

  it("drops frames for an unknown turn, a foreign thread, and a settled turn", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    adapter.handleUpdate("t1", { kind: "done", turnId: "never-started" }); // no throw

    const { turn, observed, frame } = await startTurn(adapter, endpoint, "t1");
    adapter.handleUpdate("OTHER-THREAD", {
      kind: "draft",
      turnId: frame.turnId,
      blocks: [{ type: "paragraph", text: "spoof" }],
    });
    expect(observed.drafts).toHaveLength(0);

    adapter.handleUpdate("t1", {
      kind: "draft",
      turnId: frame.turnId,
      blocks: [{ type: "paragraph", text: "real" }],
    });
    adapter.handleUpdate("t1", { kind: "done", turnId: frame.turnId });
    await turn;

    adapter.handleUpdate("t1", { kind: "failed", turnId: frame.turnId, message: "late" }); // no effect
    expect(observed.commits).toEqual([[{ type: "paragraph", text: "real" }]]);
    expect(observed.done).toBe(1);
  });

  it("runs concurrent turns on different threads independently", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const a = await startTurn(adapter, endpoint, "ta");
    const b = await startTurn(adapter, endpoint, "tb");
    expect(a.frame.turnId).not.toBe(b.frame.turnId);

    adapter.handleUpdate("tb", {
      kind: "draft",
      turnId: b.frame.turnId,
      blocks: [{ type: "paragraph", text: "b done" }],
    });
    adapter.handleUpdate("tb", { kind: "done", turnId: b.frame.turnId });
    await b.turn;
    expect(a.observed.done).toBe(0);

    adapter.handleUpdate("ta", {
      kind: "draft",
      turnId: a.frame.turnId,
      blocks: [{ type: "paragraph", text: "a done" }],
    });
    adapter.handleUpdate("ta", { kind: "done", turnId: a.frame.turnId });
    await a.turn;
    expect(a.observed.commits).toEqual([[{ type: "paragraph", text: "a done" }]]);
  });
});

describe("AttachRouter", () => {
  it("routes updates and disconnects to the registered adapter and ignores unknown agents", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const router = new AttachRouter();
    router.register("a1", adapter);
    router.onUpdate("ghost", "t1", { kind: "done", turnId: "x" }); // no throw
    router.onDisconnect("ghost"); // no throw

    const { turn, frame } = await startTurn(adapter, endpoint, "t1");
    router.onUpdate("a1", "t1", {
      kind: "draft",
      turnId: frame.turnId,
      blocks: [{ type: "paragraph", text: "via router" }],
    });
    router.onUpdate("a1", "t1", { kind: "done", turnId: frame.turnId });
    await turn;
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway exec vitest run test/attach-adapter.test.ts`
Expected: FAIL (cannot resolve `../src/adapters/attach/adapter.ts`).

- [ ] **Step 3: Implement the adapter**

`packages/gateway/src/adapters/attach/adapter.ts`:

```ts
import { randomUUID } from "node:crypto";

import type { PresenceState, RichBlock } from "cozygateway-contract";

import type { AgentConfig } from "../../config.ts";
import type { BackendAdapter, BackendSession, TurnHandlers } from "../types.ts";
import type { AttachTurnFrame, AttachUpdate } from "./protocol.ts";
import { blocksToText } from "./blocks-to-text.ts";

/** The slice of the ingress a turn needs. A seam so adapter tests run with no sockets;
 *  AttachIngress satisfies it structurally. */
export interface TurnEndpoint {
  isAttached(agentId: string): boolean;
  sendTurn(agentId: string, frame: AttachTurnFrame): boolean;
}

/** A BackendAdapter that also receives routed ingress events for its agent. */
export interface AttachAdapter extends BackendAdapter {
  handleUpdate(threadId: string, update: AttachUpdate): void;
  handleDisconnect(): void;
}

/** Generous by default: agentic turns with tool use can legitimately run for minutes. The
 *  per-agent options.turnTimeoutSeconds overrides it. */
export const DEFAULT_TURN_TIMEOUT_SECONDS = 600;

export interface ParsedAttachOptions {
  tokenEnv: string;
  token: string;
  turnTimeoutMs: number;
}

/** Parse and validate an attach agent's options. The config file carries the NAME of the
 *  environment variable holding the connection token, never the token itself; startup fails
 *  closed when the variable is missing or empty. */
export function parseAttachOptions(
  agent: AgentConfig,
  env: Record<string, string | undefined>,
): ParsedAttachOptions {
  const options = agent.options ?? {};
  const tokenEnv = options["tokenEnv"];
  if (typeof tokenEnv !== "string" || tokenEnv.length === 0) {
    throw new Error(
      `agent "${agent.id}": the attach backend requires options.tokenEnv, the NAME of an environment variable holding the connection token`,
    );
  }
  const token = env[tokenEnv];
  if (token === undefined || token.length === 0) {
    throw new Error(
      `agent "${agent.id}": environment variable "${tokenEnv}" is not set; the attach token rides the environment, never the config file`,
    );
  }
  const rawTimeout = options["turnTimeoutSeconds"];
  let turnTimeoutMs = DEFAULT_TURN_TIMEOUT_SECONDS * 1000;
  if (rawTimeout !== undefined) {
    if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
      throw new Error(`agent "${agent.id}": options.turnTimeoutSeconds must be a positive number`);
    }
    turnTimeoutMs = rawTimeout * 1000;
  }
  return { tokenEnv, token, turnTimeoutMs };
}

/** Build the token-to-agentId map the ingress authenticates against. The token IS the agent
 *  identity on /attach, so a shared token is a hard startup error, not a warning. */
export function collectAttachTokens(
  agents: AgentConfig[],
  env: Record<string, string | undefined>,
): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const agent of agents) {
    if (agent.backend !== "attach") continue;
    const { token } = parseAttachOptions(agent, env);
    const holder = tokens.get(token);
    if (holder !== undefined) {
      throw new Error(
        `agent "${agent.id}": attach token collides with agent "${holder}"; every attach agent needs its own token`,
      );
    }
    tokens.set(token, agent.id);
  }
  return tokens;
}

interface InflightTurn {
  threadId: string;
  handlers: TurnHandlers;
  latest: RichBlock[] | undefined;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (err: Error) => void;
}

/** One attach agent's BackendAdapter. Sessions are per thread (the runner caches one per
 *  thread); turns across threads may be in flight concurrently, each correlated by a wire
 *  turnId this adapter mints. Frames for unknown turns, foreign threads, or settled turns are
 *  dropped. */
export function createAttachAdapter(deps: {
  agentId: string;
  endpoint: TurnEndpoint;
  turnTimeoutMs: number;
}): AttachAdapter {
  const turns = new Map<string, InflightTurn>();

  const settle = (turnId: string): InflightTurn | undefined => {
    const turn = turns.get(turnId);
    if (turn === undefined) return undefined;
    turns.delete(turnId);
    clearTimeout(turn.timer);
    return turn;
  };

  const failTurn = (turnId: string, message: string): void => {
    settle(turnId)?.reject(new Error(message));
  };

  return {
    backend: "attach",

    async startSession(threadId: string): Promise<BackendSession> {
      return {
        send(blocks: RichBlock[], handlers: TurnHandlers): Promise<void> {
          if (!deps.endpoint.isAttached(deps.agentId)) {
            return Promise.reject(new Error(`agent "${deps.agentId}" is not attached`));
          }
          const turnId = randomUUID();
          return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => failTurn(turnId, `turn timed out after ${deps.turnTimeoutMs / 1000}s`),
              deps.turnTimeoutMs,
            );
            timer.unref();
            turns.set(turnId, { threadId, handlers, latest: undefined, timer, resolve, reject });
            const sent = deps.endpoint.sendTurn(deps.agentId, {
              kind: "turn",
              threadId,
              turnId,
              text: blocksToText(blocks),
            });
            if (!sent) failTurn(turnId, `agent "${deps.agentId}" is not attached`);
          });
        },
        async close(): Promise<void> {},
      };
    },

    presence: (): PresenceState => (deps.endpoint.isAttached(deps.agentId) ? "online" : "absent"),

    handleUpdate(threadId: string, update: AttachUpdate): void {
      const turn = turns.get(update.turnId);
      if (turn === undefined || turn.threadId !== threadId) return;
      if (update.kind === "draft") {
        turn.latest = update.blocks;
        turn.handlers.onDraft({ blocks: update.blocks, toolCalls: update.toolCalls ?? [] });
        return;
      }
      if (update.kind === "failed") {
        failTurn(update.turnId, update.message ?? "the agent reported a failed turn");
        return;
      }
      // kind === "done": seal the latest draft. A turn with no draft content is a failure, so
      // the runner records turn.failed instead of committing an empty reply.
      const latest = turn.latest;
      if (latest === undefined || latest.length === 0) {
        failTurn(update.turnId, "the agent finished the turn without any reply content");
        return;
      }
      const settled = settle(update.turnId);
      if (settled === undefined) return;
      settled.handlers.onCommit({ blocks: latest });
      settled.handlers.onDone();
      settled.resolve();
    },

    handleDisconnect(): void {
      for (const turnId of [...turns.keys()]) {
        failTurn(turnId, "the attached connection dropped mid-turn");
      }
    },
  };
}

/** Routes ingress events to the owning agent's adapter. The server registers each attach
 *  adapter here at build time; events for agents with no adapter are dropped. */
export class AttachRouter {
  readonly #adapters = new Map<string, AttachAdapter>();

  register(agentId: string, adapter: AttachAdapter): void {
    this.#adapters.set(agentId, adapter);
  }

  onUpdate(agentId: string, threadId: string, update: AttachUpdate): void {
    this.#adapters.get(agentId)?.handleUpdate(threadId, update);
  }

  onDisconnect(agentId: string): void {
    this.#adapters.get(agentId)?.handleDisconnect();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway exec vitest run test/attach-adapter.test.ts`
Expected: PASS, pristine exit.

- [ ] **Step 5: Commit**

```bash
cd /Users/kmcdowell/Documents/repos/cozygateway && git add packages/gateway/src/adapters/attach/adapter.ts packages/gateway/test/attach-adapter.test.ts && git commit -m "feat: attach backend adapter with turn orchestration and fail-fast semantics"
```

---

### Task 4: Registry and server wiring, end-to-end test, README

**Files:**
- Modify: `packages/gateway/src/adapters/registry.ts`
- Modify: `packages/gateway/src/server.ts`
- Modify: `README.md`
- Test: `packages/gateway/test/attach-e2e.test.ts`

**Interfaces:**
- Consumes: everything Task 3 produced; `AttachIngress`, `AttachEvents` from `./attach/ingress.ts`.
- Produces: `buildAdapters(agents: AgentConfig[], attach?: AttachWiring)` where `AttachWiring = { endpoint: TurnEndpoint; env: Record<string, string | undefined>; register(agentId: string, adapter: AttachAdapter): void }`. `startGateway` signature is unchanged.

- [ ] **Step 1: Write the failing end-to-end test**

`packages/gateway/test/attach-e2e.test.ts`:

```ts
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message, ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { buildAdapters } from "../src/adapters/registry.ts";

const TOKEN_ENV = "E2E_ATTACH_TOKEN";
const TOKEN = "e2e-attach-token";

let gateway: RunningGateway;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  process.env[TOKEN_ENV] = TOKEN;
  gateway = await startGateway({
    name: "attach-e2e",
    port: 0,
    dbPath: ":memory:",
    agents: [
      {
        id: "helper",
        name: "Helper",
        backend: "attach",
        options: { tokenEnv: TOKEN_ENV, turnTimeoutSeconds: 5 },
      },
    ],
  });
});

afterEach(async () => {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
  sockets.length = 0;
  await gateway.close();
  delete process.env[TOKEN_ENV];
});

function track(socket: WebSocket): WebSocket {
  sockets.push(socket);
  return socket;
}

async function pairDevice(): Promise<string> {
  const code = gateway.issueSetupCode();
  const res = await fetch(`${gateway.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "e2e phone" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { deviceToken: string };
  return body.deviceToken;
}

async function createThread(deviceToken: string): Promise<string> {
  const res = await fetch(`${gateway.url}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({ agentId: "helper", title: "e2e" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function openClientWs(deviceToken: string, frames: ServerFrame[]): Promise<WebSocket> {
  const ws = track(new WebSocket(`${gateway.url.replace("http", "ws")}/ws`));
  await once(ws, "open");
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
  ws.send(JSON.stringify({ type: "auth", token: deviceToken }));
  await until(() => frames.some((f) => f.type === "ready"));
  return ws;
}

/** A scripted fake harness: dials /attach and answers every turn frame with two drafts (the
 *  second carrying a tool chip) and done. */
async function attachFakeHarness(): Promise<WebSocket> {
  const ws = track(
    new WebSocket(`${gateway.url.replace("http", "ws")}/attach`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  await once(ws, "open");
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data)) as { threadId: string; turnId: string; text: string };
    const send = (update: unknown) => ws.send(JSON.stringify({ threadId: frame.threadId, update }));
    send({ kind: "draft", turnId: frame.turnId, blocks: [{ type: "paragraph", text: "Thinking" }] });
    send({
      kind: "draft",
      turnId: frame.turnId,
      blocks: [{ type: "paragraph", text: `You said: ${frame.text}` }],
      toolCalls: [{ id: "lookup#1", name: "lookup", status: "ok" }],
    });
    send({ kind: "done", turnId: frame.turnId });
  });
  return ws;
}

async function until(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 3_000) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("attach backend end to end", () => {
  it("streams a live turn from an attached harness through to the client", async () => {
    const deviceToken = await pairDevice();
    const frames: ServerFrame[] = [];
    await openClientWs(deviceToken, frames);

    // Before the harness attaches: absent, and a send fails as a turn.failed marker.
    const agentsBefore = await fetch(`${gateway.url}/agents`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const listBefore = (await agentsBefore.json()) as Array<{ id: string; presence: string }>;
    expect(listBefore[0]?.presence).toBe("absent");

    const threadId = await createThread(deviceToken);
    const failedSend = await fetch(`${gateway.url}/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "anyone home?" }] }),
    });
    expect(failedSend.status).toBe(200); // the user message commits; the TURN fails
    await until(() => frames.some((f) => f.type === "error" && f.code === "turn_failed"));

    // Harness attaches: presence flips online (frame + REST agree).
    await attachFakeHarness();
    await until(() => frames.some((f) => f.type === "presence" && f.state === "online"));
    const agentsAfter = await fetch(`${gateway.url}/agents`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const listAfter = (await agentsAfter.json()) as Array<{ presence: string }>;
    expect(listAfter[0]?.presence).toBe("online");

    // A live turn: drafts stream (tool chip included), the reply commits, done arrives.
    const sendRes = await fetch(`${gateway.url}/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "hello agent" }] }),
    });
    expect(sendRes.status).toBe(200);
    await until(() => frames.some((f) => f.type === "done"));

    const drafts = frames.filter(
      (f): f is Extract<ServerFrame, { type: "draft" }> => f.type === "draft",
    );
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    expect(drafts[drafts.length - 1]?.toolCalls).toEqual([
      { id: "lookup#1", name: "lookup", status: "ok" },
    ]);
    const committed = frames.filter(
      (f): f is Extract<ServerFrame, { type: "committed" }> => f.type === "committed",
    );
    const agentReply: Message | undefined = committed
      .map((f) => f.message)
      .find((m) => m.role === "agent");
    expect(agentReply?.blocks).toEqual([{ type: "paragraph", text: "You said: hello agent" }]);
  });

  it("fails the in-flight turn and flips presence when the harness drops mid-turn", async () => {
    const deviceToken = await pairDevice();
    const frames: ServerFrame[] = [];
    await openClientWs(deviceToken, frames);
    const threadId = await createThread(deviceToken);

    // A harness that answers with one draft and then hangs (never done).
    const harness = track(
      new WebSocket(`${gateway.url.replace("http", "ws")}/attach`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    await once(harness, "open");
    harness.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { threadId: string; turnId: string };
      harness.send(
        JSON.stringify({
          threadId: frame.threadId,
          update: {
            kind: "draft",
            turnId: frame.turnId,
            blocks: [{ type: "paragraph", text: "partial" }],
          },
        }),
      );
    });
    await until(() => frames.some((f) => f.type === "presence" && f.state === "online"));

    await fetch(`${gateway.url}/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "hi" }] }),
    });
    await until(() => frames.some((f) => f.type === "draft"));

    harness.close();
    await until(() => frames.some((f) => f.type === "error" && f.code === "turn_failed"));
    await until(() => frames.some((f) => f.type === "presence" && f.state === "absent"));

    // The failed turn left a turn.failed marker, not a committed agent reply.
    const history = await fetch(`${gateway.url}/threads/${threadId}/messages`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const body = (await history.json()) as { messages: Message[] };
    expect(body.messages.some((m) => m.marker === "turn.failed")).toBe(true);
    expect(body.messages.some((m) => m.role === "agent")).toBe(false);
  });

  it("startGateway fails closed when the token env var is missing", async () => {
    delete process.env[TOKEN_ENV];
    await expect(
      startGateway({
        name: "bad",
        port: 0,
        dbPath: ":memory:",
        agents: [{ id: "x", name: "X", backend: "attach", options: { tokenEnv: TOKEN_ENV } }],
      }),
    ).rejects.toThrow(new RegExp(TOKEN_ENV));
  });
});

describe("buildAdapters attach branch", () => {
  it("requires the attach wiring", () => {
    expect(() =>
      buildAdapters([{ id: "a1", name: "A", backend: "attach", options: { tokenEnv: "X" } }]),
    ).toThrow(/attach/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway exec vitest run test/attach-e2e.test.ts`
Expected: FAIL (`buildAdapters` throws `unknown backend "attach"` during startGateway).

- [ ] **Step 3: Wire the registry**

Replace `packages/gateway/src/adapters/registry.ts` with:

```ts
import type { AgentConfig } from "../config.ts";
import type { BackendAdapter } from "./types.ts";
import { createMockAdapter } from "./mock.ts";
import {
  createAttachAdapter,
  parseAttachOptions,
  type AttachAdapter,
  type TurnEndpoint,
} from "./attach/adapter.ts";

/** What the attach backend needs from the caller: the live ingress (turn delivery), the
 *  environment (token resolution), and a registration hook so ingress events route back to
 *  each built adapter. startGateway wires all three; bare callers without attach agents may
 *  omit it. */
export interface AttachWiring {
  endpoint: TurnEndpoint;
  env: Record<string, string | undefined>;
  register(agentId: string, adapter: AttachAdapter): void;
}

export function buildAdapters(
  agents: AgentConfig[],
  attach?: AttachWiring,
): Map<string, BackendAdapter> {
  const adapters = new Map<string, BackendAdapter>();
  for (const agent of agents) {
    if (agent.backend === "mock") {
      adapters.set(agent.id, createMockAdapter(agent.options as { failOn?: string } | undefined));
    } else if (agent.backend === "attach") {
      if (attach === undefined) {
        throw new Error(
          `agent "${agent.id}": the attach backend requires the gateway's attach wiring`,
        );
      }
      const options = parseAttachOptions(agent, attach.env);
      const adapter = createAttachAdapter({
        agentId: agent.id,
        endpoint: attach.endpoint,
        turnTimeoutMs: options.turnTimeoutMs,
      });
      attach.register(agent.id, adapter);
      adapters.set(agent.id, adapter);
    } else {
      throw new Error(`unknown backend "${agent.backend}" for agent "${agent.id}"`);
    }
  }
  return adapters;
}
```

- [ ] **Step 4: Wire the server**

Replace `packages/gateway/src/server.ts` with:

```ts
import type { Server } from "node:http";

import { serve } from "@hono/node-server";
import type { GatewayInfo } from "cozygateway-contract";

import type { GatewayConfig } from "./config.ts";
import { openStorage, type Storage } from "./storage.ts";
import { buildAdapters } from "./adapters/registry.ts";
import { AttachIngress } from "./adapters/attach/ingress.ts";
import { AttachRouter, collectAttachTokens } from "./adapters/attach/adapter.ts";
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
  const gatewayInfo: GatewayInfo = { name: config.name, version: GATEWAY_VERSION, contract: "v1" };
  const hub = new WsHub({ storage, gatewayInfo, now: () => Date.now() });

  // The attach ingress exists only when an attach agent is configured. Token resolution fails
  // closed BEFORE the listener opens, so a misconfigured gateway never half-starts.
  const attachAgents = config.agents.filter((a) => a.backend === "attach");
  const router = new AttachRouter();
  let attachIngress: AttachIngress | undefined;
  if (attachAgents.length > 0) {
    const tokens = collectAttachTokens(config.agents, process.env);
    attachIngress = new AttachIngress({
      tokens,
      events: {
        onUpdate: (agentId, threadId, update) => router.onUpdate(agentId, threadId, update),
        onDisconnect: (agentId) => router.onDisconnect(agentId),
        onPresence: (agentId, state) => hub.broadcast({ type: "presence", agentId, state }),
      },
    });
  }

  const adapters = buildAdapters(
    config.agents,
    attachIngress === undefined
      ? undefined
      : {
          endpoint: attachIngress,
          env: process.env,
          register: (agentId, adapter) => router.register(agentId, adapter),
        },
  );
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
  attachIngress?.attach(server);
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
      // Closing attach sockets fires the disconnect path, which fails in-flight turns, so the
      // runner's per-thread chains settle before closeAll drains them.
      attachIngress?.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await runner.closeAll();
      storage.close();
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway exec vitest run test/attach-e2e.test.ts`
Expected: PASS, pristine exit.

- [ ] **Step 6: Update the README**

In `README.md`, replace the sentence in the intro paragraph "A reference echo backend ships today, for trying the gateway out before wiring up a real one. Additional backend adapters are planned." with:

```markdown
Two backends ship today: a reference echo backend for trying the gateway out, and an `attach` backend that lets an agent harness dial in over a small WebSocket protocol and answer turns live.
```

In the `## Status` section, replace "and real backend adapters, all planned." with "and further backend adapters, all planned. The `attach` backend and its adapter-facing protocol (`contract/attach-v0.md`, v0, not yet frozen) shipped with a reference harness plugin in `integrations/`."

At the end of the `## Repo layout` list, add:

```markdown
- `integrations/attach-plugin`: a reference plugin for agent harnesses that support Python platform plugins, speaking the attach v0 protocol.
```

- [ ] **Step 7: Run the full gate (conformance must stay 21/21)**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm check`
Expected: build, typecheck, every package's tests green, conformance suite 21/21 against the mock backend.

- [ ] **Step 8: Commit**

```bash
cd /Users/kmcdowell/Documents/repos/cozygateway && git add packages/gateway/src/adapters/registry.ts packages/gateway/src/server.ts packages/gateway/test/attach-e2e.test.ts README.md && git commit -m "feat: wire the attach backend through registry and server, end to end"
```

---

### Task 5: Reference harness plugin (verification and hygiene gate)

The plugin source in `integrations/attach-plugin/` (a `plugin.yaml` manifest, the
`cozygateway/` Python package, and its README) was authored by the plan designer against
the harness's real plugin API and is committed together with this plan. This task is the
verification gate over that code, not a transcription task.

**Files:**
- Verify (already present): `integrations/attach-plugin/plugin.yaml`, `integrations/attach-plugin/README.md`, `integrations/attach-plugin/cozygateway/{__init__,adapter,attach_client,text_blocks,tool_chips}.py`

**Interfaces:**
- Consumes: the attach v0 protocol exactly as specified in `contract/attach-v0.md` (Task 1).
- Produces: nothing other tasks depend on; the plugin is exercised live in Task 6.

- [ ] **Step 1: Compile gate**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway && python3 -m py_compile integrations/attach-plugin/cozygateway/*.py && echo OK`
Expected: `OK`, no output before it. Remove any `__pycache__` directories afterwards (`find integrations/attach-plugin -name __pycache__ -type d -exec rm -rf {} +`); they must never be committed.

- [ ] **Step 2: Copy-hygiene gate**

Grep the plugin directory for the private names listed in the internal execution ledger (the task brief carries the exact pattern; it is deliberately not reproduced in this public document). Expected: the ONLY matches are the two interop session-context constants in `adapter.py`, each commented "harness-defined identifier"; nothing in prose. Also verify no em-dash characters (U+2014): `grep -rn $'\u2014' integrations/attach-plugin/ contract/attach-v0.md README.md docs/plans/` must produce no matches.

- [ ] **Step 3: Protocol-fidelity spot check against contract/attach-v0.md**

Read `attach_client.py` and confirm, against the spec: frames are `{"threadId", "update"}` with update kinds exactly `draft`/`done`/`failed`; drafts are full-replace and omit `toolCalls` when empty; the bearer token rides only the `Authorization` header; close code 4000 and HTTP 401 are terminal (no reconnect), other closes reconnect with capped backoff. Report any mismatch as a finding; do not silently edit.

- [ ] **Step 4: Verify the full repo gate still passes**

Run: `cd /Users/kmcdowell/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm check`
Expected: green (the plugin adds no Node surface; this confirms nothing else regressed).

- [ ] **Step 5: Commit (only if Steps 1 to 4 required fixes; otherwise report clean)**

```bash
cd /Users/kmcdowell/Documents/repos/cozygateway && git add integrations/attach-plugin && git commit -m "chore: attach plugin hygiene fixes"
```

Known follow-ups recorded for the final review (do NOT act on them in this task):
- The harness's tool hooks DO carry a stable `tool_call_id`; v0 deliberately synthesizes `name#n` chip ids instead (tool calls run sequentially in the studied harness). Adopting the real id is a candidate v0.1 improvement.
- The plugin's `_seen_turns` dedup set is unbounded by design for a reference implementation.
- Two live-validation checkpoints from the design notes: the injected message event must clear the harness per-message authorization gate (fallback: the synthetic-event flag), and the harness session context must reach the tool worker thread for chip routing.

---

### Task 6: Live validation (manual, run by the orchestrator, not a subagent)

Not a CI step. Performed locally against a real harness install with a throwaway profile; no
credentials or machine-specific values are committed anywhere in this repo.

- [ ] **Step 1: Start the gateway with one attach agent**

Config (temp dir, not committed): one agent `{ "id": "helper", "name": "Helper", "backend": "attach", "options": { "tokenEnv": "ATTACH_TOKEN_HELPER" } }`. Export a freshly generated token, run `serve`, confirm `GET /agents` reports the agent `absent`.

- [ ] **Step 2: Attach a real harness**

Install `integrations/attach-plugin` into a THROWAWAY harness profile (never a live one) pointed at a local model endpoint. Set the plugin's two environment variables to the gateway URL and the same token. Confirm the gateway logs presence online and `GET /agents` agrees.

- [ ] **Step 3: Drive live turns**

Pair a device, create a thread, send messages. Verify: drafts stream and full-replace, tool chips appear when the model uses a tool, the final reply commits with matching blocks, `done` follows, and a second turn in the same thread shows the harness kept conversation memory (ask a follow-up that needs the earlier context).

- [ ] **Step 4: Exercise the failure paths live**

Kill the harness mid-turn (expect `turn.failed` plus presence absent), restart it (expect presence online and a working next turn), and send while detached (expect the fast `turn.failed`).

- [ ] **Step 5: Write up findings**

Record results, latencies, and any protocol drift discovered in the execution ledger. Spec drift gets REPORTED, never papered over.

---

## Execution notes

- One branch for the whole plan: `feat/attach-adapter`. Merge to main locally with `--no-ff` only after the final whole-branch review passes; push only when the full gate is green.
- Task order is 1 through 5 (subagent-driven, fresh implementer per task, reviewer between tasks), then Task 6 by the orchestrator.
- The conformance suite must remain 21/21 against the mock backend after every task; the client contract v1 is untouched by design.

## Self-review checklist (after writing, before executing)

- Spec coverage: design-spec section 6 ingress shape (drafts, tool projection, commit on done): Tasks 1 to 4. Reference plugin: Task 5. Live validation: Task 6. Presence: Tasks 2 and 4. Documented protocol: Task 1.
- No placeholders: every step carries complete code or exact copy.
- Type consistency: `TurnEndpoint`, `AttachAdapter`, `AttachWiring`, `AttachEvents`, and the schema names are used identically across Tasks 1 to 4.



# OpenClaw Tool Chips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `toolCalls` on openclaw-thread drafts by mapping the live-pinned OpenClaw `agent` item-stream tool frames to cozygateway tool chips (issue #13).

**Architecture:** The wire client accumulates a per-session chip snapshot behind the existing per-session privacy gate (mirroring how it already owns text accumulation), and the adapter passes the latest snapshot into the existing draft flush. Contract v1 is untouched: chips are draft-only.

**Tech Stack:** TypeScript (pure ESM `.ts` imports, erasableSyntaxOnly), TypeBox schemas, vitest, pnpm workspace.

**Spec:** `docs/specs/2026-07-09-openclaw-tool-chips-design.md` (approved). Read it before starting; the wire fixtures below are copied from its live captures.

## Global Constraints

- Branch: `feat/13-openclaw-tool-chips` (already exists; spec commit `3a1bcf8` is on it).
- Every pnpm command needs `PATH=/opt/homebrew/opt/node@26/bin:$PATH`. Shell cwd resets between bash calls: `cd ~/Documents/repos/cozygateway` (or use absolute paths) each time.
- Commit with `--no-verify` (pre-push hook has a noreply false-positive).
- NO em-dashes anywhere (code, comments, docs, commit messages).
- Contract v1 is FROZEN: do not touch `packages/contract` or `packages/conformance`. Conformance must stay 21/21.
- The operator token is ROOT on the target gateway. Never log, throw, or echo wire content: no tool names, ids, titles, or session keys in any log line.
- The newly pinned wire fact (tool frames = `agent` + `stream:"item"` + `data.kind:"tool"`) lives behind ONE named site (`toolItemOf` in protocol.ts) with a comment citing the live capture (openclaw@2026.6.11, 2026-07-09).
- Full gate before any ship claim: `pnpm check` (build + typecheck + gateway/conformance/contract/relay suites).

---

### Task 1: protocol.ts: parse `agent` events and narrow tool items

**Files:**
- Modify: `packages/gateway/src/adapters/openclaw/protocol.ts`
- Test: `packages/gateway/test/openclaw-protocol.test.ts`

**Interfaces:**
- Consumes: existing `parseServerFrame`, `ServerFrame`, TypeBox `check` from `cozygateway-contract`.
- Produces (Task 2 relies on these exact names):
  - `AgentEventSchema` / `type AgentEvent` (exported)
  - `ServerFrame` union gains `(AgentEvent & { kind: "agent" })`
  - `interface AgentToolItem { toolCallId: string; name: string; phase: "start" | "end"; failed: boolean }` (exported)
  - `function toolItemOf(event: AgentEvent): AgentToolItem | undefined` (exported)

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/test/openclaw-protocol.test.ts` (add `AgentEventSchema`, `toolItemOf` to the existing import from `../src/adapters/openclaw/protocol.ts`). The first fixture is the live capture verbatim, minus fields elided for length:

```ts
/** Live-captured tool item frames (openclaw@2026.6.11, 2026-07-09; see
 *  docs/specs/2026-07-09-openclaw-tool-chips-design.md). */
function agentToolFrame(data: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId: "cabc10f1-b12f-486b-8a3d-dc8d70480b86",
      sessionKey: "agent:main:dashboard:b8400f2f",
      stream: "item",
      data,
      seq: 3,
      ts: 1783629483751,
      isHeartbeat: false,
    },
    seq: 4,
  };
}

const TOOL_START = {
  itemId: "tool:790639779",
  phase: "start",
  kind: "tool",
  title: "read from magic-number.txt",
  status: "running",
  name: "read",
  meta: "from magic-number.txt",
  toolCallId: "790639779",
  startedAt: 1783629483750,
};

const TOOL_END_OK = { ...TOOL_START, phase: "end", status: "completed", endedAt: 1783629483774 };

const TOOL_END_FAILED = {
  ...TOOL_START,
  phase: "end",
  status: "failed",
  error: "ENOENT: no such file or directory, access '/workspace/totally-missing-xyz.txt'",
  endedAt: 1783629574578,
};

describe("parseServerFrame: agent events", () => {
  it("parses a live-captured agent item frame as kind agent", () => {
    const frame = parseServerFrame(agentToolFrame(TOOL_START));
    expect(frame?.kind).toBe("agent");
    if (frame?.kind === "agent") {
      expect(frame.payload.sessionKey).toBe("agent:main:dashboard:b8400f2f");
      expect(frame.payload.stream).toBe("item");
    }
  });

  it("parses an agent lifecycle frame (no data requirements beyond the envelope)", () => {
    const frame = parseServerFrame({
      type: "event",
      event: "agent",
      payload: { sessionKey: "s1", stream: "lifecycle", data: { phase: "start" } },
    });
    expect(frame?.kind).toBe("agent");
  });

  it("rejects an agent frame with no sessionKey (falls through to unrecognized)", () => {
    const frame = parseServerFrame({
      type: "event",
      event: "agent",
      payload: { stream: "item", data: TOOL_START },
    });
    expect(frame).toBeUndefined();
  });
});

describe("toolItemOf", () => {
  function agentEvent(payload: Record<string, unknown>) {
    const frame = parseServerFrame({ type: "event", event: "agent", payload });
    if (frame?.kind !== "agent") throw new Error("fixture did not parse as agent");
    return frame;
  }

  it("narrows a live-captured start frame: running phase, not failed", () => {
    const item = toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data: TOOL_START }));
    expect(item).toEqual({ toolCallId: "790639779", name: "read", phase: "start", failed: false });
  });

  it("narrows a completed end frame as not failed", () => {
    const item = toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data: TOOL_END_OK }));
    expect(item).toEqual({ toolCallId: "790639779", name: "read", phase: "end", failed: false });
  });

  it("narrows a failed end frame as failed (status failed)", () => {
    const item = toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data: TOOL_END_FAILED }));
    expect(item?.failed).toBe(true);
  });

  it("treats an error field as failure even without status failed", () => {
    const data = { ...TOOL_END_OK, status: "completed", error: "boom" };
    const item = toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data }));
    expect(item?.failed).toBe(true);
  });

  it("maps an unknown end status without an error field to not-failed", () => {
    const data = { ...TOOL_END_OK, status: "some-future-status" };
    const item = toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data }));
    expect(item).toEqual({ toolCallId: "790639779", name: "read", phase: "end", failed: false });
  });

  it("falls back to itemId when toolCallId is missing, and yields undefined when both are missing", () => {
    const noToolCallId: Record<string, unknown> = { ...TOOL_START };
    delete noToolCallId["toolCallId"];
    const viaItemId = toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data: noToolCallId }));
    expect(viaItemId?.toolCallId).toBe("tool:790639779");

    const noIds: Record<string, unknown> = { ...noToolCallId };
    delete noIds["itemId"];
    expect(toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data: noIds }))).toBeUndefined();
  });

  it("falls back to a generic name when name is missing", () => {
    const noName: Record<string, unknown> = { ...TOOL_START };
    delete noName["name"];
    const item = toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data: noName }));
    expect(item?.name).toBe("tool");
  });

  it("yields undefined for non-item streams, non-tool kinds, unknown phases, and missing data", () => {
    expect(toolItemOf(agentEvent({ sessionKey: "s1", stream: "assistant", data: { ...TOOL_START } }))).toBeUndefined();
    expect(toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data: { ...TOOL_START, kind: "message" } }))).toBeUndefined();
    expect(toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data: { ...TOOL_START, phase: "middle" } }))).toBeUndefined();
    expect(toolItemOf(agentEvent({ sessionKey: "s1", stream: "item" }))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway test -- openclaw-protocol`
Expected: FAIL (AgentEventSchema / toolItemOf not exported).

- [ ] **Step 3: Implement in protocol.ts**

Add after `TickEventSchema` (keep the file's comment style):

```ts
/** Agent progress event. The envelope (sessionKey + stream) is required; `data` stays an open
 *  record because only tool items are ever read, via `toolItemOf` below. PINNED by live capture
 *  (openclaw@2026.6.11, 2026-07-09, docs/specs/2026-07-09-openclaw-tool-chips-design.md):
 *  `sessionKey` rides every agent event, and streams observed are `lifecycle`, `assistant`,
 *  `item`, and `compaction`. */
export const AgentEventSchema = Type.Object({
  type: Type.Literal("event"),
  event: Type.Literal("agent"),
  payload: Type.Object({
    sessionKey: Type.String(),
    stream: Type.String(),
    data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
  seq: Type.Optional(Type.Number()),
  stateVersion: Type.Optional(Type.Number()),
});
export type AgentEvent = Static<typeof AgentEventSchema>;

/** One OpenClaw tool call lifecycle edge, narrowed from an agent item frame. */
export interface AgentToolItem {
  toolCallId: string;
  name: string;
  phase: "start" | "end";
  failed: boolean;
}

/** THE one named site owning the tool-frame wire fact. PINNED by live capture (openclaw@2026.6.11,
 *  2026-07-09): tool activity rides `event:"agent"` with `stream:"item"` and `data.kind:"tool"`,
 *  as a start/end pair keyed by `data.toolCallId`; a failed call ends with `status:"failed"` and
 *  an `error` string. The protocol docs' `stream:"tool"` and `session.tool` were NEVER observed
 *  live and are deliberately not parsed. `title`/`meta`/`error` carry argument-derived content
 *  (file names, host paths) and are never surfaced by this narrowing. */
export function toolItemOf(event: AgentEvent): AgentToolItem | undefined {
  if (event.payload.stream !== "item") return undefined;
  const data = event.payload.data;
  if (data === undefined || data["kind"] !== "tool") return undefined;
  const phase = data["phase"];
  if (phase !== "start" && phase !== "end") return undefined;
  const toolCallId =
    typeof data["toolCallId"] === "string" && data["toolCallId"].length > 0
      ? data["toolCallId"]
      : typeof data["itemId"] === "string" && data["itemId"].length > 0
        ? data["itemId"]
        : undefined;
  if (toolCallId === undefined) return undefined;
  const name = typeof data["name"] === "string" && data["name"].length > 0 ? data["name"] : "tool";
  const failed = data["status"] === "failed" || data["error"] !== undefined;
  return { toolCallId, name, phase, failed };
}
```

Extend the `ServerFrame` union and `parseServerFrame`'s event branch:

```ts
export type ServerFrame =
  | (HelloOkResponse & { kind: "hello-ok" })
  | (ConnectChallengeEvent & { kind: "challenge" })
  | (ResponseFrame & { kind: "response" })
  | (ChatEvent & { kind: "chat" })
  | (AgentEvent & { kind: "agent" })
  | (TickEvent & { kind: "tick" });
```

In `parseServerFrame`, inside the `type === "event"` branch, after the chat check:

```ts
    if (check(ChatEventSchema, raw)) return { ...raw, kind: "chat" };
    if (check(AgentEventSchema, raw)) return { ...raw, kind: "agent" };
    return undefined;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway test -- openclaw-protocol`
Expected: PASS (all new and existing protocol tests).

Note: the client switch in `client.ts` does not yet have a `case "agent"`; with `noFallthroughCasesInSwitch`-style exhaustiveness this compiles fine (the switch has no default and simply falls through for the new kind), but run the typecheck to be sure: `PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway typecheck` (if the switch is exhaustiveness-checked and errors, add `case "agent": return;` as a stub; Task 2 replaces it).

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/repos/cozygateway && git add packages/gateway/src/adapters/openclaw/protocol.ts packages/gateway/test/openclaw-protocol.test.ts && git commit --no-verify -m "feat(openclaw): parse agent events and narrow tool items (issue #13, task 1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: client.ts: fold tool items into per-session chip snapshots

**Files:**
- Modify: `packages/gateway/src/adapters/openclaw/client.ts`
- Modify: `packages/gateway/scripts/openclaw-canary.mjs` (add the now-required no-op handler so the interface change does not break it)
- Test: `packages/gateway/test/openclaw-client.test.ts`

**Interfaces:**
- Consumes (from Task 1): `toolItemOf(event: AgentEvent): AgentToolItem | undefined`, `ServerFrame` `kind:"agent"`.
- Produces (Task 3 relies on these exact names):
  - `export interface SessionToolCall { id: string; name: string; status: "running" | "ok" | "error" }`
  - `SessionHandlers` gains required `onToolCalls(toolCalls: SessionToolCall[]): void`

- [ ] **Step 1: Update every existing `SessionHandlers` literal in the client test file**

`packages/gateway/test/openclaw-client.test.ts` has 8 object literals of the shape `{ onDelta: ..., onDone: ..., onError: ... }` (grep `onDelta:`). Add `onToolCalls: () => {},` to each. Example:

```ts
c.subscribeSession("session-a", { onDelta: (s) => aDeltas.push(s), onDone: () => {}, onError: () => {}, onToolCalls: () => {} });
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/gateway/test/openclaw-client.test.ts` (import `SessionToolCall` from the client module in the existing type import):

```ts
/** Agent tool item frame in the live-pinned wire shape (see protocol tests / the design spec). */
function toolFrame(input: {
  sessionKey: string;
  toolCallId: string;
  name?: string;
  phase: "start" | "end";
  failed?: boolean;
}): Record<string, unknown> {
  return {
    type: "event",
    event: "agent",
    payload: {
      sessionKey: input.sessionKey,
      stream: "item",
      data: {
        itemId: `tool:${input.toolCallId}`,
        kind: "tool",
        phase: input.phase,
        toolCallId: input.toolCallId,
        name: input.name ?? "read",
        status: input.phase === "start" ? "running" : input.failed ? "failed" : "completed",
        ...(input.failed ? { error: "ENOENT: secret-path" } : {}),
      },
    },
  };
}

describe("subscribeSession: tool call snapshots", () => {
  it("folds start/end pairs into running -> ok chips, and failed ends into error chips", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const snapshots: SessionToolCall[][] = [];
    c.subscribeSession("s1", {
      onDelta: () => {},
      onDone: () => {},
      onError: () => {},
      onToolCalls: (calls) => snapshots.push(calls),
    });

    server.sendEvent(toolFrame({ sessionKey: "s1", toolCallId: "t1", phase: "start" }));
    server.sendEvent(toolFrame({ sessionKey: "s1", toolCallId: "t1", phase: "end" }));
    server.sendEvent(toolFrame({ sessionKey: "s1", toolCallId: "t2", name: "exec", phase: "start" }));
    server.sendEvent(toolFrame({ sessionKey: "s1", toolCallId: "t2", phase: "end", failed: true }));

    await until(() => snapshots.length >= 4);
    expect(snapshots[0]).toEqual([{ id: "t1", name: "read", status: "running" }]);
    expect(snapshots[1]).toEqual([{ id: "t1", name: "read", status: "ok" }]);
    expect(snapshots[2]).toEqual([
      { id: "t1", name: "read", status: "ok" },
      { id: "t2", name: "exec", status: "running" },
    ]);
    expect(snapshots[3]).toEqual([
      { id: "t1", name: "read", status: "ok" },
      { id: "t2", name: "exec", status: "error" },
    ]);
  });

  it("keeps insertion order stable and each snapshot a fresh array", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const snapshots: SessionToolCall[][] = [];
    c.subscribeSession("s1", {
      onDelta: () => {},
      onDone: () => {},
      onError: () => {},
      onToolCalls: (calls) => snapshots.push(calls),
    });

    server.sendEvent(toolFrame({ sessionKey: "s1", toolCallId: "a", phase: "start" }));
    server.sendEvent(toolFrame({ sessionKey: "s1", toolCallId: "b", phase: "start" }));
    server.sendEvent(toolFrame({ sessionKey: "s1", toolCallId: "a", phase: "end" }));

    await until(() => snapshots.length >= 3);
    // "a" keeps its first-seen position after its end frame overwrites its status.
    expect(snapshots[2].map((call) => call.id)).toEqual(["a", "b"]);
    // Fresh array per callback: mutating an earlier snapshot cannot corrupt a later one.
    expect(snapshots[0]).not.toBe(snapshots[1]);
    expect(snapshots[0]).toEqual([{ id: "a", name: "read", status: "running" }]);
  });

  it("drops tool frames for unsubscribed sessions silently, with no content in any log line", async () => {
    const logged: string[] = [];
    const server = await fakeServer();
    const c = client(server.url, { logSink: (line) => logged.push(line) });
    c.start();
    await until(() => c.state() === "online");

    const snapshots: SessionToolCall[][] = [];
    c.subscribeSession("mine", {
      onDelta: () => {},
      onDone: () => {},
      onError: () => {},
      onToolCalls: (calls) => snapshots.push(calls),
    });

    server.sendEvent(toolFrame({ sessionKey: "theirs", toolCallId: "foreign-tool", phase: "start" }));
    server.sendEvent(toolFrame({ sessionKey: "mine", toolCallId: "t1", phase: "start" }));

    await until(() => snapshots.length >= 1);
    expect(snapshots[0]).toEqual([{ id: "t1", name: "read", status: "running" }]);
    // The foreign frame's content must appear nowhere in the log (silent drop; the chat drop
    // line already flags foreign traffic, and agent frames are several-per-turn noise).
    const allLogs = logged.join("\n");
    expect(allLogs).not.toContain("foreign-tool");
    expect(allLogs).not.toContain("theirs");
  });

  it("ignores tool frames after the reply ended and non-tool agent streams entirely", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const snapshots: SessionToolCall[][] = [];
    let done = false;
    c.subscribeSession("s1", {
      onDelta: () => {},
      onDone: () => {
        done = true;
      },
      onError: () => {},
      onToolCalls: (calls) => snapshots.push(calls),
    });

    server.sendEvent({
      type: "event",
      event: "agent",
      payload: { sessionKey: "s1", stream: "lifecycle", data: { phase: "start" } },
    });
    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: "hi", done: true }));
    await until(() => done);
    server.sendEvent(toolFrame({ sessionKey: "s1", toolCallId: "late", phase: "start" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(snapshots).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ~/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway test -- openclaw-client`
Expected: FAIL (compile error: `onToolCalls` not in `SessionHandlers` / `SessionToolCall` not exported).

- [ ] **Step 4: Implement in client.ts**

Add the neutral chip type and extend `SessionHandlers` (keep the interface's doc style):

```ts
/** One tool call's chip-shaped state for a subscribed session. Deliberately a LOCAL type,
 *  not the cozygateway contract's ToolCall: the wire client stays contract-free; the adapter
 *  maps this 1:1 (and never sets a detail). Statuses fold from the live-pinned wire facts:
 *  phase start -> running; phase end -> error when failed, else ok. */
export interface SessionToolCall {
  id: string;
  name: string;
  status: "running" | "ok" | "error";
}

export interface SessionHandlers {
  onDelta(snapshot: string): void;
  onDone(): void;
  onError(message: string): void;
  /** Fires with the session's FULL chip snapshot (fresh array, first-seen order) each time a
   *  subscribed session's tool call starts or ends. Same privacy gate as onDelta: frames for
   *  unsubscribed sessions are dropped before any content is read. */
  onToolCalls(toolCalls: SessionToolCall[]): void;
}
```

Import `toolItemOf` (add to the existing protocol import). Extend the subscription state and `subscribeSession`:

```ts
  interface SessionSubscriptionState {
    handlers: SessionHandlers;
    snapshot: string;
    done: boolean;
    toolCalls: Map<string, SessionToolCall>;
  }
```

```ts
    subscribeSession(sessionKey: string, handlers: SessionHandlers): () => void {
      sessionSubscriptions.set(sessionKey, { handlers, snapshot: "", done: false, toolCalls: new Map() });
      return () => {
        sessionSubscriptions.delete(sessionKey);
      };
    },
```

Add the `case "agent"` to `handleMessage`'s switch (after the `"chat"` case):

```ts
      case "agent": {
        // Same gate as "chat", same reason (openclaw#32579 broadcast bug + cross-operator
        // privacy: this connection's root token can observe other operators' traffic): look up
        // the subscription BEFORE reading anything beyond the envelope. Unlike the chat drop,
        // this one is silent: agent frames arrive several per turn (lifecycle, assistant echo,
        // compaction) and the chat drop line already flags foreign traffic.
        const sub = sessionSubscriptions.get(frame.payload.sessionKey);
        if (sub === undefined) return;
        if (sub.done) return; // reply already ended; ignore trailing tool frames.
        const item = toolItemOf(frame);
        if (item === undefined) return; // non-tool stream or unusable item: not our concern.
        const status = item.phase === "start" ? "running" : item.failed ? "error" : "ok";
        sub.toolCalls.set(item.toolCallId, { id: item.toolCallId, name: item.name, status });
        // Fresh array per delivery so a caller can hold a snapshot without later folds mutating it.
        sub.handlers.onToolCalls([...sub.toolCalls.values()]);
        return;
      }
```

- [ ] **Step 5: Add the no-op handler to the canary**

In `packages/gateway/scripts/openclaw-canary.mjs`, the `client.subscribeSession(sessionKey, {...})` literal gains:

```js
    onToolCalls: () => {},
```

(Task 4 replaces this with real chip recording; this step just keeps the canary compiling/running.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ~/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway test -- openclaw-client`
Expected: PASS (all new and existing client tests).

- [ ] **Step 7: Commit**

```bash
cd ~/Documents/repos/cozygateway && git add packages/gateway/src/adapters/openclaw/client.ts packages/gateway/test/openclaw-client.test.ts packages/gateway/scripts/openclaw-canary.mjs && git commit --no-verify -m "feat(openclaw): fold tool items into per-session chip snapshots (issue #13, task 2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: adapter.ts: chips ride the draft flush

**Files:**
- Modify: `packages/gateway/src/adapters/openclaw/adapter.ts`
- Test: `packages/gateway/test/openclaw-adapter.test.ts`

**Interfaces:**
- Consumes (from Task 2): `SessionHandlers.onToolCalls(toolCalls: SessionToolCall[])`, `SessionToolCall`.
- Produces: openclaw drafts carry live `toolCalls` (contract `ToolCall[]`, `detail` never set); commits unchanged (blocks only).

- [ ] **Step 1: Extend the fake client in the adapter test file**

`FakeOpenClawClient` in `packages/gateway/test/openclaw-adapter.test.ts` gains a driver mirroring the real client's delivery (next to `emitDelta`/`emitDone`/`emitError`; import `SessionToolCall` from the client module):

```ts
  emitToolCalls(sessionKey: string, toolCalls: SessionToolCall[]): void {
    this.subscriptions.get(sessionKey)?.onToolCalls(toolCalls);
  }
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/gateway/test/openclaw-adapter.test.ts`:

```ts
describe("tool chips on drafts", () => {
  it("drafts carry the latest chip snapshot, a chip-only transition still flushes, and the commit carries none", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeOpenClawClient();
      const adapter = createOpenClawAdapter({ agentId: "a1", client, turnTimeoutMs: 60_000 });
      const session = await adapter.startSession("thread-1");
      const { handlers, observed } = observer();

      const turn = session.send([{ type: "paragraph", text: "go" }], handlers);
      const sessionKey = client.sessionKeys[0];

      client.emitDelta(sessionKey, "working");
      client.emitToolCalls(sessionKey, [{ id: "t1", name: "read", status: "running" }]);
      await vi.advanceTimersByTimeAsync(150);
      expect(observed.drafts).toHaveLength(1);
      expect(observed.drafts[0].toolCalls).toEqual([{ id: "t1", name: "read", status: "running" }]);

      // Chip-only transition, no new text: must still produce a fresh draft.
      client.emitToolCalls(sessionKey, [{ id: "t1", name: "read", status: "ok" }]);
      await vi.advanceTimersByTimeAsync(150);
      expect(observed.drafts).toHaveLength(2);
      expect(observed.drafts[1].toolCalls).toEqual([{ id: "t1", name: "read", status: "ok" }]);

      // Text-only repeat of the same chips: dedupe still applies to unchanged text+chips.
      await vi.advanceTimersByTimeAsync(300);
      expect(observed.drafts).toHaveLength(2);

      client.emitDelta(sessionKey, "working done");
      client.emitDone(sessionKey);
      await turn;
      // The pre-commit flush carries the final text and the final chip states.
      const last = observed.drafts[observed.drafts.length - 1];
      expect(last.toolCalls).toEqual([{ id: "t1", name: "read", status: "ok" }]);
      // Commit is blocks-only (contract: chips are draft-scoped and die at commit).
      expect(observed.commits).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores tool snapshots after the turn settled", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeOpenClawClient();
      const adapter = createOpenClawAdapter({ agentId: "a1", client, turnTimeoutMs: 60_000 });
      const session = await adapter.startSession("thread-1");
      const { handlers, observed } = observer();

      const turn = session.send([{ type: "paragraph", text: "go" }], handlers);
      const sessionKey = client.sessionKeys[0];
      client.emitDelta(sessionKey, "hi");
      client.emitDone(sessionKey);
      await turn;

      const draftsAfterCommit = observed.drafts.length;
      client.emitToolCalls(sessionKey, [{ id: "late", name: "read", status: "running" }]);
      await vi.advanceTimersByTimeAsync(300);
      expect(observed.drafts).toHaveLength(draftsAfterCommit);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

Note: the real client also stops delivering after its own `done` guard and the adapter unsubscribes at settle; the second test pins the adapter's own `settled` guard independently.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ~/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway test -- openclaw-adapter`
Expected: FAIL (compile: subscription literal in adapter.ts lacks `onToolCalls`; then behavioral: drafts carry `[]`).

- [ ] **Step 4: Implement in adapter.ts**

Import the contract chip type and the client chip type:

```ts
import type { PresenceState, RichBlock, ToolCall } from "cozygateway-contract";
```

Inside `send`'s promise executor, extend the turn state and flush dedupe (replacing the existing `lastFlushedSnapshot` block):

```ts
            let settled = false;
            let snapshot = "";
            let toolCalls: ToolCall[] = [];
            let lastFlushedSnapshot: string | undefined;
            let lastFlushedToolCallsKey: string | undefined;
            let flushTimer: ReturnType<typeof setTimeout> | undefined;
```

```ts
            const flushDraft = (): void => {
              clearFlushTimer();
              // Dedupe on text AND chips: a chip-only transition (running -> ok with no new
              // text) must still emit a draft, and an unchanged text+chips pair must not.
              const toolCallsKey = JSON.stringify(toolCalls);
              if (snapshot === lastFlushedSnapshot && toolCallsKey === lastFlushedToolCallsKey) return;
              lastFlushedSnapshot = snapshot;
              lastFlushedToolCallsKey = toolCallsKey;
              handlers.onDraft({ blocks: normalizeMarkdownToBlocks(snapshot), toolCalls });
            };
```

Extend the subscription handlers (the `deps.client.subscribeSession(sessionKey, {...})` literal):

```ts
              onToolCalls: (calls) => {
                if (settled) return;
                // 1:1 map from the client's neutral chip shape to the contract ToolCall; the
                // detail field is DELIBERATELY never set (the wire's title/meta/error strings
                // carry argument-derived content from a root-token wire; see the design spec).
                toolCalls = calls.map((call) => ({ id: call.id, name: call.name, status: call.status }));
                scheduleFlush();
              },
```

Also update the file's header comment for `DEFAULT_DRAFT_FLUSH_MS` if it says drafts are text-only, and the module doc if it mentions `toolCalls: []`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway test -- openclaw-adapter`
Expected: PASS. Note the pre-existing test asserting `toolCalls` always empty ("streams throttled drafts then commits, with toolCalls always empty...") still passes because that test never emits tool calls; update its name and inline comment to say drafts carry the CURRENT chip snapshot (empty when no tools ran) rather than "always empty".

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/repos/cozygateway && git add packages/gateway/src/adapters/openclaw/adapter.ts packages/gateway/test/openclaw-adapter.test.ts && git commit --no-verify -m "feat(openclaw): tool chips ride the draft flush (issue #13, task 3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: integration test, canary tool mode, wire-study addendum

**Files:**
- Modify: `packages/gateway/test/openclaw-integration.test.ts`
- Modify: `packages/gateway/scripts/openclaw-canary.mjs`
- Modify: `docs/specs/2026-07-08-openclaw-wire-study.md`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: an end-to-end fixture proving agent frames from a (fake) server surface as chips in adapter drafts; a canary mode that proves the same against a REAL gateway (used by Task 5).

- [ ] **Step 1: Write the integration test**

Append to the existing `describe` block in `packages/gateway/test/openclaw-integration.test.ts`. It reuses the file's own helpers exactly as they exist today: `startFakeOpenClawServer` + `servers`/`clients` cleanup arrays, `until`, `deltaFrame`, and `observer()` (whose `drafts` entries already record `toolCalls`):

```ts
  it("surfaces tool chips end-to-end: wire agent frames -> client fold -> adapter drafts", async () => {
    const server = await startFakeOpenClawServer();
    servers.push(server);

    const client = createOpenClawClient({
      url: server.url,
      token: "SECRET-INTEGRATION-TOKEN",
      identity: generateDeviceIdentity(),
      reconnect: { minMs: 15, maxMs: 80 },
    });
    clients.push(client);
    client.start();
    await until(() => client.state() === "online");

    const adapter = createOpenClawAdapter({
      agentId: "integration-agent",
      client,
      turnTimeoutMs: 5_000,
      draftFlushMs: 20,
    });
    const session = await adapter.startSession("thread-1");
    const sessionKey = server.sessionKeys()[0]!;

    const { handlers, observed } = observer();
    const turn = session.send([{ type: "paragraph", text: "use a tool" }], handlers);

    function toolItemFrame(phase: "start" | "end"): Record<string, unknown> {
      return {
        type: "event",
        event: "agent",
        payload: {
          sessionKey,
          stream: "item",
          data: {
            itemId: "tool:1",
            kind: "tool",
            phase,
            toolCallId: "1",
            name: "read",
            status: phase === "start" ? "running" : "completed",
          },
        },
      };
    }

    server.sendEvent(toolItemFrame("start"));
    // Space past draftFlushMs (20) so the running-status draft actually flushes before the end
    // frame overwrites the chip (same trailing-timer reasoning as the full-turn test above).
    await new Promise((resolve) => setTimeout(resolve, 30));
    server.sendEvent(toolItemFrame("end"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    server.sendEvent(deltaFrame({ sessionKey, deltaText: "The answer.", done: true }));
    await turn;

    const chipDrafts = observed.drafts.filter((d) => d.toolCalls.length > 0);
    expect(chipDrafts.length).toBeGreaterThanOrEqual(2);
    expect(chipDrafts[0]!.toolCalls).toEqual([{ id: "1", name: "read", status: "running" }]);
    expect(chipDrafts.at(-1)!.toolCalls).toEqual([{ id: "1", name: "read", status: "ok" }]);
    expect(observed.commits).toHaveLength(1);
    expect(observed.done).toBe(1);
  });
```

- [ ] **Step 2: Run it, verify it passes as a regression net**

Run: `cd ~/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway test -- openclaw-integration`
Expected: PASS immediately if Tasks 1-3 are correct (this is an integration regression net, not a red-green cycle). If it fails, fix the wiring, not the test.

- [ ] **Step 3: Canary tool mode**

In `packages/gateway/scripts/openclaw-canary.mjs`, record chips and add an env-gated assertion. Replace the Task 2 no-op with recording, and assert after the reply completes:

```js
  const toolSnapshots = [];
  client.subscribeSession(sessionKey, {
    onDelta: (snapshot) => {
      text = snapshot;
    },
    onDone: () => {
      done = true;
    },
    onError: (message) => {
      errored = message;
    },
    onToolCalls: (toolCalls) => {
      toolSnapshots.push(toolCalls);
    },
  });
```

The message becomes overridable and the assertion opt-in (document both in the header comment block, alongside the existing env vars):

```js
const message =
  process.env.OPENCLAW_CANARY_MESSAGE ?? "Reply with exactly the word PONG and nothing else.";
const expectTool = process.env.OPENCLAW_CANARY_EXPECT_TOOL === "1";
```

```js
  if (expectTool) {
    const sawRunning = toolSnapshots.some((calls) => calls.some((c) => c.status === "running"));
    const lastSnapshot = toolSnapshots[toolSnapshots.length - 1] ?? [];
    const terminal = lastSnapshot.filter((c) => c.status === "ok" || c.status === "error");
    if (!sawRunning || terminal.length === 0) {
      fail(`expected a tool chip to reach a terminal status (snapshots: ${toolSnapshots.length})`);
    }
    console.log(`OK: tool chips observed (${toolSnapshots.length} snapshots, ${terminal.length} terminal).`);
  }
```

(`chat.send` uses `message` instead of the hardcoded string. Chip names/ids are wire content: the failure line above prints only counts, never names.)

- [ ] **Step 4: Wire-study addendum**

Append to `docs/specs/2026-07-08-openclaw-wire-study.md` (after the Follow-up section; no em-dashes):

```markdown
## Addendum (2026-07-09): tool events as actually observed

The tool-chips live study (docs/specs/2026-07-09-openclaw-tool-chips-design.md) corrected
section (e)'s hypothesis. Across real tool-using turns against the same gateway version:

- Tool activity rides `event:"agent"` with `stream:"item"` and `data.kind:"tool"`, as a
  start/end pair keyed by `data.toolCallId` (`phase:"start"` with `status:"running"`, then
  `phase:"end"` with `status:"completed"`, or `status:"failed"` plus an `error` string).
- `stream:"tool"` was never observed. `session.tool` remains advertised in
  `hello-ok.features.events` but never fired; neither is parsed by the adapter.
- The item's `title`, `meta`, and `error` strings carry argument-derived content (file names,
  full host paths) and are never forwarded to chips.
```

- [ ] **Step 5: Run the full gateway suite**

Run: `cd ~/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm --filter cozygateway test`
Expected: PASS (206+ tests; new integration test included).

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/repos/cozygateway && git add packages/gateway/test/openclaw-integration.test.ts packages/gateway/scripts/openclaw-canary.mjs docs/specs/2026-07-08-openclaw-wire-study.md && git commit --no-verify -m "test(openclaw): chip integration net, canary tool mode, wire-study addendum (issue #13, task 4)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: full gate + live verification against a real gateway

**Files:**
- No source changes expected (fixes only if the gate or live run finds a defect).

**Interfaces:**
- Consumes: the canary tool mode from Task 4.
- Produces: the evidence required before any ship claim.

- [ ] **Step 1: Full gate**

Run: `cd ~/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH pnpm check`
Expected: build + typecheck of all 4 packages green; gateway, conformance (21/21), contract, and relay suites all PASS. Conformance count must be exactly 21/21 (contract untouched).

- [ ] **Step 2: Live verify (success chip)**

A study gateway from the design session may still be running on `ws://127.0.0.1:18789` (token `study-operator-token-7431`, workspace containing `magic-number.txt`). Check: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18789` returns a code (any response means it is up). If it is gone, recreate it with the recipe in the handoff/memory (isolated `OPENCLAW_CONFIG_PATH`/`OPENCLAW_STATE_DIR`, LM Studio model `ornith-1.0-9b-abliterated-mlx` loaded with `--context-length 40960`).

```bash
cd ~/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH \
OPENCLAW_CANARY_URL=ws://127.0.0.1:18789 \
OPENCLAW_TOKEN=study-operator-token-7431 \
OPENCLAW_CANARY_EXPECT_TOOL=1 \
OPENCLAW_CANARY_MESSAGE="Use your file read tool to read the file magic-number.txt in your workspace and tell me the magic number it contains." \
node packages/gateway/scripts/openclaw-canary.mjs
```

Expected output includes `OK: tool chips observed` and `PASS: non-empty streamed reply`.

- [ ] **Step 3: Live verify (error chip)**

```bash
cd ~/Documents/repos/cozygateway && PATH=/opt/homebrew/opt/node@26/bin:$PATH \
OPENCLAW_CANARY_URL=ws://127.0.0.1:18789 \
OPENCLAW_TOKEN=study-operator-token-7431 \
OPENCLAW_CANARY_EXPECT_TOOL=1 \
OPENCLAW_CANARY_MESSAGE="Use your file read tool to read the file totally-missing-xyz.txt in your workspace. It may not exist; report exactly what the tool returned." \
node packages/gateway/scripts/openclaw-canary.mjs
```

Expected: `OK: tool chips observed` (the terminal chip is `error`; the canary accepts ok or error as terminal) and `PASS`.

- [ ] **Step 4: Record the evidence**

Paste both canary outputs (PASS lines and chip-observation lines) into the PR description draft and `.superpowers/sdd/openclaw-progress.md` (gitignored ledger). No ship claim without them.

- [ ] **Step 5: Commit any fixes**

Only if Steps 1-3 surfaced defects; otherwise nothing to commit.

---

## Self-Review Notes

- Spec coverage: protocol parsing (Task 1), client fold + privacy + done-guard (Task 2), adapter drafts + dedupe + detail-never-set (Task 3), integration + canary + wire-study addendum (Task 4), gate + mandatory live verification (Task 5). Non-goals need no tasks.
- The pre-existing adapter test asserting empty toolCalls is renamed, not deleted (Task 3 Step 5).
- Type names are consistent across tasks: `AgentToolItem` (protocol), `SessionToolCall` (client), contract `ToolCall` (adapter).

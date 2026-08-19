/** The hermes approval bridge, in isolation (issue #19, bridge lane).
 *
 *  Every event fed in here is the wire shape the 2026-08-19 probe read off hermes 0.20.3/0.20.4
 *  source, cited file:line in the probe report:
 *
 *  ```
 *  {"type":"approval.request","session_id":"runtime-1","payload":{
 *     "request_id":"4e8b...","command":"rm -rf /tmp/x","description":"delete a directory",
 *     "pattern_key":"terminal:rm","pattern_keys":["terminal:rm"],
 *     "allow_permanent":true,"allow_session":true,"choices":["once","session","always","deny"]}}
 *  ```
 *
 *  and the resolve is `approval.respond {session_id, request_id, choice}` answering
 *  `{"resolved": <int>}`. Nothing here talks to a real hermes.
 */
import { describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import {
  APPROVAL_NAME_FALLBACK,
  APPROVAL_NAME_MAX,
  BotApprovals,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type BotApprovalPush,
} from "../src/hermes-bridge/approvals.ts";
import type { StreamBinding } from "../src/hermes-bridge/chat-stream.ts";
import { HermesRpcError, HermesUnavailable, type HermesEvent } from "../src/hermes-bridge/client.ts";

const NOW = 1_800_000_000_000;
const REQUEST_ID = "4e8b2c1d9f0a4c1e8b2c1d9f0a4c1e8b";

type PendingFrame = Extract<ServerFrame, { type: "bot_approval_pending" }>;
type ResolvedFrame = Extract<ServerFrame, { type: "bot_approval_resolved" }>;

interface RpcCall {
  method: string;
  params: unknown;
}

function harness(
  opts: {
    respond?: (params: Record<string, unknown>) => unknown;
    timeoutMs?: number;
    turnId?: string | undefined;
  } = {},
) {
  const frames: ServerFrame[] = [];
  const calls: RpcCall[] = [];
  const pushes: BotApprovalPush[] = [];
  const audit: string[] = [];
  const logs: string[] = [];
  const bindings = new Map<string, StreamBinding>();

  const approvals = new BotApprovals({
    rpc: {
      request: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method !== "approval.respond") throw new HermesRpcError(`unknown method: ${method}`);
        const answer = opts.respond?.((params ?? {}) as Record<string, unknown>);
        return answer ?? { resolved: 1 };
      },
    },
    chat: {
      binding: (runtimeId) => bindings.get(runtimeId),
      turnId: () => ("turnId" in opts ? opts.turnId : "runtime-1#1-1"),
    },
    broadcast: (frame) => frames.push(frame),
    now: () => NOW,
    log: (line) => logs.push(line),
    approvalLog: (line) => audit.push(line),
    raisePush: (event) => pushes.push(event),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });

  const bind = (runtimeId: string, binding: StreamBinding): void => void bindings.set(runtimeId, binding);
  const request = (payload: unknown, runtimeId = "runtime-1"): void =>
    approvals.handleEvent({ type: "approval.request", sessionId: runtimeId, payload } as HermesEvent);
  const pendings = (): PendingFrame[] =>
    frames.filter((f): f is PendingFrame => f.type === "bot_approval_pending");
  const resolveds = (): ResolvedFrame[] =>
    frames.filter((f): f is ResolvedFrame => f.type === "bot_approval_resolved");

  return { approvals, frames, calls, pushes, audit, logs, bind, request, pendings, resolveds };
}

/** The probe's payload, verbatim in shape. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: REQUEST_ID,
    command: "rm -rf /tmp/secret-token-abc",
    description: "delete a directory called secret-token-abc",
    pattern_key: "terminal:rm",
    pattern_keys: ["terminal:rm"],
    allow_permanent: true,
    allow_session: true,
    choices: ["once", "session", "always", "deny"],
    ...overrides,
  };
}

describe("BotApprovals: raising a pending approval", () => {
  it("maps approval.request onto a bot_approval_pending frame", () => {
    const h = harness();
    h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    h.request(payload());

    expect(h.pendings()).toEqual([
      {
        type: "bot_approval_pending",
        bot: "scout",
        // The STORED id, never the runtime one the event was addressed to.
        sessionId: "stored-1",
        // The gateway's OWN in-flight turn for the chat: the same id `bot_chat_delta` carries.
        turnId: "runtime-1#1-1",
        // toolCallId IS the hermes request_id (ruling 1).
        toolCallId: REQUEST_ID,
        // Derived from pattern_key, never from the free-text command (rulings 1 and 4).
        name: "terminal:rm",
        updatedAt: NOW,
      },
    ]);
  });

  it("never lets the free-text command or description reach a frame, a push, or a log line", () => {
    const h = harness();
    h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    h.request(payload());
    void h.approvals.resolve("scout", REQUEST_ID, "deny", "device-1");

    const everything = JSON.stringify({
      frames: h.frames,
      pushes: h.pushes,
      audit: h.audit,
      logs: h.logs,
      calls: h.calls,
    });
    expect(everything).not.toContain("secret-token-abc");
    expect(everything).not.toContain("rm -rf");
    expect(everything).not.toContain("delete a directory");
  });

  it("drops an approval for a hermes session this gateway is not driving", () => {
    const h = harness();
    h.request(payload(), "some-desktop-session");
    expect(h.pendings()).toEqual([]);
    expect(h.logs.join("\n")).toMatch(/not driving/i);
  });

  it("ignores every event type but approval.request, and a payload with no request_id", () => {
    const h = harness();
    h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    h.approvals.handleEvent({ type: "message.delta", sessionId: "runtime-1", payload: { text: "x" } });
    h.approvals.handleEvent({ type: "approval.received", sessionId: "runtime-1", payload: payload() });
    h.request({ command: "rm -rf /", pattern_key: "terminal:rm" });
    expect(h.frames).toEqual([]);
  });

  it("is idempotent on request_id, so a session.info replay never double-emits", () => {
    const h = harness();
    h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    h.request(payload());
    // The reconnect replay: hermes hands the SAME entry back on `session.info.pending_approval`.
    h.approvals.ingest("runtime-1", payload());
    h.request(payload());
    expect(h.pendings()).toHaveLength(1);
    expect(h.pushes).toHaveLength(1);
  });

  it("mints its own turn id when no draft is in flight, and keeps it across the pair", async () => {
    const h = harness({ turnId: undefined });
    h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    h.request(payload());
    const minted = h.pendings()[0]!.turnId;
    expect(minted).toContain("runtime-1");
    await h.approvals.resolve("scout", REQUEST_ID, "approve", "device-1");
    expect(h.resolveds()[0]!.turnId).toBe(minted);
  });
});

describe("BotApprovals: the name derivation", () => {
  const nameFor = (over: Record<string, unknown>): string => {
    const h = harness();
    h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    h.request(payload({ request_id: `id-${Math.random()}`, ...over }));
    return h.pendings().at(-1)!.name;
  };

  it("prefers pattern_key, falls back to the first pattern_keys entry, then to a literal", () => {
    expect(nameFor({ pattern_key: "execute_code:python" })).toBe("execute_code:python");
    expect(nameFor({ pattern_key: "  terminal:rm  " })).toBe("terminal:rm");
    expect(nameFor({ pattern_key: "", pattern_keys: ["plugin:deploy"] })).toBe("plugin:deploy");
    expect(nameFor({ pattern_key: undefined, pattern_keys: [] })).toBe(APPROVAL_NAME_FALLBACK);
    expect(nameFor({ pattern_key: 42, pattern_keys: undefined })).toBe(APPROVAL_NAME_FALLBACK);
  });

  it("caps the derived name, because a pattern key is hermes-side data of unbounded length", () => {
    const long = "terminal:".concat("x".repeat(500));
    expect(nameFor({ pattern_key: long })).toHaveLength(APPROVAL_NAME_MAX);
  });
});

describe("BotApprovals: resolving", () => {
  it("approves with choice `once`, addressed by request_id, and emits exactly one resolved frame", async () => {
    const h = harness();
    h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    h.request(payload());

    expect(await h.approvals.resolve("scout", REQUEST_ID, "approve", "device-1")).toBe("approved");

    expect(h.calls).toEqual([
      {
        method: "approval.respond",
        // session_id is the RUNTIME id off the gateway's own record; nothing here came from the
        // request. `all` is never sent, and neither is `session` or `always`.
        params: { session_id: "runtime-1", request_id: REQUEST_ID, choice: "once" },
      },
    ]);
    expect(h.resolveds()).toEqual([
      {
        type: "bot_approval_resolved",
        bot: "scout",
        sessionId: "stored-1",
        turnId: "runtime-1#1-1",
        toolCallId: REQUEST_ID,
        outcome: "approved",
        updatedAt: NOW,
      },
    ]);
    expect(h.audit.join("\n")).toContain(`toolCall=${REQUEST_ID}`);
    expect(h.audit.join("\n")).toContain("device=device-1");
  });

  it("denies with choice `deny`, and never with session or always", async () => {
    const h = harness();
    h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    h.request(payload());
    expect(await h.approvals.resolve("scout", REQUEST_ID, "deny", "device-1")).toBe("denied");
    // The two native scopes a mobile client is never handed, and the blanket `all` flag, never
    // appear on the wire whatever the decision.
    for (const call of h.calls) {
      const params = call.params as Record<string, unknown>;
      expect(["once", "deny"]).toContain(params["choice"]);
      expect(params).not.toHaveProperty("all");
    }
  });

  it("answers a second decision instead of announcing a second outcome", async () => {
    const h = harness();
    h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    h.request(payload());
    await h.approvals.resolve("scout", REQUEST_ID, "approve", "device-1");
    expect(await h.approvals.resolve("scout", REQUEST_ID, "deny", "device-2")).toBe("not_pending");
    expect(h.resolveds()).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
  });

  it("maps {resolved: 0} to the stale path: outcome expired, one frame, no invention", async () => {
    const h = harness({ respond: () => ({ resolved: 0 }) });
    h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    h.request(payload());
    expect(await h.approvals.resolve("scout", REQUEST_ID, "approve", "device-1")).toBe("expired");
    expect(h.resolveds().map((f) => f.outcome)).toEqual(["expired"]);
    // And a follow-up decision reads the terminal state rather than calling hermes again.
    expect(await h.approvals.resolve("scout", REQUEST_ID, "deny", "device-1")).toBe("expired");
    expect(h.calls).toHaveLength(1);
  });

  it("answers `unknown` for a toolCallId this bot never raised, and never crosses bots", async () => {
    const h = harness();
    h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    h.request(payload());
    expect(await h.approvals.resolve("scout", "not-a-request", "approve", "d")).toBe("unknown");
    // The very same id, addressed against a different bot: still unknown, because records are
    // per bot and a client cannot reach another bot's approval by guessing an id.
    expect(await h.approvals.resolve("pixel", REQUEST_ID, "approve", "d")).toBe("unknown");
    expect(h.calls).toHaveLength(0);
  });

  it("answers `unsupported` when hermes cannot carry the decision, and leaves it pending", async () => {
    for (const err of [
      new HermesRpcError("unknown method: approval.respond"),
      new HermesUnavailable("hermes bridge is absent, not online"),
    ]) {
      const h = harness({
        respond: () => {
          throw err;
        },
      });
      h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
      h.request(payload());
      expect(await h.approvals.resolve("scout", REQUEST_ID, "approve", "d")).toBe("unsupported");
      // Nothing was announced: an approval whose decision did not land is still pending, and the
      // expiry timer is still the thing that will end it.
      expect(h.resolveds()).toEqual([]);
      expect(await h.approvals.resolve("scout", REQUEST_ID, "approve", "d")).toBe("unsupported");
    }
  });
});

describe("BotApprovals: expiry", () => {
  it("mirrors the hermes approvals.timeout default", () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(300_000);
  });

  it("synthesizes `expired` from its own timer, because hermes emits no expiry event", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ timeoutMs: 50 });
      h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
      h.request(payload());
      expect(h.resolveds()).toEqual([]);
      vi.advanceTimersByTime(51);
      expect(h.resolveds().map((f) => f.outcome)).toEqual(["expired"]);
      // Nothing was sent to hermes: it already dropped the entry itself, silently.
      expect(h.calls).toEqual([]);
      // And a late decision reads the terminal state.
      expect(await h.approvals.resolve("scout", REQUEST_ID, "approve", "d")).toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the timer once a decision lands, so a resolved approval cannot expire on top", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ timeoutMs: 50 });
      h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
      h.request(payload());
      await h.approvals.resolve("scout", REQUEST_ID, "approve", "d");
      vi.advanceTimersByTime(200);
      expect(h.resolveds()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BotApprovals: pushes", () => {
  it("raises one push per terminal transition, carrying no argument summary", async () => {
    const h = harness();
    h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    h.request(payload());
    await h.approvals.resolve("scout", REQUEST_ID, "deny", "device-1");
    expect(h.pushes).toEqual([
      {
        kind: "approval_pending",
        bot: "scout",
        sessionId: "stored-1",
        turnId: "runtime-1#1-1",
        toolCallId: REQUEST_ID,
        name: "terminal:rm",
      },
      {
        kind: "approval_resolved",
        bot: "scout",
        sessionId: "stored-1",
        turnId: "runtime-1#1-1",
        toolCallId: REQUEST_ID,
        outcome: "denied",
      },
    ]);
  });
});

describe("BotApprovals: teardown", () => {
  it("forgets a bot's approvals and cancels their timers", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ timeoutMs: 50 });
      h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
      h.request(payload());
      h.approvals.forgetBot("scout");
      vi.advanceTimersByTime(200);
      // No frame for a bot that is gone, and the record with it.
      expect(h.resolveds()).toEqual([]);
      expect(await h.approvals.resolve("scout", REQUEST_ID, "approve", "d")).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes quiet after close", () => {
    const h = harness();
    h.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    h.approvals.close();
    h.request(payload());
    expect(h.frames).toEqual([]);
  });
});

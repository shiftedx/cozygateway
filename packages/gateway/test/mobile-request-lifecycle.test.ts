/** Capability 68 (contract/ext-bots-v1.md row 68): every phone capability request carries a typed
 *  lifecycle and ends in exactly one typed terminal state, bound to the profile, conversation,
 *  turn, paired device and the person that device belongs to. A result or a progress report from
 *  another device, or for a request another conversation owns, fails closed. A reconnect during
 *  execution never re-dispatches, and a second device attaching never becomes the target. */
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { registerBotRoutes } from "../src/hermes-bridge/routes.ts";
import {
  MobileNodeBroker,
  type MobileNodeLifecycleEvent,
  type MobileNodeRoute,
} from "../src/mobile-node.ts";
import { openStorage } from "../src/storage.ts";
import type { TraceLog } from "../src/trace.ts";

const purpose = "Report phone readiness";

function available(foreground = true): MobileNodeRoute {
  return {
    status: "available", selectedSocketPresent: true, selectedSocketOpen: true,
    commandAdvertised: true, connectedSocketCount: 1, foreground,
  };
}

function unavailable(): MobileNodeRoute {
  return {
    status: "selected_socket_unavailable", selectedSocketPresent: false, selectedSocketOpen: false,
    commandAdvertised: false, connectedSocketCount: 0, foreground: false,
  };
}

function harness(options: {
  route?: (deviceId: string, command: string) => MobileNodeRoute;
  receipt?: () => boolean;
  now?: () => number;
  trace?: TraceLog;
} = {}) {
  const lifecycle = vi.fn<(event: MobileNodeLifecycleEvent) => void>();
  const send = vi.fn((_deviceId: string, _frame: unknown) => "sent" as const);
  const result = vi.fn();
  const broker = new MobileNodeBroker({
    lifecycle,
    wake: () => true,
    route: options.route ?? (() => available()),
    send,
    result,
    receipt: options.receipt ?? (() => true),
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    now: options.now ?? (() => 1_000),
  });
  return { broker, lifecycle, send, result };
}

function states(lifecycle: { mock: { calls: unknown[][] } }, requestId: string): string[] {
  return lifecycle.mock.calls
    .map((call) => call[0] as MobileNodeLifecycleEvent)
    .filter((event) => event.requestId === requestId)
    .map((event) => event.state);
}

function statusRequest(overrides: Partial<{ requestId: string; threadId: string; turnId: string; deviceId: string; expiresAt: number }> = {}) {
  return {
    requestId: "req-1", command: "device.status" as const, bot: "sage", threadId: "thread-1",
    turnId: "turn-1", expiresAt: 20_000, purpose, deviceId: "phone-a", agentId: "sage",
    ...overrides,
  };
}

function lease(send: ReturnType<typeof vi.fn>, requestId: string): string {
  const frame = send.mock.calls
    .map((call) => call[1] as { type?: string; requestId?: string; lease?: string })
    .find((candidate) => candidate.type === "mobile_node_request" && candidate.requestId === requestId);
  if (frame?.lease === undefined) throw new Error(`no lease for ${requestId}`);
  return frame.lease;
}

describe("capability-68 typed phone capability request lifecycle", () => {
  it("binds the record to profile, conversation, turn and the one target device", () => {
    const { broker, lifecycle } = harness();
    broker.invoke(statusRequest());

    const first = lifecycle.mock.calls[0]?.[0];
    expect(first).toMatchObject({
      requestId: "req-1", bot: "sage", sessionId: "thread-1", turnId: "turn-1",
      deviceId: "phone-a", command: "device.status", purpose, state: "requested", expiresAt: 20_000,
    });
    expect(states(lifecycle, "req-1")).toEqual(["requested", "routed"]);
  });

  it("reaches completed when the phone answers", () => {
    const { broker, lifecycle, send } = harness();
    broker.invoke(statusRequest());
    broker.result("phone-a", {
      type: "mobile_node_result", requestId: "req-1", lease: lease(send, "req-1"), status: "ok",
      result: {
        appState: "background", lowPowerMode: false,
        capabilities: [
          { command: "device.status", permission: "not_required" },
          { command: "location.current", permission: "authorized" },
          { command: "camera.capture", permission: "authorized" },
          { command: "file.pick", permission: "not_required" },
          { command: "notification.present", permission: "not_required" },
        ],
      },
    });

    expect(states(lifecycle, "req-1").at(-1)).toBe("completed");
  });

  it("reaches denied, cancelled, expired, failed, policy_blocked and foreground_required as their own outcomes", () => {
    const denied = harness();
    denied.broker.invoke(statusRequest());
    denied.broker.result("phone-a", {
      type: "mobile_node_result", requestId: "req-1", lease: lease(denied.send, "req-1"), status: "denied",
    });
    expect(states(denied.lifecycle, "req-1").at(-1)).toBe("denied");

    const cancelled = harness();
    cancelled.broker.invoke(statusRequest());
    cancelled.broker.cancelRequest("sage", "req-1");
    expect(states(cancelled.lifecycle, "req-1").at(-1)).toBe("cancelled");

    let now = 1_000;
    const expired = harness({ now: () => now });
    expired.broker.invoke(statusRequest());
    now = 30_000;
    expired.broker.result("phone-a", {
      type: "mobile_node_result", requestId: "req-1", lease: lease(expired.send, "req-1"), status: "denied",
    });
    expect(states(expired.lifecycle, "req-1").at(-1)).toBe("expired");

    // No device selected at all: the outcome is a failure, never a policy refusal.
    const failed = harness();
    failed.broker.invoke({ ...statusRequest(), deviceId: undefined });
    expect(states(failed.lifecycle, "req-1")).toEqual(["requested", "failed"]);

    // Refused by the gateway before any phone was asked.
    const blocked = harness();
    blocked.broker.invoke(statusRequest({ expiresAt: 500 }));
    expect(states(blocked.lifecycle, "req-1")).toEqual(["requested", "policy_blocked"]);

    // The device or app lifecycle prevented it: a distinct outcome, not a generic failure.
    const foreground = harness({ route: () => available(false) });
    foreground.broker.invoke({ ...statusRequest(), command: "location.current" as const });
    expect(states(foreground.lifecycle, "req-1").at(-1)).toBe("foreground_required");
  });

  it("refuses a result from another device, logs it, and leaves the request pending", () => {
    const lines: string[] = [];
    const trace: TraceLog = (line) => lines.push(line);
    const { broker, lifecycle, send, result } = harness({ trace });
    broker.invoke(statusRequest());
    broker.result("phone-b", {
      type: "mobile_node_result", requestId: "req-1", lease: lease(send, "req-1"), status: "denied",
    });

    expect(result).not.toHaveBeenCalled();
    expect(states(lifecycle, "req-1")).toEqual(["requested", "routed"]);
    // Refused AND said out loud, with a bounded reason and no phone content.
    const logged = lines.map((line) => JSON.parse(line) as { event: string; reason?: string });
    expect(logged.some((entry) => entry.event === "mobile_node_failure" && entry.reason === "cross_device_result")).toBe(true);

    // The bound device still settles it.
    broker.result("phone-a", {
      type: "mobile_node_result", requestId: "req-1", lease: lease(send, "req-1"), status: "denied",
    });
    expect(states(lifecycle, "req-1").at(-1)).toBe("denied");
  });

  it("refuses a progress report from another device and one carrying the wrong lease", () => {
    const { broker, lifecycle, send } = harness();
    broker.invoke(statusRequest());
    const good = lease(send, "req-1");

    broker.progress("phone-b", { type: "mobile_node_progress", requestId: "req-1", lease: good, stage: "executing" });
    broker.progress("phone-a", {
      type: "mobile_node_progress", requestId: "req-1",
      lease: "x".repeat(43), stage: "executing",
    });
    expect(states(lifecycle, "req-1")).toEqual(["requested", "routed"]);

    broker.progress("phone-a", { type: "mobile_node_progress", requestId: "req-1", lease: good, stage: "device_received" });
    expect(states(lifecycle, "req-1").at(-1)).toBe("device_received");
  });

  it("never re-dispatches a request the phone is already executing when that phone reconnects", () => {
    const { broker, send } = harness();
    broker.invoke(statusRequest());
    broker.progress("phone-a", {
      type: "mobile_node_progress", requestId: "req-1", lease: lease(send, "req-1"), stage: "executing",
    });
    const dispatched = send.mock.calls.length;

    broker.disconnectDevice("phone-a");
    broker.reconnectDevice("phone-a");

    expect(send.mock.calls.length).toBe(dispatched);
  });

  it("keeps re-dispatching for a phone that reports no progress, exactly as it did before row 68", () => {
    let up = false;
    const { broker, send } = harness({ route: () => (up ? available(false) : unavailable()) });
    broker.invoke(statusRequest());
    expect(send).not.toHaveBeenCalled();

    up = true;
    broker.reconnectDevice("phone-a");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not seal completed when the receipt the answer needs could not be written", () => {
    const { broker, lifecycle, send, result } = harness({ receipt: () => false });
    broker.invoke(statusRequest());
    broker.result("phone-a", {
      type: "mobile_node_result", requestId: "req-1", lease: lease(send, "req-1"), status: "ok",
      result: {
        appState: "background", lowPowerMode: false,
        capabilities: [
          { command: "device.status", permission: "not_required" },
          { command: "location.current", permission: "authorized" },
          { command: "camera.capture", permission: "authorized" },
          { command: "file.pick", permission: "not_required" },
          { command: "notification.present", permission: "not_required" },
        ],
      },
    });

    // The peer is told the request failed, so the person must not read `completed`.
    expect(result).toHaveBeenCalledWith("sage", expect.objectContaining({ requestId: "req-1", status: "device_unavailable" }));
    expect(states(lifecycle, "req-1")).toEqual(["requested", "routed", "failed"]);
  });

  it("calls a failure after the phone already ran the request a failure, not a policy block", () => {
    const { broker, lifecycle, send } = harness();
    broker.invoke(statusRequest());
    // A phone answer the gateway cannot accept arrives AFTER the request was routed and run, so
    // `policy_blocked`, which means refused before any phone saw it, would be a lie.
    broker.result("phone-a", {
      type: "mobile_node_result", requestId: "req-1", lease: lease(send, "req-1"), status: "ok",
      // An inventory the closed status schema refuses: the gateway cannot accept this answer.
      result: { appState: "background", lowPowerMode: false, capabilities: [] } as never,
    });

    expect(states(lifecycle, "req-1").at(-1)).toBe("failed");
  });

  it("records no terminal for a request the peer is never told about", () => {
    const { broker, lifecycle, result } = harness();
    // A one-request ceiling: the second admission is dropped fail-closed and silently, which is
    // the pre-68 behavior. A durable terminal nobody was told would disagree with the peer.
    const bounded = new MobileNodeBroker({
      lifecycle, wake: () => true, route: () => available(), send: () => "sent" as const,
      result, receipt: () => true, now: () => 1_000, terminalLimit: 1,
    });
    bounded.invoke(statusRequest());
    bounded.invoke(statusRequest({ requestId: "req-2" }));

    expect(states(lifecycle, "req-2")).toEqual([]);
    expect(result).not.toHaveBeenCalledWith("sage", expect.objectContaining({ requestId: "req-2" }));
  });

  it("keeps the original target when a second device attaches mid-request", () => {
    const { broker, lifecycle, send } = harness();
    broker.invoke(statusRequest());
    const dispatched = send.mock.calls.length;

    broker.reconnectDevice("phone-b");

    expect(send.mock.calls.length).toBe(dispatched);
    expect(send.mock.calls.every((call) => call[0] === "phone-a")).toBe(true);
    expect(lifecycle.mock.calls.every((call) => (call[0] as MobileNodeLifecycleEvent).deviceId !== "phone-b")).toBe(true);
  });
});

describe("capability-68 durable request records", () => {
  function storage() {
    return openStorage(":memory:");
  }

  const base = {
    requestId: "req-1", bot: "sage", sessionId: "thread-1", turnId: "turn-1", deviceId: "phone-a",
    command: "device.status" as const, purpose, expiresAt: 20_000,
  };

  it("records one row per request and moves it forward only", () => {
    const store = storage();
    store.recordBotMobileRequest({ ...base, state: "requested", at: 1_000 });
    store.recordBotMobileRequest({ ...base, state: "routed", at: 1_100 });
    // A stale earlier stage never rewinds a request.
    store.recordBotMobileRequest({ ...base, state: "requested", at: 1_200 });

    expect(store.nativeBotMobileRequests("sage", "thread-1")).toEqual([{
      ...base, state: "routed", requestedAt: 1_000, updatedAt: 1_100,
    }]);
    store.close();
  });

  it("seals the first terminal state", () => {
    const store = storage();
    store.recordBotMobileRequest({ ...base, state: "requested", at: 1_000 });
    store.recordBotMobileRequest({ ...base, state: "denied", at: 1_100 });
    store.recordBotMobileRequest({ ...base, state: "completed", at: 1_200 });

    expect(store.nativeBotMobileRequests("sage", "thread-1")[0]?.state).toBe("denied");
    store.close();
  });

  it("answers the newest requests and a live one whatever its age, past the read bound", () => {
    const store = storage();
    // Older than the window, and settled: history, not something to reconcile against.
    store.recordBotMobileRequest({ ...base, requestId: "ancient", state: "requested", at: 1_000 });
    store.recordBotMobileRequest({ ...base, requestId: "ancient", state: "denied", at: 1_000 });
    for (let index = 0; index < 150; index += 1) {
      const requestId = `req-${String(index).padStart(3, "0")}`;
      store.recordBotMobileRequest({ ...base, requestId, state: "requested", at: 2_000 + index });
      store.recordBotMobileRequest({ ...base, requestId, state: "completed", at: 2_000 + index });
    }
    // The one the resuming app is actually trying to reconcile, opened before the newest hundred.
    store.recordBotMobileRequest({ ...base, requestId: "pending", state: "requested", at: 2_010 });
    store.recordBotMobileRequest({ ...base, requestId: "pending", state: "executing", at: 2_011 });

    const answered = store.nativeBotMobileRequests("sage", "thread-1");
    expect(answered).toHaveLength(100);
    // A request that has not settled is never crowded out by finished ones.
    expect(answered[0]).toMatchObject({ requestId: "pending", state: "executing" });
    // Newest first among the settled ones, so the window moves with the conversation.
    expect(answered[1]?.requestId).toBe("req-149");
    expect(answered.some((request) => request.requestId === "req-000")).toBe(false);
    store.close();
  });

  it("sweeps settled records past the retention window and never a live one", () => {
    const store = storage();
    const day = 24 * 60 * 60 * 1_000;
    store.recordBotMobileRequest({ ...base, requestId: "old-settled", state: "requested", at: 1_000 });
    store.recordBotMobileRequest({ ...base, requestId: "old-settled", state: "completed", at: 1_000 });
    store.recordBotMobileRequest({ ...base, requestId: "old-live", state: "requested", at: 1_000 });

    store.recordBotMobileRequest({ ...base, requestId: "fresh", state: "requested", at: 1_000 + 31 * day });

    const remaining = store.nativeBotMobileRequests("sage", "thread-1").map((request) => request.requestId);
    expect(remaining).not.toContain("old-settled");
    // A request nobody settled is not swept: its outcome is still owed to a person.
    expect(remaining).toContain("old-live");
    expect(remaining).toContain("fresh");
    store.close();
  });

  it("takes its lifecycle records with the bot they belong to", () => {
    const store = storage();
    store.recordBotMobileRequest({ ...base, state: "requested", at: 1_000 });
    store.recordBotMobileRequest({ ...base, bot: "other", requestId: "req-2", state: "requested", at: 1_000 });

    const purged = store.purgeBot("sage");

    expect(purged["mobileRequests"]).toBe(1);
    expect(store.nativeBotMobileRequests("sage", "thread-1")).toEqual([]);
    expect(store.nativeBotMobileRequests("other", "thread-1")).toHaveLength(1);
    store.close();
  });

  it("answers only for the conversation and profile the request was issued in", () => {
    const store = storage();
    store.recordBotMobileRequest({ ...base, state: "requested", at: 1_000 });

    expect(store.nativeBotMobileRequests("sage", "other-thread")).toEqual([]);
    expect(store.nativeBotMobileRequests("other-bot", "thread-1")).toEqual([]);
    store.close();
  });
});

describe("capability-68 reconciliation route", () => {
  type Env = { Variables: { deviceId: string } };

  function mount(surface: Partial<BotsSurface>): Hono<Env> {
    const app = new Hono<Env>();
    const requireDevice: MiddlewareHandler<Env> = async (c, next) => {
      c.set("deviceId", "device-1");
      await next();
    };
    registerBotRoutes(app, requireDevice, surface as unknown as BotsSurface);
    return app;
  }

  it("answers the requests of one conversation", async () => {
    const record = {
      requestId: "req-1", bot: "sage", sessionId: "thread-1", turnId: "turn-1", deviceId: "phone-a",
      command: "device.status" as const, purpose, state: "routed" as const,
      requestedAt: 1_000, updatedAt: 1_100, expiresAt: 20_000,
    };
    const mobileRequests = vi.fn(() => [record]);
    const response = await mount({ mobileRequests }).request("/bots/sage/mobile-requests?sessionId=thread-1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requests: [record] });
    expect(mobileRequests).toHaveBeenCalledWith("sage", "thread-1");
  });

  it("requires the conversation the request is scoped to", async () => {
    const response = await mount({ mobileRequests: vi.fn(() => []) }).request("/bots/sage/mobile-requests");
    expect(response.status).toBe(400);
  });
});

/** The push half of row 68: a backgrounded phone learns a Task finished. The announcement is
 *  deduplicated against capability 64's own completion notification record, so a reapplied or
 *  replayed terminal announces nothing a second time. */
describe("capability-68 Task completion announcement", () => {
  it("announces once, on the transition that wrote the completion notification record", async () => {
    const store = openStorage(":memory:");
    store.tasks.clock(() => 0);
    const announced: { taskId: string; runId: string; bot: string; sessionId: string; room?: string }[] = [];
    store.tasks.completions((notice) => announced.push(notice));
    const sessionId = store.nativeBotChat("sage", 1).sessionId;
    const command = store.enqueueAttachCommand(
      "sage", "command",
      { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "Check the build" },
      2,
    );
    store.ackAttachCommand("sage", command.sequence, command.commandId, 3);
    const taskId = store.tasks.list({ bot: "sage" })[0]!.taskId;
    const final = {
      kind: "event" as const, sequence: 1, eventId: "final",
      event: {
        kind: "commit" as const, threadId: sessionId, turnId: "run", messageId: "reply",
        blocks: [{ type: "paragraph" as const, text: "Verified" }],
      },
    };
    store.acceptAttachEvent("sage", final, 4);
    // The same terminal, replayed: the record is already there, so nothing is announced again.
    store.acceptAttachEvent("sage", final, 5);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(announced).toEqual([{ taskId, runId: "run", bot: "sage", sessionId }]);
    expect(store.tasks.read(taskId)?.view.notification?.taskId).toBe(taskId);
    store.close();
  });
});

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
} = {}) {
  const lifecycle = vi.fn<(event: MobileNodeLifecycleEvent) => void>();
  const send = vi.fn(() => "sent" as const);
  const result = vi.fn();
  const broker = new MobileNodeBroker({
    lifecycle,
    wake: () => true,
    route: options.route ?? (() => available()),
    send,
    result,
    receipt: options.receipt ?? (() => true),
    now: options.now ?? (() => 1_000),
  });
  return { broker, lifecycle, send, result };
}

function states(lifecycle: { mock: { calls: [MobileNodeLifecycleEvent][] } }, requestId: string): string[] {
  return lifecycle.mock.calls
    .map(([event]) => event)
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

  it("refuses a result from another device and leaves the request pending", () => {
    const { broker, lifecycle, send, result } = harness();
    broker.invoke(statusRequest());
    broker.result("phone-b", {
      type: "mobile_node_result", requestId: "req-1", lease: lease(send, "req-1"), status: "denied",
    });

    expect(result).not.toHaveBeenCalled();
    expect(states(lifecycle, "req-1")).toEqual(["requested", "routed"]);

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

  it("keeps the original target when a second device attaches mid-request", () => {
    const { broker, lifecycle, send } = harness();
    broker.invoke(statusRequest());
    const dispatched = send.mock.calls.length;

    broker.reconnectDevice("phone-b");

    expect(send.mock.calls.length).toBe(dispatched);
    expect(send.mock.calls.every((call) => call[0] === "phone-a")).toBe(true);
    expect(lifecycle.mock.calls.every(([event]) => event.deviceId !== "phone-b")).toBe(true);
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

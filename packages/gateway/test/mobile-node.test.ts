import { describe, expect, it, vi } from "vitest";
import type { MobileNodePhoneStatusResult } from "cozygateway-contract";

import { MobileNodeBroker } from "../src/mobile-node.ts";

const purpose = "Report phone readiness";
const phoneStatus: MobileNodePhoneStatusResult = {
  appState: "background" as const,
  lowPowerMode: true,
  capabilities: [
    { command: "device.status" as const, permission: "not_required" as const },
    { command: "location.current" as const, permission: "authorized" as const },
  ],
};

describe("MobileNodeBroker", () => {
  it("delivers one closed status request and ignores a duplicate request id", () => {
    const send = vi.fn(() => true);
    const result = vi.fn();
    const broker = new MobileNodeBroker({ available: () => true, send, result, now: () => 1_000 });
    const request = { requestId: "request-1", command: "device.status" as const, bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose, deviceId: "device-1", agentId: "sage" };

    broker.invoke(request);
    broker.invoke(request);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("device-1", {
      type: "mobile_node_request", requestId: "request-1", command: "device.status", bot: "sage",
      threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose,
    });
    expect(result).not.toHaveBeenCalled();
  });

  it("accepts background status and adds gateway-authenticated reachability stamps", () => {
    let now = 1_000;
    const result = vi.fn();
    const broker = new MobileNodeBroker({ available: () => true, send: () => true, result, now: () => now });
    broker.invoke({
      requestId: "status-v2", command: "device.status", bot: "sage", threadId: "thread-1",
      turnId: "turn-1", expiresAt: 2_000, purpose, deviceId: "device-1", agentId: "sage",
    });

    now = 1_234;
    broker.result("device-1", { type: "mobile_node_result", requestId: "status-v2", status: "ok", result: phoneStatus });

    expect(result).toHaveBeenCalledWith("sage", {
      requestId: "status-v2", status: "ok",
      result: { ...phoneStatus, authenticatedReachable: true, lastAuthenticatedPresenceAt: 1_234 },
    });
  });

  it("delivers one normalized approximate location and rejects malformed purpose or coordinates", () => {
    const send = vi.fn(() => true);
    const result = vi.fn();
    const broker = new MobileNodeBroker({ available: (_device, command) => command === "location.current", send, result, now: () => 1_000 });
    const base = { command: "location.current" as const, bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, deviceId: "origin", agentId: "sage" };

    broker.invoke({ ...base, requestId: "location", purpose: "Find nearby coffee" });
    expect(send).toHaveBeenCalledWith("origin", { type: "mobile_node_request", requestId: "location", command: "location.current", bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose: "Find nearby coffee" });
    broker.result("origin", { type: "mobile_node_result", requestId: "location", status: "ok", result: { latitude: 41.881, longitude: -87.63 } });
    broker.result("origin", { type: "mobile_node_result", requestId: "location", status: "ok", result: { latitude: 41.88, longitude: -87.63 } });
    broker.invoke({ ...base, requestId: "control", purpose: "bad\npurpose" });
    broker.invoke({ ...base, requestId: "empty", purpose: "" });
    broker.invoke({ ...base, requestId: "oversize", purpose: "x".repeat(161) });

    expect(result.mock.calls).toEqual([
      ["sage", { requestId: "location", status: "ok", result: { latitude: 41.88, longitude: -87.63 } }],
      ["sage", { requestId: "control", status: "policy_blocked" }],
      ["sage", { requestId: "empty", status: "policy_blocked" }],
      ["sage", { requestId: "oversize", status: "policy_blocked" }],
    ]);
  });

  it("rejects a location result if the selected socket backgrounded after dispatch", () => {
    let foreground = true;
    const result = vi.fn();
    const broker = new MobileNodeBroker({
      available: (_device, command) => command === "device.status" || foreground,
      send: () => true, result, now: () => 1_000,
    });
    broker.invoke({
      requestId: "location-backgrounded", command: "location.current", bot: "sage",
      threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000,
      purpose: "Find nearby coffee", deviceId: "origin", agentId: "sage",
    });

    foreground = false;
    broker.result("origin", {
      type: "mobile_node_result", requestId: "location-backgrounded", status: "ok",
      result: { latitude: 41.88, longitude: -87.63 },
    });

    expect(result).toHaveBeenCalledWith("sage", { requestId: "location-backgrounded", status: "foreground_required" });
  });

  it("settles an agent cancellation once and drops the late phone result", () => {
    const send = vi.fn(() => true);
    const result = vi.fn();
    const broker = new MobileNodeBroker({ available: () => true, send, result, now: () => 1_000 });
    broker.invoke({ requestId: "request-1", command: "device.status", bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose, deviceId: "device-1", agentId: "sage" });

    broker.cancelRequest("sage", "request-1");
    broker.invoke({ requestId: "request-1", command: "device.status", bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose, deviceId: "device-1", agentId: "sage" });
    broker.result("device-1", { type: "mobile_node_result", requestId: "request-1", status: "ok", result: phoneStatus });

    expect(send).toHaveBeenLastCalledWith("device-1", { type: "mobile_node_cancel", requestId: "request-1", status: "cancelled" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledWith("sage", { requestId: "request-1", status: "cancelled" });
  });

  it("holds terminal ids only through their deadline or bounded short TTL", () => {
    let now = 1_000;
    const send = vi.fn(() => true);
    const broker = new MobileNodeBroker({
      available: () => true, send, result: vi.fn(), now: () => now,
      terminalTtlMs: 10, terminalLimit: 1,
    });
    const base = { command: "device.status" as const, bot: "sage", threadId: "thread-1", turnId: "turn-1", purpose, deviceId: "device-1", agentId: "sage" };
    broker.invoke({ ...base, requestId: "request-1", expiresAt: 1_001 });
    broker.cancelRequest("sage", "request-1");
    broker.invoke({ ...base, requestId: "request-1", expiresAt: 2_000 });
    expect(send).toHaveBeenCalledTimes(2); // request + cancel; the terminal id blocks re-prompting

    now = 1_011;
    broker.invoke({ ...base, requestId: "request-1", expiresAt: 2_000 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not admit a burst beyond the bounded pending and terminal capacity", () => {
    const send = vi.fn(() => true);
    const broker = new MobileNodeBroker({
      available: () => true, send, result: vi.fn(), now: () => 1_000,
      terminalLimit: 1,
    });
    const base = { command: "device.status" as const, bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose, deviceId: "device-1", agentId: "sage" };
    broker.invoke({ ...base, requestId: "oldest" });
    broker.invoke({ ...base, requestId: "newest" });
    broker.invoke({ ...base, requestId: "third" });
    broker.cancelRequest("sage", "oldest");
    broker.invoke({ ...base, requestId: "newest" });

    expect(send).toHaveBeenCalledTimes(2); // one request and its cancellation; no unexpired id is evicted
  });

  it("fails closed for missing origin, unavailable node, and an out-of-policy deadline", () => {
    const result = vi.fn();
    const broker = new MobileNodeBroker({ available: () => false, send: () => true, result, now: () => 1_000 });
    const base = { command: "device.status" as const, bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose, agentId: "sage" };

    broker.invoke({ ...base, requestId: "missing" });
    broker.invoke({ ...base, requestId: "unavailable", deviceId: "device-1" });
    broker.invoke({ ...base, requestId: "late", deviceId: "device-1", expiresAt: 32_000 });

    expect(result.mock.calls).toEqual([
      ["sage", { requestId: "missing", status: "device_unavailable" }],
      ["sage", { requestId: "unavailable", status: "foreground_required" }],
      ["sage", { requestId: "late", status: "policy_blocked" }],
    ]);
  });

  it("tombstones every pre-dispatch terminal and explicit reject before emitting it", () => {
    const result = vi.fn();
    const broker = new MobileNodeBroker({ available: () => false, send: () => true, result, now: () => 1_000 });
    const base = { command: "device.status" as const, bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose, agentId: "sage" };
    broker.invoke({ ...base, requestId: "missing" });
    broker.invoke({ ...base, requestId: "missing" });
    broker.invoke({ ...base, requestId: "unavailable", deviceId: "device-1" });
    broker.invoke({ ...base, requestId: "unavailable", deviceId: "device-1" });
    broker.invoke({ ...base, requestId: "policy", deviceId: "device-1", expiresAt: 32_000 });
    broker.invoke({ ...base, requestId: "policy", deviceId: "device-1", expiresAt: 32_000 });
    broker.reject("sage", "reject");
    broker.reject("sage", "reject");

    expect(result.mock.calls).toEqual([
      ["sage", { requestId: "missing", status: "device_unavailable" }],
      ["sage", { requestId: "unavailable", status: "foreground_required" }],
      ["sage", { requestId: "policy", status: "policy_blocked" }],
      ["sage", { requestId: "reject", status: "policy_blocked" }],
    ]);
  });

  it("accepts only the origin device result and terminalizes expiry or disconnect once", () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(() => true);
      const result = vi.fn();
      const broker = new MobileNodeBroker({ available: () => true, send, result, now: () => 1_000 });
      const request = { command: "device.status" as const, bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 1_010, purpose, deviceId: "origin", agentId: "sage" };
      broker.invoke({ ...request, requestId: "expiry" });
      broker.result("foreign", { type: "mobile_node_result", requestId: "expiry", status: "ok", result: phoneStatus });
      expect(result).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10);
      broker.result("origin", { type: "mobile_node_result", requestId: "expiry", status: "ok", result: phoneStatus });

      broker.invoke({ ...request, requestId: "disconnect", expiresAt: 2_000 });
      broker.disconnectDevice("origin");
      broker.disconnectDevice("origin");

      expect(result.mock.calls).toEqual([
        ["sage", { requestId: "expiry", status: "expired" }],
        ["sage", { requestId: "disconnect", status: "device_unavailable" }],
      ]);
      expect(send).toHaveBeenCalledWith("origin", { type: "mobile_node_cancel", requestId: "expiry", status: "expired" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a result after the lease deadline even when the timer callback is delayed", () => {
    let now = 1_000;
    const send = vi.fn(() => true);
    const result = vi.fn();
    const broker = new MobileNodeBroker({ available: () => true, send, result, now: () => now });
    broker.invoke({
      requestId: "late-result", command: "device.status", bot: "sage", threadId: "thread-1",
      turnId: "turn-1", expiresAt: 1_010, purpose, deviceId: "origin", agentId: "sage",
    });

    now = 1_011;
    broker.result("origin", {
      type: "mobile_node_result", requestId: "late-result", status: "ok", result: phoneStatus,
    });

    expect(result).toHaveBeenCalledWith("sage", { requestId: "late-result", status: "expired" });
    expect(send).toHaveBeenLastCalledWith("origin", {
      type: "mobile_node_cancel", requestId: "late-result", status: "expired",
    });
  });
});

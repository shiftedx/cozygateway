import { describe, expect, it, vi } from "vitest";

import { MobileNodeBroker } from "../src/mobile-node.ts";

describe("MobileNodeBroker", () => {
  it("delivers one closed status request and ignores a duplicate request id", () => {
    const send = vi.fn(() => true);
    const result = vi.fn();
    const broker = new MobileNodeBroker({ available: () => true, send, result, now: () => 1_000 });
    const request = { requestId: "request-1", command: "device.status" as const, bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, deviceId: "device-1", agentId: "sage" };

    broker.invoke(request);
    broker.invoke(request);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("device-1", {
      type: "mobile_node_request", requestId: "request-1", command: "device.status", bot: "sage",
      threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000,
    });
    expect(result).not.toHaveBeenCalled();
  });

  it("settles an agent cancellation once and drops the late phone result", () => {
    const send = vi.fn(() => true);
    const result = vi.fn();
    const broker = new MobileNodeBroker({ available: () => true, send, result, now: () => 1_000 });
    broker.invoke({ requestId: "request-1", command: "device.status", bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, deviceId: "device-1", agentId: "sage" });

    broker.cancelRequest("sage", "request-1");
    broker.result("device-1", { type: "mobile_node_result", requestId: "request-1", status: "ok", result: { foreground: true } });

    expect(send).toHaveBeenLastCalledWith("device-1", { type: "mobile_node_cancel", requestId: "request-1", status: "cancelled" });
    expect(result).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledWith("sage", { requestId: "request-1", status: "cancelled" });
  });

  it("fails closed for missing origin, unavailable node, and an out-of-policy deadline", () => {
    const result = vi.fn();
    const broker = new MobileNodeBroker({ available: () => false, send: () => true, result, now: () => 1_000 });
    const base = { command: "device.status" as const, bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, agentId: "sage" };

    broker.invoke({ ...base, requestId: "missing" });
    broker.invoke({ ...base, requestId: "unavailable", deviceId: "device-1" });
    broker.invoke({ ...base, requestId: "late", deviceId: "device-1", expiresAt: 32_000 });

    expect(result.mock.calls).toEqual([
      ["sage", { requestId: "missing", status: "device_unavailable" }],
      ["sage", { requestId: "unavailable", status: "foreground_required" }],
      ["sage", { requestId: "late", status: "policy_blocked" }],
    ]);
  });

  it("accepts only the origin device result and terminalizes expiry or disconnect once", () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(() => true);
      const result = vi.fn();
      const broker = new MobileNodeBroker({ available: () => true, send, result, now: () => 1_000 });
      const request = { command: "device.status" as const, bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 1_010, deviceId: "origin", agentId: "sage" };
      broker.invoke({ ...request, requestId: "expiry" });
      broker.result("foreign", { type: "mobile_node_result", requestId: "expiry", status: "ok", result: { foreground: true } });
      expect(result).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10);
      broker.result("origin", { type: "mobile_node_result", requestId: "expiry", status: "ok", result: { foreground: true } });

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
});

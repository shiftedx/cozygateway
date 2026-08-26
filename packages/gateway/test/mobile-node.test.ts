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
    { command: "camera.capture" as const, permission: "authorized" as const },
    { command: "file.pick" as const, permission: "not_required" as const },
    { command: "notification.present" as const, permission: "not_required" as const },
  ],
};

function leaseFor(send: ReturnType<typeof vi.fn>, requestId: string): string {
  const frame = send.mock.calls
    .map((call) => call[1] as { type?: string; requestId?: string; lease?: string })
    .find((candidate) => candidate.type === "mobile_node_request" && candidate.requestId === requestId);
  if (frame?.lease === undefined) throw new Error(`missing lease for ${requestId}`);
  return frame.lease;
}

describe("MobileNodeBroker", () => {
  it("settles successful P1 media exactly once and rechecks expiry and foreground during upload", () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const send = vi.fn(() => true), result = vi.fn(), receipt = vi.fn(() => true);
      let foreground = true;
      const route = () => ({ status: "available" as const, selectedSocketPresent: true, selectedSocketOpen: true, commandAdvertised: true, connectedSocketCount: 1, foreground });
      const broker = new MobileNodeBroker({ route, send, result, receipt, now: () => now });
      const requests = [
        { command: "camera.capture" as const, camera: "rear" as const, capture: "photo" as const, videoDurationSeconds: 10 },
        { command: "file.pick" as const, selection: "file" as const },
        { command: "notification.present" as const, title: "Cozy", body: "Approve?" },
      ];
      for (const [index, request] of requests.entries()) {
        const requestId = `p1-${index}`;
        broker.invoke({ ...request, requestId, bot: "sage", threadId: "thread", turnId: "turn", purpose, deviceId: "origin", agentId: "sage", expiresAt: 2_000 });
        const original = send.mock.calls.at(-1);
        broker.reconnectDevice("origin");
        expect(send.mock.calls.at(-1)).toEqual(original); // reconnect keeps the exact lease/frame
        const lease = leaseFor(send, requestId);
        if (request.command === "notification.present") {
          broker.result("foreign", { type: "mobile_node_result", requestId, lease, status: "ok", result: { action: "approve" } });
          expect(result.mock.calls.some(([_, value]) => value.requestId === requestId)).toBe(false);
          broker.result("origin", { type: "mobile_node_result", requestId, lease, status: "denied" });
          broker.result("origin", { type: "mobile_node_result", requestId, lease, status: "denied" });
        } else {
          expect(broker.beginMediaUpload("foreign", requestId, lease)).toBeUndefined();
          const claim = broker.beginMediaUpload("origin", requestId, lease);
          expect(claim).toBeDefined();
          broker.completeMediaUpload(claim!, { mediaId: `media${index}`, mimeType: "image/jpeg", byteCount: 1, sha256: "a".repeat(64), filename: "photo.jpg", family: "image" });
          expect(broker.beginMediaUpload("origin", requestId, lease)).toBeUndefined(); // replay
        }
      }
      broker.invoke({ command: "camera.capture", camera: "front", capture: "photo", videoDurationSeconds: 10, requestId: "expired-p1", bot: "sage", threadId: "thread", turnId: "turn", purpose, deviceId: "origin", agentId: "sage", expiresAt: 1_001 });
      const expiredClaim = broker.beginMediaUpload("origin", "expired-p1", leaseFor(send, "expired-p1"));
      now = 1_001;
      expect(broker.completeMediaUpload(expiredClaim!, { mediaId: "expired", mimeType: "image/jpeg", byteCount: 1, sha256: "a".repeat(64), filename: "photo.jpg", family: "image" })).toBe(false);
      expect(result.mock.calls.some(([_, value]) => value.requestId === "expired-p1" && value.status === "expired")).toBe(true);
      now = 1_000;
      broker.invoke({ command: "file.pick", selection: "photo", requestId: "background-p1", bot: "sage", threadId: "thread", turnId: "turn", purpose, deviceId: "origin", agentId: "sage", expiresAt: 2_000 });
      const backgroundClaim = broker.beginMediaUpload("origin", "background-p1", leaseFor(send, "background-p1"));
      foreground = false;
      expect(broker.completeMediaUpload(backgroundClaim!, { mediaId: "background", mimeType: "image/jpeg", byteCount: 1, sha256: "a".repeat(64), filename: "photo.jpg", family: "image" })).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it.each(["camera.capture", "file.pick", "notification.present"] as const)("makes %s reconnect-safe, replay-safe, expiring, deniable, and origin-only", (command) => {
    let now = 1_000;
    const send = vi.fn(() => true), result = vi.fn();
    const route = () => ({ status: "available" as const, selectedSocketPresent: true, selectedSocketOpen: true, commandAdvertised: true, connectedSocketCount: 1, foreground: true });
    const broker = new MobileNodeBroker({ route, send, result, receipt: () => true, now: () => now });
    const request = command === "camera.capture"
      ? { command, camera: "rear" as const, capture: "photo" as const, videoDurationSeconds: 10 }
      : command === "file.pick" ? { command, selection: "file" as const }
      : { command, title: "Cozy", body: "Approve?" };
    const base = { ...request, bot: "sage", threadId: "thread", turnId: "turn", purpose, deviceId: "origin", agentId: "sage", expiresAt: 2_000 };
    broker.invoke({ ...base, requestId: "one" });
    const first = send.mock.calls.at(-1);
    broker.reconnectDevice("origin");
    expect(send.mock.calls.at(-1)).toEqual(first);
    const oneLease = leaseFor(send, "one");
    if (command === "camera.capture" || command === "file.pick")
      expect(broker.beginMediaUpload("foreign", "one", oneLease)).toBeUndefined();
    else broker.result("foreign", { type: "mobile_node_result", requestId: "one", lease: oneLease, status: "denied" });
    expect(result).not.toHaveBeenCalled();
    broker.result("origin", { type: "mobile_node_result", requestId: "one", lease: oneLease, status: "denied" });
    broker.result("origin", { type: "mobile_node_result", requestId: "one", lease: oneLease, status: "denied" });
    expect(result.mock.calls.filter(([_, value]) => value.requestId === "one")).toHaveLength(1);
    broker.invoke({ ...base, requestId: "expired", expiresAt: 1_001 });
    const expiryLease = leaseFor(send, "expired");
    now = 1_001;
    if (command === "camera.capture" || command === "file.pick") expect(broker.beginMediaUpload("origin", "expired", expiryLease)).toBeUndefined();
    else broker.result("origin", { type: "mobile_node_result", requestId: "expired", lease: expiryLease, status: "denied" });
    expect(result).toHaveBeenCalledWith("sage", { requestId: "expired", status: "expired" });
  });
  it("delivers one closed status request and ignores a duplicate request id", () => {
    const send = vi.fn(() => true);
    const result = vi.fn();
    const broker = new MobileNodeBroker({ receipt: () => true, available: () => true, send, result, now: () => 1_000 });
    const request = { requestId: "request-1", command: "device.status" as const, bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose, deviceId: "device-1", agentId: "sage" };

    broker.invoke(request);
    broker.invoke(request);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("device-1", {
      type: "mobile_node_request", requestId: "request-1", lease: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), command: "device.status", bot: "sage",
      threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose,
    });
    expect(result).not.toHaveBeenCalled();
  });

  it("accepts background status and adds gateway-authenticated reachability stamps", () => {
    let now = 1_000;
    const send = vi.fn(() => true);
    const result = vi.fn();
    const broker = new MobileNodeBroker({ receipt: () => true, available: () => true, send, result, now: () => now });
    broker.invoke({
      requestId: "status-v2", command: "device.status", bot: "sage", threadId: "thread-1",
      turnId: "turn-1", expiresAt: 2_000, purpose, deviceId: "device-1", agentId: "sage",
    });

    now = 1_234;
    broker.result("device-1", { type: "mobile_node_result", requestId: "status-v2", lease: leaseFor(send, "status-v2"), status: "ok", result: phoneStatus });

    expect(result).toHaveBeenCalledWith("sage", {
      requestId: "status-v2", status: "ok",
      result: { ...phoneStatus, authenticatedReachable: true, lastAuthenticatedPresenceAt: 1_234 },
    });
  });

  it("delivers one normalized approximate location and rejects malformed purpose or coordinates", () => {
    const send = vi.fn(() => true);
    const result = vi.fn();
    const broker = new MobileNodeBroker({ receipt: () => true, available: (_device, command) => command === "location.current", send, result, now: () => 1_000 });
    const base = { command: "location.current" as const, bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, deviceId: "origin", agentId: "sage" };

    broker.invoke({ ...base, requestId: "location", purpose: "Find nearby coffee" });
    expect(send).toHaveBeenCalledWith("origin", expect.objectContaining({ type: "mobile_node_request", requestId: "location", lease: expect.any(String), command: "location.current", bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose: "Find nearby coffee" }));
    broker.result("origin", { type: "mobile_node_result", requestId: "location", lease: leaseFor(send, "location"), status: "ok", result: { latitude: 41.881, longitude: -87.63 } });
    broker.result("origin", { type: "mobile_node_result", requestId: "location", lease: leaseFor(send, "location"), status: "ok", result: { latitude: 41.88, longitude: -87.63 } });
    broker.invoke({ ...base, requestId: "control", purpose: "bad\npurpose" });
    broker.invoke({ ...base, requestId: "empty", purpose: "" });
    broker.invoke({ ...base, requestId: "oversize", purpose: "x".repeat(161) });

    expect(result.mock.calls).toEqual([
      ["sage", { requestId: "location", status: "policy_blocked" }],
      ["sage", { requestId: "control", status: "policy_blocked" }],
      ["sage", { requestId: "empty", status: "policy_blocked" }],
      ["sage", { requestId: "oversize", status: "policy_blocked" }],
    ]);
  });

  it("rejects a location result if the selected socket backgrounded after dispatch", () => {
    let foreground = true;
    const send = vi.fn(() => true);
    const result = vi.fn();
    const broker = new MobileNodeBroker({ receipt: () => true,
      available: (_device, command) => command === "device.status" || foreground,
      send, result, now: () => 1_000,
    });
    broker.invoke({
      requestId: "location-backgrounded", command: "location.current", bot: "sage",
      threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000,
      purpose: "Find nearby coffee", deviceId: "origin", agentId: "sage",
    });

    foreground = false;
    broker.result("origin", {
      type: "mobile_node_result", requestId: "location-backgrounded", status: "ok",
      lease: leaseFor(send, "location-backgrounded"),
      result: { latitude: 41.88, longitude: -87.63 },
    });

    expect(result).toHaveBeenCalledWith("sage", { requestId: "location-backgrounded", status: "foreground_required" });
  });

  it("settles an agent cancellation once and drops the late phone result", () => {
    const send = vi.fn(() => true);
    const result = vi.fn();
    const broker = new MobileNodeBroker({ receipt: () => true, available: () => true, send, result, now: () => 1_000 });
    broker.invoke({ requestId: "request-1", command: "device.status", bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose, deviceId: "device-1", agentId: "sage" });

    broker.cancelRequest("sage", "request-1");
    broker.invoke({ requestId: "request-1", command: "device.status", bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose, deviceId: "device-1", agentId: "sage" });
    broker.result("device-1", { type: "mobile_node_result", requestId: "request-1", lease: leaseFor(send, "request-1"), status: "ok", result: phoneStatus });

    expect(send).toHaveBeenLastCalledWith("device-1", expect.objectContaining({ type: "mobile_node_cancel", requestId: "request-1", lease: expect.any(String), status: "cancelled" }));
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledWith("sage", { requestId: "request-1", status: "cancelled" });
  });

  it("holds terminal ids only through their deadline or bounded short TTL", () => {
    let now = 1_000;
    const send = vi.fn(() => true);
    const broker = new MobileNodeBroker({ receipt: () => true,
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
    const broker = new MobileNodeBroker({ receipt: () => true,
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
    const broker = new MobileNodeBroker({ receipt: () => true, available: () => false, send: () => true, result, now: () => 1_000 });
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
    const broker = new MobileNodeBroker({ receipt: () => true, available: () => false, send: () => true, result, now: () => 1_000 });
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

  it("requires the originating device and lease, resends unchanged after reconnect, and expires once", () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(() => true);
      const result = vi.fn();
      const broker = new MobileNodeBroker({ receipt: () => true, available: () => true, send, result, now: () => 1_000 });
      const request = { command: "device.status" as const, bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 1_010, purpose, deviceId: "origin", agentId: "sage" };
      broker.invoke({ ...request, requestId: "expiry" });
      const expiryLease = leaseFor(send, "expiry");
      broker.result("foreign", { type: "mobile_node_result", requestId: "expiry", lease: expiryLease, status: "ok", result: phoneStatus });
      broker.result("origin", { type: "mobile_node_result", requestId: "expiry", lease: "___________________________________________", status: "ok", result: phoneStatus });
      expect(result).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10);
      broker.result("origin", { type: "mobile_node_result", requestId: "expiry", lease: expiryLease, status: "ok", result: phoneStatus });

      broker.invoke({ ...request, requestId: "disconnect", expiresAt: 2_000 });
      const original = send.mock.calls.at(-1);
      broker.disconnectDevice("origin");
      expect(result).toHaveBeenCalledTimes(1);
      broker.reconnectDevice("origin");
      expect(send.mock.calls.at(-1)).toEqual(original);
      const reconnectLease = leaseFor(send, "disconnect");
      broker.result("origin", { type: "mobile_node_result", requestId: "disconnect", lease: reconnectLease, status: "ok", result: phoneStatus });
      broker.result("origin", { type: "mobile_node_result", requestId: "disconnect", lease: reconnectLease, status: "ok", result: phoneStatus });

      expect(result.mock.calls[0]).toEqual(["sage", { requestId: "expiry", status: "expired" }]);
      expect(result.mock.calls.filter(([_, value]) => value.requestId === "disconnect")).toHaveLength(1);
      expect(send).toHaveBeenCalledWith("origin", expect.objectContaining({
        type: "mobile_node_cancel", requestId: "expiry", lease: expiryLease, status: "expired",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a result after the lease deadline even when the timer callback is delayed", () => {
    let now = 1_000;
    const send = vi.fn(() => true);
    const result = vi.fn();
    const broker = new MobileNodeBroker({ receipt: () => true, available: () => true, send, result, now: () => now });
    broker.invoke({
      requestId: "late-result", command: "device.status", bot: "sage", threadId: "thread-1",
      turnId: "turn-1", expiresAt: 1_010, purpose, deviceId: "origin", agentId: "sage",
    });

    now = 1_011;
    broker.result("origin", {
      type: "mobile_node_result", requestId: "late-result", status: "ok", result: phoneStatus,
      lease: leaseFor(send, "late-result"),
    });

    expect(result).toHaveBeenCalledWith("sage", { requestId: "late-result", status: "expired" });
    expect(send).toHaveBeenLastCalledWith("origin", {
      type: "mobile_node_cancel", requestId: "late-result", status: "expired",
      lease: expect.any(String),
    });
  });
  it("refuses a consumed lease when profile, turn, or command scope changes", () => {
    const send = vi.fn(() => true);
    const result = vi.fn();
    const broker = new MobileNodeBroker({ receipt: () => true, available: () => true, send, result, now: () => 1_000 });
    const base = { command: "device.status" as const, bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose, deviceId: "origin", agentId: "sage" };
    broker.invoke({ ...base, requestId: "original" });
    const consumed = leaseFor(send, "original");
    broker.result("origin", { type: "mobile_node_result", requestId: "original", lease: consumed, status: "denied" });

    const changes = [
      { ...base, requestId: "profile", bot: "juniper", agentId: "juniper" },
      { ...base, requestId: "turn", turnId: "turn-2" },
      { ...base, requestId: "command", command: "location.current" as const },
    ];
    for (const changed of changes) {
      broker.invoke(changed);
      broker.result("origin", { type: "mobile_node_result", requestId: changed.requestId, lease: consumed, status: "denied" });
      expect(result.mock.calls.some(([_, value]) => value.requestId === changed.requestId)).toBe(false);
      broker.result("origin", { type: "mobile_node_result", requestId: changed.requestId, lease: leaseFor(send, changed.requestId), status: "denied" });
    }
    expect(result.mock.calls.map(([_, value]) => value.requestId)).toEqual(["original", "profile", "turn", "command"]);
  });

  it("writes one metadata receipt only for a successful share", () => {
    const send = vi.fn(() => true);
    const recordReceipt = vi.fn(() => true);
    const result = vi.fn();
    const broker = new MobileNodeBroker({ receipt: recordReceipt, available: () => true, send, result, now: () => 1_000 });
    const request = { command: "device.status" as const, bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose, deviceId: "origin", agentId: "sage" };
    broker.invoke({ ...request, requestId: "shared" });
    broker.result("origin", { type: "mobile_node_result", requestId: "shared", lease: leaseFor(send, "shared"), status: "ok", result: phoneStatus });
    broker.result("origin", { type: "mobile_node_result", requestId: "shared", lease: leaseFor(send, "shared"), status: "ok", result: phoneStatus });
    broker.invoke({ ...request, requestId: "denied" });
    broker.result("origin", { type: "mobile_node_result", requestId: "denied", lease: leaseFor(send, "denied"), status: "denied" });
    expect(recordReceipt).toHaveBeenCalledTimes(1);
    expect(recordReceipt).toHaveBeenCalledWith({ requestId: "shared", bot: "sage", threadId: "thread-1", turnId: "turn-1", command: "device.status", purpose, sharedDescription: "Device status" });
    expect(result.mock.calls.filter(([_, value]) => value.requestId === "shared")).toHaveLength(1);
  });

});

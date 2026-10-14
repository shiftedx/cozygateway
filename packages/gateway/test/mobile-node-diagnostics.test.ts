import { describe, expect, it, vi } from "vitest";

import { MobileNodeBroker, type MobileNodeRoute } from "../src/mobile-node.ts";

const purpose = "Report phone readiness";
const availableRoute: MobileNodeRoute = {
  status: "available",
  selectedSocketPresent: true,
  selectedSocketOpen: true,
  commandAdvertised: true,
  connectedSocketCount: 1,
  foreground: true,
};
const invocation = {
  requestId: "request-1",
  command: "device.status" as const,
  bot: "sage",
  threadId: "thread-1",
  turnId: "turn-1",
  expiresAt: 2_000,
  purpose,
  deviceId: "device-1",
  agentId: "sage",
};

function reasons(traces: string[]): string[] {
  return traces
    .map((line) => JSON.parse(line) as { event?: string; reason?: string })
    .filter((entry) => entry.event === "mobile_node_failure")
    .map((entry) => entry.reason ?? "");
}

function brokerFor(options: {
  route?: MobileNodeRoute;
  send?: "sent" | "frame_send_failed" | "command_not_advertised" | "selected_socket_unavailable";
} = {}) {
  const traces: string[] = [];
  const result = vi.fn();
  const send = vi.fn((_deviceId: string, _frame: unknown) => options.send ?? "sent");
  const broker = new MobileNodeBroker({ receipt: () => true,
    route: () => options.route ?? availableRoute,
    send,
    result,
    now: () => 1_000,
    trace: (line) => traces.push(line),
  });
  return { broker, result, send, traces };
}

describe("mobile-node operator failure diagnostics", () => {
  it("produces no_selected_device", () => {
    const { broker, result, traces } = brokerFor();
    const { deviceId: _deviceId, ...withoutDevice } = invocation;

    broker.invoke({ ...withoutDevice, requestId: "missing-device" });

    expect(reasons(traces)).toEqual(["no_selected_device"]);
    expect(result).toHaveBeenCalledWith("sage", {
      requestId: "missing-device", status: "device_unavailable",
      stage: "routing", reason: "no_selected_device",
    });
  });

  it("produces command_not_advertised", () => {
    const route: MobileNodeRoute = {
      status: "command_not_advertised",
      selectedSocketPresent: true,
      selectedSocketOpen: true,
      commandAdvertised: false,
      connectedSocketCount: 1,
    };
    const { broker, result, traces } = brokerFor({ route });

    broker.invoke({ ...invocation, requestId: "not-advertised" });

    expect(reasons(traces)).toEqual(["command_not_advertised"]);
    expect(result).toHaveBeenCalledWith("sage", {
      requestId: "not-advertised", status: "foreground_required",
      stage: "routing", reason: "command_not_advertised",
    });
  });

  it("produces selected_socket_unavailable", () => {
    const route: MobileNodeRoute = {
      status: "selected_socket_unavailable",
      selectedSocketPresent: false,
      selectedSocketOpen: false,
      commandAdvertised: false,
      connectedSocketCount: 0,
    };
    const { broker, traces } = brokerFor({ route });

    broker.invoke({ ...invocation, requestId: "no-socket" });

    expect(reasons(traces)).toEqual(["selected_socket_unavailable"]);
  });

  it("produces frame_send_failed", () => {
    const { broker, result, traces } = brokerFor({ send: "frame_send_failed" });

    broker.invoke({ ...invocation, requestId: "send-failed" });

    expect(reasons(traces)).toEqual(["frame_send_failed"]);
    expect(result).toHaveBeenCalledWith("sage", {
      requestId: "send-failed", status: "device_unavailable",
      stage: "dispatch", reason: "frame_send_failed",
    });
  });

  it("produces phone_disconnected_pending", () => {
    const { broker, traces } = brokerFor();
    broker.invoke({ ...invocation, requestId: "disconnect" });

    broker.disconnectDevice("device-1");

    expect(reasons(traces)).toEqual(["phone_disconnected_pending"]);
  });

  it("produces invalid_phone_payload", () => {
    const { broker, result, send, traces } = brokerFor();
    broker.invoke({ ...invocation, requestId: "invalid-result" });
    const request = send.mock.calls[0]?.[1] as { lease: string };

    broker.result("device-1", {
      type: "mobile_node_result",
      requestId: "invalid-result",
      lease: request.lease,
      status: "ok",
      result: { latitude: 41.881, longitude: -87.63 },
    } as never);

    expect(reasons(traces)).toEqual(["invalid_phone_payload"]);
    expect(result).toHaveBeenCalledWith("sage", {
      requestId: "invalid-result", status: "policy_blocked",
      stage: "response", reason: "invalid_phone_payload",
    });
  });

  it("produces broker_closed_pending", () => {
    const { broker, traces } = brokerFor();
    broker.invoke({ ...invocation, requestId: "shutdown" });

    broker.close();

    expect(reasons(traces)).toEqual(["broker_closed_pending"]);
  });

  it("refuses a malformed broker-produced request with a closed diagnostic", () => {
    const { broker, result, send } = brokerFor();
    broker.invoke({ ...invocation, requestId: "malformed", privatePath: "/secret/file" } as never);

    expect(send).not.toHaveBeenCalled();
    expect(result).toHaveBeenCalledWith("sage", {
      requestId: "malformed", status: "policy_blocked",
      stage: "dispatch", reason: "malformed_request_frame",
    });
    expect(JSON.stringify(result.mock.calls)).not.toContain("/secret/file");
  });

  it("returns a closed dispatch failure without leaking request values", () => {
    const { broker, result } = brokerFor({ send: "frame_send_failed" });

    broker.invoke({ ...invocation, requestId: "public-shape" });

    const publicResult = result.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(publicResult).toEqual({
      requestId: "public-shape", status: "device_unavailable",
      stage: "dispatch", reason: "frame_send_failed",
    });
    expect(Object.keys(publicResult).sort()).toEqual(["reason", "requestId", "stage", "status"]);
  });

  it("distinguishes unanswered, invalid phone, policy, route, and media failures", () => {
    vi.useFakeTimers();
    try {
      const { broker, result, send } = brokerFor();
      broker.invoke({ ...invocation, requestId: "unanswered", expiresAt: 1_010 });
      vi.advanceTimersByTime(10);
      broker.invoke({ ...invocation, requestId: "invalid" });
      broker.result("device-1", {
        type: "mobile_node_result", requestId: "invalid", lease: (send.mock.calls.at(-1)?.[1] as { lease: string }).lease,
        status: "ok", result: { privatePath: "/secret", latitude: 99 },
      } as never);
      broker.invoke({ ...invocation, requestId: "policy", purpose: "secret\npurpose" });
      const noRoute: MobileNodeRoute = {
        status: "selected_socket_unavailable", selectedSocketPresent: false,
        selectedSocketOpen: false, commandAdvertised: false, connectedSocketCount: 0,
      };
      const routed = brokerFor({ route: noRoute });
      routed.broker.invoke({ ...invocation, requestId: "route" });

      const media = brokerFor();
      for (const [requestId, mediaReason] of [
        ["media-validation", "media_validation_failed"],
        ["media-storage", "media_storage_failed"],
      ] as const) {
        media.broker.invoke({
          ...invocation, requestId, command: "camera.capture",
          camera: "rear", capture: "photo", videoDurationSeconds: 10,
        });
        const mediaLease = (media.send.mock.calls.at(-1)?.[1] as { lease: string }).lease;
        const claim = media.broker.beginMediaUpload("device-1", requestId, mediaLease);
        media.broker.completeMediaUpload(claim!, undefined, mediaReason);
      }

      expect(result.mock.calls.map((call) => call[1])).toEqual([
        { requestId: "unanswered", status: "expired", stage: "response", reason: "request_expired_unanswered" },
        { requestId: "invalid", status: "policy_blocked", stage: "response", reason: "invalid_phone_payload" },
        { requestId: "policy", status: "policy_blocked", stage: "policy", reason: "request_policy_rejected" },
      ]);
      expect(routed.result).toHaveBeenCalledWith("sage", {
        requestId: "route", status: "foreground_required", stage: "routing", reason: "selected_socket_unavailable",
      });
      expect(media.result.mock.calls.map((call) => call[1])).toEqual([
        { requestId: "media-validation", status: "policy_blocked", stage: "media", reason: "media_validation_failed" },
        { requestId: "media-storage", status: "policy_blocked", stage: "media", reason: "media_storage_failed" },
      ]);
      expect(JSON.stringify([...result.mock.calls, ...routed.result.mock.calls, ...media.result.mock.calls]))
        .not.toMatch(/secret|privatePath|latitude|purpose/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs only bounded fields and no forbidden request values", () => {
    const traces: string[] = [];
    const broker = new MobileNodeBroker({ receipt: () => true,
      route: () => availableRoute,
      send: () => "frame_send_failed",
      result: vi.fn(),
      now: () => 1_000,
      trace: (line) => traces.push(line),
    });
    const forbidden = [
      "device-secret", "token-secret", "purpose-secret", "41.88", "private-message", "socket-secret",
    ];

    broker.invoke({
      requestId: "private-message",
      command: "device.status",
      bot: "token-secret",
      threadId: "socket-secret",
      turnId: "turn-secret",
      expiresAt: 2_000,
      purpose: "purpose-secret",
      deviceId: "device-secret",
      agentId: "agent-secret",
    });

    const payload = JSON.parse(traces[0] ?? "{}") as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "command", "commandAdvertised", "connectedSocketCount", "event", "pendingCount",
      "reason", "selectedDevicePresent", "selectedSocketOpen", "selectedSocketPresent",
    ]);
    expect(payload).toMatchObject({
      event: "mobile_node_failure",
      reason: "frame_send_failed",
      command: "device.status",
      selectedDevicePresent: true,
      selectedSocketPresent: true,
      selectedSocketOpen: true,
      commandAdvertised: true,
      connectedSocketCount: 1,
      pendingCount: 1,
    });
    for (const value of forbidden) expect(traces.join("\n")).not.toContain(value);
  });
});

import { describe, expect, it, vi } from "vitest";

import { MobileNodeBroker, type MobileNodeRoute } from "../src/mobile-node.ts";

const purpose = "Report phone readiness";
const availableRoute: MobileNodeRoute = {
  status: "available",
  selectedSocketPresent: true,
  selectedSocketOpen: true,
  commandAdvertised: true,
  connectedSocketCount: 1,
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
    });
  });

  it("produces broker_closed_pending", () => {
    const { broker, traces } = brokerFor();
    broker.invoke({ ...invocation, requestId: "shutdown" });

    broker.close();

    expect(reasons(traces)).toEqual(["broker_closed_pending"]);
  });

  it("keeps the public typed result unchanged and omits the internal reason", () => {
    const { broker, result } = brokerFor({ send: "frame_send_failed" });

    broker.invoke({ ...invocation, requestId: "public-shape" });

    const publicResult = result.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(publicResult).toEqual({ requestId: "public-shape", status: "device_unavailable" });
    expect(Object.keys(publicResult).sort()).toEqual(["requestId", "status"]);
    expect(publicResult).not.toHaveProperty("reason");
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

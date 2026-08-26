import { describe, expect, it } from "vitest";

import type { ClientFrame, ServerFrame } from "../src/ws.ts";
import { ClientFrameSchema, ServerFrameSchema } from "../src/ws.ts";
import { check } from "../src/validate.ts";

const lease = "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678";

describe("client frames", () => {
  it("accepts only the P1 foreground/media/notification wire shapes", () => {
    for (const frame of [
      { type: "mobile_node_request", requestId: "camera", lease, command: "camera.capture", bot: "sage", threadId: "thread", turnId: "turn", expiresAt: 10, purpose: "Read a label", camera: "rear", capture: "video", videoDurationSeconds: 10 },
      { type: "mobile_node_request", requestId: "file", lease, command: "file.pick", bot: "sage", threadId: "thread", turnId: "turn", expiresAt: 10, purpose: "Read the receipt", selection: "file" },
      { type: "mobile_node_request", requestId: "notice", lease, command: "notification.present", bot: "sage", threadId: "thread", turnId: "turn", expiresAt: 10, purpose: "Approve the plan", title: "Cozy", body: "Approve?" },
    ]) expect(check(ServerFrameSchema, frame)).toBe(true);
    expect(check(ServerFrameSchema, { type: "mobile_node_request", requestId: "bad", lease, command: "camera.capture", bot: "sage", threadId: "thread", turnId: "turn", expiresAt: 10, purpose: "Read", camera: "rear", capture: "video", videoDurationSeconds: 11 })).toBe(false);
    expect(check(ClientFrameSchema, { type: "mobile_node_result", requestId: "notice", lease, status: "ok", result: { action: "approve" } })).toBe(true);
    for (const sharedDescription of ["Camera photo", "Camera video", "Selected photo", "Selected file", "Notification action"]) {
      expect(check(ServerFrameSchema, { type: "bot_mobile_receipt", requestId: "receipt", bot: "sage", sessionId: "thread", turnId: "turn", command: "camera.capture", sharedDescription, purpose: "Read", sharedAt: 1 })).toBe(true);
    }
    expect(check(ServerFrameSchema, { type: "bot_mobile_receipt", requestId: "receipt", bot: "sage", sessionId: "thread", turnId: "turn", command: "camera.capture", sharedDescription: "Camera capture", purpose: "Read", sharedAt: 1 })).toBe(false);
  });
  it("accepts auth and sync", () => {
    const auth: ClientFrame = { type: "auth", token: "tok" };
    const sync: ClientFrame = { type: "sync", threads: { t1: 0, t2: 17 } };
    expect(check(ClientFrameSchema, auth)).toBe(true);
    expect(check(ClientFrameSchema, sync)).toBe(true);
  });

  it("decodes the closed device status v2 phone result and background advertisement", () => {
    expect(check(ClientFrameSchema, {
      type: "mobile_node_advertise", commands: ["device.status"], foreground: false,
    })).toBe(true);
    expect(check(ClientFrameSchema, {
      type: "mobile_node_result", requestId: "request-1", lease, status: "ok", result: {
        appState: "background", batteryBand: "low", lowPowerMode: true,
        thermalState: "serious", networkClass: "cellular",
        capabilities: [
          { command: "device.status", permission: "not_required" },
          { command: "location.current", permission: "authorized" },
          { command: "camera.capture", permission: "authorized" },
          { command: "file.pick", permission: "not_required" },
          { command: "notification.present", permission: "not_required" },
        ],
        wakeReason: "notification_action",
      },
    })).toBe(true);
    // Genuinely unknowable optional fields are absent, not defaulted.
    expect(check(ClientFrameSchema, {
      type: "mobile_node_result", requestId: "minimal", lease, status: "ok", result: {
        appState: "foreground", lowPowerMode: false,
        capabilities: [
          { command: "device.status", permission: "not_required" },
          { command: "location.current", permission: "not_determined" },
          { command: "camera.capture", permission: "not_determined" },
          { command: "file.pick", permission: "not_required" },
          { command: "notification.present", permission: "not_required" },
        ],
      },
    })).toBe(true);
  });

  it("rejects forbidden status keys, nested extras, duplicate capabilities, and legacy v1", () => {
    const base = {
      type: "mobile_node_result", requestId: "request-1", lease, status: "ok",
      result: { appState: "foreground", lowPowerMode: false, capabilities: [
        { command: "device.status", permission: "not_required" },
        { command: "location.current", permission: "unavailable" },
        { command: "camera.capture", permission: "unavailable" },
        { command: "file.pick", permission: "not_required" },
        { command: "notification.present", permission: "not_required" },
      ] },
    };
    for (const forbidden of [
      "advertisingId", "serialNumber", "ssid", "ipAddress", "batteryPercentage",
      "identifierForVendor", "deviceName", "model", "bssid", "exactBatteryPercentage", "version",
      "authenticatedReachable", "lastAuthenticatedPresenceAt",
    ]) {
      expect(check(ClientFrameSchema, { ...base, result: { ...base.result, [forbidden]: "secret" } })).toBe(false);
    }
    expect(check(ClientFrameSchema, {
      ...base, result: { ...base.result, capabilities: [
        { command: "device.status", permission: "not_required", extra: true },
        { command: "location.current", permission: "authorized" },
      ] },
    })).toBe(false);
    expect(check(ClientFrameSchema, {
      ...base, result: { ...base.result, capabilities: [
        { command: "device.status", permission: "not_required" },
        { command: "device.status", permission: "authorized" },
      ] },
    })).toBe(false);
    for (const capabilities of [
      [{ command: "device.status", permission: "not_required" }],
      [
        { command: "location.current", permission: "authorized" },
        { command: "device.status", permission: "not_required" },
      ],
      [
        { command: "device.status", permission: "authorized" },
        { command: "location.current", permission: "not_required" },
      ],
      // Every command is present, but out of the one fixed order.
      [
        { command: "location.current", permission: "authorized" },
        { command: "device.status", permission: "not_required" },
        { command: "camera.capture", permission: "authorized" },
        { command: "file.pick", permission: "not_required" },
        { command: "notification.present", permission: "not_required" },
      ],
      // A sixth record, even a well-formed one.
      [
        { command: "device.status", permission: "not_required" },
        { command: "location.current", permission: "authorized" },
        { command: "camera.capture", permission: "authorized" },
        { command: "file.pick", permission: "not_required" },
        { command: "notification.present", permission: "not_required" },
        { command: "notification.present", permission: "not_required" },
      ],
    ]) expect(check(ClientFrameSchema, { ...base, result: { ...base.result, capabilities } })).toBe(false);
    expect(check(ClientFrameSchema, {
      type: "mobile_node_result", requestId: "legacy", lease, status: "ok", result: { foreground: true },
    })).toBe(false);
  });

  it("accepts the closed location result", () => {
    expect(check(ClientFrameSchema, {
      type: "mobile_node_result", requestId: "location-1", lease, status: "ok", result: { latitude: 41.88, longitude: -87.63 },
    })).toBe(true);
    expect(check(ClientFrameSchema, {
      type: "mobile_node_result", requestId: "location-1", lease, status: "ok", result: { latitude: 41.881, longitude: -87.63 },
    })).toBe(true); // integer-cent precision is enforced against the pending command in the broker.
    expect(check(ClientFrameSchema, {
      type: "mobile_node_result", requestId: "location-1", lease, status: "ok", result: { latitude: 91, longitude: -87.63 },
    })).toBe(false);
    expect(check(ClientFrameSchema, {
      type: "mobile_node_result", requestId: "missing-lease", status: "denied",
    })).toBe(false);
  });

  it("rejects a negative sinceSeq and an unknown type", () => {
    expect(check(ClientFrameSchema, { type: "sync", threads: { t1: -1 } })).toBe(false);
    expect(check(ClientFrameSchema, { type: "send", text: "hi" })).toBe(false);
  });
});

describe("server frames", () => {
  it("accepts the full lifecycle frames", () => {
    const frames: ServerFrame[] = [
      { type: "ready", deviceId: "d1", gateway: { name: "g", version: "0.1.0", contract: "v1" } },
      {
        type: "committed",
        threadId: "t1",
        seq: 4,
        message: {
          threadId: "t1",
          seq: 4,
          role: "agent",
          blocks: [{ type: "paragraph", text: "done" }],
          turnId: "turn-1",
          createdAt: 1,
        },
      },
      {
        type: "draft",
        threadId: "t1",
        turnId: "turn-1",
        blocks: [{ type: "paragraph", text: "thinking" }],
        toolCalls: [{ id: "c1", name: "search", status: "running" }],
      },
      { type: "done", threadId: "t1", turnId: "turn-1" },
      { type: "presence", agentId: "a1", state: "absent" },
      { type: "error", code: "backend_unavailable", message: "agent offline", threadId: "t1" },
      { type: "bot_clarify_pending", bot: "sage", sessionId: "s1", turnId: "turn-1", clarifyId: "question-1", prompt: "Choose", options: [{ id: "a", label: "A" }], expiresAt: 100, updatedAt: 1 },
      { type: "bot_clarify_resolved", bot: "sage", sessionId: "s1", turnId: "turn-1", clarifyId: "question-1", outcome: "selected", selectedOptionId: "a", updatedAt: 2 },
      { type: "bot_mobile_receipt", requestId: "request-1", bot: "sage", sessionId: "thread-1", turnId: "turn-1", command: "device.status", sharedDescription: "Device status", purpose: "Report phone readiness", sharedAt: 100 },
      { type: "synced" },
      { type: "mobile_node_request", requestId: "request-1", lease, command: "device.status", bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 100, purpose: "Report phone readiness" },
      { type: "mobile_node_request", requestId: "location-1", lease, command: "location.current", bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 100, purpose: "Find nearby coffee" },
      { type: "mobile_node_cancel", requestId: "request-1", lease, status: "cancelled" },
    ];
    for (const frame of frames) {
      expect(check(ServerFrameSchema, frame)).toBe(true);
    }
    expect(check(ServerFrameSchema, {
      type: "mobile_node_request", requestId: "legacy", command: "device.status", bot: "sage",
      threadId: "thread-1", turnId: "turn-1", expiresAt: 100, purpose: "Report phone readiness",
    })).toBe(false);
    expect(check(ServerFrameSchema, {
      type: "mobile_node_request", requestId: "bad-purpose", lease, command: "device.status", bot: "sage",
      threadId: "thread-1", turnId: "turn-1", expiresAt: 100, purpose: " bad  spacing ",
    })).toBe(false);
    expect(check(ServerFrameSchema, {
      type: "bot_mobile_receipt", requestId: "request-1", bot: "sage",
      sessionId: "thread-1", turnId: "turn-1", command: "location.current", sharedDescription: "Approximate location",
      purpose: "Find nearby coffee", sharedAt: 100, lease,
    })).toBe(false);
  });
});

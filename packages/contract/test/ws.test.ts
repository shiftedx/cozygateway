import { describe, expect, it } from "vitest";

import type { ClientFrame, ServerFrame } from "../src/ws.ts";
import { ClientFrameSchema, ServerFrameSchema } from "../src/ws.ts";
import { check } from "../src/validate.ts";

describe("client frames", () => {
  it("accepts auth and sync", () => {
    const auth: ClientFrame = { type: "auth", token: "tok" };
    const sync: ClientFrame = { type: "sync", threads: { t1: 0, t2: 17 } };
    expect(check(ClientFrameSchema, auth)).toBe(true);
    expect(check(ClientFrameSchema, sync)).toBe(true);
  });

  it("accepts only the closed foreground mobile-node advertisement and result", () => {
    expect(check(ClientFrameSchema, {
      type: "mobile_node_advertise", commands: ["device.status"], foreground: true,
    })).toBe(true);
    expect(check(ClientFrameSchema, {
      type: "mobile_node_result", requestId: "request-1", status: "ok", result: { foreground: true },
    })).toBe(true);
    expect(check(ClientFrameSchema, {
      type: "mobile_node_result", requestId: "request-1", status: "ok", result: { foreground: true, battery: 90 },
    })).toBe(false);
    expect(check(ClientFrameSchema, {
      type: "mobile_node_advertise", commands: ["device.status", "location.current"], foreground: true,
    })).toBe(true);
    expect(check(ClientFrameSchema, {
      type: "mobile_node_result", requestId: "location-1", status: "ok", result: { latitude: 41.88, longitude: -87.63 },
    })).toBe(true);
    expect(check(ClientFrameSchema, {
      type: "mobile_node_result", requestId: "location-1", status: "ok", result: { latitude: 41.881, longitude: -87.63 },
    })).toBe(true); // integer-cent precision is enforced against the pending command in the broker.
    expect(check(ClientFrameSchema, {
      type: "mobile_node_result", requestId: "location-1", status: "ok", result: { latitude: 91, longitude: -87.63 },
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
      { type: "synced" },
      { type: "mobile_node_request", requestId: "request-1", command: "device.status", bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 100 },
      { type: "mobile_node_request", requestId: "location-1", command: "location.current", bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 100, purpose: "Find nearby coffee" },
      { type: "mobile_node_cancel", requestId: "request-1", status: "cancelled" },
    ];
    for (const frame of frames) {
      expect(check(ServerFrameSchema, frame)).toBe(true);
    }
  });
});

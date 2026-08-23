import { describe, expect, it } from "vitest";
import { check } from "cozygateway-contract";

import {
  AttachV1ClientFrameSchema,
  AttachV1EventFrameSchema,
  AttachV1HelloSchema,
  AttachV1HelloV1Schema,
  AttachV1ServerFrameSchema,
} from "../src/adapters/attach/protocol-v1.ts";

describe("attach-v1 protocol", () => {
  it("negotiates version, capabilities, cursor and backpressure limits", () => {
    expect(check(AttachV1HelloSchema, {
      kind: "hello",
      version: 2,
      instanceId: "plugin-1",
      capabilities: ["draft", "media", "tools", "approvals", "clarify", "scheduled", "mobile_node", "mobile_location"],
      resume: { eventSequence: 41, commandSequence: 8 },
      limits: { maxInFlightEvents: 32, maxInFlightBytes: 1048576 },
    })).toBe(true);
    expect(check(AttachV1HelloV1Schema, {
      kind: "hello", version: 1, instanceId: "plugin-1", capabilities: ["draft", "mobile_node"],
    })).toBe(true);
    expect(check(AttachV1HelloV1Schema, {
      kind: "hello", version: 2, instanceId: "plugin-1", capabilities: ["mobile_node", "mobile_location"],
    })).toBe(false);
    expect(check(AttachV1HelloSchema, { kind: "hello", version: 0, instanceId: "x", capabilities: [] })).toBe(false);
  });

  it("accepts stable sequenced commands and all terminal event states", () => {
    expect(check(AttachV1ServerFrameSchema, {
      kind: "command",
      sequence: 9,
      commandId: "cmd-9",
      command: { kind: "turn", threadId: "thread", turnId: "turn", messageId: "user-msg", text: "hello" },
    })).toBe(true);
    expect(check(AttachV1ServerFrameSchema, {
      kind: "command",
      sequence: 10,
      commandId: "cmd-cancelled",
      command: { kind: "discard", originalKind: "resolve_approval", reason: "capability not negotiated: approvals" },
    })).toBe(true);
    for (const kind of ["commit", "failed", "cancelled", "interrupted"] as const) {
      const event = {
        kind,
        threadId: "thread",
        turnId: "turn",
        messageId: "assistant-msg",
        ...(kind === "commit" ? { blocks: [{ type: "paragraph", text: "done" }] } : {}),
      };
      expect(check(AttachV1EventFrameSchema, {
        kind: "event", sequence: 1, eventId: `event-${kind}`, event,
      })).toBe(true);
    }
  });

  it("models tools, approvals, clarifications, scheduled delivery and media by stable id", () => {
    const events = [
      { kind: "tool", threadId: "t", turnId: "u", callId: "call", name: "search", status: "running" },
      { kind: "approval", threadId: "t", turnId: "u", approvalId: "approval", callId: "call", name: "shell", status: "pending", expiresAt: 2000 },
      { kind: "clarify", threadId: "t", turnId: "u", clarifyId: "clarify", prompt: "Which?", options: [{ id: "a", label: "A" }], status: "pending", expiresAt: 2000 },
      { kind: "scheduled", threadId: "home", deliveryId: "cron-1", messageId: "m1", blocks: [{ type: "paragraph", text: "report" }] },
      { kind: "media", media: { mediaId: "media-1", mimeType: "image/png", byteCount: 8, sha256: "a".repeat(64), filename: "x.png", family: "image" } },
    ];
    events.forEach((event, index) => expect(check(AttachV1EventFrameSchema, {
      kind: "event", sequence: index + 1, eventId: `e-${index}`, event,
    })).toBe(true));
  });

  it("has replay, ack, gap and heartbeat control frames but no reasoning event", () => {
    expect(check(AttachV1ClientFrameSchema, { kind: "ack", channel: "command", sequence: 7, id: "cmd-7" })).toBe(true);
    expect(check(AttachV1ServerFrameSchema, { kind: "ack", channel: "event", sequence: 4, id: "event-4", duplicate: true })).toBe(true);
    expect(check(AttachV1ServerFrameSchema, { kind: "gap", channel: "event", requestedAfter: 1, earliestAvailable: 8, latestAvailable: 20 })).toBe(true);
    expect(check(AttachV1ClientFrameSchema, { kind: "gap", channel: "command", requestedAfter: 1, earliestAvailable: 2, latestAvailable: 4 })).toBe(true);
    expect(check(AttachV1ClientFrameSchema, { kind: "heartbeat", sentAt: 100 })).toBe(true);
    expect(check(AttachV1EventFrameSchema, { kind: "event", sequence: 1, eventId: "leak", event: { kind: "reasoning", text: "secret" } })).toBe(false);
  });

  it("keeps negotiated mobile requests and results outside the durable envelopes", () => {
    expect(check(AttachV1ClientFrameSchema, {
      kind: "mobile_request", requestId: "request-1", command: "device.status", threadId: "thread-1", turnId: "turn-1", expiresAt: 1_000,
    })).toBe(true);
    expect(check(AttachV1ClientFrameSchema, { kind: "mobile_cancel", requestId: "request-1" })).toBe(true);
    expect(check(AttachV1ClientFrameSchema, { kind: "mobile_request", requestId: "request-1", command: "device.status", threadId: "thread-1", turnId: "turn-1", expiresAt: 1_000, extra: true })).toBe(false);
    expect(check(AttachV1ClientFrameSchema, {
      kind: "mobile_request", requestId: "location-1", command: "location.current", threadId: "thread-1", turnId: "turn-1", expiresAt: 1_000, purpose: "Find coffee",
    })).toBe(true);
    expect(check(AttachV1ClientFrameSchema, {
      kind: "mobile_request", requestId: "location-1", command: "location.current", threadId: "thread-1", turnId: "turn-1", expiresAt: 1_000, purpose: "Find coffee", extra: true,
    })).toBe(false);
    expect(check(AttachV1ClientFrameSchema, { kind: "mobile_cancel", requestId: "request-1", extra: true })).toBe(false);
    expect(check(AttachV1ServerFrameSchema, {
      kind: "mobile_result", requestId: "request-1", status: "ok", result: { foreground: true },
    })).toBe(true);
    expect(check(AttachV1ServerFrameSchema, {
      kind: "mobile_result", requestId: "request-1", status: "ok", result: { foreground: true, location: "no" },
    })).toBe(false);
    expect(check(AttachV1ServerFrameSchema, {
      kind: "mobile_result", requestId: "location-1", status: "ok", result: { latitude: 41.88, longitude: -87.63 },
    })).toBe(true);
  });
});

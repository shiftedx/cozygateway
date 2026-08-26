import { describe, expect, it } from "vitest";
import { check } from "cozygateway-contract";

import {
  AttachV1ClientFrameSchema,
  AttachV1EventFrameSchema,
  AttachV1HelloSchema,
  AttachV1ServerFrameSchema,
} from "../src/adapters/attach/protocol-v1.ts";

describe("attach-v1 protocol", () => {
  it("negotiates capabilities, cursor and backpressure limits with one hello shape", () => {
    expect(check(AttachV1HelloSchema, {
      kind: "hello",
      version: 2,
      instanceId: "plugin-1",
      capabilities: ["draft", "media", "tools", "approvals", "clarify", "scheduled", "mobile_node", "mobile_location"],
      resume: { eventSequence: 41, commandSequence: 8 },
      limits: { maxInFlightEvents: 32, maxInFlightBytes: 1048576 },
      commands: [
        { name: "/status", description: "Show session status", category: "Session" },
        { name: "/queue", description: "Queue the next prompt", argsHint: "<prompt>" },
      ],
    })).toBe(true);
    // There is no second hello shape to fall back to. A peer that still speaks version 1 fails
    // the schema outright rather than negotiating a quietly reduced capability set.
    expect(check(AttachV1HelloSchema, {
      kind: "hello", version: 1, instanceId: "plugin-1", capabilities: ["draft", "mobile_node"],
    })).toBe(false);
    expect(check(AttachV1HelloSchema, {
      kind: "hello", version: 2, instanceId: "plugin-1", capabilities: ["draft"],
      telemetry: { eventOutboxDepth: 3, oldestEventAgeMs: 4, eventAckCursor: 5, commandInboxDepth: 7 },
    })).toBe(true);
    // A brand-new spool has no oldest row or ACK progress yet. Those are unknown aggregate
    // measurements, not a malformed hello that should strand the plugin before it can reconnect.
    expect(check(AttachV1HelloSchema, {
      kind: "hello", version: 2, instanceId: "fresh-plugin", capabilities: ["draft"],
      telemetry: { eventOutboxDepth: 0, oldestEventAgeMs: null, eventAckCursor: 0, commandInboxDepth: 0 },
    })).toBe(true);
    expect(check(AttachV1HelloSchema, { kind: "hello", version: 0, instanceId: "x", capabilities: [] })).toBe(false);
    expect(check(AttachV1HelloSchema, {
      kind: "hello", version: 2, instanceId: "x", capabilities: [],
      commands: [{ name: "status", description: "missing slash" }],
    })).toBe(false);
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
    expect(check(AttachV1ServerFrameSchema, {
      kind: "ack", channel: "event", sequence: 5, id: "event-5",
      discarded: true, reason: "unauthorized_target",
    })).toBe(true);
    expect(check(AttachV1ServerFrameSchema, { kind: "gap", channel: "event", requestedAfter: 1, earliestAvailable: 8, latestAvailable: 20 })).toBe(true);
    expect(check(AttachV1ClientFrameSchema, { kind: "gap", channel: "command", requestedAfter: 1, earliestAvailable: 2, latestAvailable: 4 })).toBe(true);
    expect(check(AttachV1ClientFrameSchema, { kind: "heartbeat", sentAt: 100 })).toBe(true);
    expect(check(AttachV1ClientFrameSchema, {
      kind: "heartbeat", sentAt: 100,
      telemetry: { eventOutboxDepth: 1, oldestEventAgeMs: 2, eventAckCursor: 3, commandInboxDepth: 5 },
    })).toBe(true);
    expect(check(AttachV1ClientFrameSchema, {
      kind: "heartbeat", sentAt: 100,
      telemetry: { eventOutboxDepth: 1, oldestEventAgeMs: 2, eventAckCursor: 3, commandInboxDepth: 5, lastEventAckProgressAt: 4 },
    })).toBe(false);
    // The old closed rule survives for anything unbounded: a raw `reasoning` event still fails.
    expect(check(AttachV1EventFrameSchema, { kind: "event", sequence: 1, eventId: "leak", event: { kind: "reasoning", text: "secret" } })).toBe(false);
  });

  it("lets a delegation event carry the canonical batch alias without changing identity", () => {
    const frame = {
      kind: "event", sequence: 12, eventId: "deleg-1",
      event: {
        kind: "delegation", threadId: "thread", turnId: "turn",
        batchId: "call_d3R3sBldNWhDI0Kqqqk3P2Xi", childId: "20260825_195359_003db6",
        index: 0, count: 1, status: "succeeded", lastActiveAt: 5,
        aliasId: "deleg_c6eb9310",
      },
    };
    expect(check(AttachV1EventFrameSchema, frame)).toBe(true);
    // Alias-free events stay exactly as they were: an older plugin never sends the field.
    const { aliasId: _omitted, ...bare } = frame.event;
    expect(check(AttachV1EventFrameSchema, { ...frame, event: bare })).toBe(true);
  });

  it("carries a bounded latest-only thinking preview and refuses anything past its bounds", () => {
    const event = (body: Record<string, unknown>) => ({
      kind: "event", sequence: 1, eventId: "think-1",
      event: { kind: "thinking", threadId: "thread", turnId: "turn", text: "weighing the two options", seq: 1, lastActiveAt: 1_800_000_000_000, ...body },
    });
    expect(check(AttachV1EventFrameSchema, event({}))).toBe(true);
    expect(check(AttachV1EventFrameSchema, event({ text: "x".repeat(280) }))).toBe(true);
    // The 280-char cap is enforced ON THE SCHEMA: an unsanitized peer cannot exceed it.
    expect(check(AttachV1EventFrameSchema, event({ text: "x".repeat(281) }))).toBe(false);
    // `seq` starts at 1 and is an integer: 0 and fractions cannot express "latest".
    expect(check(AttachV1EventFrameSchema, event({ seq: 0 }))).toBe(false);
    expect(check(AttachV1EventFrameSchema, event({ seq: 1.5 }))).toBe(false);
    expect(check(AttachV1EventFrameSchema, event({ lastActiveAt: -1 }))).toBe(false);
    // The preview is one bounded text field: no blocks, args, or attachments ride along.
    expect(check(AttachV1EventFrameSchema, event({ seq: undefined }))).toBe(false);
  });

  it("keeps negotiated mobile requests and results outside the durable envelopes", () => {
    expect(check(AttachV1ClientFrameSchema, {
      kind: "mobile_request", requestId: "request-1", command: "device.status", threadId: "thread-1", turnId: "turn-1", expiresAt: 1_000, purpose: "Report phone readiness",
    })).toBe(true);
    expect(check(AttachV1ClientFrameSchema, { kind: "mobile_cancel", requestId: "request-1" })).toBe(true);
    expect(check(AttachV1ClientFrameSchema, { kind: "mobile_request", requestId: "request-1", command: "device.status", threadId: "thread-1", turnId: "turn-1", expiresAt: 1_000 })).toBe(false);
    expect(check(AttachV1ClientFrameSchema, { kind: "mobile_request", requestId: "request-1", command: "device.status", threadId: "thread-1", turnId: "turn-1", expiresAt: 1_000, purpose: " bad  spacing " })).toBe(false);
    expect(check(AttachV1ClientFrameSchema, {
      kind: "mobile_request", requestId: "location-1", command: "location.current", threadId: "thread-1", turnId: "turn-1", expiresAt: 1_000, purpose: "Find coffee",
    })).toBe(true);
    expect(check(AttachV1ClientFrameSchema, {
      kind: "mobile_request", requestId: "location-1", command: "location.current", threadId: "thread-1", turnId: "turn-1", expiresAt: 1_000, purpose: "Find coffee", extra: true,
    })).toBe(false);
    expect(check(AttachV1ClientFrameSchema, { kind: "mobile_cancel", requestId: "request-1", extra: true })).toBe(false);
    expect(check(AttachV1ServerFrameSchema, {
      kind: "mobile_result", requestId: "request-1", status: "ok", result: {
        appState: "background", batteryBand: "high", lowPowerMode: false, thermalState: "fair",
        networkClass: "wifi", capabilities: [
          { command: "device.status", permission: "not_required" },
          { command: "location.current", permission: "authorized" },
        ],
        wakeReason: "deep_link", authenticatedReachable: true, lastAuthenticatedPresenceAt: 1_234,
      },
    })).toBe(true);
    expect(check(AttachV1ServerFrameSchema, {
      kind: "mobile_result", requestId: "request-1", status: "ok", result: {
        appState: "foreground", lowPowerMode: false,
        capabilities: [
          { command: "device.status", permission: "not_required", ssid: "secret" },
          { command: "location.current", permission: "authorized" },
        ],
        authenticatedReachable: true, lastAuthenticatedPresenceAt: 1_234,
      },
    })).toBe(false);
    expect(check(AttachV1ServerFrameSchema, {
      kind: "mobile_result", requestId: "legacy", status: "ok", result: { foreground: true },
    })).toBe(false);
    expect(check(AttachV1ServerFrameSchema, {
      kind: "mobile_result", requestId: "location-1", status: "ok", result: { latitude: 41.88, longitude: -87.63 },
    })).toBe(true);
  });
});

import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileNodeGatewayStatusResult } from "cozygateway-contract";

import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1EventFrame, AttachV1MemoryResult, AttachV1MobileRequest, AttachV1ServerFrame } from "../src/adapters/attach/protocol-v1.ts";
import { openStorage, type Storage } from "../src/storage.ts";

const gatewayStatus: MobileNodeGatewayStatusResult = {
  appState: "background" as const, lowPowerMode: false,
  capabilities: [
    { command: "device.status" as const, permission: "not_required" as const },
    { command: "location.current" as const, permission: "authorized" as const },
    { command: "camera.capture" as const, permission: "authorized" as const },
    { command: "file.pick" as const, permission: "not_required" as const },
    { command: "notification.present" as const, permission: "not_required" as const },
  ],
  authenticatedReachable: true as const, lastAuthenticatedPresenceAt: 1_234,
};

describe("attach-v1 ingress", () => {
  let server: Server;
  let port: number;
  let storage: Storage;
  let ingress: AttachV1Ingress;
  let accepted: AttachV1EventFrame[];
  let presence: string[];
  let clock: number;
  let projectionSucceeds: boolean;
  let traces: string[];
  let mobileRequests: AttachV1MobileRequest[];
  let mobileCancels: string[];
  let acceptsTarget: boolean;
  let memoryResults: AttachV1MemoryResult[];
  let logs: string[];

  beforeEach(async () => {
    storage = openStorage(":memory:");
    accepted = [];
    presence = [];
    clock = 0;
    projectionSucceeds = true;
    traces = [];
    mobileRequests = [];
    mobileCancels = [];
    acceptsTarget = true;
    memoryResults = [];
    logs = [];
    ingress = new AttachV1Ingress({
      tokens: new Map([
        ["secret", "sage"],
        ["soak-1", "soak-1"], ["soak-2", "soak-2"], ["soak-3", "soak-3"],
        ["soak-4", "soak-4"], ["soak-5", "soak-5"], ["soak-6", "soak-6"],
      ]), storage,
      events: {
        onEvent: (_agent, frame) => { accepted.push(frame); return projectionSucceeds; },
        canAcceptEvent: () => acceptsTarget,
        onPresence: (_agent, state) => presence.push(state),
        onMobileRequest: (_agent, frame) => mobileRequests.push(frame),
        onMobileCancel: (_agent, frame) => mobileCancels.push(frame.requestId),
        onMemoryResult: (_agent, frame) => memoryResults.push(frame),
      },
      now: () => clock,
      heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 5000,
      projectionRetryMs: 10,
      projectionMaxAttempts: 3,
      trace: (line) => traces.push(line),
      log: (line) => logs.push(line),
    });
    server = createServer();
    server.on("upgrade", (req, socket, head) => ingress.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
  });

  afterEach(async () => {
    ingress.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
  });

  async function dial(
    limits?: { maxInFlightEvents: number; maxInFlightBytes: number },
    capabilities: string[] = ["draft"],
    resume = { eventSequence: 0, commandSequence: 0 },
    peer: { token?: string; instanceId?: string; heartbeatAckLimit?: number; commands?: Array<{ name: string; description: string; argsHint?: string; category?: string }> } = {},
  ): Promise<{ ws: WebSocket; frames: AttachV1ServerFrame[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/attach/v1`, { headers: { authorization: `Bearer ${peer.token ?? "secret"}` } });
    const frames: AttachV1ServerFrame[] = [];
    let acknowledgedHeartbeats = 0;
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as AttachV1ServerFrame;
      frames.push(frame);
      if (frame.kind === "heartbeat" && acknowledgedHeartbeats < (peer.heartbeatAckLimit ?? 0)) {
        acknowledgedHeartbeats += 1;
        ws.send(JSON.stringify({ kind: "heartbeat", sentAt: frame.sentAt }));
      }
    });
    await once(ws, "open");
    ws.send(JSON.stringify({ kind: "hello", version: 2, instanceId: peer.instanceId ?? "plugin", capabilities, resume, ...(limits === undefined ? {} : { limits }), ...(peer.commands === undefined ? {} : { commands: peer.commands }) }));
    await until(() => frames.some((frame) => frame.kind === "hello_ack"));
    return { ws, frames };
  }

  it("keeps the command catalog across a drop and lets a new authenticated hello clear it", async () => {
    const commands = [
      { name: "/status", description: "Show session status", category: "Session" },
      { name: "/queue", description: "Queue the next prompt", argsHint: "<prompt>" },
    ];
    const peer = await dial(undefined, ["draft"], undefined, { commands });
    expect(ingress.commandCatalog("sage")).toEqual(commands);

    peer.ws.close();
    await once(peer.ws, "close");
    expect(ingress.commandCatalog("sage")).toEqual(commands);

    const replacement = await dial(undefined, ["draft"], undefined, { commands: [] });
    expect(ingress.commandCatalog("sage")).toEqual([]);
    replacement.ws.close();
  });

  it("requires hello, negotiates v1, and replays an unacked durable command", async () => {
    expect(ingress.sendTurn("sage", { kind: "turn", threadId: "t", turnId: "u", text: "hello" })).toBe(true);
    const first = await dial();
    await until(() => first.frames.some((frame) => frame.kind === "command"));
    const command = first.frames.find((frame) => frame.kind === "command");
    expect(command).toMatchObject({ kind: "command", sequence: 1, command: { kind: "turn", threadId: "t", turnId: "u" } });
    first.ws.close();
    await once(first.ws, "close");

    const second = await dial();
    await until(() => second.frames.some((frame) => frame.kind === "command"));
    expect(second.frames.find((frame) => frame.kind === "command")).toMatchObject({ kind: "command", sequence: 1 });
    second.ws.send(JSON.stringify({ kind: "ack", channel: "command", sequence: 1, id: (command as { commandId: string }).commandId }));
    await until(() => storage.pendingAttachCommands("sage", 0, 10).length === 0);
    second.ws.close();
  });

  it("routes negotiated mobile frames without creating a durable event or command", async () => {
    const peer = await dial(undefined, ["mobile_node"]);
    peer.ws.send(JSON.stringify({ kind: "mobile_request", requestId: "request-1", command: "device.status", threadId: "thread-1", turnId: "turn-1", expiresAt: 1_000, purpose: "Private status purpose" }));
    peer.ws.send(JSON.stringify({ kind: "mobile_cancel", requestId: "request-1" }));
    await until(() => mobileRequests.length === 1 && mobileCancels.length === 1);

    expect(ingress.sendMobileResult("sage", { requestId: "request-1", status: "ok", result: gatewayStatus })).toBe(true);
    await until(() => peer.frames.some((frame) => frame.kind === "mobile_result"));
    expect(ingress.sendMobileResult("sage", {
      requestId: "forbidden", status: "ok", result: { ...gatewayStatus, serialNumber: "secret" },
    } as never)).toBe(false);
    expect(peer.frames.some((frame) => frame.kind === "mobile_result" && frame.requestId === "forbidden")).toBe(false);
    expect(storage.attachEventCursor("sage")).toBe(0);
    expect(storage.attachCommandCursor("sage")).toBe(0);
    expect(storage.pendingAttachCommands("sage", 0, 10)).toEqual([]);
    expect([...logs, ...traces].join("\n")).not.toContain("Private status purpose");
    expect([...logs, ...traces].join("\n")).not.toContain("background");
    peer.ws.close();
  });

  it("sends only closed mobile failure details", async () => {
    const detailed = await dial(undefined, ["mobile_node"]);
    expect(ingress.sendMobileResult("sage", {
      requestId: "detailed-failure", status: "device_unavailable",
      stage: "dispatch", reason: "frame_send_failed",
    })).toBe(true);
    await until(() => detailed.frames.some((frame) => frame.kind === "mobile_result"));
    expect(detailed.frames.find((frame) => frame.kind === "mobile_result")).toEqual({
      kind: "mobile_result", requestId: "detailed-failure", status: "device_unavailable",
      stage: "dispatch", reason: "frame_send_failed",
    });
    expect(ingress.sendMobileResult("sage", {
      requestId: "unknown", status: "policy_blocked", stage: "payload-secret", reason: "token-secret",
    } as never)).toBe(false);
    expect(ingress.sendMobileResult("sage", {
      requestId: "false-success", status: "ok", result: gatewayStatus,
      stage: "response", reason: "invalid_phone_payload",
    } as never)).toBe(false);
    detailed.ws.close();
  });

  it("routes memory requests and results live without writing raw content to storage", async () => {
    const peer = await dial(undefined, ["memory_management"]);
    expect(ingress.sendMemoryRequest("sage", {
      kind: "memory_request", requestId: "memory-1", operation: "update",
      input: { sourceId: "vault:0", itemId: "note:Cleo.md", content: "private-memory", expectedRevision: "r1" },
    })).toBe("sent");
    await until(() => peer.frames.some((frame) => frame.kind === "memory_request"));
    peer.ws.send(JSON.stringify({
      kind: "memory_result", requestId: "memory-1", status: "ok",
      result: { item: { id: "note:Cleo.md", sourceId: "vault:0", kind: "note", title: "Cleo", snippet: "private-memory", timestampKind: "unknown", revision: "r2" } },
    }));
    await until(() => memoryResults.length === 1);

    expect(storage.attachEventCursor("sage")).toBe(0);
    expect(storage.attachCommandCursor("sage")).toBe(0);
    expect(storage.pendingAttachCommands("sage", 0, 10)).toEqual([]);
    peer.ws.close();
  });

  it("requires memory_setup in addition to memory_management for setup only", async () => {
    const oldPeer = await dial(undefined, ["memory_management"]);
    expect(ingress.sendMemoryRequest("sage", {
      kind: "memory_request", requestId: "setup-old", operation: "setup",
      input: { memoryEnabled: true, userProfileEnabled: false, holographicEnabled: false },
    })).toBe("capability_not_negotiated");
    oldPeer.ws.close();
    await until(() => !ingress.isAttached("sage"));

    const currentPeer = await dial(undefined, ["memory_management", "memory_setup"]);
    expect(ingress.sendMemoryRequest("sage", {
      kind: "memory_request", requestId: "setup-current", operation: "setup",
      input: { memoryEnabled: true, userProfileEnabled: false, holographicEnabled: false },
    })).toBe("sent");
    await until(() => currentPeer.frames.some((frame) => frame.kind === "memory_request"));
    expect(currentPeer.frames.find((frame) => frame.kind === "memory_request")).toMatchObject({ operation: "setup" });
    currentPeer.ws.close();
  });

  it("keeps location behind mobile_location while preserving status-only mobile_node peers", async () => {
    const oldPeer = await dial(undefined, ["mobile_node"]);
    expect(oldPeer.frames.find((frame) => frame.kind === "hello_ack")).toMatchObject({ capabilities: ["mobile_node"] });
    oldPeer.ws.send(JSON.stringify({ kind: "mobile_request", requestId: "status-1", command: "device.status", threadId: "thread-1", turnId: "turn-1", expiresAt: 1_000, purpose: "Report phone readiness" }));
    await until(() => mobileRequests.some((frame) => frame.requestId === "status-1"));
    expect(ingress.sendMobileResult("sage", { requestId: "location-old-result", status: "ok", result: { latitude: 41.88, longitude: -87.63 } })).toBe(false);
    expect(oldPeer.frames.some((frame) => frame.kind === "mobile_result" && frame.requestId === "location-old-result")).toBe(false);
    oldPeer.ws.send(JSON.stringify({ kind: "mobile_request", requestId: "location-old", command: "location.current", threadId: "thread-1", turnId: "turn-1", expiresAt: 1_000, purpose: "Find coffee" }));
    await once(oldPeer.ws, "close");
    expect(mobileRequests.some((frame) => frame.requestId === "location-old")).toBe(false);

    const newPeer = await dial(undefined, ["mobile_node", "mobile_location"]);
    expect(newPeer.frames.find((frame) => frame.kind === "hello_ack")).toMatchObject({ capabilities: ["mobile_node", "mobile_location"] });
    newPeer.ws.send(JSON.stringify({ kind: "mobile_request", requestId: "location-new", command: "location.current", threadId: "thread-1", turnId: "turn-1", expiresAt: 1_000, purpose: "Find coffee" }));
    await until(() => mobileRequests.some((frame) => frame.requestId === "location-new"));
    expect(ingress.sendMobileResult("sage", { requestId: "location-new", status: "ok", result: { latitude: 41.88, longitude: -87.63 } })).toBe(true);
    await until(() => newPeer.frames.some((frame) => frame.kind === "mobile_result" && frame.requestId === "location-new"));
    newPeer.ws.close();
  });

  it("reconciles a lost command ACK from the plugin's durable resume cursor without replay", async () => {
    ingress.sendTurn("sage", { kind: "turn", threadId: "t", turnId: "u", text: "once" });
    const first = await dial();
    await until(() => first.frames.some((frame) => frame.kind === "command"));
    // The plugin durably executed sequence 1, but its ACK was lost with the socket.
    first.ws.close();
    await once(first.ws, "close");

    const second = await dial(undefined, ["draft"], { eventSequence: 0, commandSequence: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(second.frames.filter((frame) => frame.kind === "command")).toEqual([]);
    expect(second.frames.find((frame) => frame.kind === "hello_ack")).toMatchObject({ resume: { commandSequence: 1 } });
    expect(storage.pendingAttachCommands("sage", 0, 10)).toEqual([]);
    second.ws.close();
  });

  it("intersects capabilities and quarantines unsupported events without dropping the agent", async () => {
    const { ws, frames } = await dial(undefined, ["draft", "tools"]);
    expect(frames.find((frame) => frame.kind === "hello_ack")).toMatchObject({ capabilities: ["draft", "tools"] });
    expect(ingress.sendApprovalResolution("sage", { threadId: "t", turnId: "u", approvalId: "a", decision: "approve" })).toBe(false);
    ws.send(JSON.stringify({ kind: "event", sequence: 1, eventId: "approval", event: { kind: "approval", threadId: "t", turnId: "u", approvalId: "a", callId: "c", name: "tool", status: "pending" } }));
    await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.id === "approval"));
    expect(frames.find((frame) => frame.kind === "ack" && frame.id === "approval")).toMatchObject({
      discarded: true, reason: "capability_not_negotiated",
    });
    ws.send(JSON.stringify({ kind: "event", sequence: 2, eventId: "draft-after", event: { kind: "draft", threadId: "t", turnId: "u", blocks: [] } }));
    await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.id === "draft-after"));
    expect(storage.attachEventCursor("sage")).toBe(2);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("quarantines desktop session sync rows unless that capability was negotiated", async () => {
    const { ws, frames } = await dial(undefined, ["draft"]);
    ws.send(JSON.stringify({
      kind: "event", sequence: 1, eventId: "desktop-sync-disabled",
      event: {
        kind: "desktop_session_message", threadId: "native-chat", hermesSessionId: "raw-current",
        source: "cozygateway", rowId: "row-1", role: "assistant", text: "must not project", at: 1,
      },
    }));
    await until(() => frames.some((frame) => frame.kind === "ack" && frame.id === "desktop-sync-disabled"));
    expect(frames.find((frame) => frame.kind === "ack" && frame.id === "desktop-sync-disabled")).toMatchObject({
      discarded: true, reason: "capability_not_negotiated",
    });
    expect(accepted).toEqual([]);
    ws.close();
  });

  it("quarantines an unauthorized target and continues with the next valid event", async () => {
    const { ws, frames } = await dial(undefined, ["draft"]);
    acceptsTarget = false;
    ws.send(JSON.stringify({ kind: "event", sequence: 1, eventId: "bad-target", event: { kind: "draft", threadId: "retired", turnId: "u", blocks: [] } }));
    await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.id === "bad-target"));
    expect(frames.find((frame) => frame.kind === "ack" && frame.id === "bad-target")).toMatchObject({
      discarded: true, reason: "unauthorized_target",
    });
    acceptsTarget = true;
    ws.send(JSON.stringify({ kind: "event", sequence: 2, eventId: "good-target", event: { kind: "draft", threadId: "current", turnId: "u", blocks: [] } }));
    await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.id === "good-target"));
    expect(accepted.map((frame) => frame.eventId)).toEqual(["good-target"]);
    expect(storage.attachEventCursor("sage")).toBe(2);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("applies independent server-side feature gates during negotiation and routing", async () => {
    ingress.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
    storage = openStorage(":memory:");
    ingress = new AttachV1Ingress({
      tokens: new Map([["secret", "sage"]]),
      storage,
      allowedCapabilities: new Map([["sage", new Set(["draft", "tools", "clarify"] as const)]]),
      events: { onEvent: (_agent, frame) => { accepted.push(frame); return true; }, onPresence: () => undefined },
    });
    server = createServer();
    server.on("upgrade", (req, socket, head) => ingress.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;

    const { ws, frames } = await dial(undefined, ["draft", "media", "tools", "approvals", "clarify", "scheduled"]);
    expect(frames.find((frame) => frame.kind === "hello_ack")).toMatchObject({ capabilities: ["draft", "tools", "clarify"] });
    expect(ingress.sendApprovalResolution("sage", { threadId: "t", turnId: "u", approvalId: "a", decision: "approve" })).toBe(false);
    expect(ingress.sendClarifyResolution("sage", { threadId: "t", turnId: "u", clarifyId: "q", optionId: "x" })).toBe(true);
    ws.send(JSON.stringify({ kind: "event", sequence: 1, eventId: "scheduled-disabled", event: { kind: "scheduled", threadId: "home", deliveryId: "d", messageId: "m", blocks: [{ type: "paragraph", text: "no" }] } }));
    await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.id === "scheduled-disabled"));
    expect(frames.find((frame) => frame.kind === "ack" && frame.id === "scheduled-disabled")).toMatchObject({
      discarded: true, reason: "capability_not_negotiated",
    });
    expect(storage.attachEventCursor("sage")).toBe(1);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("converts a downgraded queued command to a durable discard and continues compatible turns", async () => {
    expect(ingress.sendApprovalResolution("sage", { threadId: "t", turnId: "u", approvalId: "a", decision: "approve" }, "approval-command")).toBe(true);
    expect(ingress.sendTurn("sage", { kind: "turn", threadId: "t", turnId: "next", text: "compatible" })).toBe(true);
    const { ws, frames } = await dial(undefined, ["draft"]);
    await until(() => frames.filter((frame) => frame.kind === "command").length === 2);
    const commands = frames.filter((frame) => frame.kind === "command");
    expect(commands[0]).toMatchObject({ sequence: 1, commandId: "approval-command", command: { kind: "discard", originalKind: "resolve_approval", reason: "capability not negotiated: approvals" } });
    expect(commands[1]).toMatchObject({ sequence: 2, command: { kind: "turn", turnId: "next", text: "compatible" } });
    expect(storage.attachCommandCancellation("sage", 1)).toMatchObject({ reason: "capability not negotiated: approvals" });
    for (const frame of commands) {
      if (frame.kind === "command") ws.send(JSON.stringify({ kind: "ack", channel: "command", sequence: frame.sequence, id: frame.commandId }));
    }
    await until(() => storage.attachCommandCursor("sage") === 2);
    ws.close();
  });

  it("durably ACKs events, deduplicates ACK loss, reports sequence gaps, and ignores a late draft", async () => {
    const { ws, frames } = await dial();
    const commit = { kind: "event", sequence: 1, eventId: "e1", event: { kind: "commit", threadId: "t", turnId: "u", messageId: "m", blocks: [{ type: "paragraph", text: "done" }] } };
    ws.send(JSON.stringify(commit));
    await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event"));
    ws.send(JSON.stringify(commit));
    await until(() => frames.filter((frame) => frame.kind === "ack" && frame.channel === "event").length === 2);
    ws.send(JSON.stringify({ kind: "event", sequence: 3, eventId: "e3", event: { kind: "draft", threadId: "t", turnId: "u", blocks: [] } }));
    await until(() => frames.some((frame) => frame.kind === "gap"));
    ws.send(JSON.stringify({ kind: "event", sequence: 2, eventId: "e2", event: { kind: "draft", threadId: "t", turnId: "u", blocks: [] } }));
    await until(() => frames.some((frame) => frame.kind === "ack" && frame.sequence === 2));
    expect(accepted.map((frame) => frame.eventId)).toEqual(["e1"]);
    expect(frames.find((frame) => frame.kind === "gap")).toMatchObject({ requestedAfter: 1, earliestAvailable: 2 });
    ws.close();
  });

  it("bounds unacked commands and advances only after ACK", async () => {
    const { ws, frames } = await dial({ maxInFlightEvents: 1, maxInFlightBytes: 4096 });
    expect(frames.find((frame) => frame.kind === "hello_ack")).toMatchObject({ limits: { maxInFlightEvents: 1, maxInFlightBytes: 4096 } });
    ingress.sendTurn("sage", { kind: "turn", threadId: "t", turnId: "u1", text: "one" });
    ingress.sendTurn("sage", { kind: "turn", threadId: "t", turnId: "u2", text: "two" });
    await until(() => frames.some((frame) => frame.kind === "command"));
    expect(frames.filter((frame) => frame.kind === "command").every((frame) => frame.kind === "command" && frame.sequence === 1)).toBe(true);
    const first = frames.find((frame) => frame.kind === "command")!;
    ws.send(JSON.stringify({ kind: "ack", channel: "command", sequence: 1, id: first.kind === "command" ? first.commandId : "" }));
    await until(() => frames.some((frame) => frame.kind === "command" && frame.sequence === 2));
    ws.close();
  });

  it("ACKs only after durable admission but retries a failed projection after correction", async () => {
    projectionSucceeds = false;
    const { ws, frames } = await dial(undefined, ["scheduled"]);
    ws.send(JSON.stringify({ kind: "event", sequence: 1, eventId: "retry-me", event: { kind: "scheduled", threadId: "home", deliveryId: "delivery", messageId: "message", blocks: [{ type: "paragraph", text: "hello" }] } }));
    await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event"));
    expect(storage.unappliedAttachEvents("sage").map((frame) => frame.eventId)).toEqual(["retry-me"]);

    projectionSucceeds = true;
    await until(() => storage.unappliedAttachEvents("sage").length === 0);
    expect(accepted.map((frame) => frame.eventId)).toEqual(["retry-me", "retry-me"]);
    ws.close();
  });

  it("dead-letters a persistently unprojectable event after bounded attempts", async () => {
    projectionSucceeds = false;
    const { ws, frames } = await dial(undefined, ["scheduled"]);
    ws.send(JSON.stringify({ kind: "event", sequence: 1, eventId: "bad-projection", event: { kind: "scheduled", threadId: "home", deliveryId: "delivery-bad", messageId: "message-bad", blocks: [{ type: "paragraph", text: "hello" }] } }));
    await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event"));
    ws.send(JSON.stringify({ kind: "event", sequence: 2, eventId: "later-event", event: { kind: "scheduled", threadId: "home", deliveryId: "delivery-later", messageId: "message-later", blocks: [{ type: "paragraph", text: "later" }] } }));
    await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 2));
    await until(() => storage.attachProjectionFailure("sage", "bad-projection")?.deadLetteredAt !== undefined);
    expect(storage.attachProjectionFailure("sage", "bad-projection")).toMatchObject({ attempts: 3, error: "projection declined event" });
    expect(storage.unappliedAttachEvents("sage")).toEqual([]);
    ingress.replayUnapplied("sage");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(accepted.some((frame) => frame.eventId === "later-event")).toBe(false);

    projectionSucceeds = true;
    expect(ingress.releaseProjectionDeadLetter("sage", "bad-projection")).toBe(true);
    await until(() => accepted.some((frame) => frame.eventId === "later-event"));
    expect(accepted.slice(-2).map((frame) => frame.eventId)).toEqual(["bad-projection", "later-event"]);
    ws.close();
  });

  it("tracks the sent window without heartbeat/enqueue resends exceeding it", async () => {
    const { ws, frames } = await dial({ maxInFlightEvents: 2, maxInFlightBytes: 8192 });
    for (let index = 1; index <= 4; index += 1) {
      ingress.sendTurn("sage", { kind: "turn", threadId: "t", turnId: `u${index}`, text: `${index}` });
    }
    await until(() => frames.filter((frame) => frame.kind === "command").length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frames.filter((frame) => frame.kind === "command").map((frame) => frame.kind === "command" ? frame.sequence : 0)).toEqual([1, 2]);
    const first = frames.find((frame) => frame.kind === "command" && frame.sequence === 1)!;
    ws.send(JSON.stringify({ kind: "ack", channel: "command", sequence: 1, id: first.kind === "command" ? first.commandId : "" }));
    await until(() => frames.some((frame) => frame.kind === "command" && frame.sequence === 3));
    expect(frames.filter((frame) => frame.kind === "command").map((frame) => frame.kind === "command" ? frame.sequence : 0)).toEqual([1, 2, 3]);
    ws.close();
  });

  it("bounds the cumulative unacked command byte window and refills it on ACK", async () => {
    const { ws, frames } = await dial({ maxInFlightEvents: 10, maxInFlightBytes: 1024 });
    ingress.sendTurn("sage", { kind: "turn", threadId: "t", turnId: "u1", text: "x".repeat(650) });
    ingress.sendTurn("sage", { kind: "turn", threadId: "t", turnId: "u2", text: "y".repeat(650) });
    await until(() => frames.some((frame) => frame.kind === "command"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(frames.filter((frame) => frame.kind === "command").map((frame) => frame.kind === "command" ? frame.sequence : 0)).toEqual([1]);
    const first = frames.find((frame) => frame.kind === "command")!;
    ws.send(JSON.stringify({ kind: "ack", channel: "command", sequence: 1, id: first.kind === "command" ? first.commandId : "" }));
    await until(() => frames.some((frame) => frame.kind === "command" && frame.sequence === 2));
    ws.close();
  });

  it("uses negotiated heartbeats to move online through degraded to absent", async () => {
    const { ws, frames } = await dial();
    expect(presence).toContain("online");
    await until(() => frames.some((frame) => frame.kind === "heartbeat"), 1_500);
    clock = 2_500;
    await until(() => presence.includes("degraded"), 1_500);
    clock = 6_000;
    await until(() => presence.includes("absent"), 1_500);
    await until(() => ws.readyState !== WebSocket.OPEN, 1_500);
  });

  it("treats plugin heartbeats as acknowledgements instead of echoing them", async () => {
    const { ws, frames } = await dial();
    ws.send(JSON.stringify({ kind: "heartbeat", sentAt: 42 }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(frames.filter((frame) => frame.kind === "heartbeat")).toEqual([]);
    ws.close();
  });

  it("summarizes aggregate connection state and the last actual heartbeat without identities", async () => {
    expect(ingress.health()).toMatchObject({ configured: 7, online: 0, degraded: 0, absent: 7, lastHeartbeatAt: null });
    const { ws } = await dial();
    expect(ingress.health()).toMatchObject({ configured: 7, online: 1, degraded: 0, absent: 6, lastHeartbeatAt: null });
    clock = 123;
    ws.send(JSON.stringify({ kind: "heartbeat", sentAt: 123 }));
    await until(() => ingress.health().lastHeartbeatAt === 123);
    expect(ingress.health()).toMatchObject({ lastHeartbeatAt: 123, queueDepth: 0, deadLetters: 0 });
    ws.close();
  });

  it("traces transitions without heartbeat volume or frame content", async () => {
    const { ws } = await dial();
    await until(() => traces.some((line) => JSON.parse(line).event === "attach_hello"));
    const beforeHeartbeats = traces.length;
    clock = 99;
    for (let index = 0; index < 5; index += 1) ws.send(JSON.stringify({ kind: "heartbeat", sentAt: index }));
    await until(() => ingress.health().lastHeartbeatAt === 99);
    expect(traces).toHaveLength(beforeHeartbeats);
    const joined = traces.join("\n");
    expect(joined).not.toContain("secret");
    expect(joined).not.toContain("hello required");
    expect(traces.every((line) => /^[0-9a-f]{16}$/.test(JSON.parse(line).profile))).toBe(true);
    ws.close();
  });

  it("closes safely after storage teardown while a trace sink is installed", async () => {
    const { ws } = await dial();
    storage.close();
    // Preserve afterEach ownership while the ingress deliberately retains the closed handle.
    storage = openStorage(":memory:");
    ws.close();
    await once(ws, "close");
    await until(() => traces.some((line) => JSON.parse(line).event === "attach_close"));
  });

  it("keeps six acknowledged peers at one heartbeat per profile per interval", async () => {
    const pendingReads = vi.spyOn(storage, "pendingAttachCommands");
    // The cap is unused by the fixed protocol (three gateway heartbeats, three ACKs), but makes
    // the regression bounded if an echo turns every ACK into another server heartbeat.
    const peers = await Promise.all(Array.from({ length: 6 }, (_, index) => dial(
      undefined,
      ["draft"],
      undefined,
      { token: `soak-${index + 1}`, instanceId: `soak-${index + 1}`, heartbeatAckLimit: 3 },
    )));
    const readsAfterHello = pendingReads.mock.calls.length;
    await until(() => peers.every(({ frames }) => frames.filter((frame) => frame.kind === "heartbeat").length >= 3), 4_000);
    const heartbeatCounts = peers.map(({ frames }) => frames.filter((frame) => frame.kind === "heartbeat").length);
    expect(heartbeatCounts).toEqual([3, 3, 3, 3, 3, 3]);
    expect(heartbeatCounts.reduce((total, count) => total + count, 0)).toBe(18);
    expect(pendingReads).toHaveBeenCalledTimes(readsAfterHello);
    peers.forEach(({ ws }) => ws.close());
  });

  // Regression: the hello a real Hermes profile sends in production. Every field here is what the
  // attach plugin actually puts on the wire (all nine capabilities, a spool telemetry snapshot, a
  // full command catalog, cursors from a long-lived stream). A hello that fails validation now
  // closes the socket out loud, so an unparseable production shape takes the profile offline
  // instead of quietly costing it the memory surface for hours. Keep this parseable.
  it("negotiates memory_management from the full production-shaped hello", async () => {
    const commands = Array.from({ length: 512 }, (_, index) => ({
      name: `/command_${index}`, description: "x".repeat(200), argsHint: "y".repeat(160), category: "z".repeat(80),
    }));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/attach/v1`, { headers: { authorization: "Bearer secret" } });
    const frames: AttachV1ServerFrame[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as AttachV1ServerFrame));
    await once(ws, "open");
    ws.send(JSON.stringify({
      kind: "hello", version: 2, instanceId: "b3f2c1d0-1111-2222-3333-444455556666",
      capabilities: ["draft", "media", "tools", "approvals", "clarify", "scheduled", "mobile_node", "mobile_location", "memory_management"],
      resume: { eventSequence: 0, commandSequence: 0 },
      limits: { maxInFlightEvents: 64, maxInFlightBytes: 4 * 1024 * 1024 },
      commands,
      telemetry: { eventOutboxDepth: 12, oldestEventAgeMs: 7 * 24 * 60 * 60 * 1000, eventAckCursor: 106738, commandInboxDepth: 3 },
    }));
    await until(() => frames.some((frame) => frame.kind === "hello_ack"));
    const ack = frames.find((frame) => frame.kind === "hello_ack") as unknown as { version: number; capabilities: string[] };
    expect(ack.version).toBe(2);
    expect(ack.capabilities).toContain("memory_management");
    expect(ingress.sendMemoryRequest("sage", { kind: "memory_request", requestId: "m1", operation: "overview", input: {} })).toBe("sent");
    // The negotiated set is the only thing that decides whether the memory lane exists at all, so
    // it has to be readable from a log instead of inferred from a 503 hours later.
    expect(logs.some((line) => line.includes("negotiated hello v2") && line.includes("memory_management"))).toBe(true);
    ws.close();
  });

  // Regression: the gateway used to answer an older hello with a silently reduced capability set,
  // so a peer built against the previous shape looked attached and healthy while its memory and
  // location surfaces were dead. There is one hello now, and anything else is refused by name.
  it("refuses an older hello version out loud instead of negotiating a reduced set", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/attach/v1`, { headers: { authorization: "Bearer secret" } });
    const frames: AttachV1ServerFrame[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as AttachV1ServerFrame));
    await once(ws, "open");
    ws.send(JSON.stringify({
      kind: "hello", version: 1, instanceId: "legacy-plugin",
      capabilities: ["draft", "mobile_node"], resume: { eventSequence: 0, commandSequence: 0 },
    }));
    const [code, reason] = (await once(ws, "close")) as [number, Buffer];
    expect(code).toBe(1008);
    expect(String(reason)).toBe("attach-v1 invalid hello frame");
    expect(frames.some((frame) => frame.kind === "hello_ack")).toBe(false);
    expect(logs.some((line) => line.includes("refused hello frame") && line.includes("unsupported hello version 1"))).toBe(true);
    expect(traces.some((line) => JSON.parse(line).event === "attach_frame_refused")).toBe(true);
    expect(ingress.isAttached("sage")).toBe(false);
  });

  it("separates the three ways the memory lane can be closed", async () => {
    const peer = await dial(undefined, ["draft"]);
    expect(logs.some((line) => line.includes("negotiated hello v2") && !line.includes("memory_management"))).toBe(true);
    expect(ingress.sendMemoryRequest("sage", { kind: "memory_request", requestId: "m1", operation: "overview", input: {} })).toBe("capability_not_negotiated");
    peer.ws.close();
    await until(() => !ingress.isAttached("sage"));
    expect(ingress.sendMemoryRequest("sage", { kind: "memory_request", requestId: "m2", operation: "overview", input: {} })).toBe("not_attached");
    expect(ingress.sendMemoryRequest("nobody", { kind: "memory_request", requestId: "m3", operation: "overview", input: {} })).toBe("unknown_bot");
  });

  // Regression: a frame the schema rejects used to be dropped without a word, so a contract skew
  // between the gateway and its plugin presented as a request that simply never got its reply.
  it("closes loudly on a schema-invalid frame instead of dropping it in silence", async () => {
    const peer = await dial(undefined, ["memory_management"]);
    peer.ws.send(JSON.stringify({
      kind: "memory_result", requestId: "m1", status: "ok", result: { sources: [{ id: "vault" }] },
    }));
    const [code, reason] = (await once(peer.ws, "close")) as [number, Buffer];
    expect(code).toBe(1008);
    expect(String(reason)).toBe("attach-v1 invalid memory_result frame");
    expect(logs.some((line) => line.includes("refused memory_result frame") && line.includes("/result"))).toBe(true);
    expect(traces.some((line) => JSON.parse(line).event === "attach_frame_refused")).toBe(true);
  });

  it("closes loudly on a frame that is not JSON at all", async () => {
    const peer = await dial(undefined, ["draft"]);
    peer.ws.send("not json");
    const [code] = (await once(peer.ws, "close")) as [number];
    expect(code).toBe(1008);
    expect(logs.some((line) => line.includes("refused unparseable frame"))).toBe(true);
  });
});

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

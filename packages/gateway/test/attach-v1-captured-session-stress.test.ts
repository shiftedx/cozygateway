import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocket } from "ws";
import { expect, it } from "vitest";

import { startGateway, type RunningGateway } from "../src/server.ts";
import type { AttachV1ServerFrame } from "../src/adapters/attach/protocol-v1.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

// Cleo's 2026-08-23 long-turn shape after enforcing the attach-v1 contract: drafts carry text;
// tool events carry only lifecycle changes. IDs and text are neutralized, but the complete event
// counts and ordering shape are preserved.
const DRAFT_FRAMES = 564;
const TOOL_FRAMES = 563;
const APPROVAL_FRAMES = 4;
const EVENT_COUNT = DRAFT_FRAMES + TOOL_FRAMES + APPROVAL_FRAMES + 1;
const MAX_IN_FLIGHT_EVENTS = 64;
const MAX_IN_FLIGHT_BYTES = 4 * 1024 * 1024;

interface PendingFrame {
  sequence: number;
  eventId: string;
  encoded: string;
  bytes: number;
}

it("replays Cleo's complete long-session shape without starving health or losing its result", async () => {
  process.env["CAPTURED_DASHBOARD_TOKEN"] = "dashboard-secret";
  process.env["CAPTURED_ATTACH_TOKEN"] = "attach-secret";
  let gateway: RunningGateway | undefined;
  let hermes: FakeHermesServer | undefined;
  let plugin: WebSocket | undefined;
  const tempDir = await mkdtemp(join(tmpdir(), "cozygateway-captured-session-"));
  try {
    hermes = await startFakeHermesServer({
      methods: {
        "profiles.list": () => ({
          profiles: [{ name: "sage", description: "native", has_avatar: false }],
          bot_mode_protocol: true,
        }),
      },
    });
    gateway = await startGateway({
      name: "captured-session-stress",
      port: 0,
      dbPath: join(tempDir, "captured-session.db"),
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default",
        url: hermes.url,
        tokenEnv: "CAPTURED_DASHBOARD_TOKEN",
        profiles: { sage: { tokenEnv: "CAPTURED_ATTACH_TOKEN", name: "Sage" } },
      }],
    }, { traceLog: () => undefined });
    const pair = await fetch(`${gateway.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "stress-phone" }),
    });
    const deviceToken = ((await pair.json()) as { deviceToken: string }).deviceToken;

    const pluginFrames: AttachV1ServerFrame[] = [];
    plugin = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, {
      headers: { authorization: "Bearer attach-secret" },
    });
    plugin.on("message", (data) => pluginFrames.push(JSON.parse(String(data)) as AttachV1ServerFrame));
    await once(plugin, "open");
    plugin.send(JSON.stringify({
      kind: "hello", version: 2, instanceId: "captured-session-replay",
      capabilities: ["draft", "tools", "approvals"],
      limits: { maxInFlightEvents: MAX_IN_FLIGHT_EVENTS, maxInFlightBytes: MAX_IN_FLIGHT_BYTES },
      resume: { eventSequence: 0, commandSequence: 0 },
    }));
    await until(() => pluginFrames.some((frame) => frame.kind === "hello_ack"));

    const send = await fetch(`${gateway.url}/bots/sage/chat/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "replay the captured session", clientId: "captured-user" }),
    });
    expect(send.status).toBe(202);
    await until(() => pluginFrames.some((frame) => frame.kind === "command" && frame.command.kind === "turn"));
    const command = pluginFrames.find((frame) => frame.kind === "command" && frame.command.kind === "turn");
    if (command?.kind !== "command" || command.command.kind !== "turn") throw new Error("turn command missing");
    plugin.send(JSON.stringify({ kind: "ack", channel: "command", sequence: command.sequence, id: command.commandId }));

    const frames = capturedFrames(command.command.threadId, command.command.turnId);
    let next = 0;
    let inFlightBytes = 0;
    const inFlight = new Map<number, PendingFrame>();
    let maxInFlight = 0;
    let maxBytes = 0;
    let acked = 0;
    const healthProbes: Array<Promise<number>> = [];
    const healthProbeAt = new Set([256, Math.floor(EVENT_COUNT / 2), EVENT_COUNT - 256]);
    let resolveComplete: (() => void) | undefined;
    const complete = new Promise<void>((resolve) => { resolveComplete = resolve; });

    const pump = () => {
      while (next < frames.length && inFlight.size < MAX_IN_FLIGHT_EVENTS) {
        const frame = frames[next]!;
        if (inFlightBytes + frame.bytes > MAX_IN_FLIGHT_BYTES) break;
        plugin!.send(frame.encoded);
        inFlight.set(frame.sequence, frame);
        inFlightBytes += frame.bytes;
        maxInFlight = Math.max(maxInFlight, inFlight.size);
        maxBytes = Math.max(maxBytes, inFlightBytes);
        next += 1;
      }
    };
    plugin.on("message", (data) => {
      const frame = JSON.parse(String(data)) as AttachV1ServerFrame;
      if (frame.kind !== "ack" || frame.channel !== "event") return;
      const sent = inFlight.get(frame.sequence);
      if (sent === undefined || frame.id !== sent.eventId) return;
      inFlight.delete(frame.sequence);
      inFlightBytes -= sent.bytes;
      acked += 1;
      if (healthProbeAt.has(acked)) healthProbes.push(healthLatency(gateway!.url));
      if (acked === EVENT_COUNT) resolveComplete?.();
      else pump();
    });
    pump();
    await complete;
    const healthMs = await Promise.all(healthProbes);

    expect(next).toBe(EVENT_COUNT);
    expect(acked).toBe(EVENT_COUNT);
    expect(maxInFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT_EVENTS);
    expect(maxBytes).toBeLessThanOrEqual(MAX_IN_FLIGHT_BYTES);
    expect(healthMs).toHaveLength(3);
    expect(Math.max(...healthMs)).toBeLessThan(1_000);
    expect(gateway.storage.attachEventCursor("sage")).toBe(EVENT_COUNT);
    expect(gateway.storage.attachHealth().deadLetters).toBe(0);

    const history = await (await fetch(`${gateway.url}/bots/sage/chat/messages`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    })).json() as { messages: Array<{ id: string; text: string }> };
    expect(history.messages.filter((message) => message.id === "captured-final")).toEqual([
      expect.objectContaining({ text: "The captured workflow completed." }),
    ]);
  } finally {
    if (plugin !== undefined && (plugin.readyState === WebSocket.OPEN || plugin.readyState === WebSocket.CONNECTING)) {
      plugin.close();
      await once(plugin, "close");
    }
    await gateway?.close();
    await hermes?.close();
    await rm(tempDir, { recursive: true, force: true });
    delete process.env["CAPTURED_DASHBOARD_TOKEN"];
    delete process.env["CAPTURED_ATTACH_TOKEN"];
  }
}, 30_000);

function capturedFrames(threadId: string, turnId: string): PendingFrame[] {
  const frames: PendingFrame[] = [];
  let sequence = 1;
  const append = (event: Record<string, unknown>) => {
    const eventId = `captured-${sequence}`;
    const encoded = JSON.stringify({ kind: "event", sequence, eventId, event });
    frames.push({ sequence, eventId, encoded, bytes: Buffer.byteLength(encoded) });
    sequence += 1;
  };
  for (let draft = 0; draft < DRAFT_FRAMES; draft += 1) {
    append({ kind: "draft", threadId, turnId, replace: true, blocks: [{ type: "paragraph", text: `Working ${draft + 1}` }] });
    if (draft < TOOL_FRAMES) {
      const terminal = draft >= 283;
      const call = terminal ? draft - 283 : draft;
      append({
        kind: "tool", threadId, turnId, callId: `call-${call}`, name: `tool-${call}`,
        status: terminal ? "ok" : "running",
      });
    }
    if (draft === 100 || draft === 200) {
      const approval = draft === 100 ? 1 : 2;
      append({
        kind: "approval", threadId, turnId, approvalId: `approval-${approval}`,
        callId: `approval-call-${approval}`, name: "permission", status: "pending",
      });
    }
    if (draft === 300 || draft === 400) {
      const approval = draft === 300 ? 1 : 2;
      append({
        kind: "approval", threadId, turnId, approvalId: `approval-${approval}`,
        callId: `approval-call-${approval}`, name: "permission",
        status: approval === 1 ? "approved" : "denied",
      });
    }
  }
  append({
    kind: "commit", threadId, turnId, messageId: "captured-final",
    blocks: [{ type: "paragraph", text: "The captured workflow completed." }],
  });
  expect(frames).toHaveLength(EVENT_COUNT);
  return frames;
}

async function healthLatency(url: string): Promise<number> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(`${url}/health`, { signal: controller.signal });
    expect(response.status).toBe(200);
    return Date.now() - started;
  } finally {
    clearTimeout(timeout);
  }
}

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

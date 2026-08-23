import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import { openStorage, type Storage } from "../src/storage.ts";

/**
 * Federated health is a public aggregate, not a second event stream. The plugin reports bounded
 * spool facts on its authenticated control frames; the gateway owns durable association, staleness,
 * and aggregate redaction before `/health` reads this snapshot.
 */
describe("attach-v1 federated health", () => {
  let server: Server;
  let storage: Storage;
  let ingress: AttachV1Ingress;
  let port: number;
  let clock: number;

  beforeEach(async () => {
    clock = 1_000;
    storage = openStorage(":memory:");
    ingress = makeIngress();
    server = createServer();
    server.on("upgrade", (request, socket, head) => ingress.handleUpgrade(request, socket, head));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
  });

  afterEach(async () => {
    ingress.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
  });

  function makeIngress(): AttachV1Ingress {
    return new AttachV1Ingress({
      tokens: new Map([["attach-bearer", "sage"]]),
      storage,
      events: { onEvent: () => true, onPresence: () => undefined },
      now: () => clock,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 120_000,
    });
  }

  async function dial(telemetry: Record<string, unknown>): Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>> }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/attach/v1`, {
      headers: { authorization: "Bearer attach-bearer" },
    });
    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    await once(ws, "open");
    ws.send(JSON.stringify({
      kind: "hello", version: 2, instanceId: "plugin-instance-private",
      capabilities: ["draft"], resume: { eventSequence: 7, commandSequence: 0 }, telemetry,
    }));
    await until(() => frames.some((frame) => frame.kind === "hello_ack"));
    return { ws, frames };
  }

  it("persists authenticated bounded telemetry, degrades a stalled plugin backlog, and recovers on ACK cursor progress without exposing identities", async () => {
    const stalled = {
      eventOutboxDepth: 3,
      oldestEventAgeMs: 45_000,
      eventAckCursor: 7,
      commandInboxDepth: 1,
    };
    const peer = await dial(stalled);

    expect(ingress.health()).toMatchObject({
      configured: 1, online: 1, degraded: 0, absent: 0,
      queueDepth: 0,
      pluginOutboxDepth: 3,
      pluginOldestEventAgeMs: 45_000,
      pluginLastAckProgressAt: 1_000,
      pluginCommandInboxDepth: 1,
    });

    // A nonzero plugin backlog with no cursor movement for 30 seconds is degraded even when the
    // gateway-to-plugin command queue is empty. The next ACK cursor advances and clears it.
    clock = 31_001;
    peer.ws.send(JSON.stringify({ kind: "heartbeat", sentAt: clock, telemetry: { ...stalled, oldestEventAgeMs: 75_001 } }));
    await until(() => ingress.health().degraded === 1);
    expect(ingress.health()).toMatchObject({ queueDepth: 0, pluginOutboxDepth: 3, degraded: 1 });

    clock = 31_002;
    peer.ws.send(JSON.stringify({
      kind: "heartbeat", sentAt: clock,
      telemetry: { ...stalled, eventOutboxDepth: 2, oldestEventAgeMs: 30_000, eventAckCursor: 8 },
    }));
    await until(() => ingress.health().online === 1 && ingress.health().degraded === 0);

    const publicHealth = JSON.stringify(ingress.health());
    expect(publicHealth).not.toContain("sage");
    expect(publicHealth).not.toContain("attach-bearer");
    expect(publicHealth).not.toContain("plugin-instance-private");
    expect(publicHealth).not.toContain("event-7-private");

    peer.ws.close();
    await once(peer.ws, "close");
    ingress.close();
    ingress = makeIngress();
    expect(ingress.health()).toMatchObject({
      configured: 1, online: 0, absent: 1,
      pluginOutboxDepth: 2,
      pluginOldestEventAgeMs: 30_000,
      pluginLastAckProgressAt: 31_002,
      pluginCommandInboxDepth: 1,
    });
  });
});

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

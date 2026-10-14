import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1EventFrame, AttachV1ServerFrame } from "../src/adapters/attach/protocol-v1.ts";
import { openStorage, type Storage } from "../src/storage.ts";

/** The three moments the gateway knows something about a scheduled delivery that the plugin that
 *  produced it cannot know: a human read it, it was refused at the door, or it died on the way to
 *  the transcript. Each one becomes exactly one durable command. */
describe("attach-v1 delivery receipt emission", () => {
  let server: Server;
  let port: number;
  let storage: Storage;
  let ingress: AttachV1Ingress;
  let clock: number;
  let projectionSucceeds: boolean;
  let acceptsTarget: boolean;
  let failures: Array<Record<string, unknown>>;

  beforeEach(async () => {
    storage = openStorage(":memory:");
    clock = 1_000;
    projectionSucceeds = true;
    acceptsTarget = true;
    failures = [];
    ingress = new AttachV1Ingress({
      tokens: new Map([["secret", "sage"]]),
      storage,
      events: {
        onEvent: () => projectionSucceeds,
        canAcceptEvent: () => acceptsTarget,
        onPresence: () => undefined,
        onScheduledDeliveryFailed: (agentId, failure) => failures.push({ agentId, ...failure }),
      },
      now: () => clock,
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 5_000,
      projectionRetryMs: 10,
      projectionMaxAttempts: 1,
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

  async function dial(capabilities: string[]): Promise<{ ws: WebSocket; frames: AttachV1ServerFrame[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/attach/v1`, {
      headers: { authorization: "Bearer secret" },
    });
    const frames: AttachV1ServerFrame[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as AttachV1ServerFrame));
    await once(ws, "open");
    ws.send(JSON.stringify({
      kind: "hello", version: 2, instanceId: "plugin", capabilities,
      resume: { eventSequence: 0, commandSequence: 0 },
    }));
    await until(() => frames.some((frame) => frame.kind === "hello_ack"));
    return { ws, frames };
  }

  function scheduled(sequence: number, deliveryId: string): AttachV1EventFrame {
    return {
      kind: "event", sequence, eventId: `event-${deliveryId}`,
      event: {
        kind: "scheduled", threadId: "home", deliveryId, messageId: `message-${deliveryId}`,
        blocks: [{ type: "paragraph", text: "daily report" }],
      },
    };
  }

  const receipts = (frames: AttachV1ServerFrame[]) =>
    frames.filter((frame) => frame.kind === "command" && frame.command.kind === "delivery_receipt");

  it("emits a displayed receipt once per delivery, keyed so a repeat is the same command", async () => {
    const peer = await dial(["draft", "scheduled", "delivery_receipts"]);
    clock = 2_000;
    expect(ingress.sendDeliveryReceipt("sage", {
      deliveryId: "cron-1", messageId: "message-cron-1", state: "displayed", at: 1_900,
    })).toBe(true);
    await until(() => receipts(peer.frames).length === 1);
    expect(receipts(peer.frames)[0]).toMatchObject({
      kind: "command",
      commandId: "rcpt:cron-1:displayed",
      command: {
        kind: "delivery_receipt", deliveryId: "cron-1", messageId: "message-cron-1",
        state: "displayed", at: 1_900,
      },
    });

    // Idempotent by commandId: a second report of the same delivery adds no durable row, so a
    // plugin that already applied it never sees a second one.
    ingress.sendDeliveryReceipt("sage", {
      deliveryId: "cron-1", messageId: "message-cron-1", state: "displayed", at: 2_500,
    });
    expect(storage.pendingAttachCommands("sage", 0, 10).filter(
      (frame) => frame.command.kind === "delivery_receipt",
    )).toHaveLength(1);
    peer.ws.close();
  });

  it("emits a failed/authorization receipt and an app-facing failure when admission quarantines", async () => {
    const peer = await dial(["draft", "scheduled", "delivery_receipts"]);
    acceptsTarget = false;
    clock = 3_000;
    peer.ws.send(JSON.stringify(scheduled(1, "cron-quarantined")));
    await until(() => receipts(peer.frames).length === 1);

    expect(receipts(peer.frames)[0]).toMatchObject({
      commandId: "rcpt:cron-quarantined:failed",
      command: {
        kind: "delivery_receipt", deliveryId: "cron-quarantined",
        messageId: "message-cron-quarantined", state: "failed",
        stage: "authorization", reason: "unauthorized_target", at: 3_000,
      },
    });
    // The plugin learns over attach; the USER learns through the layer that owns the chat.
    expect(failures).toEqual([{
      agentId: "sage", deliveryId: "cron-quarantined", messageId: "message-cron-quarantined",
      stage: "authorization", reason: "unauthorized_target", at: 3_000,
    }]);
    peer.ws.close();
  });

  it("emits a failed/projection receipt when a scheduled event reaches the dead-letter barrier", async () => {
    const peer = await dial(["draft", "scheduled", "delivery_receipts"]);
    projectionSucceeds = false;
    clock = 4_000;
    peer.ws.send(JSON.stringify(scheduled(1, "cron-blocked")));
    await until(() => receipts(peer.frames).length === 1);

    expect(receipts(peer.frames)[0]).toMatchObject({
      commandId: "rcpt:cron-blocked:failed",
      command: {
        kind: "delivery_receipt", deliveryId: "cron-blocked", state: "failed",
        stage: "projection", reason: "projection declined event", at: 4_000,
      },
    });
    expect(failures).toEqual([{
      agentId: "sage", deliveryId: "cron-blocked", messageId: "message-cron-blocked",
      stage: "projection", reason: "projection declined event", at: 4_000,
    }]);
    peer.ws.close();
  });

  it("never queues a receipt for a connected plugin that did not negotiate the capability", async () => {
    const peer = await dial(["draft", "scheduled"]);
    expect(ingress.sendDeliveryReceipt("sage", {
      deliveryId: "cron-1", messageId: "message-cron-1", state: "displayed",
    })).toBe(false);
    expect(storage.pendingAttachCommands("sage", 0, 10)).toHaveLength(0);
    peer.ws.close();
  });

  it("converts a receipt queued while away into the ordinary discard tombstone", async () => {
    // Queued with no plugin connected: the durable path, exactly like every other command.
    expect(ingress.sendDeliveryReceipt("sage", {
      deliveryId: "cron-1", messageId: "message-cron-1", state: "displayed", at: 900,
    })).toBe(true);

    const peer = await dial(["draft", "scheduled"]);
    await until(() => peer.frames.some((frame) => frame.kind === "command"));
    expect(peer.frames.find((frame) => frame.kind === "command")).toMatchObject({
      commandId: "rcpt:cron-1:displayed",
      command: {
        kind: "discard", originalKind: "delivery_receipt",
        reason: "capability not negotiated: delivery_receipts",
      },
    });
    peer.ws.close();
  });
});

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

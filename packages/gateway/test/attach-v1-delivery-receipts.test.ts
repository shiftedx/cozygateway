import { describe, expect, it } from "vitest";
import type { Message, RichBlock } from "cozygateway-contract";

import { createApp } from "../src/http.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import type { GatewayConfig } from "../src/config.ts";
import { testHermes } from "./support/test-config.ts";

const config: GatewayConfig = {
  name: "receipt-test",
  port: 0,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermes: testHermes(),
};

const receiptToken = "receipt-secret";

function receiptApp(storage: Storage, mediaAllowed = true) {
  return createApp({
    storage,
    config,
    gatewayInfo: { name: "receipt-test", version: "0", contract: "v1" },
    attachTokens: new Map([[receiptToken, "sage"]]),
    attachMediaAllowed: () => mediaAllowed,
    presenceOf: () => "online",
    submitUserMessage: (_threadId: string, _blocks: RichBlock[]): Message => {
      throw new Error("not used by delivery receipt routes");
    },
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: () => {},
    now: () => 10_000,
  });
}

function scheduled(deliveryId: string, sequence = 1) {
  return {
    kind: "event" as const,
    sequence,
    eventId: `event-${deliveryId}`,
    event: {
      kind: "scheduled" as const,
      threadId: "home-a",
      deliveryId,
      messageId: `message-${deliveryId}`,
      blocks: [{ type: "paragraph" as const, text: "nightly report" }],
    },
  };
}

function read(app: ReturnType<typeof receiptApp>, deliveryId: string, token = receiptToken) {
  return app.request(`/attach/v1/deliveries/${encodeURIComponent(deliveryId)}`, {
    headers: token === "" ? {} : { authorization: `Bearer ${token}` },
  });
}

describe("attach-v1 delivery receipts", () => {
  it("requires the identity-scoped attach bearer", async () => {
    const storage = openStorage(":memory:");
    try {
      const app = receiptApp(storage);
      expect((await read(app, "daily-1", "")).status).toBe(401);
      expect((await read(app, "daily-1", "wrong-token")).status).toBe(401);
    } finally {
      storage.close();
    }
  });

  it("returns 404 when this authenticated profile has no such delivery", async () => {
    const storage = openStorage(":memory:");
    try {
      const response = await read(receiptApp(storage), "missing-delivery");
      expect(response.status).toBe(404);
    } finally {
      storage.close();
    }
  });

  it("reports admission until the durable inbox row is projected, then projected", async () => {
    const storage = openStorage(":memory:");
    try {
      const frame = scheduled("daily-1");
      expect(storage.acceptAttachEvent("sage", frame, 1_000)).toEqual({
        status: "accepted",
        acknowledgedSequence: 1,
      });
      const app = receiptApp(storage);

      const admitted = await read(app, frame.event.deliveryId);
      expect(admitted.status).toBe(200);
      expect(await admitted.json()).toEqual({
        deliveryId: "daily-1",
        messageId: "message-daily-1",
        target: { kind: "thread", threadId: "home-a" },
        state: "admitted",
        admittedAt: 1_000,
      });

      storage.markAttachEventApplied("sage", frame.eventId, 2_000);
      const projected = await read(app, frame.event.deliveryId);
      expect(projected.status).toBe(200);
      expect(await projected.json()).toEqual({
        deliveryId: "daily-1",
        messageId: "message-daily-1",
        target: { kind: "thread", threadId: "home-a" },
        state: "projected",
        admittedAt: 1_000,
        projectedAt: 2_000,
      });
    } finally {
      storage.close();
    }
  });

  it("reports an ordered projection dead letter as blocked, never delivered", async () => {
    const storage = openStorage(":memory:");
    try {
      const frame = scheduled("daily-blocked");
      storage.acceptAttachEvent("sage", frame, 1_000);
      expect(
        storage.recordAttachProjectionFailure("sage", frame.eventId, "projection declined event", 1_100, 1),
      ).toEqual({ attempts: 1, deadLettered: true });

      const response = await read(receiptApp(storage), frame.event.deliveryId);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        deliveryId: "daily-blocked",
        messageId: "message-daily-blocked",
        target: { kind: "thread", threadId: "home-a" },
        state: "blocked",
        admittedAt: 1_000,
        attempts: 1,
        deadLetteredAt: 1_100,
        terminal: {
          state: "failed",
          stage: "projection",
          reason: "projection declined event",
          at: 1_100,
        },
      });
    } finally {
      storage.close();
    }
  });

  it("keeps delivery receipts readable when the media rollout is disabled", async () => {
    const storage = openStorage(":memory:");
    try {
      const frame = scheduled("daily-no-media");
      storage.acceptAttachEvent("sage", frame, 1_000);

      const response = await read(receiptApp(storage, false), frame.event.deliveryId);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        deliveryId: "daily-no-media",
        state: "admitted",
      });
    } finally {
      storage.close();
    }
  });
});

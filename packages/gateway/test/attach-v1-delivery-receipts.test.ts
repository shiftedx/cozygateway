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
  hermesEndpoints: [{ id: "default", ...testHermes() }],
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

function scheduled(
  deliveryId: string,
  options: { sequence?: number; threadId?: string; mediaIds?: string[] } = {},
) {
  return {
    kind: "event" as const,
    sequence: options.sequence ?? 1,
    eventId: `event-${deliveryId}`,
    event: {
      kind: "scheduled" as const,
      threadId: options.threadId ?? "home-a",
      deliveryId,
      messageId: `message-${deliveryId}`,
      blocks: [{ type: "paragraph" as const, text: "nightly report" }],
      ...(options.mediaIds === undefined ? {} : { mediaIds: options.mediaIds }),
    },
  };
}

function projectNativeMessage(
  storage: Storage,
  frame: ReturnType<typeof scheduled>,
  attachmentIds: string[],
  at = 2_000,
) {
  storage.appendNativeBotMessage({
    bot: "sage",
    sessionId: frame.event.threadId,
    messageId: frame.event.messageId,
    role: "assistant",
    text: "nightly report",
    at,
    ...(attachmentIds.length === 0 ? {} : {
      attachments: attachmentIds.map((fileId) => ({
        type: "attachment" as const,
        fileId,
        name: `${fileId}.png`,
        mimeType: "image/png",
        size: 1,
        mediaKind: "image" as const,
      })),
    }),
  });
  storage.markAttachEventApplied("sage", frame.eventId, at);
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
      expect(await admitted.text()).toBe(JSON.stringify({
        deliveryId: "daily-1",
        messageId: "message-daily-1",
        target: { kind: "thread", threadId: "home-a" },
        state: "admitted",
        admittedAt: 1_000,
      }));

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

  it("reports expected media at admission without claiming it committed", async () => {
    const storage = openStorage(":memory:");
    try {
      const chat = storage.nativeBotChat("sage", 1);
      const frame = scheduled("daily-media-admitted", {
        threadId: chat.sessionId,
        mediaIds: ["report-png", "chart-png"],
      });
      storage.acceptAttachEvent("sage", frame, 1_000);

      expect(await (await read(receiptApp(storage), frame.event.deliveryId)).json()).toEqual({
        deliveryId: "daily-media-admitted",
        messageId: "message-daily-media-admitted",
        target: { kind: "thread", threadId: chat.sessionId },
        state: "admitted",
        admittedAt: 1_000,
        expectedMediaIds: ["report-png", "chart-png"],
        committedMediaIds: [],
        mediaVerified: false,
      });
    } finally {
      storage.close();
    }
  });

  it("verifies a projected native message only when its media IDs match in order", async () => {
    const storage = openStorage(":memory:");
    try {
      const chat = storage.nativeBotChat("sage", 1);
      const expected = ["report-png", "chart-png"];
      const frame = scheduled("daily-media-complete", { threadId: chat.sessionId, mediaIds: expected });
      storage.acceptAttachEvent("sage", frame, 1_000);
      projectNativeMessage(storage, frame, expected);

      expect(await (await read(receiptApp(storage), frame.event.deliveryId)).json()).toMatchObject({
        state: "projected",
        expectedMediaIds: expected,
        committedMediaIds: expected,
        mediaVerified: true,
      });
    } finally {
      storage.close();
    }
  });

  it.each([
    ["missing", ["report-png"]],
    ["reordered", ["chart-png", "report-png"]],
    ["extra", ["report-png", "chart-png", "extra-png"]],
  ])("reports committed %s media IDs honestly without verifying them", async (_caseName, attachmentIds) => {
    const storage = openStorage(":memory:");
    try {
      const chat = storage.nativeBotChat("sage", 1);
      const frame = scheduled(`daily-media-${_caseName}`, {
        threadId: chat.sessionId,
        mediaIds: ["report-png", "chart-png"],
      });
      storage.acceptAttachEvent("sage", frame, 1_000);
      projectNativeMessage(storage, frame, attachmentIds);

      expect(await (await read(receiptApp(storage), frame.event.deliveryId)).json()).toMatchObject({
        state: "projected",
        expectedMediaIds: ["report-png", "chart-png"],
        committedMediaIds: attachmentIds,
        mediaVerified: false,
      });
    } finally {
      storage.close();
    }
  });

  it("does not treat a displayed media row as verified when its committed IDs differ", async () => {
    const storage = openStorage(":memory:");
    try {
      const chat = storage.nativeBotChat("sage", 1);
      const frame = scheduled("daily-media-displayed", {
        threadId: chat.sessionId,
        mediaIds: ["report-png", "chart-png"],
      });
      storage.acceptAttachEvent("sage", frame, 1_000);
      projectNativeMessage(storage, frame, ["report-png"]);
      storage.recordBotMessageDisplayed("sage", [frame.event.messageId], "device-1", 3_000);

      expect(await (await read(receiptApp(storage), frame.event.deliveryId)).json()).toMatchObject({
        state: "projected",
        displayedAt: 3_000,
        terminal: { state: "displayed", at: 3_000 },
        expectedMediaIds: ["report-png", "chart-png"],
        committedMediaIds: ["report-png"],
        mediaVerified: false,
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

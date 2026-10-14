import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { check } from "cozygateway-contract";
import type { ServerFrame } from "cozygateway-contract";

import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import {
  AttachV1EventFrameSchema,
  type AttachV1EventFrame,
} from "../src/adapters/attach/protocol-v1.ts";
import { openStorage } from "../src/storage.ts";

/** Two distinct stored images, so a positioned pair cannot pass by accident. */
function seedMedia(storage: ReturnType<typeof openStorage>, ids: string[]): void {
  ids.forEach((mediaId, index) => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, index]);
    storage.saveAttachMedia("sage", {
      mediaId, mimeType: "image/png", byteCount: png.byteLength,
      sha256: createHash("sha256").update(png).digest("hex"),
      filename: `chart-${index}.png`, family: "image",
    }, png, 1);
  });
}

describe("inline media positions", () => {
  it("threads each position onto the attachment built from the same media id", () => {
    const storage = openStorage(":memory:");
    const chat = storage.nativeBotChat("sage", 1);
    seedMedia(storage, ["media_first", "media_second"]);
    const frames: ServerFrame[] = [];
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress: {} as AttachV1Ingress,
      nativeBots: ["sage"], chatSuggestion: "", broadcast: (frame) => frames.push(frame),
      now: () => 2,
    });
    const event: AttachV1EventFrame = {
      kind: "event", sequence: 1, eventId: "scheduled-positioned",
      event: {
        kind: "scheduled", threadId: chat.sessionId, deliveryId: "report-1",
        messageId: "report-message",
        blocks: [
          { type: "heading", level: 2, text: "Sales" },
          { type: "heading", level: 2, text: "Costs" },
        ],
        mediaIds: ["media_first", "media_second"],
        mediaPositions: [1, 2],
      },
    };
    expect(storage.acceptAttachEvent("sage", event, 1).status).toBe("accepted");
    expect(plane.handle("sage", event)).toBe(true);

    // The durable row round trips the positions through SQLite, not just the frame.
    const stored = storage.nativeBotMessages("sage", chat.sessionId)
      .find((message) => message.id === "report-message");
    expect(stored?.attachments).toEqual([
      expect.objectContaining({ fileId: "media_first", position: 1 }),
      expect.objectContaining({ fileId: "media_second", position: 2 }),
    ]);
    // Text is untouched: position is the only new data.
    expect(stored?.text).toBe("## Sales\n\n## Costs");

    const broadcast = frames.find((frame) => frame.type === "bot_chat");
    expect(broadcast).toMatchObject({
      messages: [expect.objectContaining({
        attachments: [
          expect.objectContaining({ position: 1 }),
          expect.objectContaining({ position: 2 }),
        ],
      })],
    });
    plane.close();
    storage.close();
  });

  it("commits a turn's positions and drops an unknown media id without shifting the rest", async () => {
    const storage = openStorage(":memory:");
    const sent: Array<Record<string, unknown>> = [];
    let now = 10;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage,
      ingress: {
        sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
          sent.push(input);
          storage.enqueueAttachCommand(bot, "turn-command", { kind: "turn", ...input } as never, now);
          return true;
        },
      } as unknown as AttachV1Ingress,
      nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined, now: () => now++,
    });
    seedMedia(storage, ["media_kept"]);
    const accepted = await plane.surface().sendChatMessage("sage", "chart it", { clientId: "ask" });
    const turnId = String(sent[0]?.turnId);

    const commit: AttachV1EventFrame = {
      kind: "event", sequence: 1, eventId: "commit-positioned",
      event: {
        kind: "commit", threadId: accepted.sessionId, turnId, messageId: "answer",
        blocks: [{ type: "paragraph", text: "Here it is." }],
        // The gateway never stored `media_gone`, so it drops out of the attachment
        // list; the id that survived must keep the index its own position named.
        mediaIds: ["media_gone", "media_kept"],
        mediaPositions: [0, 1],
      },
    };
    expect(plane.handle("sage", commit)).toBe(true);
    const stored = storage.nativeBotMessages("sage", accepted.sessionId)
      .find((message) => message.id === "answer");
    expect(stored?.attachments).toEqual([
      expect.objectContaining({ fileId: "media_kept", position: 1 }),
    ]);
    plane.close();
    storage.close();
  });

  it("ignores a positions array that does not match the media ids", () => {
    const storage = openStorage(":memory:");
    const chat = storage.nativeBotChat("sage", 1);
    seedMedia(storage, ["media_a", "media_b"]);
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress: {} as AttachV1Ingress,
      nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined, now: () => 2,
    });
    const event: AttachV1EventFrame = {
      kind: "event", sequence: 1, eventId: "scheduled-mismatched",
      event: {
        kind: "scheduled", threadId: chat.sessionId, deliveryId: "report-2",
        messageId: "mismatched", blocks: [{ type: "paragraph", text: "Report" }],
        mediaIds: ["media_a", "media_b"], mediaPositions: [1],
      },
    };
    expect(storage.acceptAttachEvent("sage", event, 1).status).toBe("accepted");
    expect(plane.handle("sage", event)).toBe(true);
    const stored = storage.nativeBotMessages("sage", chat.sessionId)
      .find((message) => message.id === "mismatched");
    expect(stored?.attachments).toHaveLength(2);
    for (const attachment of stored?.attachments ?? []) {
      expect(attachment).not.toHaveProperty("position");
    }
    plane.close();
    storage.close();
  });

  it("accepts bounded positions on commit and scheduled events and refuses the rest", () => {
    const positioned = (mediaPositions: unknown) => ({
      kind: "event", sequence: 1, eventId: "e",
      event: {
        kind: "commit", threadId: "t", turnId: "u", messageId: "m",
        blocks: [{ type: "paragraph", text: "done" }], mediaIds: ["media-1"], mediaPositions,
      },
    });
    expect(check(AttachV1EventFrameSchema, positioned([0]))).toBe(true);
    expect(check(AttachV1EventFrameSchema, positioned([4096]))).toBe(true);
    expect(check(AttachV1EventFrameSchema, positioned([-1]))).toBe(false);
    expect(check(AttachV1EventFrameSchema, positioned([1.5]))).toBe(false);
    expect(check(AttachV1EventFrameSchema, positioned([4097]))).toBe(false);
    expect(check(AttachV1EventFrameSchema, positioned(["1"]))).toBe(false);
    // Absent stays the legacy shape on every event that can carry media.
    expect(check(AttachV1EventFrameSchema, {
      kind: "event", sequence: 1, eventId: "e",
      event: {
        kind: "commit", threadId: "t", turnId: "u", messageId: "m",
        blocks: [], mediaIds: ["media-1"],
      },
    })).toBe(true);
    expect(check(AttachV1EventFrameSchema, {
      kind: "event", sequence: 2, eventId: "e2",
      event: {
        kind: "scheduled", target: { kind: "canonical_home" }, deliveryId: "d", messageId: "m",
        blocks: [], mediaIds: ["media-1"], mediaPositions: [0],
      },
    })).toBe(true);
  });
});

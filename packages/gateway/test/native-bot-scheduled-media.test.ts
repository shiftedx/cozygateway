import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1EventFrame } from "../src/adapters/attach/protocol-v1.ts";
import { openStorage } from "../src/storage.ts";

describe("native scheduled media", () => {
  it("projects text plus PNG and media-only deliveries without an active turn, exactly once", () => {
    const storage = openStorage(":memory:");
    const chat = storage.nativeBotChat("sage", 1);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const mediaId = "scheduled_media_png";
    storage.saveAttachMedia("sage", {
      mediaId, mimeType: "image/png", byteCount: png.byteLength,
      sha256: createHash("sha256").update(png).digest("hex"), filename: "report.png", family: "image",
    }, png, 1);
    const pushed: string[] = [];
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress: {} as AttachV1Ingress,
      nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined,
      onChatMessage: ({ messageId }) => pushed.push(messageId), now: () => 2,
    });
    const textAndMedia: AttachV1EventFrame = {
      kind: "event", sequence: 1, eventId: "scheduled-text-media",
      event: {
        kind: "scheduled", threadId: chat.sessionId, deliveryId: "daily-with-report",
        messageId: "daily-report", blocks: [{ type: "paragraph", text: "Daily report" }], mediaIds: [mediaId],
      },
    };
    expect(chat.activeTurnId).toBeUndefined();
    expect(storage.acceptAttachEvent("sage", textAndMedia, 1).status).toBe("accepted");
    expect(plane.handle("sage", textAndMedia)).toBe(true);
    expect(storage.acceptAttachEvent("sage", textAndMedia, 2).status).toBe("duplicate");
    expect(storage.nativeBotMessages("sage", chat.sessionId)).toContainEqual(expect.objectContaining({
      id: "daily-report", text: "Daily report", attachments: [expect.objectContaining({ fileId: mediaId, mediaKind: "image" })],
    }));
    expect(pushed).toEqual(["daily-report"]);

    const mediaOnly: AttachV1EventFrame = {
      kind: "event", sequence: 2, eventId: "scheduled-media-only",
      event: {
        kind: "scheduled", threadId: chat.sessionId, deliveryId: "daily-media-only",
        messageId: "daily-image", blocks: [], mediaIds: [mediaId],
      },
    };
    expect(storage.acceptAttachEvent("sage", mediaOnly, 3).status).toBe("accepted");
    expect(plane.handle("sage", mediaOnly)).toBe(true);
    expect(storage.nativeBotMessages("sage", chat.sessionId)).toContainEqual(expect.objectContaining({
      id: "daily-image", text: "", attachments: [expect.objectContaining({ fileId: mediaId })],
    }));
    expect(storage.nativeBotChat("sage", 3).activeTurnId).toBeUndefined();
    plane.close();
    storage.close();
  });
});

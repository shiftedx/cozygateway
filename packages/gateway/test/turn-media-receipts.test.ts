import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1EventFrame } from "../src/adapters/attach/protocol-v1.ts";
import { openStorage } from "../src/storage.ts";

function seedMedia(storage: ReturnType<typeof openStorage>, mediaId: string): void {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  storage.saveAttachMedia("sage", {
    mediaId, mimeType: "image/png", byteCount: png.byteLength,
    sha256: createHash("sha256").update(png).digest("hex"),
    filename: "chart.png", family: "image",
  }, png, 1);
}

/** A reply the agent makes in a live conversation is the ordinary way a picture reaches a person,
 *  and until now it was the one delivery whose media lifecycle could never leave `journaled`. */
describe("turn media delivery receipts", () => {
  function plane(sendDeliveryReceipt = vi.fn(() => true)) {
    const storage = openStorage(":memory:");
    const sent: Array<Record<string, unknown>> = [];
    let now = 10;
    const instance = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress: {
        sendDeliveryReceipt,
        sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
          sent.push(input);
          storage.enqueueAttachCommand(bot, `turn-${sent.length}`, { kind: "turn", ...input } as never, now);
          return true;
        },
      } as unknown as AttachV1Ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: () => undefined,
      now: () => now++,
    });
    return { storage, instance, sent, sendDeliveryReceipt };
  }

  async function commitReply(
    fixture: ReturnType<typeof plane>,
    messageId: string,
    mediaIds: string[],
  ): Promise<{ sessionId: string; turnId: string }> {
    const accepted = await fixture.instance.surface().sendChatMessage("sage", "chart it", {
      clientId: `ask-${messageId}`,
    });
    const turnId = String(fixture.sent.at(-1)?.turnId);
    const commit: AttachV1EventFrame = {
      kind: "event", sequence: 1, eventId: `commit-${messageId}`,
      event: {
        kind: "commit", threadId: accepted.sessionId, turnId, messageId,
        blocks: [{ type: "paragraph", text: "Here it is." }],
        ...(mediaIds.length === 0 ? {} : { mediaIds }),
      },
    };
    expect(fixture.instance.handle("sage", commit)).toBe(true);
    return { sessionId: accepted.sessionId, turnId };
  }

  it("emits a delivery receipt keyed `turn:<turnId>` when the app displays a turn's attachment", async () => {
    const fixture = plane();
    seedMedia(fixture.storage, "media_chart");
    const { turnId } = await commitReply(fixture, "answer", ["media_chart"]);

    expect(fixture.instance.surface().recordDisplayed("sage", ["answer"], "device-1"))
      .toEqual({ recorded: 1 });

    expect(fixture.sendDeliveryReceipt).toHaveBeenCalledTimes(1);
    expect(fixture.sendDeliveryReceipt).toHaveBeenCalledWith("sage", expect.objectContaining({
      deliveryId: `turn:${turnId}`,
      messageId: "answer",
      state: "displayed",
    }));

    // First write wins on the receipt, so a device replaying its queue never re-announces it.
    fixture.sendDeliveryReceipt.mockClear();
    expect(fixture.instance.surface().recordDisplayed("sage", ["answer"], "device-2"))
      .toEqual({ recorded: 0 });
    expect(fixture.sendDeliveryReceipt).not.toHaveBeenCalled();

    fixture.instance.close();
    fixture.storage.close();
  });

  it("stays quiet for a text-only turn, which has no media lifecycle to close", async () => {
    const fixture = plane();
    await commitReply(fixture, "text-only", []);

    expect(fixture.instance.surface().recordDisplayed("sage", ["text-only"], "device-1"))
      .toEqual({ recorded: 1 });
    expect(fixture.sendDeliveryReceipt).not.toHaveBeenCalled();

    fixture.instance.close();
    fixture.storage.close();
  });

  it("binds nothing when every named media id is unknown to the gateway", async () => {
    const fixture = plane();
    await commitReply(fixture, "ghost-media", ["media_never_stored"]);

    expect(fixture.instance.surface().recordDisplayed("sage", ["ghost-media"], "device-1"))
      .toEqual({ recorded: 1 });
    expect(fixture.sendDeliveryReceipt).not.toHaveBeenCalled();

    fixture.instance.close();
    fixture.storage.close();
  });
});

import { describe, expect, it, vi } from "vitest";

import type { ServerFrame } from "cozygateway-contract";

import { NativeBotDataPlane, deliveryFailureText } from "../src/hermes-bridge/native-data-plane.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1EventFrame } from "../src/adapters/attach/protocol-v1.ts";
import { openStorage } from "../src/storage.ts";

/** A scheduled delivery that dies is invisible by construction: nothing arrives, and nothing says
 *  why. These cover the two halves of making it visible again, to the plugin and to the user. */
describe("terminal scheduled-delivery failure", () => {
  function plane(now: () => number, sendDeliveryReceipt = vi.fn(() => true)) {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    const instance = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress: { sendDeliveryReceipt } as unknown as AttachV1Ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: (frame) => frames.push(frame),
      now,
    });
    return { storage, frames, instance, sendDeliveryReceipt };
  }

  it("appends one marked system row to the bot's CURRENT canonical chat and broadcasts it", () => {
    const at = Date.parse("2026-08-23T03:03:00Z");
    const { storage, frames, instance } = plane(() => at);
    const stale = storage.nativeBotChat("sage", 1).sessionId;
    // The chat the user is actually looking at is the one selected NOW, not the one the delivery
    // was bound to when it was admitted.
    const current = storage.resetNativeBotChat("sage", 2);
    expect(current).not.toBe(stale);

    instance.recordScheduledDeliveryFailure("sage", {
      deliveryId: "cron-1", stage: "authorization", reason: "unauthorized_target", at,
    });

    expect(storage.nativeBotMessages("sage", stale)).toEqual([]);
    const history = storage.nativeBotMessages("sage", current);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: "delivery-failed:cron-1",
      role: "system",
      marker: "delivery.failed",
      at,
    });
    expect(history[0]?.text).toContain("could not be delivered: unauthorized_target.");
    expect(history[0]?.text).toContain("Sage tried to deliver a scheduled message at");
    expect(frames).toEqual([{
      type: "bot_chat", bot: "sage", sessionId: current, messages: [history[0]], updatedAt: at,
    }]);

    // A retried failure for the same occurrence writes one row, not a pile of them.
    instance.recordScheduledDeliveryFailure("sage", {
      deliveryId: "cron-1", stage: "projection", reason: "still broken", at: at + 1_000,
    });
    expect(storage.nativeBotMessages("sage", current)).toHaveLength(1);
    instance.close();
    storage.close();
  });

  it("says the failure in one human sentence, on the gateway's own clock", () => {
    const at = new Date(2026, 7, 23, 3, 3).getTime();
    expect(deliveryFailureText("cleo", at, "unauthorized_target")).toBe(
      "Cleo tried to deliver a scheduled message at 3:03 AM and it could not be delivered: unauthorized_target.",
    );
  });

  it("ignores a failure for a profile this plane does not run", () => {
    const { storage, frames, instance } = plane(() => 5);
    instance.recordScheduledDeliveryFailure("pixel", {
      deliveryId: "cron-1", stage: "projection", reason: "boom", at: 5,
    });
    expect(frames).toEqual([]);
    instance.close();
    storage.close();
  });

  it("tells the plugin when a displayed report closes a scheduled delivery", () => {
    const sendDeliveryReceipt = vi.fn(() => true);
    const { storage, instance, sendDeliveryReceipt: send } = plane(() => 100, sendDeliveryReceipt);
    const chat = storage.nativeBotChat("sage", 1);
    const frame: AttachV1EventFrame = {
      kind: "event", sequence: 1, eventId: "cron-event",
      event: {
        kind: "scheduled", threadId: chat.sessionId, deliveryId: "cron-1",
        messageId: "cron-message", blocks: [{ type: "paragraph", text: "report" }],
      },
    };
    storage.acceptAttachEvent("sage", frame, 10);
    expect(instance.handle("sage", frame)).toBe(true);

    const surface = instance.surface();
    expect(surface.recordDisplayed("SAGE", ["cron-message", "unknown"], "device-1"))
      .toEqual({ recorded: 1 });
    expect(send).toHaveBeenCalledWith("sage", {
      deliveryId: "cron-1", messageId: "cron-message", state: "displayed", at: 100,
    });

    // Re-reporting the same row is free and silent: the receipt already exists.
    send.mockClear();
    expect(surface.recordDisplayed("sage", ["cron-message"], "device-1")).toEqual({ recorded: 0 });
    expect(send).not.toHaveBeenCalled();
    instance.close();
    storage.close();
  });
});

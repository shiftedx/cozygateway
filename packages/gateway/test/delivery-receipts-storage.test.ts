import { describe, expect, it } from "vitest";

import { openStorage } from "../src/storage.ts";
import type { AttachV1EventFrame } from "../src/adapters/attach/protocol-v1.ts";

/** Capability 31's durable half. A receipt is the only record in this gateway that a HUMAN saw a
 *  message, so the rules that matter are the ones that keep it honest: it cannot be invented for a
 *  row that does not exist, and it cannot be moved once written. */
describe("bot message receipts", () => {
  function seed() {
    const storage = openStorage(":memory:");
    const chat = storage.nativeBotChat("sage", 1);
    storage.appendNativeBotMessage({
      bot: "sage", sessionId: chat.sessionId, messageId: "m1",
      role: "assistant", text: "daily report", at: 10,
    });
    storage.appendNativeBotMessage({
      bot: "sage", sessionId: chat.sessionId, messageId: "m2",
      role: "assistant", text: "second", at: 11,
    });
    return { storage, sessionId: chat.sessionId };
  }

  it("records once per message, first write wins, and ignores unknown ids", () => {
    const { storage } = seed();
    expect(storage.recordBotMessageDisplayed("sage", ["m1", "m2"], "device-1", 100))
      .toEqual({ recorded: 2, deliveries: [] });
    // Second report of the same ids: recorded is the count of NEW receipts, so zero, and the
    // original timestamp and device survive. A client MUST NOT read that zero as a failure.
    expect(storage.recordBotMessageDisplayed("sage", ["m1", "m2"], "device-2", 200))
      .toEqual({ recorded: 0, deliveries: [] });
    expect(storage.botMessageReceipt("sage", "m1")).toEqual({ displayedAt: 100, deviceId: "device-1" });

    // An id naming no durable row is ignored rather than refused: a device flushing an offline
    // queue after a reset must not be stuck on a batch it cannot repair.
    expect(storage.recordBotMessageDisplayed("sage", ["ghost"], "device-1", 300))
      .toEqual({ recorded: 0, deliveries: [] });
    expect(storage.botMessageReceipt("sage", "ghost")).toBeUndefined();
    // Nor can one bot's report create a receipt against another bot's transcript.
    expect(storage.recordBotMessageDisplayed("pixel", ["m1"], "device-1", 300).recorded).toBe(0);

    // Duplicates inside one batch count once.
    expect(storage.recordBotMessageDisplayed("sage", ["m1", "m1"], "device-1", 400).recorded).toBe(0);
    storage.close();
  });

  it("reports the scheduled delivery a newly displayed row was bound to, and only that one", () => {
    const storage = openStorage(":memory:");
    const chat = storage.nativeBotChat("sage", 1);
    const frame: AttachV1EventFrame = {
      kind: "event", sequence: 1, eventId: "cron-event",
      event: {
        kind: "scheduled", threadId: chat.sessionId, deliveryId: "cron-1",
        messageId: "cron-message", blocks: [{ type: "paragraph", text: "report" }],
      },
    };
    expect(storage.acceptAttachEvent("sage", frame, 10).status).toBe("accepted");
    storage.appendNativeBotMessage({
      bot: "sage", sessionId: chat.sessionId, messageId: "cron-message",
      role: "assistant", text: "report", at: 11,
    });
    storage.appendNativeBotMessage({
      bot: "sage", sessionId: chat.sessionId, messageId: "typed-reply",
      role: "assistant", text: "sure", at: 12,
    });

    expect(storage.recordBotMessageDisplayed("sage", ["cron-message", "typed-reply"], "device-1", 100))
      .toEqual({ recorded: 2, deliveries: [{ deliveryId: "cron-1", messageId: "cron-message" }] });
    // A repeat report binds nothing: only a NEW receipt closes a delivery, so the plugin is told
    // exactly once no matter how often a device re-reports the row.
    expect(storage.recordBotMessageDisplayed("sage", ["cron-message"], "device-1", 200))
      .toEqual({ recorded: 0, deliveries: [] });
    storage.close();
  });

  it("extends the delivery receipt with displayedAt and a terminal that outranks the pipeline state", () => {
    const storage = openStorage(":memory:");
    const chat = storage.nativeBotChat("sage", 1);
    const frame: AttachV1EventFrame = {
      kind: "event", sequence: 1, eventId: "cron-event",
      event: {
        kind: "scheduled", threadId: chat.sessionId, deliveryId: "cron-1",
        messageId: "cron-message", blocks: [{ type: "paragraph", text: "report" }],
      },
    };
    storage.acceptAttachEvent("sage", frame, 10);
    storage.markAttachEventApplied("sage", "cron-event", 20);
    expect(storage.attachScheduledDeliveryReceipt("sage", "cron-1")).toEqual({
      deliveryId: "cron-1", messageId: "cron-message",
      target: { kind: "thread", threadId: chat.sessionId },
      state: "projected", admittedAt: 10, projectedAt: 20,
    });

    storage.appendNativeBotMessage({
      bot: "sage", sessionId: chat.sessionId, messageId: "cron-message",
      role: "assistant", text: "report", at: 20,
    });
    storage.recordBotMessageDisplayed("sage", ["cron-message"], "device-1", 30);
    expect(storage.attachScheduledDeliveryReceipt("sage", "cron-1")).toEqual({
      deliveryId: "cron-1", messageId: "cron-message",
      target: { kind: "thread", threadId: chat.sessionId },
      state: "projected", admittedAt: 10, projectedAt: 20,
      displayedAt: 30,
      terminal: { state: "displayed", at: 30 },
    });
    storage.close();
  });

  it("keeps a marker on a durable row and leaves every other row unmarked", () => {
    const { storage, sessionId } = seed();
    const marked = storage.appendNativeBotMessage({
      bot: "sage", sessionId, messageId: "delivery-failed:cron-1",
      role: "system", marker: "delivery.failed", text: "it could not be delivered", at: 12,
    });
    expect(marked).toMatchObject({ role: "system", marker: "delivery.failed" });
    expect(storage.nativeBotMessage("sage", "delivery-failed:cron-1"))
      .toMatchObject({ role: "system", marker: "delivery.failed" });
    const history = storage.nativeBotMessages("sage", sessionId);
    expect(history.map((message) => message.marker)).toEqual([undefined, undefined, "delivery.failed"]);
    storage.close();
  });
});

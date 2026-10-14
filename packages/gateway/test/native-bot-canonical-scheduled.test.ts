import { describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import { openStorage } from "../src/storage.ts";

describe("native canonical scheduled delivery", () => {
  it("projects an admitted canonical-home delivery into its bound session after /new", () => {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    const sessionA = storage.nativeBotChat("sage", 1).sessionId;
    const sessionB = storage.resetNativeBotChat("sage", 2);
    const frame = {
      kind: "event" as const, sequence: 1, eventId: "canonical-event",
      event: {
        kind: "scheduled" as const, target: { kind: "canonical_home" as const },
        deliveryId: "daily", messageId: "daily-message",
        blocks: [{ type: "paragraph" as const, text: "scheduled report" }],
      },
    };
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress: {} as AttachV1Ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: (event) => frames.push(event),
      now: () => 3,
    });
    expect(plane.canAccept("sage", frame)).toBe(true);
    expect(storage.acceptAttachEvent("sage", frame, 3).status).toBe("accepted");
    const sessionC = storage.resetNativeBotChat("sage", 4);

    expect(plane.handle("sage", frame)).toBe(true);
    expect(storage.nativeBotMessages("sage", sessionA)).toEqual([]);
    expect(storage.nativeBotMessages("sage", sessionB)).toEqual([
      expect.objectContaining({ id: "daily-message", text: "scheduled report" }),
    ]);
    expect(storage.nativeBotMessages("sage", sessionC)).toEqual([]);
    expect(frames).toContainEqual(expect.objectContaining({ type: "bot_chat", sessionId: sessionB }));
    plane.close();
    storage.close();
  });
});

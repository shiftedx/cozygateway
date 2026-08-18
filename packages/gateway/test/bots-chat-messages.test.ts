import { describe, expect, it } from "vitest";

import {
  extractMessageText,
  normalizeTimestamp,
  parseChatSnapshot,
} from "../src/hermes-bridge/chat-messages.ts";

/** Hermes message shape drifts between builds and between the paths that wrote a message, so the
 *  mapping is deliberately tolerant. These are unit tests because the drift is invisible until a
 *  particular gateway build hands us a shape we did not expect, and by then it is a blank chat on
 *  someone's phone. */

describe("extractMessageText", () => {
  it("reads a plain string content", () => {
    expect(extractMessageText({ role: "assistant", content: "hello" })).toBe("hello");
  });

  it("joins an array of parts, whether the parts are strings or objects", () => {
    expect(
      extractMessageText({ content: ["one ", { text: "two " }, { content: "three" }] }),
    ).toBe("one two three");
  });

  it("ignores parts that carry no text at all, rather than stringifying them", () => {
    expect(extractMessageText({ content: [{ type: "tool_use", id: "t1" }, { text: "done" }] })).toBe("done");
  });

  it("falls back to msg.text when there is no content field", () => {
    expect(extractMessageText({ role: "user", text: "  typed this  " })).toBe("typed this");
  });

  it("yields the empty string for a message with nothing readable", () => {
    expect(extractMessageText({ role: "assistant" })).toBe("");
  });
});

describe("normalizeTimestamp", () => {
  it("promotes seconds to milliseconds and leaves milliseconds alone", () => {
    expect(normalizeTimestamp(1_755_000_000)).toBe(1_755_000_000_000);
    expect(normalizeTimestamp(1_755_000_000_000)).toBe(1_755_000_000_000);
  });

  it("accepts a numeric string and an ISO string", () => {
    expect(normalizeTimestamp("1755000000")).toBe(1_755_000_000_000);
    expect(normalizeTimestamp("2026-08-17T00:00:00.000Z")).toBe(Date.parse("2026-08-17T00:00:00.000Z"));
  });

  it("returns null for nothing usable", () => {
    expect(normalizeTimestamp(undefined)).toBeNull();
    expect(normalizeTimestamp(0)).toBeNull();
    expect(normalizeTimestamp("later")).toBeNull();
  });
});

describe("parseChatSnapshot", () => {
  it("maps a mixed-shape message list to the stable wire shape", () => {
    const snapshot = parseChatSnapshot(
      {
        session_id: "runtime-9",
        message_count: 3,
        running: true,
        inflight: false,
        messages: [
          { id: "m1", role: "user", content: "hey", at: 1_755_000_000 },
          { role: "assistant", content: [{ text: "hi " }, "there"], timestamp: 1_755_000_060_000 },
          { role: "assistant", text: "and again" },
        ],
      },
      "stored-9",
    );
    expect(snapshot.runtimeId).toBe("runtime-9");
    expect(snapshot.messageCount).toBe(3);
    expect(snapshot.running).toBe(true);
    expect(snapshot.inflight).toBe(false);
    expect(snapshot.messages).toEqual([
      { id: "m1", role: "user", text: "hey", at: 1_755_000_000_000 },
      { id: "stored-9#1", role: "assistant", text: "hi there", at: 1_755_000_060_000 },
      { id: "stored-9#2", role: "assistant", text: "and again", at: null },
    ]);
  });

  it("reads an unrecognizable reply as an empty idle session instead of throwing", () => {
    expect(parseChatSnapshot("nope", "stored-1")).toEqual({
      runtimeId: undefined,
      messages: [],
      messageCount: 0,
      running: false,
      inflight: false,
    });
  });

  it("keeps the gateway's own count when messages were omitted", () => {
    const snapshot = parseChatSnapshot({ session_id: "runtime-1", message_count: 12 }, "stored-1");
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.messageCount).toBe(12);
  });

  it("drops a row that is neither an object nor carries a role or text", () => {
    const snapshot = parseChatSnapshot({ messages: [null, 7, {}, { role: "assistant", content: "kept" }] }, "s");
    expect(snapshot.messages.map((message) => message.text)).toEqual(["kept"]);
  });
});
